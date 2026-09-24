import type { World, Building } from './World';
import { bboxOf, bboxHit, rng, type BBox } from '../util/math';
import { ROOF_ADS } from '../data/brands';

const CHUNK = 128;

type DrawOp = { kind: 'fill'; color: string } | { kind: 'stroke'; color: string; width: number; dash?: number[] };

interface Layer {
  op: DrawOp;
  order: number;
}

interface Chunk {
  bbox: BBox;
  cx: number;
  cy: number;
  layers: Map<string, Path2D>;
  /** building groups: key `${heightBin}|${wall}|${roof}` */
  bgroups: { h: number; wall: string; wallDark: string; roof: string; path: Path2D; outline: Path2D; rings: Float32Array[] }[];
}

export interface View {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  camX: number;
  camY: number;
  /** virtual camera height used for the fake-3D building extrusion */
  camH: number;
  scale: number;
}

const AREA_COLORS: Record<string, string> = {
  plaza: '#cdc3ad',
  parking: '#9c9992',
  rail: '#a39c90',
  pitch: '#7aa75a',
  sand: '#dccb8e',
  green: '#86a860',
  wood: '#5e8948',
  water: '#3a6f93',
};
const AREA_ORDER = ['plaza', 'parking', 'rail', 'pitch', 'sand', 'green', 'wood', 'water'];

const ROAD_FILL = ['#3f4045', '#414247', '#45464b', '#47484d', '#4a4b50', '#4d4e52', '#555558', '#58595c', '#d6ccb4', '#c8bca1', '#a69a7f'];
const ROAD_CASING = ['#6d6a64', '#6d6a64', '#76736d', '#76736d', '#7a7771', '#7d7a74', '#8a867f', '#8a867f', '#b5aa92', '', ''];

const ROOFS = ['#b0583a', '#a04d33', '#b86b4b', '#8b8580', '#7b7772', '#6a6d72', '#94613f', '#b2a28e'];
const FLAT_ROOFS = ['#9fa2a5', '#b3b4b3', '#8e9196', '#a7a39b'];

export class Renderer {
  private chunks: Chunk[] = [];
  private layers = new Map<string, Layer>();
  ads: { b: Building; ad: (typeof ROOF_ADS)[number]; chunk: Chunk; h: number; angle: number; w: number; len: number }[] = [];

  constructor(private world: World) {
    this.build();
  }

  private chunkAt(bbox: BBox, map: Map<number, Chunk>) {
    const cx = Math.floor((bbox.x0 + bbox.x1) / 2 / CHUNK);
    const cy = Math.floor((bbox.y0 + bbox.y1) / 2 / CHUNK);
    const k = (cx + 500) * 1000 + cy + 500;
    let c = map.get(k);
    if (!c) {
      c = {
        bbox: { x0: cx * CHUNK, y0: cy * CHUNK, x1: (cx + 1) * CHUNK, y1: (cy + 1) * CHUNK },
        cx: (cx + 0.5) * CHUNK,
        cy: (cy + 0.5) * CHUNK,
        layers: new Map(),
        bgroups: [],
      };
      map.set(k, c);
      this.chunks.push(c);
    }
    c.bbox.x0 = Math.min(c.bbox.x0, bbox.x0);
    c.bbox.y0 = Math.min(c.bbox.y0, bbox.y0);
    c.bbox.x1 = Math.max(c.bbox.x1, bbox.x1);
    c.bbox.y1 = Math.max(c.bbox.y1, bbox.y1);
    return c;
  }

  private path(chunk: Chunk, key: string, op: DrawOp, order: number) {
    if (!this.layers.has(key)) this.layers.set(key, { op, order });
    let p = chunk.layers.get(key);
    if (!p) chunk.layers.set(key, (p = new Path2D()));
    return p;
  }

