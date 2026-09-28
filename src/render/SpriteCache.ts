/** Offscreen sprite cache for cheap, high-volume entities (the crowd).
 * Rasterizes a keyed shape once into a small square bitmap at a coarse zoom bucket, then every
 * later draw is a single drawImage instead of a pile of paths/gradients. Least-recently-used entries
 * go when it's full. */

interface Entry {
  img: CanvasImageSource;
  /** when it was last drawn (the `clock` below), for evicting the least recently used */
  used: number;
}

const MAX_ENTRIES = 800;
/** key -> sub-key x 16 + zoom bucket's index -> sprite */
const cache = new Map<string, Map<number, Entry>>();
let count = 0;
let clock = 0;
// power-of-~1.5 steps: enough zoom fidelity without a combinatorial blow-up of cache entries
const STEPS = [6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
/** the bucket (index into STEPS) last drawn at (every sprite is drawn at the camera's scale) */
let cur = 0;

/** The zoom bucket for this many px per unit: the smallest step at least that big (a sprite is never
 *  scaled up), but kept a little longer on the way down: while the zoom breathes across a step (the
 *  speed zoom when driving), the crowd isn't rasterized afresh at every crossing. */
function pxBucket(pxPerUnit: number) {
  let i = 0;
  while (i < STEPS.length - 1 && pxPerUnit > STEPS[i]) i++;
  if (cur > i && pxPerUnit > (cur > 0 ? STEPS[cur - 1] : 0) * 0.9) return cur;
  return (cur = i);
}

/** One reused 2D context to rasterize misses into (they're kept as ImageBitmaps): a canvas and a
 *  context per sprite made every miss cost a DOM element, a context and garbage. */
let scratch: OffscreenCanvas | null | undefined;
function scratchCanvas() {
  if (scratch === undefined) {
    try {
      scratch = typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function' ? new OffscreenCanvas(8, 8) : null;
      if (scratch && !scratch.getContext('2d')) scratch = null;
    } catch {
      scratch = null;
    }
  }
  return scratch;
}

function rasterize(px: number, worldSize: number, render: (c: CanvasRenderingContext2D, size: number) => void): CanvasImageSource {
  const oc = scratchCanvas();
  if (oc) {
    oc.width = oc.height = px;
    const c2 = oc.getContext('2d')! as unknown as CanvasRenderingContext2D;
    c2.setTransform(px / worldSize, 0, 0, px / worldSize, px / 2, px / 2);
    render(c2, worldSize);
    return oc.transferToImageBitmap();
  }
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = px;
  const c2 = cvs.getContext('2d')!;
  c2.translate(px / 2, px / 2);
  c2.scale(px / worldSize, px / worldSize);
  render(c2, worldSize);
  return cvs;
}

function evictOldest() {
  let oldK = '', oldB = 0, oldT = Infinity;
  for (const [k, m] of cache)
    for (const [b, e] of m)
      if (e.used < oldT) (oldT = e.used), (oldK = k), (oldB = b);
  const m = cache.get(oldK);
  const e = m?.get(oldB);
  if (!m || !e) return;
  if (typeof ImageBitmap !== 'undefined' && e.img instanceof ImageBitmap) e.img.close();
  m.delete(oldB);
  if (!m.size) cache.delete(oldK);
  count--;
}

export const SpriteCache = {
  /** Draw a cached sprite centred at the current transform origin (caller has already
   * translated/rotated). `key` and `sub` (a small integer, e.g. a pose: no string to build per draw)
   * name it. `worldSize`: side length (in the ctx's current local units) of the
   * square `render` draws into, centred at (0,0), +x right / +y down, unrotated.
   * `render(c, size)` draws once into a fresh size×size offscreen canvas on a cache miss. */
  draw(ctx: CanvasRenderingContext2D, key: string, sub: number, worldSize: number, render: (c: CanvasRenderingContext2D, size: number) => void) {
    const t = ctx.getTransform();
    const pxPerUnit = Math.hypot(t.a, t.b) || 1;
    const bi = pxBucket(pxPerUnit);
    const k = sub * 16 + bi;
    let m = cache.get(key);
    if (!m) cache.set(key, (m = new Map()));
    let e = m.get(k);
    if (!e) {
      if (count >= MAX_ENTRIES) evictOldest();
      e = { img: rasterize(Math.max(8, Math.round(worldSize * STEPS[bi])), worldSize, render), used: 0 };
      // (the eviction may have emptied and dropped this key's map)
      if (!cache.has(key)) cache.set(key, m);
      m.set(k, e);
      count++;
    }
    e.used = ++clock;
    ctx.drawImage(e.img, -worldSize / 2, -worldSize / 2, worldSize, worldSize);
  },
  clear() {
    for (const m of cache.values())
      for (const e of m.values()) if (typeof ImageBitmap !== 'undefined' && e.img instanceof ImageBitmap) e.img.close();
    cache.clear();
    count = 0;
  },
  get size() {
    return count;
  },
};
