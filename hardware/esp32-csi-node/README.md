# ESP32-S3 CSI node firmware

One binary for all three nodes. Identity and network live in NVS, so a board is
told who it is after flashing rather than being rebuilt per node.

It emits the upstream ADR-018 UDP frame, so it is a drop-in replacement for
RuView's prebuilt node binary — and the same frames can be read directly by
`tools/csi_probe.py` with nothing else running.

> **Build status.** Builds clean on ESP-IDF v5.4.2 for both the ESP32-S3 and the
> classic ESP32 (WROOM-32). Flashed and booted on an ESP32-D0WD-V3; not yet
> validated streaming against an AP.

## What it does

```
   poke task ──ICMP echo request──▶ sensing host
   CSI callback ◀──AP transmits echo reply── sensing host
   report task ──ADR-018 CSI frame──▶ sensing host :5005
```

The traffic generator requests ICMP echo replies at `poke_hz` (default 100).
The incoming data frames supply CSI; the report task emits the newest sample at
`report_hz` (default 10). The sensing host must allow ICMP echo requests.
On the tested S3/AP pair, UDP poke traffic with ACK dumping produced only about
0.5 CSI frames/s. Incoming data traffic restored the configured report rate.

The node makes **no decisions**: no filtering, no averaging, no presence logic.
Everything interpretive lives in the backend where it is versioned, tested and
re-runnable against recordings.

## Build

```bash
# once per shell — path depends on where ESP-IDF is installed
. $HOME/esp/esp-idf/export.sh        # Windows: %USERPROFILE%\esp\esp-idf\export.bat

cd hardware/esp32-csi-node
idf.py set-target esp32s3
idf.py build
```

A classic ESP32 (WROOM-32) also works: it uses the non-HE CSI config path and
emits identical frames. Build it into its own directory so both images coexist:

```bash
idf.py -B build-esp32 -D SDKCONFIG=sdkconfig.esp32 set-target esp32
idf.py -B build-esp32 -D SDKCONFIG=sdkconfig.esp32 build
```

`tools/flash-node.sh` detects the chip and picks the matching build.

## Flash

The UART USB-C port uses the default `build/` firmware. Native S3 USB
(`/dev/ttyACM*`) uses `build-usb/`, with `sdkconfig.usb` selecting
`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`. Rebuild that variant with:

```bash
idf.py -B build-usb -D SDKCONFIG=sdkconfig.usb build
```

`tools/flash-node.sh` selects `build-usb/` for S3 native USB ports. If the board
is not detected, hold **BOOT**, tap **RESET**, release **BOOT**.

```bash
idf.py -p /dev/ttyUSB0 flash monitor     # Linux
idf.py -p COM9 flash monitor             # Windows
```

Finding the port: `ls /dev/ttyUSB* /dev/ttyACM*` on Linux, or Device Manager →
Ports (COM & LPT) on Windows. Plug the board in and watch which entry appears.

## Provision

A freshly flashed node prints `UNPROVISIONED` and waits in its console. Either
drive it with the tool:

```bash
python tools/provision.py --port /dev/ttyUSB0 \
    --ssid SentinelAP --password "your-ap-password" \
    --target-ip 192.168.1.20 --node-id 1
```

…or type the same commands into `idf.py monitor`:

```
set id 1
set ssid SentinelAP
set pass your-ap-password
set ip 192.168.1.20
save
reboot
```

`--target-ip` is the host running the sensing server — the Jetson. Repeat for
each board with `--node-id 2` and `3`.

### Console commands

| Command | Effect |
|---|---|
| `show` | Print the configuration (password masked) |
| `set <key> <value>` | `ssid`, `pass`, `ip`, `port`, `id`, `report_hz`, `poke_hz` |
| `save` | Persist to NVS — nothing takes effect until this succeeds |
| `clear` | Erase the stored configuration |
| `stats` | Link state, RSSI, channel, disconnects, CSI count, frames sent, errors |
| `reboot` | Restart |

## Verify

With nothing else running, on the host:

```bash
python tools/csi_probe.py
```

Expected, per node:

```
node 1:  10.0 frames/s  rssi  -54.0 dBm  amp mean   18.42  amp sd  0.412
```

- **frames/s ≈ report_hz.** Much lower means CSI callbacks are being dropped —
  raise the RX buffers in `sdkconfig.defaults`, or lower `poke_hz`.
- **RSSI better than −70 dBm.** Past −80, respiration will not lock.
- **amp sd** should visibly move when someone breathes in the link path and sit
  near-flat in an empty room. That is the actual signal everything downstream is
  built on; if it does not move, no amount of backend tuning will help.

Then run the rest of the stack and check the console's **RF / Nodes** screen.

## Configuration reference

| Key | Default | Notes |
|---|---|---|
| `node_id` | 1 | 1–255, unique per deployment. Node ids are how the backend attributes vitals. |
| `target_ip` | unset | The sensing host. Re-provision if DHCP moves it, or reserve the address. |
| `target_port` | 5005 | What the sensing server binds. |
| `report_hz` | 10 | Frames published per second. The analysis assumes ~10 Hz; the respiration band tops out at 0.5 Hz, so more is wasted airtime. |
| `poke_hz` | 100 | Sampling rate. Must stay well above `report_hz`; oversampling then decimating means a lost ACK costs nothing. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Build error on `wifi_csi_config_t` fields | IDF version difference: HE-capable targets (C6) take `acquire_csi_*` sub-configs, older ones take `lltf_en`/`htltf_en` | `csi_capture.c` has both under `#if defined(CONFIG_SOC_WIFI_HE_SUPPORT)`; if your IDF disagrees, check `components/esp_wifi/include/esp_wifi_types.h` and match the struct there |
| `esp_wifi_set_csi: ESP_ERR_NOT_SUPPORTED` | CSI not compiled in | `CONFIG_ESP_WIFI_CSI_ENABLED=y` — it is in `sdkconfig.defaults`; confirm with `idf.py menuconfig` |
| "link is up but no CSI is arriving" | power save re-enabled, or poke traffic not reaching the AP | Power save is disabled in code and config; check `stats` shows a sane channel, and that the AP is not isolating clients |
| "capturing CSI but sending nothing" | wrong `target_ip`/`port`, or a host firewall | Fix with `set ip`; open UDP 5005 on the host |
| Node never associates | AP on 5 GHz, or wrong credentials | The S3 has no 5 GHz radio. Force the AP to 2.4 GHz and re-provision |
| Random reboots | brownout | Its own 5 V / 2 A supply and a short, thick cable. Not a firmware fault |
| Frames arrive but `n_subcarriers` is 0 | a u16 field read as one byte somewhere downstream | This firmware writes the u16 correctly; if a consumer disagrees, it predates upstream issue #1005 |

## Files

| File | Role |
|---|---|
| `main/app_main.c` | Task wiring, the poke/report loop, the status reporter |
| `main/csi_capture.c` | CSI configuration and the RX callback |
| `main/csi_frame.c` | ADR-018 frame packing (the wire contract) |
| `main/wifi_link.c` | Station mode, power save off, unconditional reconnect |
| `main/node_config.c` | NVS-backed configuration and the provisioning shell |
| `tools/provision.py` | Host-side provisioning over serial |
| `tools/csi_probe.py` | Host-side UDP listener: parse, rate, RSSI, amplitude stats |
