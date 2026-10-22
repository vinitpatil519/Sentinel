#!/usr/bin/env bash
#
# Flash and provision one CSI node, then print what goes in the NEXT-STEPS §5 table.
#
#   ./tools/flash-node.sh <port> <node-id> <ssid> <password> [target-ip]
#   ./tools/flash-node.sh /dev/ttyUSB0 1 "lab-ap" "secret"
#
# target-ip defaults to this host's first address, which is what the nodes must
# stream to when this runs on the Jetson. Build first: `idf.py build`.

set -euo pipefail

if [[ $# -lt 4 ]]; then
  sed -n '3,9p' "$0"
  exit 2
fi

PORT="$1"; NODE_ID="$2"; SSID="$3"; PASSWORD="$4"
TARGET_IP="${5:-$(hostname -I | awk '{print $1}')}"
NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDF_EXPORT="${IDF_PATH:-$HOME/esp/esp-idf}/export.sh"

[[ -e "$PORT" ]] || { echo "no such port: $PORT (ls /dev/ttyUSB* /dev/ttyACM*)"; exit 1; }

# shellcheck disable=SC1090
. "$IDF_EXPORT" >/dev/null

# The same source builds for the S3 (build/) and a classic WROOM-32 (build-esp32/,
# via `idf.py -B build-esp32 -D SDKCONFIG=sdkconfig.esp32 set-target esp32 build`).
CHIP_LINE="$(python -m esptool --port "$PORT" chip_id 2>/dev/null | grep -m1 '^Chip is')"
case "$CHIP_LINE" in
  *ESP32-S3*) CHIP=esp32s3; BUILD_DIR="$NODE_DIR/build" ;;
  *ESP32-D0*|*ESP32-PICO*|*"ESP32 "*) CHIP=esp32; BUILD_DIR="$NODE_DIR/build-esp32" ;;
  *) echo "unsupported or unreadable chip: ${CHIP_LINE:-none} (hold BOOT, tap RESET)"; exit 1 ;;
esac
# Native S3 USB needs stdin on USB Serial/JTAG, rather than UART0.
if [[ "$CHIP" == esp32s3 && "$(readlink -f "$PORT")" == /dev/ttyACM* ]]; then
    BUILD_DIR="$NODE_DIR/build-usb"
fi
[[ -f "$BUILD_DIR/flash_args" ]] || { echo "not built for $CHIP: no $BUILD_DIR/flash_args"; exit 1; }

echo "== node $NODE_ID ($CHIP) on $PORT -> $TARGET_IP:5005"

MAC="$(python -m esptool --chip "$CHIP" --port "$PORT" read_mac 2>/dev/null \
       | awk '/^MAC:/{print $2; exit}')"
echo "   MAC $MAC"

( cd "$BUILD_DIR" && python -m esptool --chip "$CHIP" --port "$PORT" -b 460800 \
    --before default_reset --after hard_reset write_flash "@flash_args" )

# The console needs a moment after the hard reset before it accepts commands.
sleep 3
python3 "$NODE_DIR/tools/provision.py" --port "$PORT" \
    --ssid "$SSID" --password "$PASSWORD" \
    --target-ip "$TARGET_IP" --node-id "$NODE_ID"
# provision.py reboots the node to apply; wait for its console to return.
sleep 4
python3 "$NODE_DIR/tools/provision.py" --port "$PORT" --show

echo
echo "§5 table row:  ID $NODE_ID   MAC $MAC   flashed [x]  provisioned [x]"
