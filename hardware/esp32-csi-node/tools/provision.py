#!/usr/bin/env python3
"""Provision a SENTINEL CSI node over its serial console.

One binary is flashed to every node; this is what tells a particular board who it
is and where to stream. It drives the same line-based shell you get from
`idf.py monitor`, so anything it does can also be done by hand.

    python tools/provision.py --port COM9 --ssid SentinelAP --password secret \
        --target-ip 192.168.1.20 --node-id 1

    python tools/provision.py --port /dev/ttyUSB0 --show
    python tools/provision.py --port /dev/ttyUSB0 --stats

Requires pyserial (`pip install pyserial`), which the ESP-IDF environment already
has.
"""

from __future__ import annotations

import argparse
import sys
import time

try:
    import serial  # type: ignore
except ImportError:  # pragma: no cover - environment dependent
    sys.exit("pyserial is required: pip install pyserial")

PROMPT_WAIT_S = 0.35


def send(ser, line: str, *, echo: bool = True) -> str:
    """Send one command and return whatever the node printed in reply."""
    ser.reset_input_buffer()
    ser.write((line + "\n").encode())
    ser.flush()
    time.sleep(PROMPT_WAIT_S)
    out = ser.read(ser.in_waiting or 1).decode(errors="replace")
    if echo:
        for raw in out.splitlines():
            text = raw.strip()
            if text:
                print(f"  {text}")
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--port", required=True, help="COM9, /dev/ttyUSB0, /dev/ttyACM0")
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--ssid")
    p.add_argument("--password", default="")
    p.add_argument("--target-ip", help="host running the sensing server")
    p.add_argument("--target-port", type=int, default=5005)
    p.add_argument("--node-id", type=int, help="1..255, unique per deployment")
    p.add_argument("--report-hz", type=int, default=10)
    p.add_argument("--poke-hz", type=int, default=100)
    p.add_argument("--show", action="store_true", help="print configuration and exit")
    p.add_argument("--stats", action="store_true", help="print link/CSI counters and exit")
    p.add_argument("--clear", action="store_true", help="erase the stored configuration")
    p.add_argument("--no-reboot", action="store_true")
    args = p.parse_args()

    with serial.Serial(args.port, args.baud, timeout=1) as ser:
        time.sleep(0.4)

        if args.show:
            send(ser, "show")
            return 0
        if args.stats:
            send(ser, "stats")
            return 0
        if args.clear:
            send(ser, "clear")
            return 0

        if not args.ssid or not args.target_ip or args.node_id is None:
            p.error("--ssid, --target-ip and --node-id are required to provision")

        print(f"provisioning node {args.node_id} on {args.port}")
        steps = [
            f"set id {args.node_id}",
            f"set ssid {args.ssid}",
            f"set pass {args.password}",
            f"set ip {args.target_ip}",
            f"set port {args.target_port}",
            f"set report_hz {args.report_hz}",
            f"set poke_hz {args.poke_hz}",
        ]
        failures = []
        for step in steps:
            reply = send(ser, step)
            if "ERR" in reply:
                failures.append(step)
        if failures:
            print("\nrefused:", *failures, sep="\n  ")
            return 1

        reply = send(ser, "save")
        if "OK saved" not in reply:
            print("\nsave did not confirm — configuration NOT persisted")
            return 1

        send(ser, "show")
        if not args.no_reboot:
            print("rebooting")
            send(ser, "reboot", echo=False)
        print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
