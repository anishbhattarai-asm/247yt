#!/usr/bin/env bash
# One-time setup on the Oracle VM (Ubuntu 22.04/24.04, ARM64) — or on any
# x86_64 Ubuntu with systemd, e.g. WSL on your PC for a rehearsal. Run from
# the project folder as the normal user (not root):
#
#   bash deploy/setup.sh                 asks for the panel password and keys
#   bash deploy/setup.sh --unattended    asks nothing (the Oracle Deploy
#                                        button runs this); the password is
#                                        chosen in the browser with a setup code
#
# --unattended reads these, all optional:
#   SETUP_CODE    the one-time setup code (made up and printed if not given)
#   PANEL_TZ      the server's time zone, e.g. Europe/London
#   FINDER_PORT   stable link port, e.g. 8080 (opened in this server's firewall)
#
# Installs Node.js 24, FFmpeg 9.0 (pinned static build — the version the
# pipeline was tested on), cloudflared; installs and starts the systemd
# service and the Terminal tab's socket (the terminal stays off until it has
# its own password). Safe to re-run (it skips what's already done).

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR=24
FFMPEG_VERSION=9.0

UNATTENDED=0
for arg in "$@"; do
  case "$arg" in
    --unattended) UNATTENDED=1 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# A fresh cloud server runs its own updates at first boot; wait for apt's lock
# instead of failing. No progress bars when nobody is watching (log files).
APT=(sudo apt-get -o DPkg::Lock::Timeout=600)
if [ "$UNATTENDED" = 1 ]; then CURL_PROGRESS=-sS; else CURL_PROGRESS=--progress-bar; fi

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

# Oracle's Ubuntu images reject everything but SSH in iptables, so open what
# the panel needs here. Oracle's VCN security list is separate (the Deploy
# button sets it; by hand, see SETUP-GUIDE.md).
open_port() { # $1 = tcp|udp, $2 = port, $3 = what it is for
  command -v iptables >/dev/null || return 0
  local reject_at
  reject_at=$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
  if [ -n "$reject_at" ] && ! sudo iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT "$reject_at" -p "$1" --dport "$2" -j ACCEPT
    if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null 2>&1; fi
    echo "Opened ${1^^} $2 for $3 in this server's firewall."
  fi
}

say "1/6  System packages"
"${APT[@]}" update -qq
"${APT[@]}" install -y -qq curl ca-certificates xz-utils git python3 >/dev/null

say "2/6  Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  "${APT[@]}" install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

say "3/6  FFmpeg ${FFMPEG_VERSION} (static ${FF_ARCH} build)"
if ! ffmpeg -version 2>/dev/null | head -1 | grep -q "version n\?${FFMPEG_VERSION}"; then
  tmp="$(mktemp -d)"
  curl -fL "$CURL_PROGRESS" "$FFMPEG_URL" -o "$tmp/ffmpeg.tar.xz"
  tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp"
  sudo install -m 755 "$tmp"/ffmpeg-*/bin/ffmpeg "$tmp"/ffmpeg-*/bin/ffprobe /usr/local/bin/
  rm -rf "$tmp"
fi
ffmpeg -version | head -1

say "4/6  cloudflared"
if ! command -v cloudflared >/dev/null; then
  tmp="$(mktemp -d)"
  curl -fL "$CURL_PROGRESS" "$CLOUDFLARED_URL" -o "$tmp/cloudflared.deb"
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

if node -e "process.exit(require('./data/config.json').auth?.passwordHash ? 0 : 1)" 2>/dev/null; then
  echo "Panel password already set (change it later in the panel, or: npm run set-password)."
elif [ "$UNATTENDED" = 1 ]; then
  # Whoever opens the panel first needs this code to choose the password.
  if [ -n "${SETUP_CODE:-}" ]; then
    printf '%s\n' "$SETUP_CODE" | node cli.js setup-code --stdin
  else
    node cli.js setup-code
  fi
else
  echo "Choose the panel password (you'll type it into the browser)."
  node cli.js set-password
fi

if [ "$UNATTENDED" = 0 ]; then
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
  echo "Press Enter on its own to skip one (all of them can be set in the panel later)."
  ask_secret "YouTube stream key (Studio > your scheduled stream > Key)" youtube.streamKey
  ask_secret "Discord webhook URL (optional)" notifications.discordWebhookUrl
  ask_secret "Healthchecks.io ping URL (optional)" healthcheck.url

  read -r -p "Your time zone (e.g. Europe/London, Enter = keep $(timedatectl show -p Timezone --value)): " tz
  if [ -n "$tz" ]; then sudo timedatectl set-timezone "$tz"; fi
elif [ -n "${PANEL_TZ:-}" ]; then
  sudo timedatectl set-timezone "$PANEL_TZ" || warn "Unknown time zone ${PANEL_TZ}; set it in the panel instead."
fi

# OBS input (off until switched on in the panel) arrives over UDP.
OBS_PORT=$(node -e "console.log(require('./data/config.json').obs?.port ?? 9710)")
open_port udp "$OBS_PORT" "OBS"

# Stable link: http://<public ip>:<port> always forwards to the panel's
# current Cloudflare link (it serves nothing else). The Cloudflare link
# changes on every restart, so this is how people who don't use Discord (or
# the server's command line) find the panel. Asked once, yes by default.
FINDER=$(node -e "console.log(require('./data/config.json').finder?.port ?? 0)")
if [ -n "${FINDER_PORT:-}" ]; then
  node cli.js set finder.port "$FINDER_PORT" >/dev/null
elif [ "$UNATTENDED" = 0 ] && [ "$FINDER" = 0 ]; then
  echo "The panel's Cloudflare link changes whenever the server restarts. A link that"
  echo "never changes, http://<this server's IP>:8080, can always forward to it."
  read -r -p "Turn on that link (it only forwards visitors to the panel)? [Y/n] " yn
  case "$yn" in
    [nN]*) echo "  Off. Turn it on later with: FINDER_PORT=8080 bash deploy/setup.sh" ;;
    *) node cli.js set finder.port 8080 >/dev/null ;;
  esac
fi
FINDER=$(node -e "console.log(require('./data/config.json').finder?.port ?? 0)")
if [ "$FINDER" -gt 0 ]; then open_port tcp "$FINDER" "the panel's stable link"; fi

say "6/6  Service"
bash deploy/install-units.sh # the panel, and the Terminal tab's socket
sudo systemctl enable stream-panel >/dev/null 2>&1
sudo systemctl restart stream-panel # starts it, or restarts it with the new code (one start, one link)

say "Done."
if [ "$FINDER" -gt 0 ]; then
  ip=$(curl -fsS --max-time 5 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' || true)
  echo "Open the panel:         http://${ip:-<public IP>}:${FINDER}"
  echo "                        (the Deploy button opens TCP ${FINDER} in Oracle's firewall;"
  echo "                        installed by hand, add it to the VCN's security list)"
fi
if [ "$UNATTENDED" = 1 ]; then
  echo "First visit: enter the setup code shown above, then choose the panel password."
fi
echo "The panel URL arrives in Discord within a minute (if you set a webhook)."
echo "Or watch for it here:   journalctl -u stream-panel -f | grep 'panel URL'"
echo "Logs:                   journalctl -u stream-panel -f"
echo "Update later:           bash deploy/update.sh"
