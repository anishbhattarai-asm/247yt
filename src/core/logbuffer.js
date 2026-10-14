// In-memory log ring buffer for the panel's log view (polled, not SSE —
// SSE doesn't work through Cloudflare quick tunnels). Server logs also go to
// stdout, which journald keeps on the VM. Secrets are masked on the way in.

export class LogBuffer {
  constructor({ size = 500, redact = (s) => s, echo = true } = {}) {
    this.size = size;
    this.redact = redact;
    this.echo = echo;
    this.lines = [];
    this.seq = 0;
  }

  push(source, text) {
    const line = { seq: ++this.seq, t: Date.now(), source, text: this.redact(String(text)).slice(0, 1000) };
    this.lines.push(line);
    if (this.lines.length > this.size) this.lines.shift();
    if (this.echo) console.log(`[${new Date(line.t).toISOString()}] ${source}: ${line.text}`);
    return line;
  }

  // Lines after `seq` (0 = everything kept).
  since(seq = 0) {
    return { seq: this.seq, lines: this.lines.filter((l) => l.seq > seq) };
  }

  // A logger bound to one source, e.g. log('pipeline')('feed x').
  for(source) {
    return (text) => this.push(source, text);
  }
}

// Masks every non-empty secret in a string.
export function makeRedactor(getSecrets) {
  return (s) => {
    let out = String(s);
    for (const secret of getSecrets()) {
      if (secret && secret.length >= 4) out = out.split(secret).join('***');
    }
    return out;
  };
}
