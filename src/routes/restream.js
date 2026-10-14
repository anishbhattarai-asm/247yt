import { Router } from 'express';
import { cleanDestination, MAX_DESTINATIONS, PLATFORMS } from '../core/restream.js';

// Multistream destinations. Keys are write-only: never returned.
export function restreamRoutes(ctx) {
  const r = Router();
  const { settings, restream } = ctx;
  const notFound = () => Object.assign(new Error('No such destination'), { status: 404 });

  const view = () => ({
    destinations: settings.public().restream.destinations,
    status: restream.status(),
    platforms: Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, v])),
  });

  const save = async (fn, what) => {
    await settings.setInternal((d) => {
      d.restream.destinations = fn(d.restream.destinations);
    });
    restream.apply();
    ctx.logs.push('config', `multistream: ${what}`);
  };

  r.get('/', (req, res) => res.json(view()));

  r.post('/', async (req, res) => {
    const current = ctx.getConfig().restream.destinations;
    if (current.length >= MAX_DESTINATIONS) throw Object.assign(new Error(`At most ${MAX_DESTINATIONS} platforms`), { status: 400 });
    const d = cleanDestination(req.body ?? {});
    await save((list) => [...list, d], `added ${d.name}`);
    res.status(201).json(view());
  });

  r.patch('/:id', async (req, res) => {
    const existing = ctx.getConfig().restream.destinations.find((x) => x.id === req.params.id);
    if (!existing) throw notFound();
    const { name, url, key, enabled } = req.body ?? {};
    const d = cleanDestination({ name, url, key, enabled }, existing);
    await save((list) => list.map((x) => (x.id === d.id ? d : x)), `${d.name} ${enabled === undefined ? 'changed' : enabled ? 'on' : 'off'}`);
    res.json(view());
  });

  r.delete('/:id', async (req, res) => {
    const existing = ctx.getConfig().restream.destinations.find((x) => x.id === req.params.id);
    if (!existing) throw notFound();
    await save((list) => list.filter((x) => x.id !== req.params.id), `removed ${existing.name}`);
    res.json(view());
  });

  return r;
}
