// Discord notifications.
//
// Style (owner's preference): no emoji. One coloured embed per event with a
// status icon attached as a PNG (Discord can't show SVG; attaching means
// nothing to host), Discord markdown values — `code`, <t:unix:R> timestamps
// that every viewer sees in their own timezone — and inline fields.
//
// The webhook URL is a secret: config/env only, redacted from every message.
// Alerts are queued and sent one at a time, honouring 429 retry-after.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// kind -> embed colour (icons: assets/icons/<kind>.png, rendered from the SVGs)
export const KINDS = {
  start: { color: 0x5865f2 },
  dropped: { color: 0xed4245 },
  online: { color: 0x3ba55c },
  frozen: { color: 0x3b9edb },
  skipped: { color: 0xe8a317 },
  failing: { color: 0xed4245 },
  stopped: { color: 0x747f8d },
  link: { color: 0x5865f2 },
  warning: { color: 0xe8a317 },
};

const ICON_DIR = fileURLToPath(new URL('../../assets/icons/', import.meta.url));

export const when = (ms = Date.now(), style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
export const mono = (s) => `\`${String(s).replace(/`/g, "'")}\``;
const errorField = (error) => (error
  ? [{ name: 'FFmpeg said', value: `\`\`\`${String(error).replace(/`/g, "'").slice(0, 900)}\`\`\``, inline: false }]
  : []);
const human = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

// Network failures are retried: alerts matter most when the network is flaky
// (an outage alert sent the moment a laptop wakes, before Wi-Fi is back, was
// lost in testing). ~9 minutes in total; HTTP 4xx errors are not retried.
const RETRY_DELAYS = [5, 15, 30, 60, 120, 300];

export class Notifier {
  constructor({ getConfig, redact = (s) => s, source = 'stream-panel', log = () => {}, retryDelays = RETRY_DELAYS }) {
    this.getConfig = getConfig;
    this.redact = redact;
    this.source = source;
    this.log = log;
    this.retryDelays = retryDelays;
    this.queue = Promise.resolve();
    this.icons = new Map();
    this.stats = { sent: 0, failed: 0, lastError: null };
  }

  // event templates

  started({ dest }) {
    this.#send('start', 'start', { title: 'Stream started', fields: [{ name: 'Destination', value: mono(dest) }, { name: 'Started', value: when() }] });
  }

  stopped({ reason }) {
    this.#send('stopped', 'stopped', { title: 'Stream stopped', fields: [{ name: 'Reason', value: mono(reason) }, { name: 'At', value: when(Date.now(), 'T') }] });
  }

