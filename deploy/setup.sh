#!/usr/bin/env bash
# One-time setup on the Oracle VM (Ubuntu 22.04/24.04, ARM64) — or on any
# x86_64 Ubuntu with systemd, e.g. WSL on your PC for a rehearsal. Run from
# the project folder as the normal user (not root):
#
#   bash deploy/setup.sh
#
# Installs Node.js 24, FFmpeg 9.0 (pinned static build — the version the
# pipeline was tested on), cloudflared; asks for the panel password, YouTube
# stream key and optional Discord/Healthchecks URLs; installs and starts the
# systemd service. Safe to re-run (it skips what's already done).

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR=24
FFMPEG_VERSION=9.0

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Oracle's free A1 servers are ARM64; WSL on a PC or most VPSes are x86_64.
case "$(uname -m)" in
  aarch64 | arm64) FF_ARCH=linuxarm64; CF_ARCH=arm64 ;;
  x86_64 | amd64) FF_ARCH=linux64; CF_ARCH=amd64 ;;
  *) die "Unsupported CPU type: $(uname -m)" ;;
esac
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n${FFMPEG_VERSION}-latest-${FF_ARCH}-gpl-${FFMPEG_VERSION}.tar.xz"
CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}.deb"

[ "$(id -u)" -ne 0 ] || die "Run this as your normal user (it uses sudo where needed), not as root."
command -v apt-get >/dev/null || die "This script expects Ubuntu/Debian (apt)."
if [ ! -d /run/systemd/system ]; then
  if grep -qi microsoft /proc/version 2>/dev/null; then
    die "systemd is off in this WSL Ubuntu. Run:
  printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
then in Windows PowerShell:  wsl --shutdown
reopen Ubuntu and run this script again."
  fi
  die "This script needs systemd (to keep the panel running and start it at boot)."
fi

say "1/6  System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl ca-certificates xz-utils git >/dev/null

say "2/6  Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

say "3/6  FFmpeg ${FFMPEG_VERSION} (static ${FF_ARCH} build)"
if ! ffmpeg -version 2>/dev/null | head -1 | grep -q "version n\?${FFMPEG_VERSION}"; then
  tmp="$(mktemp -d)"
  curl -fL --progress-bar "$FFMPEG_URL" -o "$tmp/ffmpeg.tar.xz"
  tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp"
  sudo install -m 755 "$tmp"/ffmpeg-*/bin/ffmpeg "$tmp"/ffmpeg-*/bin/ffprobe /usr/local/bin/
  rm -rf "$tmp"
fi
ffmpeg -version | head -1

say "4/6  cloudflared"
if ! command -v cloudflared >/dev/null; then
  tmp="$(mktemp -d)"
  curl -fL --progress-bar "$CLOUDFLARED_URL" -o "$tmp/cloudflared.deb"
  sudo dpkg -i "$tmp/cloudflared.deb" >/dev/null
  rm -rf "$tmp"
fi
cloudflared --version | head -1

say "5/6  App and settings"
cd "$DIR"
npm ci --omit=dev --no-fund --no-audit >/dev/null
mkdir -p data media
chmod 700 data

free_gb=$(df -BG --output=avail "$DIR" | tail -1 | tr -dc '0-9')
[ "$free_gb" -ge 50 ] || warn "Only ${free_gb} GB free. Did you set the boot volume to ~200 GB when creating the VM?"

if ! node -e "process.exit(require('./data/config.json').auth?.passwordHash ? 0 : 1)" 2>/dev/null; then
  echo "Choose the panel password (you'll type it into the browser)."
  node cli.js set-password
else
  echo "Panel password already set (change it later in the panel, or: npm run set-password)."
fi

ask_secret() { # $1 = prompt, $2 = config path; empty answer keeps the current value
  local value
  while true; do
    read -r -s -p "$1: " value; echo
    [ -z "$value" ] && return 0
    # Hidden input shows nothing, so people paste twice. Confirm what arrived.
    echo "  received ${#value} characters, ending ...${value: -4}"
    if printf '%s\n' "$value" | node cli.js set "$2" --stdin; then return 0; fi
    echo "  Try again (or press Enter to skip)."
  done
}
echo "Paste secrets when asked. They stay hidden while you type — paste ONCE, then press Enter."
echo "Press Enter on its own to skip one."
ask_secret "YouTube stream key (Studio > your scheduled stream > Key)" youtube.streamKey
ask_secret "Discord webhook URL (optional)" notifications.discordWebhookUrl
ask_secret "Healthchecks.io ping URL (optional)" healthcheck.url

read -r -p "Your time zone for the weekly quiet-hour restart (e.g. Asia/Kathmandu, Enter = keep $(timedatectl show -p Timezone --value)): " tz
if [ -n "$tz" ]; then sudo timedatectl set-timezone "$tz"; fi

# OBS input (off until switched on in the panel) arrives over UDP. Oracle's
# Ubuntu images reject everything but SSH in iptables, so open the port here.
# Oracle's VCN security list is a separate, manual step: see SETUP-GUIDE.md.
OBS_PORT=$(node -e "console.log(require('./data/config.json').obs?.port ?? 9710)")
if command -v iptables >/dev/null; then
  reject_at=$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
  if [ -n "$reject_at" ] && ! sudo iptables -C INPUT -p udp --dport "$OBS_PORT" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT "$reject_at" -p udp --dport "$OBS_PORT" -j ACCEPT
    if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null 2>&1; fi
    echo "Opened UDP ${OBS_PORT} for OBS in this server's firewall."
  fi
fi

say "6/6  Service"
sed -e "s#__USER__#$(id -un)#g" -e "s#__DIR__#${DIR}#g" -e "s#__NODE__#$(command -v node)#g" \
  deploy/stream-panel.service | sudo tee /etc/systemd/system/stream-panel.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now stream-panel >/dev/null
sudo systemctl restart stream-panel

say "Done."
echo "The panel URL arrives in Discord within a minute (if you set a webhook)."
echo "Or watch for it here:   journalctl -u stream-panel -f | grep 'panel URL'"
echo "Logs:                   journalctl -u stream-panel -f"
echo "Update later:           bash deploy/update.sh"