  private build() {
    const w = this.world;
    const map = new Map<number, Chunk>();
    const addPoly = (p: Path2D, flat: ArrayLike<number>, close: boolean) => {
      p.moveTo(flat[0], flat[1]);
      for (let i = 2; i < flat.length; i += 2) p.lineTo(flat[i], flat[i + 1]);
      if (close) p.closePath();
    };

    // areas
    AREA_ORDER.forEach((kind, i) => {
      for (const rings of w.data.areas[kind as keyof typeof w.data.areas]) {
        const c = this.chunkAt(bboxOf(rings[0]), map);
        const p = this.path(c, 'a:' + kind, { kind: 'fill', color: AREA_COLORS[kind] }, i);
        for (const r of rings) addPoly(p, r, true);
      }
    });

    // roads: casing and fill per (bridge, class, width) group
    for (const r of w.data.roads) {
      const bridge = r.b ? 1 : 0;
      const wq = Math.round(r.w * 2) / 2;
      const base = 100 + bridge * 100;
      const c = this.chunkAt(bboxOf(r.p, r.w), map);
      if (bridge) {
        addPoly(this.path(c, `bc:${wq}`, { kind: 'stroke', color: '#2b2b2e', width: wq + 3 }, base + 1), r.p, false);
        addPoly(this.path(c, `br:${wq}`, { kind: 'stroke', color: '#8f8b84', width: wq + 1.6 }, base + 2), r.p, false);
      } else if (ROAD_CASING[r.c]) {
        addPoly(this.path(c, `c:${r.c}:${wq}`, { kind: 'stroke', color: ROAD_CASING[r.c], width: wq + 1.2 }, base + 10 - r.c * 0.1), r.p, false);
      }
      addPoly(this.path(c, `f${bridge}:${r.c}:${wq}`, { kind: 'stroke', color: ROAD_FILL[r.c], width: wq }, base + 30 - r.c * 0.1), r.p, false);
      if (r.c <= 5 && r.w >= 7) {
        const key = r.o ? `m${bridge}:lane` : `m${bridge}:center`;
        addPoly(
          this.path(c, key, { kind: 'stroke', color: r.o ? 'rgba(255,255,255,0.55)' : '#e8e2c8', width: 0.18, dash: [3, 5] }, base + 50),
          r.p,
          false,
        );
      }
    }

    // tram tracks: two rails drawn as a thick stroke with a road-coloured core
    for (const t of w.data.trams) {
      const c = this.chunkAt(bboxOf(t, 2), map);
      addPoly(this.path(c, 't:rail', { kind: 'stroke', color: '#2d2d30', width: 1.75 }, 260), t, false);
      addPoly(this.path(c, 't:bed', { kind: 'stroke', color: '#6b6760', width: 1.45 }, 261), t, false);
      addPoly(this.path(c, 't:wire', { kind: 'stroke', color: 'rgba(20,20,20,0.35)', width: 0.06 }, 262), t, false);
    }

    // buildings grouped by chunk, height bin and colour
    const groups = new Map<Chunk, Map<string, Chunk['bgroups'][number]>>();
    for (const b of w.buildings) {
      const c = this.chunkAt(b.bbox, map);
      const r = rng(b.seed * 7919);
      const bin = b.kind === 4 ? 0.6 : Math.min(14, Math.round(b.levels));
      let wall = '#857a6d', roof = ROOFS[(r() * ROOFS.length) | 0];
      if (b.kind === 3 || (b.area > 2500 && b.levels >= 4)) (wall = '#767b82'), (roof = FLAT_ROOFS[(r() * FLAT_ROOFS.length) | 0]);
      if (b.levels >= 8) (wall = '#6c7179'), (roof = FLAT_ROOFS[(r() * FLAT_ROOFS.length) | 0]);
      if (b.kind === 1) (wall = '#cfc6b4'), (roof = r() < 0.6 ? '#5c8a73' : '#8c4a36');
      if (b.kind === 2) (wall = '#e9e3d6'), (roof = '#b8553a');
      if (b.kind === 4) (wall = 'rgba(80,80,80,0.5)'), (roof = 'rgba(150,150,150,0.55)');
      if (b.color) (roof = b.color), (wall = b.wallColor ?? wall);
      const key = `${bin}|${wall}|${roof}`;
      let gm = groups.get(c);
      if (!gm) groups.set(c, (gm = new Map()));
      let g = gm.get(key);
      if (!g) {
        g = { h: bin * 3.2, wall, wallDark: darken(wall), roof, path: new Path2D(), outline: new Path2D(), rings: [] };
        gm.set(key, g);
        c.bgroups.push(g);
      }
      for (const ring of b.rings) addPoly(g.path, ring, true);
      g.rings.push(...b.rings);
      addPoly(g.outline, b.rings[0], true);
    }
    for (const c of this.chunks) c.bgroups.sort((a, b) => a.h - b.h);

    // rooftop advertising on the biggest flat roofs (like GTA 2)
    const candidates = w.buildings
      .filter((b) => b.kind !== 1 && b.kind !== 2 && b.kind !== 4 && b.area > 900 && b.rings.length === 1)
      .sort((a, b) => b.area - a.area)
      .slice(0, 60);
    const rnd = rng(42);
    candidates.forEach((b, i) => {
      if (rnd() < 0.35) return;
      // orientation from the longest edge
      const ring = b.rings[0];
      let best = 0, angle = 0;
      for (let k = 0; k < ring.length - 2; k += 2) {
        const l = Math.hypot(ring[k + 2] - ring[k], ring[k + 3] - ring[k + 1]);
        if (l > best) (best = l), (angle = Math.atan2(ring[k + 3] - ring[k + 1], ring[k + 2] - ring[k]));
      }
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      const chunk = this.chunkAt(b.bbox, map);
      const len = Math.min(best * 0.7, Math.sqrt(b.area) * 1.1);
      this.ads.push({ b, ad: ROOF_ADS[i % ROOF_ADS.length], chunk, h: Math.min(14, Math.round(b.levels)) * 3.2, angle, w: len * 0.32, len });
    });
  }

  roofOffset(x: number, y: number, h: number, v: View): [number, number] {
    const hh = Math.min(h, v.camH * 0.6);
    const k = hh / (v.camH - hh);
    return [(x - v.camX) * k, (y - v.camY) * k];
  }

