// MPEG-TS joiner: sits between feeder stdout and pusher stdin.
//
// Node forwards each feeder's output into one long-running pusher. Doing the
// join here (instead of a blind pipe) lets us:
//   1. forward only whole 188-byte packets, so a killed feeder never leaves a
//      torn packet in the pusher's input;
//   2. rewrite continuity counters so the joined stream has no CC breaks
//      (otherwise the pusher flags the first packet after every join corrupt);
//   3. read PES timestamps, so the next feeder's -output_ts_offset is computed
//      from what was ACTUALLY sent, which stays exact after a mid-file skip;
//   4. cut a skipped file cleanly: stop video at a frame start, then let audio
//      (which trails video by up to ~0.5 s in the mux) catch up before stopping,
//      so neither stream is left with a gap at the join. One audio PES can hold
//      ~0.3 s of quiet audio, so a PES's start PTS says nothing about where it
//      ends — but the PES we stop AT starts exactly where the sent audio ends;
//   5. hold packets past a time limit (pacing). Per-chunk pacing isn't enough:
//      at lofi bitrates one 64 KB pipe read holds several seconds of media.

export const PACKET = 188;
export const CLOCK = 90000; // PTS/DTS ticks per second
const SYNC = 0x47;
const WRAP = 2 ** 33; // PTS/DTS are 33-bit, so they wrap every ~26.5 h
const HALF = 2 ** 32;

const FORWARD = 0;
const DROP = 1;
const CUT = 2;
const HOLD = 3;
const EMPTY = Buffer.alloc(0);

function readTimestamp(b, o) {
  return ((b[o] >> 1) & 0x07) * 0x40000000 +
    b[o + 1] * 0x400000 +
    (b[o + 2] >> 1) * 0x8000 +
    b[o + 3] * 0x80 +
    (b[o + 4] >> 1);
}

// Turns raw 33-bit timestamps into a continuous number across a wrap.
class Unwrapper {
  constructor() {
    this.base = 0;
    this.ref = null;
  }

  unwrap(raw) {
    if (this.ref === null) {
      this.ref = raw;
      return raw;
    }
    let v = raw + this.base;
    if (v < this.ref - HALF) {
      this.base += WRAP;
      v += WRAP;
    } else if (v > this.ref + HALF) {
      v -= WRAP; // reordered packet from just before a wrap
    }
    if (v > this.ref) this.ref = v;
    return v;
  }
}

export class TsJoiner {
  constructor() {
    this.cc = new Map(); // pid -> last continuity counter written to the pusher
    this.kinds = new Map(); // pid -> 'video' | 'audio'
    this.resyncs = 0;
    this.tornBytesDropped = 0;
    this.beginSegment();
  }

  // Call before piping a new feeder.
  beginSegment() {
    if (this.remainder?.length) this.tornBytesDropped += this.remainder.length;
    this.remainder = null;
    this.unwrapper = new Unwrapper();
    this.firstDts = null; // earliest DTS forwarded in this segment (ticks)
    this.lastPts = null; // latest PTS forwarded, any stream
    this.lastVideoPts = null;
    this.lastAudioPts = null;
    this.audioEnd = null; // exact end of sent audio, known after a cut
    this.packets = 0;
    this.cut = null; // null | 'wait-video' | 'drain-audio'
    this.cutDone = false;
    this.limit = null; // seconds into the segment not to forward past (null = no limit)
    this.held = false; // last push stopped at the limit; call push() again later
  }

  // True if packets are waiting (held at the limit, or a partial packet).
  hasPending() {
    return !this.cutDone && (this.remainder?.length ?? 0) >= PACKET;
  }

  // Stop forwarding at a clean point as soon as possible (skip / stop).
  requestCut() {
    if (!this.cut && !this.cutDone) this.cut = 'wait-video';
  }

  // Seconds of media forwarded in this segment, or 0 if none.
  span() {
    if (this.firstDts === null || this.lastPts === null) return 0;
    return (Math.max(this.lastPts, this.audioEnd ?? 0) - this.firstDts) / CLOCK;
  }

