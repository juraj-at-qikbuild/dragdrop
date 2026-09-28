// The ground cache's toroidal buffer arithmetic (src/world/toroid.ts): a rect splits where it wraps
// into pieces that tile it exactly, and following a view draws exactly the part of the new window that
// wasn't in the old one, so every pixel on screen is always drawn once and only once.
import { describe, expect, it } from 'vitest';
import { follow, wrapPieces, type IRect } from '../../src/world/toroid';

const area = (r: IRect) => (r.x1 - r.x0) * (r.y1 - r.y0);
const inside = (x: number, y: number, r: IRect) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;

describe('wrapPieces', () => {
  it('tiles the rect, each piece contiguous in the buffer at its global position mod the size', () => {
    const cw = 100, ch = 70;
    for (const r of [
      { x0: 0, y0: 0, x1: 100, y1: 70 },
      { x0: -30, y0: 55, x1: 40, y1: 90 },
      { x0: 1234, y0: -987, x1: 1300, y1: -930 },
      { x0: 95, y0: 65, x1: 105, y1: 75 },
    ]) {
      const ps = wrapPieces(r, cw, ch);
      expect(ps.reduce((s, p) => s + p.w * p.h, 0)).toBe(area(r));
      for (const p of ps) {
        expect(p.u).toBe((((p.gx % cw) + cw) % cw));
        expect(p.v).toBe((((p.gy % ch) + ch) % ch));
        expect(p.u + p.w).toBeLessThanOrEqual(cw);
        expect(p.v + p.h).toBeLessThanOrEqual(ch);
        expect(p.w).toBeGreaterThan(0);
        expect(p.h).toBeGreaterThan(0);
      }
    }
    expect(wrapPieces({ x0: 95, y0: 65, x1: 105, y1: 75 }, cw, ch)).toHaveLength(4);
  });
});

describe('follow', () => {
  const W = 320, H = 200, M = 64, cw = W + 2 * M, ch = H + 2 * M;
  const view = (x: number, y: number): IRect => ({ x0: x, y0: y, x1: x + W, y1: y + H });

  it('draws the whole window at first, then nothing while the view stays well inside', () => {
    const a = follow(null, view(0, 0), M, cw, ch);
    expect(a.draw).toEqual([a.win]);
    expect(a.win).toEqual({ x0: -M, y0: -M, x1: W + M, y1: H + M });
    expect(follow(a.win, view(10, -10), M, cw, ch).draw).toEqual([]);
  });

  it('draws exactly the new part of the window as the view wanders, and the view is always in it', () => {
    let win: IRect | null = null;
    let x = 0, y = 0;
    const path: [number, number][] = [];
    for (let i = 0; i < 400; i++) {
      x += Math.round(Math.sin(i * 0.07) * 23);
      y += Math.round(Math.cos(i * 0.05) * 17);
      path.push([x, y]);
    }
    path.push([5000, -3000]); // a teleport
    for (const [vx, vy] of path) {
      const prev = win;
      const r = follow(win, view(vx, vy), M, cw, ch);
      win = r.win;
      const v = view(vx, vy);
      expect(v.x0).toBeGreaterThanOrEqual(win.x0);
      expect(v.x1).toBeLessThanOrEqual(win.x1);
      expect(v.y0).toBeGreaterThanOrEqual(win.y0);
      expect(v.y1).toBeLessThanOrEqual(win.y1);
      expect(win.x1 - win.x0).toBe(cw);
      expect(win.y1 - win.y0).toBe(ch);
      // drawn rects: inside the new window, disjoint, and together with the old window's overlap they
      // cover the new window exactly
      const drawn = r.draw.reduce((s, d) => s + area(d), 0);
      const ov = prev ? Math.max(0, Math.min(win.x1, prev.x1) - Math.max(win.x0, prev.x0)) * Math.max(0, Math.min(win.y1, prev.y1) - Math.max(win.y0, prev.y0)) : 0;
      if (r.draw.length) expect(drawn + ov).toBe(area(win));
      for (const d of r.draw) {
        expect(d.x0 >= win.x0 && d.x1 <= win.x1 && d.y0 >= win.y0 && d.y1 <= win.y1).toBe(true);
        // (nothing already in the old window is drawn again)
        if (prev && ov) for (const [cx, cy] of [[d.x0, d.y0], [d.x1 - 1, d.y1 - 1], [d.x0, d.y1 - 1], [d.x1 - 1, d.y0]]) expect(inside(cx, cy, prev)).toBe(false);
      }
    }
  });
});
