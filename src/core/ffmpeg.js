// FFmpeg / ffprobe helpers shared by the normalizer, lofi builder and pipeline.

import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';

export const FFMPEG = process.env.FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE || 'ffprobe';

const execFileP = promisify(execFile);
const IMAGE_CODECS = new Set(['mjpeg', 'png', 'webp', 'bmp', 'tiff', 'jpegls']);

export async function probe(file) {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error',
    '-show_entries',
    'stream=index,codec_type,codec_name,profile,level,width,height,r_frame_rate,avg_frame_rate,pix_fmt,sample_rate,channels,start_time,duration,nb_frames,bit_rate,disposition:format=duration,format_name,size',
    '-of', 'json',
    file,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const info = JSON.parse(stdout);
  const streams = info.streams ?? [];
  // Cover art in audio files shows up as an attached_pic video stream — not video.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const end = (s) => (s ? Number(s.start_time || 0) + Number(s.duration || 0) : 0);
  const formatDuration = Number(info.format?.duration || 0);
  const isImage = Boolean(video) && IMAGE_CODECS.has(video.codec_name) && !audio;
  const isGif = video?.codec_name === 'gif';
  return {
    video,
    audio,
    isImage,
    isGif,
    formatName: info.format?.format_name ?? '',
    formatDuration,
    duration: Number(video?.duration) || Number(audio?.duration) || formatDuration,
    videoEnd: end(video),
    audioEnd: end(audio),
    size: Number(info.format?.size || 0),
  };
}

// Keyframe timestamps in the first `seconds` of the video stream. Read from
// packet flags (no decoding, and frame-level CSV output has trailing fields).
export async function keyframeTimes(file, seconds = 20) {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-read_intervals', `%+${seconds}`,
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file,
  ], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\n')
    .map((l) => l.split(','))
    .filter(([, flags]) => flags?.startsWith('K'))
    .map(([t]) => Number(t))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

// Stop a process, forcibly if it doesn't go. FFmpeg blocked writing to a dead
// connection (packets silently dropped) ignores SIGTERM until TCP gives up,
// which can take many minutes; seen in an outage test on the real server.
export function terminate(proc, graceMs = 3000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }, graceMs);
  timer.unref?.();
  proc.once('exit', () => clearTimeout(timer));
}

export function fps(rate) {
  const [n, d] = String(rate || '0/1').split('/').map(Number);
  return d ? n / d : 0;
}

// Runs ffmpeg to completion. onProgress(seconds, speed) from -progress.
// Abort with options.signal. Rejects with the last stderr lines on failure.
export function runFfmpeg(args, { onProgress, nice = false, signal } = {}) {
  const useNice = nice && process.platform !== 'win32';
  const cmd = useNice ? 'nice' : FFMPEG;
  const full = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
  const argv = useNice ? ['-n', '19', FFMPEG, ...full] : full;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let speed = 0;
    child.stderr.on('data', (d) => {
      tail = (tail + d).slice(-4000);
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const [k, v] = line.split('=');
      if (k === 'speed') speed = parseFloat(v) || 0;
      if (k === 'out_time_us' && onProgress) {
        const s = Number(v) / 1e6;
        if (Number.isFinite(s)) onProgress(s, speed);
      }
    });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      else if (code === 0) resolve();
      else reject(new Error(lastLines(tail) || `ffmpeg exited ${code}`));
    });
  });
}

function lastLines(text, n = 3) {
  return text.trim().split('\n').slice(-n).join(' | ').slice(0, 500);
}
