// Getting media onto the VM. Cloudflare quick tunnels cap request bodies at
// ~100 MB, so a plain upload of a video fails. Two paths:
//
//   import-from-URL (preferred): the VM downloads the file itself — faster than
//     a home upload and it never touches the tunnel. Google Drive share links
//     are rewritten past Drive's virus-scan page; Dropbox links to ?dl=1.
//   chunked upload (fallback): the browser sends 32 MB pieces, each keyed by
//     index so a failed piece can simply be sent again.
//
// Either way the file lands in media/incoming/ and is queued for normalizing.

import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rm, statfs } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const CHUNK_SIZE = 32 * 1024 * 1024;
const KINDS = ['auto', 'video', 'audio', 'background'];

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// Imports fetch from the public internet only: never this server itself, its
// private network or the cloud's metadata service (which knows things about
// the server). Checked for every address a name resolves to, on every
// redirect.
const INSIDE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) INSIDE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) INSIDE.addSubnet(net, bits, 'ipv6');

export function isInsideAddress(address) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return INSIDE.check(mapped[1], 'ipv4');
  return INSIDE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

export async function assertPublicUrl(url, resolve = (host) => lookup(host, { all: true, verbatim: true })) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await resolve(host)).map((a) => a.address);
  if (!addresses.length || addresses.some(isInsideAddress)) {
    throw badRequest('That link points inside this server\'s own network, which imports may not reach');
  }
}

// fetch() that checks every hop of a redirect chain with assertPublicUrl.
export async function fetchPublic(url, { signal, headers, maxRedirects = 8, check = assertPublicUrl } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await check(current);
    const res = await fetch(current, { redirect: 'manual', signal, headers });
    if (![301, 302, 303, 307, 308].includes(res.status)) return Object.assign(res, { finalUrl: current });
    await res.body?.cancel();
    const next = res.headers.get('location');
    if (!next) throw new Error(`The server answered HTTP ${res.status} without saying where to`);
    current = new URL(next, current).toString();
    if (!/^https?:$/.test(new URL(current).protocol)) throw badRequest('That link redirects to something other than http(s)');
  }
  throw new Error('That link redirects too many times');
}

// Share-page links -> direct download links.
export function directUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw badRequest('That is not a valid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw badRequest('Only http(s) links can be imported');
  if (u.hostname === '169.254.169.254') throw badRequest('That address is not allowed');
  if (/(^|\.)drive\.google\.com$/.test(u.hostname) || u.hostname === 'docs.google.com') {
    const id = u.pathname.match(/\/d\/([\w-]{10,})/)?.[1] ?? u.searchParams.get('id');
    if (!id) throw badRequest('Could not find the file id in that Google Drive link');
    return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  }
  if (/(^|\.)dropbox\.com$/.test(u.hostname)) {
    u.searchParams.set('dl', '1');
    return u.toString();
  }
  return u.toString();
}

function filenameFrom(res, url) {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = cd.match(/filename="?([^";]+)"?/i)?.[1];
  const fromUrl = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  return (star ? decodeURIComponent(star) : plain) || fromUrl || 'download';
}

const extOf = (name) => (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,5}$/)?.[0] ?? '');
const stem = (name) => path.basename(name, path.extname(name)) || name;

export class Importer {
  constructor({ library, normalizer, getConfig, log = () => {}, fetch = fetchPublic }) {
    this.fetch = fetch; // tests: a local server stands in for the internet
    this.library = library;
    this.normalizer = normalizer;
    this.getConfig = getConfig;
    this.log = log;
    this.active = new Map(); // id -> { abort, received, total }
    this.uploads = new Map(); // id -> { size, chunks, received:Set, path, kind }
  }

  // Live progress for items still downloading/uploading (merged into listings).
  progress(id) {
    const a = this.active.get(id);
    if (a) return { received: a.received, total: a.total };
    const u = this.uploads.get(id);
    if (u) return { received: u.received.size * CHUNK_SIZE > u.size ? u.size : u.received.size * CHUNK_SIZE, total: u.size };
    return null;
  }

