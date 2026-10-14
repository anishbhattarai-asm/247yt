# Setup guide

From nothing to a 24/7 YouTube stream on your own free server. About an hour,
most of it waiting. You need: a computer, a phone, a Visa or Mastercard
**credit** card, and a YouTube channel.

---

## 1. Oracle Cloud account

1. Go to **oracle.com/cloud/free** and sign up.
   - Use your **home connection, no VPN or proxy** — VPNs are the most common
     reason for an instant rejection.
   - Name and address must match the card's billing details.
   - **Card:** Visa or Mastercard **credit** card with international
     transactions enabled. RuPay, PIN debit, prepaid and virtual cards are
     refused. Oracle places a temporary hold of about ₹100; it disappears in
     3–5 days. You are not charged.
   - **Home region is permanent** and the free server only works there. Pick
     **Hyderabad** (Mumbai is closest but usually out of free servers). Distance
     barely matters — the stream goes from the server to YouTube, not to you.
   - If you're rejected, use Oracle's support form. Don't make more accounts.
2. Once the account works, upgrade it: **Billing → Upgrade to Pay As You Go**.
   - This stays **free** as long as you only create what this guide says.
   - It stops Oracle from switching off your server for "looking idle" (this
     stream would look idle — it uses very little CPU), and makes free servers
     easier to get.
   - Approval can take a few days. You can do steps 2–3 meanwhile.
