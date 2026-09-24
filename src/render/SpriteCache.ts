/** Offscreen-canvas sprite cache for cheap, high-volume entities (peds, cars, ...).
 * Rasterizes a keyed shape once into a small square canvas at a coarse zoom bucket, then every
 * later draw is a single drawImage instead of a pile of paths/gradients. LRU-evicts old entries. */

interface Entry {
  canvas: HTMLCanvasElement;
}

const MAX_ENTRIES = 400;
const cache = new Map<string, Entry>();
// power-of-~1.5 steps: enough zoom fidelity without a combinatorial blow-up of cache entries
const STEPS = [6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];

function pxBucket(pxPerUnit: number) {
  for (const s of STEPS) if (pxPerUnit <= s) return s;
  return STEPS[STEPS.length - 1];
}

export const SpriteCache = {
  /** Draw a cached sprite centred at the current transform origin (caller has already
   * translated/rotated). `worldSize`: side length (in the ctx's current local units) of the
   * square `render` draws into, centred at (0,0), +x right / +y down, unrotated.
   * `render(c, size)` draws once into a fresh size×size offscreen canvas on a cache miss. */
  draw(ctx: CanvasRenderingContext2D, key: string, worldSize: number, render: (c: CanvasRenderingContext2D, size: number) => void) {
    const t = ctx.getTransform();
    const pxPerUnit = Math.hypot(t.a, t.b) || 1;
    const bucket = pxBucket(pxPerUnit);
    const fullKey = key + '|' + bucket;
    let e = cache.get(fullKey);
    if (!e) {
      const px = Math.max(8, Math.round(worldSize * bucket));
      const cvs = document.createElement('canvas');
      cvs.width = cvs.height = px;
      const c2 = cvs.getContext('2d')!;
      c2.translate(px / 2, px / 2);
      c2.scale(px / worldSize, px / worldSize);
      render(c2, worldSize);
      e = { canvas: cvs };
      if (cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(fullKey, e);
    } else {
      // bump LRU order (Map preserves insertion order)
      cache.delete(fullKey);
      cache.set(fullKey, e);
    }
    ctx.drawImage(e.canvas, -worldSize / 2, -worldSize / 2, worldSize, worldSize);
  },
  clear() {
    cache.clear();
  },
  get size() {
    return cache.size;
  },
};
