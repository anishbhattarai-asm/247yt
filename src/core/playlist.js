// Playlist: decides what plays next. Asked at every file boundary, so edits
// (add, delete, reorder, mode/order change) apply live with no restart.

import { lofiInputs, videoInputs } from './lofi.js';

export class Playlist {
  constructor(library, getConfig) {
    this.library = library;
    this.getConfig = getConfig;
    this.shuffleQueue = [];
    this.lastIndex = 0;
  }

  #mode() {
    return this.getConfig().mode === 'lofi' ? 'lofi' : 'video';
  }

  #kind() {
    return this.#mode() === 'lofi' ? 'audio' : 'video';
  }

  #background() {
    const bg = this.library.get(this.getConfig().lofi.backgroundId);
    return bg && bg.kind === 'background' && bg.status === 'ready' ? bg : null;
  }

  // Why nothing can play right now, or null if something can.
  problem() {
    if (this.#mode() === 'lofi') {
      if (!this.#background()) return 'Lofi mode needs a ready background image or GIF — pick one in settings.';
      if (!this.library.ready('audio').length) return 'Lofi mode needs at least one ready audio track.';
      return null;
    }
    return this.library.ready('video').length ? null : 'No ready videos in the library yet.';
  }

  // A playable segment for the pipeline: { id, title, inputArgs(seek) }.
  #segment(item) {
    if (!item) return null;
    if (this.#mode() === 'lofi') {
      const bg = this.#background();
      if (!bg) return null;
      const bgFile = this.library.abs(bg.file);
      const track = this.library.abs(item.file);
      return { id: item.id, title: item.title, inputArgs: (seek) => lofiInputs(bgFile, track, seek) };
    }
    const file = this.library.abs(item.file);
    return { id: item.id, title: item.title, inputArgs: (seek) => videoInputs(file, seek) };
  }

  // The segment for a specific item (resuming after a restart), if playable.
  resolve(id) {
    const item = this.library.ready(this.#kind()).find((i) => i.id === id);
    return this.#segment(item);
  }

  // What plays after `afterId` (null = start of the playlist).
  next(afterId = null) {
    if (this.problem()) return null;
    const items = this.library.ready(this.#kind());
    const order = this.getConfig().playlist.order;
    let pick;
    if (order === 'repeat-one') {
      pick = items.find((i) => i.id === afterId) ?? items[0];
    } else if (order === 'shuffle') {
      pick = this.#shuffled(items, afterId);
    } else {
      const idx = items.findIndex((i) => i.id === afterId);
      // If the finished item was deleted meanwhile, carry on from its old slot.
      const nextIdx = idx >= 0 ? idx + 1 : afterId === null ? 0 : this.lastIndex;
      pick = items[nextIdx % items.length];
    }
    this.lastIndex = Math.max(0, items.indexOf(pick));
    return this.#segment(pick);
  }

  // Title of what comes after `afterId`, without consuming a shuffle slot.
  peek(afterId) {
    const items = this.library.ready(this.#kind());
    if (!items.length || this.problem()) return null;
    const order = this.getConfig().playlist.order;
    if (order === 'repeat-one') return items.find((i) => i.id === afterId)?.title ?? items[0].title;
    if (order === 'shuffle') {
      const id = this.shuffleQueue.find((x) => items.some((i) => i.id === x));
      return id ? items.find((i) => i.id === id).title : null;
    }
    const idx = items.findIndex((i) => i.id === afterId);
    return items[(idx + 1) % items.length].title;
  }

  #shuffled(items, afterId) {
    const ids = new Set(items.map((i) => i.id));
    this.shuffleQueue = this.shuffleQueue.filter((id) => ids.has(id));
    if (!this.shuffleQueue.length) {
      this.shuffleQueue = shuffle([...ids]);
      // Don't play the same item twice in a row across a reshuffle.
      if (this.shuffleQueue.length > 1 && this.shuffleQueue[0] === afterId) {
        this.shuffleQueue.push(this.shuffleQueue.shift());
      }
    }
    const id = this.shuffleQueue.shift();
    return items.find((i) => i.id === id);
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