  async #checkSpace(bytes) {
    const { limits } = this.getConfig();
    if (bytes && bytes > limits.maxUploadBytes) {
      throw badRequest(`File is larger than the ${(limits.maxUploadBytes / 1024 ** 3).toFixed(0)} GB limit`);
    }
    await mkdir(this.library.incomingDir, { recursive: true });
    const s = await statfs(this.library.incomingDir);
    const free = s.bavail * s.bsize;
    if (free - (bytes || 0) < limits.minFreeDiskBytes) {
      throw Object.assign(new Error(`Not enough disk space (${(free / 1024 ** 3).toFixed(1)} GB free)`), { status: 507 });
    }
  }

  // URL import

  async importUrl({ url, kind = 'auto', title }) {
    if (!KINDS.includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
    const target = directUrl(url);
    await this.#checkSpace(0);
    const item = await this.library.create({
      kind, title: title || 'Downloading…', source: { type: 'url', url: String(url).slice(0, 2000) }, status: 'downloading',
    });
    this.#download(item.id, target, kind, title).catch(() => {});
    return item;
  }

  async #download(id, url, kind, title) {
    const abort = new AbortController();
    const entry = { abort, received: 0, total: null };
    this.active.set(id, entry);
    let file = null;
    try {
      const res = await this.fetch(url, { signal: abort.signal, headers: { 'user-agent': 'stream-panel/0.1' } });
      if (!res.ok) throw new Error(`The server answered HTTP ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('text/html')) {
        throw new Error('That link opened a web page, not a file. Use a direct download link (Drive: make it "Anyone with the link").');
      }
      entry.total = Number(res.headers.get('content-length')) || null;
      await this.#checkSpace(entry.total);
      const name = filenameFrom(res, res.finalUrl || url);
      file = this.library.incomingPath(id, extOf(name));
      await this.library.update(id, { title: title || stem(name), incoming: file, bytes: entry.total });
      const max = this.getConfig().limits.maxUploadBytes;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          entry.received += chunk.length;
          if (entry.received > max) return cb(new Error('File is larger than the upload limit'));
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(file));
      this.active.delete(id);
      await this.#queue(id, kind, file, entry.received);
    } catch (err) {
      this.active.delete(id);
      if (file) await rm(file, { force: true });
      const cancelled = abort.signal.aborted;
      if (!cancelled) {
        this.log(`import failed: ${err.message}`);
        await this.library.update(id, { status: 'failed', error: err.message, incoming: null });
      }
    }
  }

  // chunked upload

  async createUpload({ filename, size, kind = 'auto' }) {
    if (!KINDS.includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
    if (!Number.isSafeInteger(size) || size <= 0) throw badRequest('size must be a positive number of bytes');
    if (typeof filename !== 'string' || !filename.trim()) throw badRequest('filename is required');
    await this.#checkSpace(size);
    const item = await this.library.create({
      kind, title: stem(filename.trim()).slice(0, 200), source: { type: 'upload', filename: filename.slice(0, 200) }, status: 'uploading',
    });
    const file = this.library.incomingPath(item.id, extOf(filename));
    const fh = await open(file, 'w');
    await fh.truncate(size);
    await fh.close();
    const chunks = Math.ceil(size / CHUNK_SIZE);
    this.uploads.set(item.id, { size, chunks, received: new Set(), path: file, kind });
    await this.library.update(item.id, { incoming: file, bytes: size });
    return { id: item.id, chunkSize: CHUNK_SIZE, chunks };
  }

  async putChunk(id, index, data) {
    const u = this.uploads.get(id);
    if (!u) throw Object.assign(new Error('Unknown or finished upload'), { status: 404 });
    if (!Number.isInteger(index) || index < 0 || index >= u.chunks) throw badRequest('chunk index out of range');
    const expected = Math.min(CHUNK_SIZE, u.size - index * CHUNK_SIZE);
    if (!Buffer.isBuffer(data) || data.length !== expected) throw badRequest(`chunk ${index} must be exactly ${expected} bytes`);
    const fh = await open(u.path, 'r+');
    try {
      await fh.write(data, 0, data.length, index * CHUNK_SIZE);
    } finally {
      await fh.close();
    }
    u.received.add(index);
    return { received: u.received.size, chunks: u.chunks };
  }

  async completeUpload(id) {
    const u = this.uploads.get(id);
    if (!u) throw Object.assign(new Error('Unknown or finished upload'), { status: 404 });
    const missing = [];
    for (let i = 0; i < u.chunks; i++) if (!u.received.has(i)) missing.push(i);
    if (missing.length) throw Object.assign(badRequest(`missing chunks: ${missing.slice(0, 20).join(', ')}`), { missing });
    this.uploads.delete(id);
    await this.#queue(id, u.kind, u.path, u.size);
    return this.library.get(id);
  }

  // shared

  async #queue(id, kind, file, bytes) {
    await this.library.update(id, { status: 'queued', incoming: file, bytes, progress: null, error: null });
    this.normalizer.enqueue({ id, kind, input: file, outputDir: this.library.outputDir });
  }

  // Stop a download/upload in progress (the item is being deleted).
  cancel(id) {
    this.active.get(id)?.abort.abort();
    this.active.delete(id);
    this.uploads.delete(id);
    this.normalizer.cancel(id);
  }
}
