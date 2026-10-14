// Terminal tab: browser <-> panel (WebSocket) <-> terminal socket <->
// deploy/terminal-session.py, a login shell that systemd runs outside the
// panel's sandbox (stream-panel-terminal.socket / @.service).
//
// The panel only relays bytes, and only for someone who just typed the
// terminal password: that buys a one-time ticket, valid for a minute, which
// the browser hands over on the WebSocket. Sessions close after
// terminal.idleMinutes without input, and when the tab closes.

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import net from 'node:net';

export const SOCKET = '/run/stream-panel-terminal/terminal.sock';
const TICKET_MS = 60_000;

// Frames to and from terminal-session.py: type byte, uint32 length, payload.
export function frame(kind, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.write(kind, 0, 'latin1');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  // Every complete frame in what has arrived so far: [[kind, payload], ...].
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      out.push([this.buf.toString('latin1', 0, 1), this.buf.subarray(5, 5 + len)]);
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

export class Terminal extends EventEmitter {
  constructor({ getConfig, socketPath = SOCKET, maxSessions = 3, log = () => {} }) {
    super();
    this.getConfig = getConfig;
    this.socketPath = socketPath;
    this.maxSessions = maxSessions;
    this.log = log;
    this.tickets = new Map(); // ticket -> expiry
    this.sessions = new Set();
    this.watcher = null;
    this.idleMs = null; // tests: a short idle timeout instead of terminal.idleMinutes
  }

  enabled() {
    return Boolean(this.getConfig().auth.terminalHash);
  }

  // Installed by install-units.sh (systemd creates the socket).
  available() {
    if (process.platform === 'win32') return true; // tests use a named pipe
    try {
      return statSync(this.socketPath).isSocket();
    } catch {
      return false;
    }
  }

  status() {
    return {
      enabled: this.enabled(),
      available: this.available(),
      sessions: this.sessions.size,
      idleMinutes: this.getConfig().terminal.idleMinutes,
    };
  }

  issueTicket() {
    const now = Date.now();
    for (const [t, exp] of this.tickets) if (exp < now) this.tickets.delete(t);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, now + TICKET_MS);
    return ticket;
  }

  // One use only.
  takeTicket(ticket) {
    const exp = typeof ticket === 'string' ? this.tickets.get(ticket) : undefined;
    if (exp === undefined) return false;
    this.tickets.delete(ticket);
    return exp > Date.now();
  }

  // A shell session. Emits 'data' (Buffer), 'exit' (code), 'close'.
  open({ ip, idleMs = this.idleMs ?? this.getConfig().terminal.idleMinutes * 60_000 } = {}) {
    if (this.sessions.size >= this.maxSessions) {
      throw Object.assign(new Error(`At most ${this.maxSessions} terminals at once`), { status: 429 });
    }
    const session = new EventEmitter();
    const sock = net.connect(this.socketPath);
    const reader = new FrameReader();
    let idle = null;
    let closed = false;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        session.emit('idle');
        session.close();
      }, idleMs);
      idle.unref?.();
    };
    session.write = (data) => {
      if (closed) return;
      touch();
      sock.write(frame('d', data));
    };
    session.resize = (cols, rows) => {
      if (closed || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
      const p = Buffer.alloc(4);
      p.writeUInt16BE(Math.min(Math.max(cols, 10), 1000), 0);
      p.writeUInt16BE(Math.min(Math.max(rows, 3), 500), 2);
      sock.write(frame('r', p));
    };
    session.paused = false;
    session.pause = () => {
      session.paused = true;
      sock.pause();
    };
    session.resume = () => {
      session.paused = false;
      sock.resume();
    };
    session.close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      sock.end();
      sock.destroy();
    };
    sock.on('data', (chunk) => {
      for (const [kind, payload] of reader.push(chunk)) {
        if (kind === 'd') session.emit('data', payload);
        else if (kind === 'x') session.emit('exit', payload.readInt32BE(0));
      }
    });
    sock.on('error', (err) => {
      session.emit('error', err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
        ? new Error('The terminal service is not installed on this server (run: bash deploy/update.sh)')
        : err);
    });
    sock.on('close', () => {
      closed = true;
      clearTimeout(idle);
      this.sessions.delete(session);
      this.log(`session closed (${ip ?? 'unknown'})`);
      session.emit('close');
    });
    this.sessions.add(session);
    this.#watch();
    touch();
    this.log(`session opened from ${ip ?? 'unknown'}`);
    this.emit('opened', { ip });
    return session;
  }

  // Turned off from the command line (or the password removed): end every
  // open session within a few seconds.
  #watch() {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      if (!this.enabled() && this.sessions.size) {
        this.log('terminal turned off: closing open sessions');
        this.closeAll();
      }
      if (!this.sessions.size) {
        clearInterval(this.watcher);
        this.watcher = null;
      }
    }, 3000);
    this.watcher.unref?.();
  }

  closeAll() {
    for (const s of this.sessions) s.close();
  }
}
