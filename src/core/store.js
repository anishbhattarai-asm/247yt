// Atomic JSON file store.
//
// Writes go to a temp file, are fsynced, then renamed over the real file, so a
// crash or power cut mid-write leaves either the old or the new version —
// never a torn file. Writes are serialized through one promise chain. Files are
// created with mode 600 because config.json holds secrets.

import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
    this.mtime = null;
    this.chain = Promise.resolve();
  }

  async load() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
      this.mtime = (await stat(this.file)).mtimeMs;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = structuredClone(this.defaults);
      return this.data;
    }
    try {
      this.data = JSON.parse(text);
    } catch (err) {
      // Atomic writes can't produce this, so it's a hand edit gone wrong. Fail
      // loudly rather than silently resetting (that would wipe the password).
      throw new Error(`${this.file} is not valid JSON (${err.message}). Fix or delete it.`);
    }
    return this.data;
  }

  // Re-read the file if something else (the CLI) changed it since our last
  // read or write — so an outside edit is never overwritten by stale data.
  async reloadIfChanged() {
    let m;
    try {
      m = (await stat(this.file)).mtimeMs;
    } catch {
      return false;
    }
    if (m === this.mtime) return false;
    await this.load();
    return true;
  }

  // Same, synchronously — cheap (one stat) so readers can call it every time.
  reloadIfChangedSync() {
    let m;
    try {
      m = statSync(this.file).mtimeMs;
    } catch {
      return false;
    }
    if (m === this.mtime) return false;
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
      this.mtime = m;
      return true;
    } catch {
      return false; // mid-edit or broken: keep what we have; load() reports it
    }
  }

  // Mutate a copy with fn(draft), then persist it. Returns the new data.
  update(fn) {
    const run = async () => {
      await this.reloadIfChanged();
      const draft = structuredClone(this.data ?? this.defaults);
      const result = await fn(draft);
      const next = result === undefined ? draft : result;
      await writeAtomic(this.file, JSON.stringify(next, null, 2) + '\n');
      this.data = next;
      this.mtime = (await stat(this.file)).mtimeMs;
      return next;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
}

export async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      // Windows refuses to replace a file another process (antivirus, the
      // search indexer) briefly has open. Linux never does; retry ~1 s there.
      if (['EPERM', 'EACCES', 'EBUSY'].includes(err.code) && attempt < 10) {
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        continue;
      }
      await rm(tmp, { force: true });
      throw err;
    }
  }
}
