#!/usr/bin/env bash
#
# Prepare a Jetson Orin Nano (or any Ubuntu host) to run the SENTINEL stack.
#
#   sudo ./setup.sh            # system packages, docker, firewall
#   ./setup.sh --user-only     # skip anything needing root
#
# Idempotent: safe to re-run. It installs what is missing and reports what it
# skipped rather than failing.
#
# Deliberately does NOT install CUDA, PyTorch or jetson-containers. The backend is
# pure Python with no numpy and no GPU dependency — it runs on the Orin's CPU.
# The GPU only becomes relevant if a camera modality is added later.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
USER_ONLY=0
[[ "${1:-}" == "--user-only" ]] && USER_ONLY=1

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*"; }
ok()   { printf '   %s\n' "$*"; }

need_root() {
  if [[ $EUID -ne 0 && $USER_ONLY -eq 0 ]]; then
    warn "not running as root — re-run with sudo, or use --user-only"
    exit 1
  fi
}

log "host"
ok "$(uname -srm)"
if [[ -f /etc/nv_tegra_release ]]; then
  ok "JetPack: $(head -1 /etc/nv_tegra_release)"
else
  warn "no /etc/nv_tegra_release — not a Jetson; that is fine, nothing here needs one"
fi
ok "repo: $REPO_ROOT"

if [[ $USER_ONLY -eq 0 ]]; then
  need_root

  log "system packages"
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    git curl ca-certificates jq sqlite3 \
    build-essential net-tools iputils-ping
  ok "installed"

  log "node.js (for the console)"
  if command -v node >/dev/null 2>&1 && [[ "$(node -v | cut -c2- | cut -d. -f1)" -ge 20 ]]; then
    ok "node $(node -v) already present"
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    ok "node $(node -v)"
  fi

  log "docker (for the RuView sensing server)"
  if command -v docker >/dev/null 2>&1; then
    ok "docker $(docker --version | awk '{print $3}' | tr -d ,) already present"
  else
    curl -fsSL https://get.docker.com | sh
    ok "installed"
  fi
  if [[ -n "${SUDO_USER:-}" ]]; then
    usermod -aG docker "$SUDO_USER" || true
    ok "added $SUDO_USER to the docker group (log out and back in to take effect)"
  fi

  log "firewall"
  # UDP 5005 is what the nodes stream CSI to. If it is closed, every node looks
  # healthy on the AP and the console shows an empty room.
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 5005/udp  comment "SENTINEL CSI ingest" || true
    ufw allow 8010/tcp  comment "SENTINEL backend"    || true
    ufw allow 3000/tcp  comment "SENTINEL console"    || true
    ok "ufw rules added"
  else
    ok "ufw inactive — nothing to open"
  fi

  log "power mode"
  if command -v nvpmodel >/dev/null 2>&1; then
    nvpmodel -q || true
    warn "if this is a demo rig, set the highest mode: sudo nvpmodel -m 0 && sudo jetson_clocks"
  fi
fi

log "python environment"
cd "$REPO_ROOT/backend"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  ok "created backend/.venv"
fi
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -e '.[dev]'
ok "backend installed"

log "self-test"
./.venv/bin/python -m pytest -q -m "not slow" 2>&1 | tail -3

log "console dependencies"
cd "$REPO_ROOT/frontend"
npm install --no-fund --no-audit
ok "installed"

log "host address"
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
ok "this host is ${HOST_IP:-unknown}"
cat <<NOTE

Next:
  1. Provision each node with --target-ip ${HOST_IP:-<this host's IP>}
     (hardware/esp32-csi-node/tools/provision.py)
  2. Start the sensing server:
       docker run -d --name ruview --restart unless-stopped \
         -p 3000:3000 -p 3001:3001 -p 5005:5005/udp ruvnet/wifi-densepose:latest
  3. Install the services:
       sudo cp hardware/jetson/*.service /etc/systemd/system/
       sudo systemctl daemon-reload
       sudo systemctl enable --now sentinel-backend sentinel-console
  4. Check it:
       ./hardware/jetson/check-stack.sh

Full runbook: NEXT-STEPS.md
NOTE
