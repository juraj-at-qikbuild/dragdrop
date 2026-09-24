// Procedural surface textures. Each texture is baked together with its base
// colour into a small repeating tile, so a textured surface costs a single fill
// (no overlay pass). Tiles are generated at roughly screen density (~24 px per
// metre) because canvas patterns are not mipmapped: much denser tiles alias
// into a pixel checkerboard when scaled down.
//
// Patterns are mapped into world metres with `setTransform`, so callers use
// them directly as fillStyle/strokeStyle while drawing in metres.

import { rng } from '../util/math';

type Painter = (c: CanvasRenderingContext2D, px: number, r: () => number) => void;

interface TexDef {
  /** tile size in metres */
  m: number;
  /** tile size in pixels */
  px: number;
  paint: Painter;
}

const dot = (c: CanvasRenderingContext2D, x: number, y: number, s: number) => {
  c.beginPath();
  c.arc(x, y, s, 0, Math.PI * 2);
  c.fill();
};

const DEFS = {
  /** fine speckle grain */
  asphalt: {
    m: 4,
    px: 96,
    paint(c, px, r) {
      for (let i = 0; i < 420; i++) {
        c.fillStyle = r() < 0.5 ? `rgba(0,0,0,${0.05 + r() * 0.07})` : `rgba(255,255,255,${0.025 + r() * 0.04})`;
        dot(c, r() * px, r() * px, 0.4 + r() * 0.8);
      }
      // a couple of faint patches / tar seams
      for (let i = 0; i < 3; i++) {
        c.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.03})`;
        c.beginPath();
        c.ellipse(r() * px, r() * px, 8 + r() * 14, 4 + r() * 8, r() * 3, 0, Math.PI * 2);
        c.fill();
      }
    },
  },
  /** irregular setts in offset rows (Old Town cobbles) */
  cobble: {
    m: 2.4,
    px: 64,
    paint(c, px, r) {
      const rows = 8, h = px / rows;
      for (let y = 0; y < rows; y++) {
        const off = (y % 2) * h * 0.5;
        for (let x = -1; x < rows; x++) {
          const s = r();
          c.fillStyle = s < 0.5 ? `rgba(0,0,0,${0.03 + s * 0.08})` : `rgba(255,255,255,${0.03 + (s - 0.5) * 0.1})`;
          c.beginPath();
          c.roundRect(x * h + off + 0.6, y * h + 0.6, h - 1.2, h - 1.2, 2);
          c.fill();
        }
      }
      c.strokeStyle = 'rgba(40,30,20,0.12)';
      c.lineWidth = 0.8;
      for (let y = 0; y <= rows; y++) {
        c.beginPath();
        c.moveTo(0, y * h);
        c.lineTo(px, y * h);
        c.stroke();
      }
    },
  },
  grass: {
    m: 4,
    px: 96,
    paint(c, px, r) {
      for (let i = 0; i < 8; i++) {
        c.fillStyle = r() < 0.5 ? 'rgba(30,60,10,0.05)' : 'rgba(210,230,140,0.05)';
        c.beginPath();
        c.ellipse(r() * px, r() * px, 10 + r() * 20, 8 + r() * 14, r() * 3, 0, Math.PI * 2);
        c.fill();
      }
      for (let i = 0; i < 260; i++) {
        c.strokeStyle = r() < 0.55 ? `rgba(20,45,10,${0.06 + r() * 0.08})` : `rgba(215,235,150,${0.05 + r() * 0.07})`;
        c.lineWidth = 0.8 + r() * 0.5;
        const x = r() * px, y = r() * px, a = -Math.PI / 2 + (r() - 0.5) * 1.2, len = 1.5 + r() * 2.2;
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        c.stroke();
      }
    },
  },
  /** mottled forest floor */
  wood: {
    m: 6,
    px: 128,
    paint(c, px, r) {
      for (let i = 0; i < 110; i++) {
        c.fillStyle = r() < 0.55 ? `rgba(15,28,8,${0.05 + r() * 0.07})` : `rgba(130,150,70,${0.04 + r() * 0.06})`;
        c.beginPath();
        c.ellipse(r() * px, r() * px, 3 + r() * 8, 2 + r() * 6, r() * Math.PI, 0, Math.PI * 2);
        c.fill();
      }
    },
  },
  sand: {
    m: 3,
    px: 72,
    paint(c, px, r) {
      for (let i = 0; i < 300; i++) {
        c.fillStyle = r() < 0.5 ? `rgba(90,70,30,${0.05 + r() * 0.08})` : `rgba(255,250,220,${0.05 + r() * 0.08})`;
        dot(c, r() * px, r() * px, 0.35 + r() * 0.8);
      }
    },
  },
  /** speckle + panel seams, flat roofs and plazas of modern blocks */
  concrete: {
    m: 6,
    px: 128,
    paint(c, px, r) {
      for (let i = 0; i < 260; i++) {
        c.fillStyle = r() < 0.5 ? `rgba(0,0,0,${0.03 + r() * 0.05})` : `rgba(255,255,255,${0.03 + r() * 0.05})`;
        dot(c, r() * px, r() * px, 0.4 + r() * 0.9);
      }
      c.strokeStyle = 'rgba(0,0,0,0.08)';
      c.lineWidth = 1;
      c.strokeRect(0.5, 0.5, px / 2 - 1, px - 1);
      c.strokeRect(px / 2 + 0.5, 0.5, px / 2 - 1, px - 1);
    },
  },
  /** overlapping clay tiles in rows */
  roofTile: {
    m: 2,
    px: 48,
    paint(c, px, r) {
      const rows = 4, h = px / rows, cols = 6, w = px / cols;
      for (let y = 0; y < rows; y++) {
        const off = (y % 2) * w * 0.5;
        for (let x = -1; x <= cols; x++) {
          const s = r();
          c.fillStyle = s < 0.5 ? `rgba(0,0,0,${0.02 + s * 0.08})` : `rgba(255,220,190,${0.02 + (s - 0.5) * 0.08})`;
          c.fillRect(x * w + off, y * h, w - 0.8, h);
        }
        c.fillStyle = 'rgba(0,0,0,0.16)';
        c.fillRect(0, y * h + h - 1.4, px, 1.4);
      }
    },
  },
  /** ripples; animated with animateWater */
  water: {
    m: 8,
    px: 128,
    paint(c, px, r) {
      for (let i = 0; i < 70; i++) {
        const x = r() * px, y = r() * px, w = 8 + r() * 18;
        c.strokeStyle = r() < 0.6 ? `rgba(255,255,255,${0.05 + r() * 0.07})` : `rgba(0,20,40,${0.05 + r() * 0.06})`;
        c.lineWidth = 0.7 + r() * 1;
        c.beginPath();
        c.moveTo(x, y);
        c.quadraticCurveTo(x + w / 2, y + (r() - 0.5) * 4, x + w, y);
        c.stroke();
        // wrap horizontally so the tile is seamless
        if (x + w > px) {
          c.beginPath();
          c.moveTo(x - px, y);
          c.quadraticCurveTo(x - px + w / 2, y, x - px + w, y);
          c.stroke();
        }
      }
    },
  },
  /** sparse diagonal highlight streaks, drifted independently of `water` for shimmer */
  waterShimmer: {
    m: 11,
    px: 140,
    paint(c, px, r) {
      for (let i = 0; i < 22; i++) {
        const x = r() * px, y = r() * px, w = 12 + r() * 26;
        c.strokeStyle = `rgba(255,255,255,${0.05 + r() * 0.1})`;
        c.lineWidth = 0.5 + r() * 1;
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + w, y + (r() - 0.5) * 3);
        c.stroke();
        if (x + w > px) {
          c.beginPath();
          c.moveTo(x - px, y);
          c.lineTo(x - px + w, y + (r() - 0.5) * 3);
          c.stroke();
        }
      }
    },
  },
} satisfies Record<string, TexDef>;

export type TexKind = keyof typeof DEFS;

const cache = new Map<string, CanvasPattern>();
/** kinds animated each frame by `animateWater`, with their own drift speed (m/s) */
const ANIM_SPEED: Partial<Record<TexKind, [number, number]>> = { water: [0.35, 0.12], waterShimmer: [-0.7, 0.2] };
const animPatterns: Partial<Record<TexKind, CanvasPattern[]>> = {};

/**
 * A repeating pattern of texture `kind` baked over `base` (any CSS colour).
 * Cached, so it is cheap to call during build.
 */
export function texture(kind: TexKind, base: string): CanvasPattern {
  const key = kind + '|' + base;
  let p = cache.get(key);
  if (p) return p;
  const def: TexDef = DEFS[kind];
  const cv = document.createElement('canvas');
  cv.width = cv.height = def.px;
  const c = cv.getContext('2d')!;
  c.fillStyle = base;
  c.fillRect(0, 0, def.px, def.px);
  let seed = 0;
  for (const ch of kind) seed = seed * 31 + ch.charCodeAt(0);
  def.paint(c, def.px, rng(seed));
  p = c.createPattern(cv, 'repeat')!;
  p.setTransform(new DOMMatrix().scale(def.m / def.px));
  cache.set(key, p);
  if (ANIM_SPEED[kind]) (animPatterns[kind] ??= []).push(p);
  return p;
}

/** call once per frame to drift the water/shimmer ripples, each at its own speed */
export function animateWater(nowMs: number) {
  const t = nowMs / 1000;
  for (const kind in animPatterns) {
    const list = animPatterns[kind as TexKind]!;
    const d = DEFS[kind as TexKind];
    const [sx, sy] = ANIM_SPEED[kind as TexKind]!;
    const m = new DOMMatrix().translate((t * sx) % d.m, (t * sy) % d.m).scale(d.m / d.px);
    for (const p of list) p.setTransform(m);
  }
}
