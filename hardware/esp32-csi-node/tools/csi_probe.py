#!/usr/bin/env python3
"""Listen for CSI frames from the nodes and report what is arriving.

The first thing to run when a node is flashed, before any of the rest of the
stack exists. It binds the same UDP port the sensing server binds, parses the
ADR-018 frame, and prints per-node rate, RSSI and amplitude statistics — so
"is the node working" is answered by one command with no server, no Docker and
no console.

    python tools/csi_probe.py                     # bind 0.0.0.0:5005
    python tools/csi_probe.py --port 5005 --raw    # dump one frame's amplitudes
    python tools/csi_probe.py --seconds 30 --csv capture.csv

Nothing else may hold port 5005 while this runs — if the sensing server is up,
stop it first, or this will see nothing and the server will keep the frames.
"""

from __future__ import annotations

import argparse
import csv
import math
import socket
import struct
import sys
import time
from collections import defaultdict

MAGIC = 0xC5110001
HEADER_LEN = 20
HEADER = struct.Struct("<IBBHIIbbBB")


def parse(buf: bytes) -> dict | None:
    """Parse one frame, or return None if it is not one (pokes land here too)."""
    if len(buf) < HEADER_LEN:
        return None
    (magic, node_id, n_ant, n_sub, freq_mhz, seq, rssi, noise, ppdu, flags) = HEADER.unpack_from(buf)
    if magic != MAGIC:
        return None
    pairs = n_ant * n_sub
    if pairs == 0 or len(buf) < HEADER_LEN + pairs * 2:
        return None

    amps = []
    for k in range(pairs):
        i_val = int.from_bytes(buf[HEADER_LEN + k * 2: HEADER_LEN + k * 2 + 1], "little", signed=True)
        q_val = int.from_bytes(buf[HEADER_LEN + k * 2 + 1: HEADER_LEN + k * 2 + 2], "little", signed=True)
        amps.append(math.hypot(i_val, q_val))
    return {
        "node_id": node_id,
        "n_antennas": n_ant,
        "n_subcarriers": n_sub,
        "freq_mhz": freq_mhz,
        "sequence": seq,
        "rssi": rssi,
        "noise_floor": noise,
        "ppdu_type": ppdu,
        "flags": flags,
        "amplitudes": amps,
    }


def mean(xs) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def stdev(xs) -> float:
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bind", default="0.0.0.0")
    p.add_argument("--port", type=int, default=5005)
    p.add_argument("--seconds", type=float, default=0.0, help="stop after N seconds")
    p.add_argument("--raw", action="store_true", help="print the first frame in full")
    p.add_argument("--csv", help="append per-frame mean amplitude to this file")
    args = p.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((args.bind, args.port))
    except OSError as e:
        return int(bool(print(f"cannot bind {args.bind}:{args.port} — {e}\n"
                              "something else is holding it (the sensing server?)")) ) or 1
    sock.settimeout(1.0)
    print(f"listening on udp {args.bind}:{args.port} — ctrl-c to stop\n")

    writer = None
    handle = None
    if args.csv:
        handle = open(args.csv, "a", newline="", encoding="utf-8")
        writer = csv.writer(handle)
        writer.writerow(["wall_time", "node_id", "sequence", "rssi", "n_subcarriers",
                         "amp_mean", "amp_sd"])

    started = time.monotonic()
    last_report = started
    frames = defaultdict(int)
    pokes = 0
    rssi_sum = defaultdict(float)
    amp_hist = defaultdict(list)
    shown_raw = False

    try:
        while True:
            if args.seconds and time.monotonic() - started >= args.seconds:
                break
            try:
                data, addr = sock.recvfrom(4096)
            except socket.timeout:
                data = None
            if data:
                frame = parse(data)
                if frame is None:
                    pokes += 1
                else:
                    nid = frame["node_id"]
                    frames[nid] += 1
                    rssi_sum[nid] += frame["rssi"]
                    amps = frame["amplitudes"]
                    amp_hist[nid].append(mean(amps))
                    if len(amp_hist[nid]) > 200:
                        amp_hist[nid].pop(0)
                    if writer:
                        writer.writerow([f"{time.time():.3f}", nid, frame["sequence"],
                                         frame["rssi"], frame["n_subcarriers"],
                                         f"{mean(amps):.4f}", f"{stdev(amps):.4f}"])
                    if args.raw and not shown_raw:
                        shown_raw = True
                        print("first frame")
                        for k, v in frame.items():
                            if k == "amplitudes":
                                print(f"  amplitudes ({len(v)}): "
                                      + " ".join(f"{a:.1f}" for a in v[:24]) + " ...")
                            else:
                                print(f"  {k}: {v}")
                        print(f"  from: {addr[0]}\n")

            now = time.monotonic()
            if now - last_report >= 2.0:
                span = now - last_report
                if not frames and not pokes:
                    print("nothing received — check the node's target_ip and any host firewall")
                for nid in sorted(frames):
                    rate = frames[nid] / span
                    avg_rssi = rssi_sum[nid] / max(frames[nid], 1)
                    series = amp_hist[nid]
                    print(f"node {nid}: {rate:5.1f} frames/s  rssi {avg_rssi:6.1f} dBm  "
                          f"amp mean {mean(series):7.2f}  amp sd {stdev(series):6.3f}")
                if pokes:
                    print(f"  ({pokes} non-frame datagrams — poke traffic, expected)")
                frames.clear()
                rssi_sum.clear()
                pokes = 0
                last_report = now
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        sock.close()
        if handle:
            handle.close()
            print(f"wrote {args.csv}")

    print("\nWhat to look for:")
    print("  frames/s near the node's report_hz (default 10)")
    print("  rssi better than -70 dBm; worse than -80 and respiration will not lock")
    print("  amp sd moving when someone breathes in the link, near-flat when the room is empty")
    return 0


if __name__ == "__main__":
    sys.exit(main())
