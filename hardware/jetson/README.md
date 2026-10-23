# Jetson Orin Nano host

Setup for the machine that runs the stack. Nothing here is Jetson-specific except
the power-mode hint — it works on any Ubuntu host, which is useful when you want
to develop on a laptop and deploy to the Orin.

The bring-up order is in [`../README.md`](../README.md). This is the reference
for what each file does.

| File | Purpose |
|---|---|
| `setup.sh` | Installs system packages, Node, Docker, opens the firewall, builds the Python venv, runs the test suite |
| `check-stack.sh` | Ten ordered first-light checks with a fix line for each failure |
| `sentinel-backend.service` | systemd unit for the backend |
| `sentinel-console.service` | systemd unit for the console (production build) |
| `sentinel-ruview.service` | Optional unit that runs the sensing server container |
| `docker-compose.jetson.yml` | ARM64 override: UDP ingest exposed, console on 3100, host-mounted database |

## Quick start

```bash
git clone <your repo> ~/sentinel && cd ~/sentinel
sudo ./hardware/jetson/setup.sh

docker run -d --name ruview --restart unless-stopped \
  -p 3000:3000 -p 3001:3001 -p 5005:5005/udp ruvnet/wifi-densepose:latest

sudo cp hardware/jetson/sentinel-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sentinel-backend sentinel-console

./hardware/jetson/check-stack.sh
```

The units assume the repo is at `/home/sentinel/sentinel` and run as user
`sentinel`. Edit `User=`, `WorkingDirectory=` and the `ExecStart=` paths if yours
differ — systemd will not guess, it will just fail to start.

The backend unit sets `SENTINEL_ADVISORY__EVIDENCE_GATE=false` for bench trials:
the advisory always shows a decision rather than INSUFFICIENT EVIDENCE. Remove
that line for an evaluation run.

## No GPU stack is installed, on purpose

The backend is pure Python: no numpy, no torch, no CUDA. Analysis windows are a
few hundred samples, and the whole pipeline runs comfortably on the Orin's CPU
alongside the sensing server. Installing JetPack's ML stack to run this would add
several gigabytes and an ARM64 wheel-compatibility problem for no benefit.

The GPU becomes relevant only if a camera modality is added later, at which point
`jetson-containers` is the right base image — not `pip install torch`.

## Things that will bite you

**UDP 5005 must be open.** It is what the nodes stream CSI to. If it is closed,
every node looks healthy on the AP, the sensing server reports nothing, and the
console shows an empty room. `setup.sh` opens it when ufw is active.

**`NEXT_PUBLIC_API_URL` is baked in at build time.** It ends up in the client
bundle, so it must be the address a *browser on the network* will use. If you
build with `localhost` and then open the console from a laptop, the laptop will
try to reach its own machine for the API. Rebuild after changing it.

**Port 3000.** RuView's own UI takes it. The console is therefore on 3100 in these
units and in the compose override.

**The node's `--target-ip` is this host's address.** If DHCP moves the Jetson, the
nodes keep streaming to an address nobody is listening on. Give it a reservation
or a static lease, and re-provision if it changes.

**Power.** Use the supplied adapter. Under-power on an Orin shows up as throttling
and reboots that read like software crashes; `dmesg | grep -i volt` will say so.
For a demo, `sudo nvpmodel -m 0 && sudo jetson_clocks`.

## Data

The session database is at `SENTINEL_DB_PATH` (the unit sets
`/home/sentinel/sentinel-data/sentinel.db`), deliberately outside the repo and
outside any container. It holds every recorded session, the assessments the
evaluation reads, and the ground-truth labels the calibration fits on — back it up
before reflashing anything.

```bash
sqlite3 ~/sentinel-data/sentinel.db "select id, started_at, ended_at from sessions order by id desc limit 5;"
curl -s localhost:8010/api/export.csv?table=assessments > session.csv
```