  // Takes a raw feeder chunk (or nothing, to retry held packets); returns whole,
  // fixed-up packets to forward (or null).
  push(chunk = EMPTY) {
    this.held = false;
    if (this.cutDone) return null;
    const buf = this.remainder ? Buffer.concat([this.remainder, chunk]) : chunk;
    this.remainder = null;
    if (!buf.length) return null;

    let o = 0;
    if (buf[0] !== SYNC) {
      o = this.#findSync(buf);
      if (o < 0) {
        this.remainder = Buffer.from(buf.subarray(Math.max(0, buf.length - PACKET)));
        return null;
      }
      this.resyncs++;
    }

    const parts = [];
    let run = -1; // start of the current run of forwarded packets
    for (; o + PACKET <= buf.length; o += PACKET) {
      if (buf[o] !== SYNC) {
        this.resyncs++; // lost sync mid-chunk: keep the rest for a resync
        break;
      }
      const action = this.#inspect(buf, o);
      if (action === FORWARD) {
        this.#fixContinuity(buf, o);
        this.packets++;
        if (run < 0) run = o;
        continue;
      }
      if (run >= 0) parts.push(buf.subarray(run, o));
      run = -1;
      if (action === CUT) {
        this.cutDone = true;
        break;
      }
      if (action === HOLD) {
        this.held = true;
        break;
      }
    }
    if (run >= 0) parts.push(buf.subarray(run, o));
    if (!this.cutDone && o < buf.length) this.remainder = Buffer.from(buf.subarray(o));
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  #findSync(buf) {
    for (let i = 0; i + PACKET < buf.length; i++) {
      if (buf[i] === SYNC && buf[i + PACKET] === SYNC) return i;
    }
    return -1;
  }

  #inspect(b, o) {
    const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
    const pusi = (b[o + 1] & 0x40) !== 0;
    const afc = (b[o + 3] >> 4) & 0x3;

    let pts = null;
    let dts = null;
    if (pusi && afc & 0x1) {
      let p = o + 4;
      if (afc & 0x2) p += 1 + b[o + 4];
      if (p + 19 <= o + PACKET && b[p] === 0 && b[p + 1] === 0 && b[p + 2] === 1) {
        const id = b[p + 3];
        if (id >= 0xe0 && id <= 0xef) this.kinds.set(pid, 'video');
        else if (id >= 0xc0 && id <= 0xdf) this.kinds.set(pid, 'audio');
        const flags = b[p + 7] >> 6;
        if (this.kinds.has(pid) && flags & 0x2) {
          pts = this.unwrapper.unwrap(readTimestamp(b, p + 9));
          dts = flags === 0x3 ? this.unwrapper.unwrap(readTimestamp(b, p + 14)) : pts;
        }
      }
    }
    const kind = this.kinds.get(pid);

    if (this.cut === 'wait-video' && kind === 'video' && pusi && this.packets > 0) {
      // A new video frame starts here, so every video frame already sent is whole.
      this.cut = 'drain-audio';
    }
    if (this.cut === 'drain-audio') {
      if (kind !== 'audio') return DROP;
      if (pusi && pts !== null && pts >= (this.lastVideoPts ?? 0)) {
        this.audioEnd = pts;
        return CUT;
      }
    }
    // Hold at a PES start, so a held frame is never split across pushes.
    if (pts !== null && this.limit !== null && this.firstDts !== null && (pts - this.firstDts) / CLOCK > this.limit) {
      return HOLD;
    }

    if (pts !== null) {
      if (this.firstDts === null || dts < this.firstDts) this.firstDts = dts;
      if (this.lastPts === null || pts > this.lastPts) this.lastPts = pts;
      if (kind === 'video' && (this.lastVideoPts === null || pts > this.lastVideoPts)) this.lastVideoPts = pts;
      if (kind === 'audio' && (this.lastAudioPts === null || pts > this.lastAudioPts)) this.lastAudioPts = pts;
    }
    return FORWARD;
  }

  #fixContinuity(b, o) {
    const afc = (b[o + 3] >> 4) & 0x3;
    if (!(afc & 0x1)) return; // CC only advances on packets with payload
    const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
    const prev = this.cc.get(pid);
    const next = prev === undefined ? b[o + 3] & 0x0f : (prev + 1) & 0x0f;
    b[o + 3] = (b[o + 3] & 0xf0) | next;
    this.cc.set(pid, next);
  }
}
