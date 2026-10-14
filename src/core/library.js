// Library: every media item, its status, and the playlist order.
//
// data/library.json = { items: { [id]: item }, order: [id, ...] }
// Normalized files live in <media>/library/<id>.mp4|.m4a; imports and uploads
// land in <media>/incoming/ until normalized (the original is then deleted).

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { JsonStore } from './store.js';

export const KINDS = ['video', 'audio', 'background'];
const PENDING = ['downloading', 'uploading'];
const WORKING = ['queued', 'normalizing'];

export class Library {
  constructor({ dataDir, mediaDir }) {
    this.mediaDir = mediaDir;
    this.incomingDir = path.join(mediaDir, 'incoming');
    this.outputDir = path.join(mediaDir, 'library');
    this.store = new JsonStore(path.join(dataDir, 'library.json'), { items: {}, order: [] });
  }

  // Returns ids that still need normalizing (the caller re-queues them).
  async load() {
    await this.store.load();
    const requeue = [];
    await this.store.update((d) => {
      for (const item of Object.values(d.items)) {
        if (PENDING.includes(item.status)) {
          Object.assign(item, { status: 'failed', error: 'Interrupted by a restart — import it again', progress: null });
        } else if (WORKING.includes(item.status)) {
          if (item.incoming && existsSync(path.join(this.mediaDir, item.incoming))) {
            Object.assign(item, { status: 'queued', progress: null, eta: null });
            requeue.push(item.id);
          } else {
            Object.assign(item, { status: 'failed', error: 'Interrupted by a restart — import it again' });
          }
        } else if (item.status === 'ready' && !existsSync(path.join(this.mediaDir, item.file))) {
          Object.assign(item, { status: 'failed', error: 'Normalized file is missing on disk' });
        }
      }
      d.order = d.order.filter((id) => d.items[id]);
      for (const id of Object.keys(d.items)) if (!d.order.includes(id)) d.order.push(id);
    });
    return requeue;
  }

  list() {
    const { items, order } = this.store.data;
    return order.map((id) => items[id]).filter(Boolean);
  }

  get(id) {
    return this.store.data.items[id] ?? null;
  }

  isEmpty() {
    return this.list().length === 0;
  }

  // Ready, playable items of one kind, in playlist order.
  ready(kind) {
    return this.list().filter((i) => i.kind === kind && i.status === 'ready' && !i.quarantined);
  }

  abs(rel) {
    return rel ? path.join(this.mediaDir, rel) : null;
  }

  incomingPath(id, ext) {
    return path.join(this.incomingDir, `${id}${ext}`);
  }

  async create({ kind = 'auto', title, source, status }) {
    const id = randomBytes(6).toString('base64url');
    const now = new Date().toISOString();
    const item = {
      id, kind, title: String(title || 'Untitled').slice(0, 200), source, status,
      progress: null, eta: null, error: null, duration: null, bytes: null,
      file: null, incoming: null, quarantined: false, playFailures: 0,
      createdAt: now, updatedAt: now,
    };
    await this.store.update((d) => {
      d.items[id] = item;
      d.order.push(id);
    });
    return item;
  }

  async update(id, patch) {
    let updated = null;
    await this.store.update((d) => {
      if (!d.items[id]) return;
      if (patch.incoming) patch.incoming = this.#rel(patch.incoming);
      if (patch.file) patch.file = this.#rel(patch.file);
      d.items[id] = { ...d.items[id], ...patch, updatedAt: new Date().toISOString() };
      updated = d.items[id];
    });
    return updated;
  }

  async remove(id) {
    const item = this.get(id);
    if (!item) return false;
    await this.store.update((d) => {
      delete d.items[id];
      d.order = d.order.filter((x) => x !== id);
    });
    for (const rel of [item.file, item.incoming]) {
      // A file that's streaming right now can't be deleted on Windows (fine
      // on Linux). It's already out of the library; the orphan is harmless.
      if (rel) await rm(path.join(this.mediaDir, rel), { force: true }).catch(() => {});
    }
    return true;
  }

  // ids: the new order for some or all items. Listed ids move into place in
  // the order given; unlisted ones keep their relative order around them.
  async reorder(ids) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw badRequest('order must be a list of unique ids');
    for (const id of ids) if (!this.get(id)) throw badRequest(`unknown item ${id}`);
    await this.store.update((d) => {
      const listed = new Set(ids);
      const slots = d.order.map((id) => listed.has(id));
      const queue = [...ids];
      d.order = d.order.map((id, i) => (slots[i] ? queue.shift() : id));
    });
    return this.list();
  }

  async setQuarantined(id, quarantined, error = null) {
    return this.update(id, { quarantined, ...(error ? { error } : {}), ...(quarantined ? {} : { playFailures: 0 }) });
  }

  #rel(p) {
    return path.isAbsolute(p) ? path.relative(this.mediaDir, p) : p;
  }
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}
