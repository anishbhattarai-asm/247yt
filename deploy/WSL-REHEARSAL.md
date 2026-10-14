# Rehearsal: a "fake Oracle server" on your PC

Before you have an Oracle account, run the real deployment on Ubuntu inside
Windows (WSL). It's the same Linux, the same `setup.sh`, the same systemd
service and Cloudflare tunnel as on Oracle. The only difference: your PC is
x86, Oracle's free servers are ARM — and ARM was already tested separately.

## Easiest: one command from PowerShell

Stop the Windows copy first (**Ctrl+C** where `npm start` runs — two copies
fight over the stream key), then in **PowerShell**:

```powershell
powershell -ExecutionPolicy Bypass -File <project folder>\deploy\wsl-rehearsal.ps1
```

It installs Ubuntu if needed (create a Linux username + password when asked,
then type `exit` at the `you@PC:~$` prompt to continue), turns on systemd,
copies the project in, runs `setup.sh`, and leaves an Ubuntu window open.
Run it again any time to update the code in Ubuntu (data is kept).
Then skip to **4** below.

## By hand

**Which terminal?** PowerShell's prompt looks like `PS C:\Users\you>`.
Ubuntu's looks like `you@PC:~$`. Step 1 is PowerShell; steps 2–3 are Ubuntu —
Linux commands typed into PowerShell fail (or worse, run on Windows files).

### 0. Stop the Windows copy

Press **Ctrl+C** in the terminal running `npm start`. Two copies streaming with
the same stream key fight over it.

### 1. Install Ubuntu (once)

In **PowerShell**:

```powershell
wsl --install -d Ubuntu-24.04
```

It downloads Ubuntu and asks you to create a Linux **username** and
**password**. Remember the password — Linux asks for it whenever a command
starts with `sudo`.

You're now in Ubuntu (the prompt looks like `you@PC:~$`). Later you can open it
from the Start menu ("Ubuntu 24.04") or by typing `wsl -d Ubuntu-24.04`.

### 2. Check systemd is on (Ubuntu)

```bash
systemctl is-system-running
```

`running` or `degraded` = fine. Anything else (an error, `offline`):

```bash
printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
```

then in PowerShell `wsl --shutdown`, and open Ubuntu again.

### 3. Copy the project in and run setup (Ubuntu)

```bash
mkdir -p ~/stream-panel
cd /mnt/c/<path to the project folder>   # e.g. /mnt/c/Users/you/stream-panel
tar --exclude=node_modules --exclude=data --exclude=media --exclude=spike -cf - . | tar -xf - -C ~/stream-panel
cd ~/stream-panel
bash deploy/setup.sh
```

It installs everything, then asks for: a panel password, your YouTube stream
key, the Discord webhook, Healthchecks (press Enter to skip), and your time
zone (`Asia/Kathmandu`).

## 4. Use it like the real thing

- Discord gets **"Panel is live"** with a new `trycloudflare.com` link. Open it
  **on your phone** — that's real HTTPS through Cloudflare, exactly as on Oracle.
- Add media (a link, or upload), press **Start**.

## 5. Try the self-healing

| Test | Command (in Ubuntu) | What should happen |
|---|---|---|
| Service restart | `sudo systemctl restart stream-panel` | Stream comes back within seconds, same YouTube broadcast |
| Crash | `sudo pkill -9 -f "node .*server.js"` | systemd restarts it after 5 s; stream resumes |
| Reboot | In PowerShell: `wsl --shutdown`, then reopen Ubuntu | Service starts by itself, stream resumes, Discord gets the new panel link |
| Network drop | Turn Wi-Fi off for 30 s, then on | Discord: "Stream dropped", then "Back online" |

Handy commands:

```bash
systemctl status stream-panel        # is it running?
journalctl -u stream-panel -f        # live logs (Ctrl+C to leave)
```

## 5b. Try OBS through the panel

1. In Ubuntu: `hostname -I` and note the first address (e.g. `192.168.245.223`).
2. Panel → Settings → **OBS live input** → switch on → Advanced → **Server
   address** = that address → Save. Copy the **Server for OBS** (`srt://...`).
3. OBS on this PC: Settings → Stream → Service **Custom...** → Server = the
   copied address, Stream Key empty. Video: 1920x1080, 30 FPS. Output
   (Advanced): x264, CBR 3000, Keyframe Interval 2.
4. **Start Streaming** in OBS (the panel's stream must be started). Within a few
   seconds the panel says **Live from OBS** and YouTube shows your OBS scene.
   **Stop Streaming** and the playlist carries on where it was cut.

On Oracle the address is detected automatically; only the security-list rule
(SETUP-GUIDE step 8) is needed.

**WSL caveats** (a real server has neither):
- WSL shuts Ubuntu down a little after you close its last window. Keep one
  Ubuntu window open while testing.
- **Laptop sleep freezes everything**, the panel included. On wake it
  reconnects by itself within seconds and Discord says "Server was paused".
  For an overnight test, set Windows to never sleep while plugged in
  (Settings > System > Power).
- The disk shown in the panel is WSL's virtual disk (it claims ~1 TB); the
  real limit is your C: drive's free space. Memory shows WSL's share of RAM.

## 6. When Oracle is ready

Same steps from **3** on the real server — see [SETUP-GUIDE.md](SETUP-GUIDE.md).
To remove the rehearsal afterwards: `wsl --unregister Ubuntu-24.04` in
PowerShell (deletes that Ubuntu and everything in it).