  dropped({ reason, error, retryIn }) {
    this.#send('dropped', 'dropped', {
      title: 'Stream dropped',
      description: `Lost the connection to YouTube ${when()}. Reconnecting automatically — you'll get "Back online" when it's live again.`,
      fields: [
        { name: 'Reason', value: mono(reason) },
        { name: 'First retry', value: mono(`in ${Math.round(retryIn)} s`) },
        ...errorField(error),
      ],
    });
  }

  // The stream never got on air this run (bad key, key in use, no network).
  cantConnect({ error, hint, retryIn }) {
    this.#send('dropped', 'dropped', {
      title: "Can't connect to YouTube",
      description: hint ?? 'YouTube did not accept the stream.',
      fields: [{ name: 'Retrying', value: mono(`in ${Math.round(retryIn)} s, then less often`) }, ...errorField(error)],
    });
  }

  online({ downtime, downSince }) {
    this.#send('online', 'online', {
      title: 'Back online',
      description: `Stream is live again after **${human(downtime)}** off-air.`,
      fields: [{ name: 'Down since', value: when(downSince, 'T') }, { name: 'Downtime', value: mono(human(downtime)) }],
    });
  }

  frozen({ idle, title, paused }) {
    if (paused) {
      // The whole machine stopped (laptop sleep, VM paused by the host), not FFmpeg.
      this.#send('frozen', 'frozen', {
        title: 'Server was paused',
        description: `The server itself was asleep or paused for **${human(paused)}** (laptop sleep, or the cloud host pausing the VM). Reconnecting now.`,
        fields: [{ name: 'Was playing', value: mono(title ?? 'nothing') }],
      });
      return;
    }
    this.#send('frozen', 'frozen', {
      title: 'Stream frozen',
      description: `No output for **${Math.round(idle)} s**. Restarting the stream.`,
      fields: [{ name: 'Was playing', value: mono(title ?? 'nothing') }],
    });
  }

  failing({ attempts, retryIn, error, hint }) {
    this.#send('failing', 'failing', {
      title: 'Repeated failures',
      description: `${attempts} failed connections in a row. ${hint ?? 'Check the stream key and the network.'}`,
      fields: [{ name: 'Next retry', value: mono(`in ${Math.round(retryIn)} s`) }, ...errorField(error)],
    });
  }

  skipped({ title, error }) {
    this.#send('skipped', 'skipped', {
      title: 'File skipped',
      description: `${mono(title)} failed twice and was taken out of the playlist.`,
      fields: [{ name: 'Last error', value: `\`\`\`${String(error).replace(/`/g, "'").slice(0, 900) || 'none'}\`\`\``, inline: false }],
    });
  }

  panelUrl({ url }) {
    this.#send('panelUrl', 'link', { title: 'Panel is live', description: `Open the panel: ${url}`, fields: [{ name: 'Since', value: when() }] });
  }

  lowDisk({ freeGB, minGB }) {
    this.#send('lowDisk', 'warning', {
      title: 'Low disk space',
      description: `Only **${freeGB.toFixed(1)} GB** free. New imports are refused below ${minGB.toFixed(0)} GB.`,
    });
  }

  highCpu({ percent, minutes }) {
    this.#send('highCpu', 'warning', {
      title: 'Sustained high CPU',
      description: `CPU has been at **${Math.round(percent)}%** for ${minutes} min. Streaming itself uses almost none — check for long encodes.`,
    });
  }

  obsLive({ info }) {
    this.#send('obs', 'start', {
      title: 'OBS is live',
      description: 'OBS took over the stream. When OBS stops, the playlist carries on where it left off.',
      fields: [
        { name: 'Video', value: mono(`${info.width}x${info.height} ${info.fps} fps`) },
        { name: 'Since', value: when() },
      ],
    });
  }

  obsEnded({ reason, seconds }) {
    this.#send('obs', 'online', {
      title: 'Back to the playlist',
      description: `OBS was live for **${human(seconds)}**.`,
      fields: [{ name: 'Why', value: mono(reason) }],
    });
  }

  // OBS retries every few seconds after a refusal: one alert per reason per 10 min.
  obsRejected({ reason }) {
    this.refusals ??= new Map();
    const last = this.refusals.get(reason);
    if (last && Date.now() - last < 600_000) return;
    this.refusals.set(reason, Date.now());
    this.#send('obs', 'warning', { title: 'OBS was refused', description: reason });
  }

  // Wrong passwords keep coming (LoginLimiter): someone may be guessing.
  guessing({ what, tries, addresses, minutes }) {
    this.#send('guessing', 'warning', {
      title: 'Someone may be guessing a password',
      description: `${tries} wrong tries at ${what} in the last ${minutes} minutes, from ${addresses} ${addresses === 1 ? 'address' : 'addresses'}. Each address is locked out after 5 wrong tries. If this keeps happening, make sure the password is long and not used anywhere else.`,
      fields: [{ name: 'At', value: when() }],
    });
  }

  // Terminal tab: it gives full control of the server, so every session
  // and every password change is reported.
  terminalOpened({ ip }) {
    this.#send('terminal', 'warning', {
      title: 'Terminal opened',
      description: 'Someone typed the terminal password and opened a command line on the server. If it was not you, change the terminal password and the panel password now.',
      fields: [{ name: 'From', value: mono(ip ?? 'unknown') }, { name: 'At', value: when() }],
    });
  }

  terminalPassword({ ip, change }) {
    const what = { set: 'Terminal password set: the Terminal tab is on', changed: 'Terminal password changed', off: 'Terminal turned off' }[change];
    this.#send('terminal', 'warning', {
      title: what ?? 'Terminal password changed',
      description: change === 'set' ? 'The panel\'s Terminal tab now opens a command line on the server for anyone with this password. If it was not you, turn it off from the server: node cli.js terminal-off' : '',
      fields: [{ name: 'From', value: mono(ip ?? 'unknown') }, { name: 'At', value: when() }],
    });
  }

  // Multistream destinations (Twitch, Kick, ...): one alert per outage.
  restreamDown({ name, error }) {
    this.#send('restream', 'dropped', {
      title: `${name}: stream dropped`,
      description: `The panel lost the connection to ${name} and is reconnecting. YouTube and the other platforms are not affected.`,
      fields: error ? [{ name: 'FFmpeg said', value: `\`\`\`${String(error).replace(/`/g, "'").slice(0, 900)}\`\`\``, inline: false }] : [],
    });
  }

  restreamUp({ name, downtime }) {
    this.#send('restream', 'online', {
      title: `${name}: back online`,
      description: `Streaming to ${name} again after **${human(downtime)}**.`,
    });
  }

  // YouTube's own health verdict (needs Connect YouTube).
  ytHealth({ status, previous, issues = [] }) {
    const label = { good: 'Excellent', ok: 'OK', bad: 'Poor', noData: 'No data' }[status] ?? status;
    const list = issues.slice(0, 3).map((i) => `**${i.reason ?? i.type}**: ${i.description ?? ''}`.trim()).join('\n');
    if (previous === 'bad') {
      this.#send('youtube', 'online', { title: `YouTube stream health: ${label}`, description: 'Back to normal.' });
      return;
    }
    this.#send('youtube', 'warning', {
      title: 'YouTube stream health: Poor',
      description: list || 'YouTube rates the stream Poor. Viewers may see buffering.',
    });
  }

  ytBroadcastEnded({ title, replacement, error }) {
    this.#send('youtube', 'dropped', {
      title: 'YouTube ended the broadcast',
      description: replacement
        ? `${mono(title)} ended. A new broadcast is running on the same stream key: ${replacement.watchUrl}`
        : `${mono(title)} ended. ${error ? `A new one could not be created: ${error}` : 'Create a new one in the panel (Settings > YouTube account).'}`,
    });
  }

  ytAuthLost({ error }) {
    this.#send('youtube', 'warning', {
      title: 'YouTube connection lost',
      description: `The panel's sign-in to YouTube stopped working (${error}). Streaming is not affected. Connect again in Settings > YouTube account.`,
    });
  }

  test() {
    this.#send(null, 'start', { title: 'Test notification', description: 'Discord alerts are working.' });
  }

  flush() {
    return this.queue;
  }

  // transport

  #send(event, kind, { title, description = '', fields = [] }) {
    const cfg = this.getConfig().notifications;
    if (!cfg.discordWebhookUrl) return;
    if (event && cfg.events[event] === false) return;
    const r = this.redact;
    const embed = {
      author: { name: r(this.source) },
      title: r(title).slice(0, 256),
      description: r(description).slice(0, 4000),
      color: (KINDS[kind] ?? KINDS.start).color,
      fields: fields.slice(0, 25).map((f) => ({ name: r(f.name).slice(0, 256), value: r(f.value).slice(0, 1024), inline: f.inline ?? true })),
      timestamp: new Date().toISOString(),
    };
    const url = cfg.discordWebhookUrl;
    this.queue = this.queue
      .then(() => this.#post(url, embed, kind))
      .then(() => this.stats.sent++)
      .catch((err) => {
        this.stats.failed++;
        this.stats.lastError = r(err.message);
        this.log(`discord: ${this.stats.lastError}`);
      });
  }

  #icon(kind) {
    if (!this.icons.has(kind)) {
      const p = `${ICON_DIR}${kind}.png`;
      this.icons.set(kind, existsSync(p) ? readFileSync(p) : null);
    }
    return this.icons.get(kind);
  }

  async #post(url, embed, kind) {
    for (let i = 0; ; i++) {
      try {
        return await this.#postOnce(url, embed, kind);
      } catch (err) {
        const network = !err.httpStatus; // fetch threw: DNS, timeout, connection reset
        if (!network || i >= this.retryDelays.length) throw err;
        this.log(`discord: ${this.redact(err.message)} — retrying in ${this.retryDelays[i]} s`);
        await new Promise((r) => setTimeout(r, this.retryDelays[i] * 1000));
      }
    }
  }

  async #postOnce(url, embed, kind) {
    const png = this.#icon(kind);
    for (let attempt = 0; attempt < 3; attempt++) {
      let init;
      if (png) {
        const name = `${kind}.png`;
        const form = new FormData();
        form.append('payload_json', JSON.stringify({
          embeds: [{ ...embed, thumbnail: { url: `attachment://${name}` } }],
          attachments: [{ id: 0, filename: name }],
        }));
        form.append('files[0]', new Blob([png], { type: 'image/png' }), name);
        init = { method: 'POST', body: form };
      } else {
        init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ embeds: [embed] }) };
      }
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      if (res.ok) return;
      if (res.status !== 429) {
        throw Object.assign(new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`), { httpStatus: res.status });
      }
      const wait = Number(res.headers.get('retry-after')) || 1;
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
    throw Object.assign(new Error('Discord rate limit: gave up after 3 tries'), { httpStatus: 429 });
  }
}
