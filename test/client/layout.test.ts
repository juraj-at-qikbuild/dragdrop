// The HUD layout on phones (src/ui/layout.ts): nothing overlaps, nothing sits under a notch or a
// thumb, and desktop keeps the numbers it always had.
import { describe, expect, it } from 'vitest';
import { bandHeight, edgePoint, hudLayout, inPlay, NO_INSETS, panelHeight, type HudLayout, type Insets, type Rect } from '../../src/ui/layout';

/** phones and the safe-area insets they report (iPhones with a notch or island report both sides in
 *  landscape; an Android camera cutout just one) */
const cases: [number, number, Insets][] = [
  [915, 412, NO_INSETS], [915, 412, { l: 32, r: 0, t: 0, b: 0 }], [915, 412, { l: 0, r: 32, t: 0, b: 0 }],
  [844, 390, NO_INSETS], [844, 390, { l: 47, r: 47, t: 0, b: 21 }],
  [932, 430, { l: 59, r: 59, t: 0, b: 21 }], [852, 393, { l: 59, r: 59, t: 0, b: 21 }],
  [740, 360, NO_INSETS], [740, 360, { l: 28, r: 0, t: 0, b: 0 }], [667, 375, NO_INSETS],
  [390, 844, NO_INSETS], [390, 844, { l: 0, r: 0, t: 47, b: 34 }], [430, 932, { l: 0, r: 0, t: 59, b: 34 }], [360, 740, { l: 0, r: 0, t: 28, b: 0 }],
];

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** the HUD's pieces as rectangles */
function pieces(L: HudLayout): Record<string, Rect> {
  const m = L.mini, s = L.speedo;
  return {
    minimap: { x: m.cx - m.r, y: m.cy - m.r, w: 2 * m.r, h: 2 * m.r },
    buttons: { x: L.util.x, y: L.util.y, w: L.util.size, h: L.utilCount * (L.util.size + L.util.gap) - L.util.gap },
    panel: { x: L.panel.right - L.panel.w, y: L.panel.y, w: L.panel.w, h: panelHeight(L.small) },
    band: { x: L.band.cx - L.band.w / 2, y: L.band.top, w: L.band.w, h: bandHeight(L.small) },
    place: { x: L.place.x, y: L.place.y - 2 * L.place.lineH, w: 150, h: 2 * L.place.lineH },
    speedo: { x: s.cx - s.r, y: s.cy - s.r, w: 2 * s.r, h: 2 * s.r },
    leftThumb: L.thumbs!.left,
    rightThumb: L.thumbs!.right,
  };
}

describe('touch HUD layout', () => {
  for (const [W, H, ins] of cases)
      it(`${W}×${H} insets ${JSON.stringify(ins)}`, () => {
        const L = hudLayout(W, H, true, ins);
        expect(L.compact).toBe(true);
        const p = pieces(L);
        const names = Object.keys(p);
        for (let i = 0; i < names.length; i++)
          for (let j = i + 1; j < names.length; j++) {
            const [a, b] = [names[i], names[j]];
            if (a.endsWith('Thumb') && b.endsWith('Thumb')) continue; // in portrait the thumbs share the bottom
            expect(overlap(p[a], p[b]), `${a} overlaps ${b}`).toBe(false);
          }
        // inside the safe area
        for (const [n, r] of Object.entries(p)) {
          expect(r.x, n).toBeGreaterThanOrEqual(ins.l);
          expect(r.y, n).toBeGreaterThanOrEqual(ins.t);
          expect(r.x + r.w, n).toBeLessThanOrEqual(W - ins.r + 0.01);
          expect(r.y + r.h, n).toBeLessThanOrEqual(H - ins.b + 0.01);
        }
        // room for a hint prompt between the thumbs, and a readable objective band
        expect(L.prompt.w).toBeGreaterThanOrEqual(180);
        expect(L.band.w).toBeGreaterThanOrEqual(240);
        // the objective above the banners, the timer and messages under the objective
        expect(L.band.top).toBeGreaterThanOrEqual(L.objective.y + 40);
        expect(L.objective.timerY).toBeGreaterThan(L.objective.y + 40);
        expect(L.msgY).toBeGreaterThan(L.objective.y + 60);
        // prompts and the radio line stay clear of the thumbs
        const promptRow = (y: number) => ({ x: L.prompt.cx - L.prompt.w / 2, y: y - 14, w: L.prompt.w, h: 28 });
        for (const y of [L.prompt.foot, L.prompt.car])
          for (const t of [L.thumbs!.left, L.thumbs!.right]) expect(overlap(promptRow(y), t), `prompt at ${y}`).toBe(false);
        // off-screen arrows land where they can be seen
        for (let a = -Math.PI; a < Math.PI; a += 0.2) {
          const e = edgePoint(L, a);
          expect(inPlay(L, e.x, e.y), `arrow at ${a.toFixed(1)} rad`).toBe(true);
        }
      });
});

describe('desktop HUD layout', () => {
  it('keeps the old numbers', () => {
    const L = hudLayout(1280, 720, false);
    expect(L.small).toBe(false);
    expect(L.mini).toEqual({ cx: 16 + 88, cy: 720 - 16 - 88, r: 88 });
    expect(L.speedo).toEqual({ cx: 640, cy: 720 - 32 - 54 - 14, r: 54 });
    expect(L.prompt.foot).toBe(720 - 16 - 56);
    expect(L.prompt.car).toBe(720 - 176);
    expect(L.band.top).toBe(116);
    expect(L.msgY).toBeCloseTo(720 * 0.28);
    expect(edgePoint(L, 0)).toEqual({ x: 640 + 720 * 0.38, y: 360 });
    const S = hudLayout(600, 800, false);
    expect(S.small).toBe(true);
    expect(S.mini.r).toBe(60);
    expect(S.band.top).toBe(92);
  });
});