3. Right after upgrading: **Billing → Budgets → Create budget**, amount **$1**,
   alert at 100%, your email. If anything ever costs money, you hear at once.
   (Budgets alert; they don't block spending.)

## 2. The server

**Compute → Instances → Create instance**

| Setting | Value |
|---|---|
| Image | **Canonical Ubuntu 24.04** (the aarch64 one) |
| Shape | **Ampere → VM.Standard.A1.Flex**, **2 OCPU, 12 GB** memory |
| SSH keys | **Generate a key pair for me → Save private key** (keep this file safe) |
| Boot volume | **Specify a custom boot volume size: 200 GB** |

Click **Create**. Don't add anything else (no extra volumes, no load balancers)
— everything above is inside the free limits; extra things may not be.

**"Out of host capacity"** is normal for free servers. Nothing was created, so
just press Create again. Indian regions have only one "availability domain", so
there's nothing to switch — keep retrying (every few minutes), or wait for the
Pay As You Go upgrade, which usually fixes it.

When it says **Running**, copy its **Public IP address**.

## 3. Connect to it

On Windows, open **PowerShell**:

```powershell
ssh -i "C:\path\to\ssh-key.key" ubuntu@YOUR_SERVER_IP
```

Type `yes` the first time. You're in when the prompt says `ubuntu@...`.

If Windows complains the key is "too open": right-click the key file →
Properties → Security → Advanced → Disable inheritance → remove everyone except
yourself.

## 4. Install the panel

Still in that SSH window:

```bash
git clone <your copy of this project's repository> stream-panel
cd stream-panel
bash deploy/setup.sh
```

(No repository yet? From your PC: `scp -i key -r 247liveYT ubuntu@IP:stream-panel`.)

The script installs everything, then asks for:
- a **panel password** — you'll type it in the browser;
- your **YouTube stream key** — see step 5 (you can paste it later in the
  panel's settings instead);
- optional **Discord webhook** and **Healthchecks** URLs — see step 6;
- your **time zone**, e.g. `Asia/Kathmandu` (for the weekly restart at 4 am).

Nothing needs to be opened in Oracle's firewall for the panel: it is reached
through a Cloudflare tunnel that connects *outwards*. (Going live from OBS
needs one port opened, see step 8.)

## 5. YouTube

New channels must enable live streaming first (phone verification, then up to
24 hours' wait): **studio.youtube.com → Create → Go live**.

Then make a **scheduled** stream — this is what lets the stream survive network
drops of several minutes on the same link:

1. Live Control Room → left sidebar **calendar icon (Manage)** → **Schedule stream**.
2. Title, visibility (Unlisted while testing). Under **"How do you want to go
   live?"** choose **Streaming software** — not Webcam.
3. Open it from **Manage**. On the preview: **Key ⌄ → Create new stream key** →
   copy it with the copy button. That's the stream key for the panel.
4. **Stream settings → Additional settings: Enable Auto-start ON, Enable
   Auto-stop OFF.**

Two things to avoid:
- **Don't open the "Stream" tab** of the Live Control Room. It creates a
  separate "go live now" broadcast that grabs your key, and your stream lands
  there instead (it ends after about a minute offline).
- With Auto-stop OFF, YouTube never ends the broadcast on its own. When you
  stop for good, also click **End Stream** in Studio.

Keep the stream key secret — anyone with it can stream to your channel. If it
leaks: Studio → Key → reset.

### 5b. Connect YouTube (optional, recommended)

With this, the panel creates the broadcast itself (right settings, key saved),
shows **YouTube's own stream health** (the Excellent/Poor that Studio shows)
in the panel and in Discord, and starts a new broadcast if YouTube ever ends
one. You sign in with the channel's normal Google account. Google only lets
*registered* apps ask for that, so the panel needs its own free registration
first (about 10 minutes, no card):

1. **console.cloud.google.com**, signed in to the channel's Google account. If
   asked, pick your country and accept the terms. Project dropdown (top left)
   → **New project** → `stream-panel` → **Create**, then select it.
2. Search bar → **YouTube Data API v3** → **Enable**.
3. Search bar → **Google Auth Platform** → **Get started**: app name
   `Stream Panel`, your email; Audience **External**; contact email; agree →
   **Create**.
4. **Branding**: add an app home page and privacy-policy link (this
   repository and its `PRIVACY.md` work) and add their domain (e.g.
   `github.com`) under **Authorized domains** → **Save**. Publishing stays
   greyed out until this is done.
5. **Audience** → Publishing status "Testing" → **Publish app** → Confirm.
   (Left in Testing, Google signs the panel out every 7 days.)
6. **Clients** → **Create client** → type **TVs and Limited Input devices** →
   name `stream-panel` → **Create**. Copy the **Client ID** and **Client
   secret** at once (newer consoles show the secret only once).
7. Panel → Settings → **YouTube account** → paste both → Save →
   **Connect YouTube**. It shows a short code: open **google.com/device** on
   any phone or computer, enter it, choose the channel's account. Google says
   the app isn't verified: it's your own app, so **Advanced → Go to Stream
   Panel → Continue**.

The panel then shows the channel, YouTube's health and the broadcast. If no
broadcast uses your key, **Create broadcast** makes one (Auto-start ON,
Auto-stop OFF) and starts it: YouTube only auto-starts a broadcast when the
stream *begins*, so the panel pauses its stream for about 10 seconds to let
YouTube start it (nobody is watching yet at that point). If Auto-stop is on,
**Turn it off** fixes it. Uses about 3% of the free daily API quota.

If Google asks you to "Verify it's you" while connecting, it sends a code to
a phone on your account; keep that phone at hand.

## 6. Alerts (optional, recommended)

**Discord** — you get a message when the stream starts, drops, comes back,
freezes, skips a broken file, or the panel's link changes:
Discord server → channel settings → **Integrations → Webhooks → New Webhook →
Copy Webhook URL**. Paste it into setup or the panel. Treat it like a password.

**Healthchecks.io** — catches the one thing the server can't report itself:
being completely dead (power, network, Oracle stopped it).
1. Sign up free at healthchecks.io → **Add Check** → period **5 minutes**,
   grace **10 minutes** → copy its ping URL into setup or the panel.
2. In Healthchecks: **Integrations → Discord** to get its alerts in the same channel.

## 7. Use it

- The panel's link arrives in Discord (or run
  `journalctl -u stream-panel | grep 'panel URL'` on the server). It changes
  when the server restarts — Discord always gets the new one.
- Sign in, set the stream key if you skipped it, add media, press **Start**.
- **Adding media:** paste a **link** (Google Drive "Anyone with the link",
  Dropbox, or any direct download) — the server downloads it itself, much faster
  than uploading from home. Uploading from your computer works too.
- Every file is converted once to the stream format; long videos take a while.
  For instant adds, export videos as **1920×1080, 30 fps, H.264 High 4.1,
  constant bitrate 3000 kbps or more, keyframe every 2 s (60 frames), AAC
  44.1 kHz stereo** — those are copied, not converted.
- **Keep your original files** somewhere else (Drive). The server keeps only
  the converted copy.
- **Lofi mode:** add one image or GIF as the background and some audio tracks,
  choose Lofi mode in settings, pick the background.

## 8. Going live from OBS (optional)

OBS can stream **into the panel** instead of straight to YouTube. When OBS
starts streaming, it takes over the broadcast within a few seconds; when OBS
stops, the playlist carries on exactly where it was cut. Viewers see one
continuous stream, and nobody else needs your YouTube stream key. (Two
encoders on one key fight over it; this way only the panel talks to YouTube.)

**Once, on Oracle:** open the port for OBS.
Networking → Virtual cloud networks → your VCN → **Security Lists** → Default
Security List → **Add Ingress Rules**: Source CIDR `0.0.0.0/0`, IP Protocol
**UDP**, Destination Port Range **9710**. (`setup.sh` already opened it in the
server's own firewall.)

**In the panel:** Settings → **OBS live input** → switch it on → Save. Copy the
**Server for OBS** address (`srt://...`). It contains a password: only give it
to people who may go live on the channel. **New password** locks the old
address out.

**In OBS** (the person going live):

| OBS setting | Value |
|---|---|
| Settings → Stream → Service | **Custom...** |
| Server | the `srt://...` address from the panel |
| Stream Key | leave empty |
| Video → Output (Scaled) Resolution | **1920x1080** (the stream's format) |
| Video → Common FPS Values | **30** |
| Output → Output Mode | **Advanced** → Streaming tab |
| Encoder | **x264** (or NVENC / QuickSync / AMF **H.264**) |
| Rate Control / Bitrate | **CBR**, **3000 Kbps** (up to 6000 is fine) |
| Keyframe Interval | **2 s** |

Audio can stay as it is; the panel converts it. Then press **Start Streaming**
in OBS as usual. The panel's Overview says **Live from OBS**, Discord says
**OBS is live**, and later **Back to the playlist**.

- The panel's stream must be **started** (Start in the panel). If it is
  stopped, OBS is refused and Discord says why.
- Wrong resolution or frame rate: OBS is refused, and the panel and Discord say
  exactly which OBS setting to change. (The video is passed through as-is to
  keep the server's CPU free, so it has to match.)
- **Skip** is disabled while OBS is live; stop streaming in OBS to return.

## Troubleshooting

| Problem | Do this |
|---|---|
| Can't open the panel | Get the newest link from Discord / `journalctl -u stream-panel \| grep 'panel URL'` |
| Forgot the password | On the server: `cd stream-panel && npm run set-password` |
| Stream won't start | Panel status shows why (no stream key, nothing ready to play, …) |
| See what's happening | `journalctl -u stream-panel -f` |
| Restart everything | `sudo systemctl restart stream-panel` (the stream resumes where it was) |
| Update to a new version | `bash deploy/update.sh` |
| Oracle stopped the server | Console → Instances → **Start**. Everything comes back by itself. (Pay As You Go prevents this.) |
| OBS can't connect ("Failed to connect") | Port 9710 UDP open in the security list (step 8)? OBS input switched on? Address copied after the last **New password**? |
| OBS connects but is refused | Discord / the panel say which OBS setting to change |
