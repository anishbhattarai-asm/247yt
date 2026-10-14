// Normalizer: converts every upload ONCE into the fixed stream profile, so
// streaming is always `-c copy` (~0.1 core).
//
//   video      -> H.264 + AAC .mp4, scale+pad, keyframe every 2 s, audio and
//                 video trimmed to exactly the same length (no overlap at joins),
//                 constant bitrate: a mostly still video (a screen recording)
//                 otherwise drops to ~600 kbps and YouTube rates the stream
//                 health "Poor" and warns viewers will buffer (seen live)
//   audio      -> AAC .m4a, loudness-normalized to -14 LUFS (lofi tracks)
//   background -> video-only H.264 loop at a constant bitrate (lofi): a still
//                 image compresses to almost nothing, and YouTube then warns
//                 about low bitrate, so the loop is padded with filler (CBR)
//
// One job at a time, under `nice -n 19` on Linux, so encoding never starves
// the live stream. Files that already match the profile are only remuxed.

import { EventEmitter } from 'node:events';
import { mkdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { fps, keyframeTimes, probe, runFfmpeg } from './ffmpeg.js';

export const GOP_SECONDS = 2;
const BACKGROUND_IMAGE_SECONDS = 10;
const BACKGROUND_MAX_SECONDS = 60;

const kbps = (b) => Number(String(b).replace(/k$/, ''));

// Lowest H.264 level that fits the profile (MaxFS, MaxMBPS per the spec).
export function h264Level(width, height, frameRate) {
  const fs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = fs * frameRate;
  const levels = [['3.1', 3600, 108000], ['4.1', 8192, 245760], ['4.2', 8704, 522240],
    ['5.0', 22080, 589824], ['5.1', 36864, 983040], ['5.2', 36864, 2073600]];
  return (levels.find(([, maxFs, maxRate]) => fs <= maxFs && rate <= maxRate) ?? levels.at(-1))[0];
}

function videoFilter(p) {
  return [
    `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease:out_color_matrix=bt709:out_range=tv`,
    `pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${p.fps}`,
    'format=yuv420p',
  ].join(',');
}

// Forced so the H.264 headers come out identical whatever the source was.
// Constant bitrate (x264 pads with filler) with a buffer of `bufferSeconds`.
function h264(p, { still = false, bufferSeconds = 2 } = {}) {
  const gop = String(p.fps * GOP_SECONDS);
  const rate = p.videoBitrate;
  return [
    '-c:v', 'libx264', '-preset', p.preset, ...(still ? ['-tune', 'stillimage'] : []),
    '-profile:v', 'high', '-level:v', h264Level(p.width, p.height, p.fps),
    '-b:v', rate, '-maxrate', rate, '-minrate', rate, '-bufsize', `${kbps(rate) * bufferSeconds}k`,
    '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  ];
}

const aac = (p) => ['-c:a', 'aac', '-b:a', p.audioBitrate, '-ar', String(p.sampleRate), '-ac', '2'];
const finish = ['-map_metadata', '-1', '-movflags', '+faststart'];

export function videoArgs(input, output, src, p) {
  const duration = Number(src.video.duration) || src.formatDuration;
  return [
    '-i', input,
    // No audio: an inaudible noise floor (about -91 dB), not digital silence.
    // Silence encodes to ~2 kbps and YouTube then warns "audio bitrate 0"
    // (seen live); this keeps a normal audio bitrate and sounds silent.
    ...(src.audio ? [] : ['-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.0001:sample_rate=${p.sampleRate}`]),
    '-map', '0:v:0', '-map', src.audio ? '0:a:0' : '1:a:0',
    '-vf', videoFilter(p),
    // apad + output -t: audio exactly as long as video (no TS overlap at joins).
    '-af', `aresample=${p.sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,apad`,
    '-t', duration.toFixed(3),
    ...h264(p), ...aac(p), ...finish, output,
  ];
}

export function remuxArgs(input, output, src) {
  return ['-i', input, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
    '-t', Math.min(src.videoEnd, src.audioEnd).toFixed(3), ...finish, output];
}

export function audioArgs(input, output, p) {
  return [
    '-i', input, '-map', '0:a:0', '-vn',
    '-af', `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=${p.sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo`,
    ...aac(p), ...finish, output,
  ];
}

export function backgroundArgs(input, output, src, p) {
  const still = src.isImage;
  const seconds = still
    ? BACKGROUND_IMAGE_SECONDS
    : Math.min(Math.max(src.duration || 0, GOP_SECONDS), BACKGROUND_MAX_SECONDS);
  const loops = !still && src.duration > 0 && src.duration < GOP_SECONDS ? Math.ceil(GOP_SECONDS / src.duration) : 0;
  return [
    ...(still ? ['-loop', '1', '-framerate', String(p.fps)] : loops ? ['-stream_loop', String(loops)] : []),
    '-i', input, '-map', '0:v:0', '-an',
    '-vf', videoFilter(p), '-t', seconds.toFixed(3),
    ...h264(p, { still, bufferSeconds: 1 }), ...finish, output,
  ];
}

// The H.264 profile our encoder actually produces: x264's ultrafast preset
// turns off CABAC, B-frames and 8x8 transforms, so it signals Constrained
// Baseline even when asked for High.
export const producedProfile = (preset) => (preset === 'ultrafast' ? 'Constrained Baseline' : 'High');

// True when a file already matches the profile exactly → remux, no re-encode.
// Strict on purpose: every file's H.264 headers should look alike at joins.
export async function matchesProfile(file, src, p) {
  const v = src.video;
  const a = src.audio;
  if (!v || !a || src.isImage) return false;
  const level = Math.round(Number(h264Level(p.width, p.height, p.fps)) * 10);
  if (v.codec_name !== 'h264' || v.profile !== producedProfile(p.preset) || Number(v.level) !== level) return false;
  if (v.width !== p.width || v.height !== p.height || v.pix_fmt !== 'yuv420p') return false;
  if (Math.abs(fps(v.r_frame_rate) - p.fps) > 0.01) return false;
  if (a.codec_name !== 'aac' || Number(a.sample_rate) !== p.sampleRate || a.channels !== 2) return false;
  if (Math.abs(src.videoEnd - src.audioEnd) > 0.1) return false;
  // Too low a bitrate (not constant) -> re-encode, or YouTube flags the stream.
  const bits = Number(v.bit_rate) || ((src.size * 8) / (src.duration || Infinity));
  if (bits < kbps(p.videoBitrate) * 1000 * 0.85) return false;
  const kf = await keyframeTimes(file, 20);
  if (kf.length < 2) return false;
  return kf.slice(1).every((t, i) => Math.abs(t - kf[i] - GOP_SECONDS) < 0.02);
}

// What an input should become when the caller didn't say.
export function detectKind(src) {
  if (src.isImage || src.isGif) return 'background';
  if (src.video) return 'video';
  if (src.audio) return 'audio';
  return null;
}

export class Normalizer extends EventEmitter {
  // getProfile(): current profile. minFreeDiskBytes: refuse below this.
  constructor({ getProfile, minFreeDiskBytes = 0 }) {
    super();
    this.getProfile = getProfile;
    this.minFreeDiskBytes = minFreeDiskBytes;
    this.queue = [];
    this.current = null;
  }

  // job: { id, kind: 'video'|'audio'|'background'|'auto', input, outputDir }
  enqueue(job) {
    if (this.current?.id === job.id || this.queue.some((j) => j.id === job.id)) return;
    this.queue.push(job);
    this.emit('queued', { id: job.id, position: this.queue.length });
    this.#next();
  }

  cancel(id) {
    this.queue = this.queue.filter((j) => j.id !== id);
    if (this.current?.id === id) this.current.abort.abort();
  }

  status() {
    return {
      current: this.current && { id: this.current.id, progress: this.current.progress, eta: this.current.eta },
      queued: this.queue.map((j) => j.id),
    };
  }

  async #next() {
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift();
    const abort = new AbortController();
    this.current = { id: job.id, abort, progress: 0, eta: null };
    try {
      const result = await this.#run(job, abort.signal);
      this.emit('done', { id: job.id, ...result });
    } catch (err) {
      if (!err.cancelled) this.emit('failed', { id: job.id, error: err.message });
    } finally {
      this.current = null;
      setImmediate(() => this.#next());
    }
  }

  async #run(job, signal) {
    const p = this.getProfile();
    let src;
    try {
      src = await probe(job.input);
    } catch {
      throw new Error('Not a media file FFmpeg can read');
    }
    const kind = job.kind === 'auto' ? detectKind(src) : job.kind;
    if (!kind) throw new Error('No video or audio stream found');
    if (kind === 'video' && (!src.video || src.isImage)) throw new Error('This file has no video — add it as an audio track or a background');
    if (kind === 'audio' && !src.audio) throw new Error('This file has no audio');
    if (kind === 'background' && !src.video) throw new Error('A background needs an image, GIF or video');

    const ext = kind === 'audio' ? 'm4a' : 'mp4';
    const output = path.join(job.outputDir, `${job.id}.${ext}`);
    await mkdir(job.outputDir, { recursive: true });
    await this.#checkDisk(job.outputDir, src, p, kind);

    let args;
    let mode = 'encode';
    if (kind === 'video' && (await matchesProfile(job.input, src, p))) {
      args = remuxArgs(job.input, output, src);
      mode = 'remux';
    } else if (kind === 'video') args = videoArgs(job.input, output, src, p);
    else if (kind === 'audio') args = audioArgs(job.input, output, p);
    else args = backgroundArgs(job.input, output, src, p);

    const total = kind === 'background' ? null : src.duration;
    const started = Date.now();
    this.emit('progress', { id: job.id, kind, mode, progress: 0, eta: null });
    await runFfmpeg(args, {
      nice: true,
      signal,
      onProgress: (s, speed) => {
        const progress = total ? Math.min(1, s / total) : null;
        const eta = total && speed > 0 ? Math.max(0, (total - s) / speed) : null;
        Object.assign(this.current, { progress, eta });
        this.emit('progress', { id: job.id, kind, mode, progress, eta });
      },
    }).catch(async (err) => {
      await rm(output, { force: true });
      throw err;
    });

    const out = await probe(output);
    if (kind === 'video' && (!out.video || !out.audio || Math.abs(out.videoEnd - out.audioEnd) > 0.1)) {
      await rm(output, { force: true });
      throw new Error('Normalized file failed verification (audio/video length mismatch)');
    }
    await rm(job.input, { force: true }); // the VM keeps only the normalized copy
    const { size } = await stat(output);
    return {
      kind,
      mode,
      file: output,
      duration: kind === 'background' ? out.duration : Math.min(out.videoEnd || Infinity, out.audioEnd || Infinity, out.duration || Infinity),
      bytes: size,
      seconds: (Date.now() - started) / 1000,
    };
  }

  async #checkDisk(dir, src, p, kind) {
    if (!this.minFreeDiskBytes) return;
    const { bavail, bsize } = await statfs(dir);
    const free = bavail * bsize;
    const seconds = kind === 'background' ? BACKGROUND_MAX_SECONDS : src.duration || 0;
    const estimate = (seconds * (kbps(p.videoBitrate) + kbps(p.audioBitrate)) * 1000) / 8;
    if (free - estimate < this.minFreeDiskBytes) {
      throw new Error(`Not enough disk space: ${(free / 1024 ** 3).toFixed(1)} GB free, need ~${(estimate / 1024 ** 3).toFixed(1)} GB plus the safety margin`);
    }
  }
}
