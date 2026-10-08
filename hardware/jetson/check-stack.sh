#!/usr/bin/env bash
#
# First-light check. Runs the verification sequence from NEXT-STEPS.md in order
# and says what to do about whatever failed.
#
#   ./check-stack.sh                       # localhost
#   ./check-stack.sh --host 192.168.1.20   # a remote Jetson
#   ./check-stack.sh --expect-nodes 3
#
# Order matters: each check depends on the one before, so the first failure is
# the one to fix. Exits non-zero if any check fails.

set -uo pipefail

HOST=localhost
BACKEND_PORT=8010
RUVIEW_PORT=3000
CONSOLE_PORT=3100
EXPECT_NODES=3

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --ruview-port) RUVIEW_PORT="$2"; shift 2 ;;
    --console-port) CONSOLE_PORT="$2"; shift 2 ;;
    --expect-nodes) EXPECT_NODES="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done

# Interpreter for the JSON helpers. The Jetson has python3; a Windows Git Bash
# shell often only has `python`, and without this the helpers fail silently and
# every check reads as a failure.
# Candidates are *executed*, not merely located: on Windows `python3` is often an
# App Execution Alias that exists on PATH and runs nothing, which would leave
# every JSON check reading as a failure.
PY=""
for candidate in python3 python py; do
  if "$candidate" -c 'print(1)' >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [[ -z "$PY" ]]; then
  echo "no python interpreter found — install python3" >&2
  exit 2
fi

PASS=0
FAIL=0
N=0

pass() { N=$((N+1)); PASS=$((PASS+1)); printf '\033[32m  ok  \033[0m %d. %s\n' "$N" "$1"; }
fail() { N=$((N+1)); FAIL=$((FAIL+1)); printf '\033[31m FAIL \033[0m %d. %s\n' "$N" "$1"
         if [[ -n "${2:-}" ]]; then printf '        fix: %s\n' "$2"; fi; }
skip() { N=$((N+1)); printf '\033[33m skip \033[0m %d. %s\n' "$N" "$1"
         if [[ -n "${2:-}" ]]; then printf '        %s\n' "$2"; fi; }
info() { printf '        %s\n' "$1"; }

get() { curl -s -m 5 "$1" 2>/dev/null; }

# Read one value out of a JSON document on stdin. The expression is handed to
# python as an argument rather than interpolated into a double-quoted string:
# quotes inside a dict lookup would terminate the bash string, and the lookup
# would then fail silently and read as a failed check rather than a broken script.
jqr() {
  "$PY" -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
try:
    print(eval(sys.argv[1]))
except Exception:
    sys.exit(1)' "$1" 2>/dev/null
}

is_json() {
  "$PY" -c 'import json, sys
try:
    json.load(sys.stdin)
except Exception:
    sys.exit(1)' 2>/dev/null
}

# Which source the backend is on, read up front. When the simulator is standing
# in for the sensing server, checks 1 and 2 are not failures — there is
# deliberately no server to find — and reporting them as failures would send
# someone chasing a container that was never meant to be running.
EARLY_STATE="$(get "http://$HOST:$BACKEND_PORT/api/state")"
EARLY_SOURCE="$(printf '%s' "$EARLY_STATE" | jqr '(d.get("rf.presence") or {}).get("data", {}).get("source", "")')"
SIM_MODE=0
if [[ "$EARLY_SOURCE" == "simulate" ]]; then SIM_MODE=1; fi

printf '\n\033[1mSENTINEL first-light check — %s\033[0m\n\n' "$HOST"

# 1. Is the sensing server actually there? -----------------------------------
# "Something answered on that port" is not the same as "the sensing server is
# running" — another app on :3000 will happily return an HTML 404.
RUVIEW_HEALTH="$(get "http://$HOST:$RUVIEW_PORT/health")"
if [[ $SIM_MODE -eq 1 ]]; then
  skip "sensing server not expected — the simulator stands in for it" \
       "this is the no-hardware path; checks 5-9 still exercise the real pipeline"
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^ruview$'; then
  pass "sensing server container is running"
elif [[ -n "$RUVIEW_HEALTH" ]] && printf '%s' "$RUVIEW_HEALTH" | is_json; then
  pass "sensing server is answering on :$RUVIEW_PORT"
elif [[ -n "$RUVIEW_HEALTH" ]]; then
  fail "something is on :$RUVIEW_PORT but it is not the sensing server" \
       "another app holds that port — move it, or pass --ruview-port"
else
  fail "sensing server is not running" \
       "docker run -d --name ruview --restart unless-stopped -p 3000:3000 -p 3001:3001 -p 5005:5005/udp ruvnet/wifi-densepose:latest"
fi

# 2. Is it seeing the nodes? --------------------------------------------------
NODES_JSON="$(get "http://$HOST:$RUVIEW_PORT/api/v1/nodes")"
if [[ $SIM_MODE -eq 1 ]]; then
  skip "node API not expected in simulator mode" \
       "node telemetry comes from the simulated scenario instead"
elif [[ -n "$NODES_JSON" ]] && printf '%s' "$NODES_JSON" | is_json; then
  pass "sensing server node API reachable"
  info "$(printf '%s' "$NODES_JSON" | head -c 180)"
else
  fail "sensing server node API not answering with JSON" \
       "docker logs ruview --tail 40"
fi

# 3. Is the backend connected to it? -----------------------------------------
HEALTH="$(get "http://$HOST:$BACKEND_PORT/healthz")"
HEALTH_OK="$(printf '%s' "$HEALTH" | jqr 'd["ok"]')"
if [[ "$HEALTH_OK" == "True" ]]; then
  pass "backend is up and its sensor is connected"