  drawGround(ctx: CanvasRenderingContext2D, v: View, detail = true) {
    const vis = this.chunks.filter((c) => bboxHit(c.bbox, v));
    const keys = [...this.layers.entries()].sort((a, b) => a[1].order - b[1].order);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [key, layer] of keys) {
      if (!detail && (key.startsWith('m') || key.startsWith('t:wire'))) continue;
      const op = layer.op;
      if (op.kind === 'fill') ctx.fillStyle = op.color;
      else {
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width;
        ctx.setLineDash(op.dash ?? []);
      }
      for (const c of vis) {
        const p = c.layers.get(key);
        if (!p) continue;
        if (op.kind === 'fill') ctx.fill(p, 'evenodd');
        else ctx.stroke(p);
      }
    }
    ctx.setLineDash([]);
  }

  /** Fake-3D buildings: walls are extruded from the footprint towards the shifted roof. */
  drawBuildings(ctx: CanvasRenderingContext2D, v: View) {
    const vis = this.chunks.filter((c) => bboxHit(c.bbox, { x0: v.x0 - 60, y0: v.y0 - 60, x1: v.x1 + 60, y1: v.y1 + 60 }));
    // draw far chunks first so nearer tall roofs overlap them
    vis.sort((a, b) => Math.hypot(b.cx - v.camX, b.cy - v.camY) - Math.hypot(a.cx - v.camX, a.cy - v.camY));
    ctx.lineJoin = 'miter';
    for (const c of vis) {
      for (const g of c.bgroups) {
        const [ox, oy] = this.roofOffset(c.cx, c.cy, g.h, v);
        const px = Math.hypot(ox, oy) * v.scale;
        ctx.save();
        if (px > 0.6) {
          // extruded walls: one quad per footprint edge, wound consistently so
          // a single nonzero fill covers them; edges are split into two tones
          const lit = new Path2D(), dark = new Path2D();
          for (const r of g.rings) {
            for (let i = 0; i < r.length - 2; i += 2) {
              const ax = r[i], ay = r[i + 1], bx = r[i + 2], by = r[i + 3];
              const ex = bx - ax, ey = by - ay;
              const p = Math.abs(ex) > Math.abs(ey) ? dark : lit;
              if (ex * oy - ey * ox >= 0) {
                p.moveTo(ax, ay);
                p.lineTo(bx, by);
                p.lineTo(bx + ox, by + oy);
                p.lineTo(ax + ox, ay + oy);
              } else {
                p.moveTo(ax, ay);
                p.lineTo(ax + ox, ay + oy);
                p.lineTo(bx + ox, by + oy);
                p.lineTo(bx, by);
              }
              p.closePath();
            }
          }
          ctx.fillStyle = g.wall;
          ctx.fill(lit);
          ctx.fillStyle = g.wallDark;
          ctx.fill(dark);
        }
        ctx.translate(ox, oy);
        ctx.fillStyle = g.roof;
        ctx.fill(g.path, 'evenodd');
        ctx.strokeStyle = 'rgba(0,0,0,0.28)';
        ctx.lineWidth = 0.35;
        ctx.stroke(g.outline);
        ctx.restore();
      }
    }
    this.drawAds(ctx, v);
  }

  private drawAds(ctx: CanvasRenderingContext2D, v: View) {
    for (const a of this.ads) {
      if (!bboxHit(a.b.bbox, v)) continue;
      const [ox, oy] = this.roofOffset(a.chunk.cx, a.chunk.cy, a.h, v);
      ctx.save();
      ctx.translate(a.b.cx + ox, a.b.cy + oy);
      ctx.rotate(a.angle);
      const w = a.len, h = a.w;
      ctx.fillStyle = a.ad.bg;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = a.ad.accent;
      ctx.lineWidth = h * 0.08;
      ctx.strokeRect(-w / 2 + h * 0.08, -h / 2 + h * 0.08, w - h * 0.16, h - h * 0.16);
      ctx.fillStyle = a.ad.fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 ${h * 0.42}px "Arial Black", Impact, sans-serif`;
      fitText(ctx, a.ad.title, 0, -h * 0.08, w * 0.9);
      ctx.font = `italic 700 ${h * 0.16}px Arial, sans-serif`;
      fitText(ctx, a.ad.slogan, 0, h * 0.28, w * 0.9);
      ctx.restore();
    }
  }

  /** Flat 2D rendering of all buildings, for the pause map. */
  drawBuildingsFlat(ctx: CanvasRenderingContext2D) {
    for (const c of this.chunks)
      for (const g of c.bgroups) {
        ctx.fillStyle = g.roof;
        ctx.fill(g.path, 'evenodd');
      }
  }
}

function darken(c: string) {
  if (!c.startsWith('#')) return c;
  const n = parseInt(c.slice(1), 16);
  const f = (v: number) => Math.round(v * 0.78);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number) {
  const m = ctx.measureText(text).width;
  if (m > maxW) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(maxW / m, 1);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  } else ctx.fillText(text, x, y);
}
