import express, { Router } from 'express';
import { CHUNK_SIZE } from '../core/importer.js';

const notFound = () => Object.assign(new Error('No such media item'), { status: 404 });

export function mediaRoutes(ctx) {
  const r = Router();
  const { library, importer, normalizer } = ctx;

  // What the panel shows for an item: no file paths, plus live progress.
  const view = (item) => {
    const norm = normalizer.status();
    const working = norm.current?.id === item.id ? norm.current : null;
    const queued = norm.queued.indexOf(item.id);
    const { file, incoming, ...rest } = item;
    return {
      ...rest,
      transfer: importer.progress(item.id),
      progress: working?.progress ?? item.progress,
      eta: working?.eta ?? item.eta,
      queuePosition: queued >= 0 ? queued + 1 : null,
    };
  };

  r.get('/', (req, res) => {
    const items = library.list().map(view);
    const cfg = ctx.getConfig();
    res.json({
      items,
      profileLocked: !library.isEmpty(),
      backgroundId: cfg.lofi.backgroundId,
      counts: Object.fromEntries(['video', 'audio', 'background'].map((k) => [k, library.ready(k).length])),
      totalBytes: items.reduce((n, i) => n + (i.status === 'ready' ? i.bytes || 0 : 0), 0),
      chunkSize: CHUNK_SIZE,
    });
  });

  r.post('/import', async (req, res) => {
    const { url, kind, title } = req.body ?? {};
    const item = await importer.importUrl({ url, kind, title });
    res.status(202).json(view(item));
  });

  r.post('/uploads', async (req, res) => {
    const { filename, size, kind } = req.body ?? {};
    res.status(201).json(await importer.createUpload({ filename, size, kind }));
  });

  r.put(
    '/uploads/:id/chunks/:index',
    express.raw({ type: 'application/octet-stream', limit: CHUNK_SIZE + 1024 }),
    async (req, res) => {
      res.json(await importer.putChunk(req.params.id, Number(req.params.index), req.body));
    },
  );

  r.post('/uploads/:id/complete', async (req, res) => {
    res.json(view(await importer.completeUpload(req.params.id)));
  });

  r.put('/order', async (req, res) => {
    await library.reorder(req.body?.order);
    ctx.supervisor.poke();
    res.json({ items: library.list().map(view) });
  });

  r.patch('/:id', async (req, res) => {
    const item = library.get(req.params.id);
    if (!item) throw notFound();
    const { title, quarantined } = req.body ?? {};
    const patch = {};
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) throw Object.assign(new Error('title must be a non-empty string'), { status: 400 });
      patch.title = title.trim().slice(0, 200);
    }
    if (quarantined === false) Object.assign(patch, { quarantined: false, playFailures: 0, error: null });
    res.json(view(await library.update(item.id, patch)));
    if (quarantined === false) ctx.supervisor.poke();
  });

  r.delete('/:id', async (req, res) => {
    const item = library.get(req.params.id);
    if (!item) throw notFound();
    importer.cancel(item.id);
    if (ctx.getConfig().lofi.backgroundId === item.id) await ctx.settings.patch({ lofi: { backgroundId: null } });
    await library.remove(item.id);
    ctx.logs.push('media', `deleted ${item.title}`);
    res.json({ ok: true });
  });

  return r;
}