elif [[ -n "$HEALTH" ]]; then
  fail "backend is up but not receiving from the sensing server" \
       "check RUVIEW_URL — the sensing WebSocket port is 3001, not 3000"
  info "healthz: $HEALTH"
else
  fail "backend is not answering on :$BACKEND_PORT" \
       "systemctl status sentinel-backend"
fi

# 4. Is the data real? -------------------------------------------------------
STATE="$(get "http://$HOST:$BACKEND_PORT/api/state")"
SOURCE="$(printf '%s' "$STATE" | jqr '(d.get("rf.presence") or {}).get("data", {}).get("source", "none")')"
case "$SOURCE" in
  esp32)
    pass "data source is real hardware (esp32)" ;;
  wifi)
    pass "data source is a live WiFi scan" ;;
  simulate)
    skip "data source is the SIMULATOR — nothing on screen is a measurement" \
         "expected without hardware; for a hardware check, stop scripts/ruview_sim.py and point RUVIEW_URL at the sensing server" ;;
  esp32:offline)
    fail "nodes were seen but have gone quiet" \
         "check node power and that they are still associated with the AP" ;;
  *)
    fail "no data source (source=${SOURCE:-unknown})" "work through checks 1-3 first" ;;
esac

# 5. Are all the nodes reporting, with usable margin? ------------------------
NODE_COUNT="$(printf '%s' "$STATE" | jqr '(d.get("rf.nodes") or {}).get("data", {}).get("node_count", 0)')"
ONLINE="$(printf '%s' "$STATE" | jqr '(d.get("rf.nodes") or {}).get("data", {}).get("online_count", 0)')"
MEAN_RSSI="$(printf '%s' "$STATE" | jqr '(d.get("rf.nodes") or {}).get("data", {}).get("mean_rssi", "")')"
if [[ "${ONLINE:-0}" -ge "$EXPECT_NODES" ]]; then
  pass "${ONLINE}/${NODE_COUNT} nodes online"
else
  fail "only ${ONLINE:-0}/${EXPECT_NODES} nodes reporting" \
       "stop the sensing server (it holds UDP 5005) and run: python hardware/esp32-csi-node/tools/csi_probe.py"
fi

if [[ -n "$MEAN_RSSI" && "$MEAN_RSSI" != "None" ]]; then
  if "$PY" -c "import sys; sys.exit(0 if float('$MEAN_RSSI') > -75 else 1)" 2>/dev/null; then
    pass "link margin usable (mean $MEAN_RSSI dBm)"
  else
    fail "link margin marginal (mean $MEAN_RSSI dBm)" \
         "move nodes closer to the AP or reposition; below -80 dBm respiration will not lock"
  fi
else
  skip "no link margin reported" "depends on check 5"
fi

# 6. Is the field arriving? --------------------------------------------------
FIELD_PTS="$(printf '%s' "$STATE" | jqr 'len((d.get("rf.field") or {}).get("data", {}).get("points", []))')"
if [[ "${FIELD_PTS:-0}" -gt 0 ]]; then
  pass "signal field arriving (${FIELD_PTS} cells above the noise floor)"
elif [[ -n "${FIELD_PTS:-}" ]]; then
  skip "signal field is empty" "correct for an empty room; walk into the link path and re-run"
else
  fail "no signal field at all" "the server publishes one once CSI is flowing; re-check 2 and 5"
fi

# 7. Is anyone being tracked? -----------------------------------------------
SUBJECTS="$(printf '%s' "$STATE" | jqr '(d.get("track.state") or {}).get("data", {}).get("subject_count", 0)')"
if [[ "${SUBJECTS:-0}" -gt 0 ]]; then
  pass "${SUBJECTS} subject(s) tracked"
else
  skip "no subject tracked" \
       "correct if the volume is empty; if someone is present, check placement (NEXT-STEPS section 5)"
fi

# 8. Is respiration locking? ------------------------------------------------
RESP_BPM="$(printf '%s' "$STATE" | jqr '
(lambda ts: (ts[0]["vitals"]["respiration"]["bpm"] if ts else None))(
    (d.get("track.state") or {}).get("data", {}).get("tracks", []))')"
if [[ -n "$RESP_BPM" && "$RESP_BPM" != "None" ]]; then
  pass "respiration lock: ${RESP_BPM} breaths/min"
elif [[ "${SUBJECTS:-0}" -gt 0 ]]; then
  skip "subject tracked but no respiration lock yet" \
       "needs ~45 s of a still subject in the link path"
else
  skip "no subject to measure" "nothing to check"
fi

# 9. Is the console up? -----------------------------------------------------
CONSOLE_CODE="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://$HOST:$CONSOLE_PORT/" 2>/dev/null)"
if [[ "$CONSOLE_CODE" == "200" ]]; then
  pass "console serving on :$CONSOLE_PORT"
else
  fail "console not serving on :$CONSOLE_PORT (HTTP ${CONSOLE_CODE:-none})" \
       "systemctl status sentinel-console, or: cd frontend && npm run build && npm start"
fi

printf '\n\033[1m%d checks: %d ok, %d failed, %d skipped\033[0m\n' \
    "$N" "$PASS" "$FAIL" "$((N - PASS - FAIL))"
if [[ $FAIL -gt 0 ]]; then
  printf 'Fix the first failure above and re-run — later checks depend on earlier ones.\n\n'
  exit 1
fi
if [[ $SIM_MODE -eq 1 ]]; then
  printf 'Pipeline is healthy on SIMULATED data — re-run against hardware before\n'
  printf 'quoting any number from it.\n'
fi
printf 'Open http://%s:%s\n\n' "$HOST" "$CONSOLE_PORT"
