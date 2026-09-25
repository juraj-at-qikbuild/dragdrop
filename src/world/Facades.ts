// Procedural building facades: window/door tiles baked once onto small offscreen
// canvases and reused as CanvasPattern fillStyle. One tile = one window bay wide,
// one storey tall (upper floors) or one bay wide, one storey tall (ground floor,
// wider bay for doors/shopfronts). Callers map pattern pixels into the wall-quad's
// own (bay-metres, storey) axes via ctx.transform, so a tile always lands as
// one bay per level regardless of the building's own scale/rotation.

import { rng } from '../shared/util/math';

export type FacadeStyle = 'oldtown' | 'panel' | 'office' | 'industrial';

/** bay width in metres for upper-floor windows, per style */
export const BAY_W: Record<FacadeStyle, number> = { oldtown: 3.4, panel: 3.1, office: 2.7, industrial: 4.4 };
/** ground-floor bay width (doors/shopfronts read wider than upper windows) */
export const GROUND_BAY_W: Record<FacadeStyle, number> = { oldtown: 3.4, panel: 4.6, office: 4.2, industrial: 4.4 };

const PXW = 64, PXH = 96;
const GPXW = 72, GPXH = 96;

type RGB = [number, number, number];
function num(color: string): RGB {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1, 7), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const m = color.match(/[\d.]+/g);
  return m ? [+m[0], +m[1], +m[2]] : [200, 197, 190];
}
function rgb(c: RGB, a = 1) {
  return a < 1 ? `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})` : `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
}
function lighten(c: RGB, f: number): RGB {
  return [c[0] + (255 - c[0]) * f, c[1] + (255 - c[1]) * f, c[2] + (255 - c[2]) * f];
}
function darken(c: RGB, f: number): RGB {
  return [c[0] * (1 - f), c[1] * (1 - f), c[2] * (1 - f)];
}
function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
/** warm or cool lit-window glow, mixed a little per call for variety */
function litGlass(r: () => number) {
  return r() < 0.65 ? `rgba(255,${205 + ((r() * 30) | 0)},140,0.9)` : `rgba(200,225,255,0.75)`;
}

const cache = new Map<string, CanvasPattern>();
/** null = the tile has no lit glass at all, so the additive night pass can skip it */
const glowCache = new Map<string, CanvasPattern | null>();

/** Pull just the lit-glass pixels out of an already-painted tile into a
 *  transparent-background copy, so it can be redrawn additively after the
 *  night light-map multiply without re-darkening the whole wall. Deriving it
 *  from the real tile (same seed) guarantees it lines up window-for-window. */
function extractGlow(cv: HTMLCanvasElement): HTMLCanvasElement | null {
  const w = cv.width, h = cv.height;
  const src = cv.getContext('2d')!.getImageData(0, 0, w, h);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const dst = octx.createImageData(w, h);
  const d = src.data, o = dst.data;
  let any = false;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const warm = r >= 245 && g >= 195 && g <= 245 && b >= 120 && b <= 165;
    const cool = r >= 190 && r <= 212 && g >= 215 && g <= 235 && b >= 245;
    if (warm || cool) {
      (o[i] = r), (o[i + 1] = g), (o[i + 2] = b), (o[i + 3] = 255);
      any = true;
    } else o[i + 3] = 0;
  }
  if (!any) return null;
  octx.putImageData(dst, 0, 0);
  return out;
}

/** Upper-storey window tile for a wall (one tile = one bay wide, one level tall). */
export function facadeTexture(style: FacadeStyle, wall: string, variant: number, lit: boolean): CanvasPattern {
  const key = `f|${style}|${wall}|${variant}|${lit ? 1 : 0}`;
  let p = cache.get(key);
  if (p) return p;
  const cv = document.createElement('canvas');
  cv.width = PXW;
  cv.height = PXH;
  const c = cv.getContext('2d')!;
  paintUpper(c, style, num(wall), variant, lit, rng(hashStr(key)));
  p = c.createPattern(cv, 'repeat')!;
  p.setTransform(new DOMMatrix().scale(BAY_W[style] / PXW, 1 / PXH));
  cache.set(key, p);
  return p;
}

/** Ground-floor band tile: a door bay, or (when `shop`) a glazed shopfront with an awning. */
export function groundTexture(style: FacadeStyle, wall: string, variant: number, lit: boolean, shop: boolean): CanvasPattern {
  const key = `g|${style}|${wall}|${variant}|${lit ? 1 : 0}|${shop ? 1 : 0}`;
  let p = cache.get(key);
  if (p) return p;
  const cv = document.createElement('canvas');
  cv.width = GPXW;
  cv.height = GPXH;
  const c = cv.getContext('2d')!;
  paintGround(c, style, num(wall), variant, shop, lit, rng(hashStr(key)));
  p = c.createPattern(cv, 'repeat')!;
  p.setTransform(new DOMMatrix().scale(GROUND_BAY_W[style] / GPXW, 1 / GPXH));
  cache.set(key, p);
  return p;
}

/** Glow-only upper-storey tile (transparent except lit windows): same seed as the
 *  real lit tile, so it redraws exactly over the windows that are actually lit. */
export function facadeGlow(style: FacadeStyle, wall: string, variant: number): CanvasPattern | null {
  const key = `fg|${style}|${wall}|${variant}`;
  let p = glowCache.get(key);
  if (p !== undefined) return p;
  const cv = document.createElement('canvas');
  cv.width = PXW;
  cv.height = PXH;
  const c = cv.getContext('2d')!;
  paintUpper(c, style, num(wall), variant, true, rng(hashStr(`f|${style}|${wall}|${variant}|1`)));
  const glow = extractGlow(cv);
  p = glow && c.createPattern(glow, 'repeat');
  p?.setTransform(new DOMMatrix().scale(BAY_W[style] / PXW, 1 / PXH));
  glowCache.set(key, p);
  return p;
}

/** Glow-only ground-floor band tile (door or shopfront). */
export function groundGlow(style: FacadeStyle, wall: string, variant: number, shop: boolean): CanvasPattern | null {
  const key = `gg|${style}|${wall}|${variant}|${shop ? 1 : 0}`;
  let p = glowCache.get(key);
  if (p !== undefined) return p;
  const cv = document.createElement('canvas');
  cv.width = GPXW;
  cv.height = GPXH;
  const c = cv.getContext('2d')!;
  paintGround(c, style, num(wall), variant, shop, true, rng(hashStr(`g|${style}|${wall}|${variant}|1|${shop ? 1 : 0}`)));
  const glow = extractGlow(cv);
  p = glow && c.createPattern(glow, 'repeat');
  p?.setTransform(new DOMMatrix().scale(GROUND_BAY_W[style] / GPXW, 1 / GPXH));
  glowCache.set(key, p);
  return p;
}

function paintUpper(c: CanvasRenderingContext2D, style: FacadeStyle, base: RGB, variant: number, lit: boolean, r: () => number) {
  c.fillStyle = rgb(base);
  c.fillRect(0, 0, PXW, PXH);

  if (style === 'oldtown') {
    for (let i = 0; i < 8; i++) {
      c.fillStyle = `rgba(0,0,0,${0.02 + r() * 0.03})`;
      c.fillRect(r() * PXW, r() * PXH, 4 + r() * 8, 4 + r() * 8);
    }
    const winW = PXW * 0.42, winX = (PXW - winW) / 2, winH = PXH * 0.5, winY = PXH * 0.22, rad = winW * 0.5;
    c.fillStyle = rgb(lighten(base, 0.5));
    c.beginPath();
    c.moveTo(winX - 3, winY + rad);
    c.arc(winX + rad - 3, winY + rad, rad + 3, Math.PI, 0);
    c.lineTo(winX + winW + 3, winY + winH + 3);
    c.lineTo(winX - 3, winY + winH + 3);
    c.closePath();
    c.fill();
    c.fillStyle = lit ? litGlass(r) : 'rgba(38,52,66,0.88)';
    c.beginPath();
    c.moveTo(winX, winY + rad);
    c.arc(winX + rad, winY + rad, rad, Math.PI, 0);
    c.lineTo(winX + winW, winY + winH);
    c.lineTo(winX, winY + winH);
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.32)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(winX + winW / 2, winY);
    c.lineTo(winX + winW / 2, winY + winH);
    c.moveTo(winX, winY + winH * 0.42);
    c.lineTo(winX + winW, winY + winH * 0.42);
    c.stroke();
    c.fillStyle = rgb(darken(base, 0.25));
    c.fillRect(winX - 5, winY + winH + 3, winW + 10, 3);
    if (variant === 1) {
      c.fillStyle = 'rgba(52,94,60,0.85)';
      c.fillRect(winX - 9, winY, 5, winH);
      c.fillRect(winX + winW + 4, winY, 5, winH);
    } else if (variant === 2) {
      c.fillStyle = 'rgba(0,0,0,0.06)';
      c.fillRect(0, PXH - 3, PXW, 3);
    }
  } else if (style === 'panel') {
    const winW = PXW * 0.34, gap = PXW * 0.1, winH = PXH * 0.4, winY = PXH * 0.1;
    for (let k = 0; k < 2; k++) {
      const wx = PXW * 0.08 + k * (winW + gap);
      c.fillStyle = rgb(lighten(base, 0.35));
      c.fillRect(wx - 2, winY - 2, winW + 4, winH + 4);
      c.fillStyle = lit && r() < 0.72 ? litGlass(r) : 'rgba(40,48,56,0.82)';
      c.fillRect(wx, winY, winW, winH);
    }
    const balY = winY + winH + 8, balH = PXH * 0.14;
    const balconyColors: RGB[] = [[200, 110, 55], [70, 120, 130], [180, 170, 90]];
    c.fillStyle = variant > 0 && r() < 0.5 ? rgb(balconyColors[variant % balconyColors.length], 0.85) : 'rgba(0,0,0,0.14)';
    c.fillRect(PXW * 0.03, balY, PXW * 0.94, balH);
    c.strokeStyle = 'rgba(255,255,255,0.28)';
    c.lineWidth = 0.9;
    for (let i = 0; i <= 5; i++) {
      const x = PXW * 0.06 + (i * PXW * 0.88) / 5;
      c.beginPath();
      c.moveTo(x, balY);
      c.lineTo(x, balY + balH);
      c.stroke();
    }
    c.strokeStyle = 'rgba(0,0,0,0.1)';
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(PXW - 0.5, 0);
    c.lineTo(PXW - 0.5, PXH);
    c.stroke();
  } else if (style === 'office') {
    const grad = c.createLinearGradient(0, 0, 0, PXH);
    grad.addColorStop(0, 'rgba(165,205,225,0.55)');
    grad.addColorStop(0.5, rgb(base, 0.92));
    grad.addColorStop(1, 'rgba(90,120,150,0.55)');
    c.fillStyle = grad;
    c.fillRect(0, 0, PXW, PXH);
    c.fillStyle = lit && r() < 0.55 ? litGlass(r) : 'rgba(210,235,245,0.3)';
    c.fillRect(PXW * 0.06, PXH * 0.05, PXW * 0.88, PXH * 0.9);
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.lineWidth = 1.4;
    c.strokeRect(0.5, 0.5, PXW - 1, PXH - 1);
    c.beginPath();
    c.moveTo(PXW / 2, 0);
    c.lineTo(PXW / 2, PXH);
    c.stroke();
  } else {
    // industrial: brick/metal speckle, small sparse windows
    for (let i = 0; i < 36; i++) {
      c.fillStyle = r() < 0.5 ? `rgba(0,0,0,${0.03 + r() * 0.05})` : `rgba(255,255,255,${0.02 + r() * 0.04})`;
      c.fillRect(r() * PXW, r() * PXH, 2 + r() * 4, 1 + r() * 2);
    }
    c.strokeStyle = 'rgba(0,0,0,0.08)';
    c.lineWidth = 0.6;
    for (let y = 6; y < PXH; y += 9) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(PXW, y);
      c.stroke();
    }
    if (variant !== 1) {
      const s = PXW * 0.3;
      c.fillStyle = 'rgba(30,30,32,0.55)';
      c.fillRect(PXW * 0.35, PXH * 0.32, s, s);
      c.strokeStyle = 'rgba(0,0,0,0.4)';
      c.lineWidth = 2;
      c.strokeRect(PXW * 0.35, PXH * 0.32, s, s);
      if (lit && r() < 0.45) {
        c.fillStyle = litGlass(r);
        c.fillRect(PXW * 0.35, PXH * 0.32, s, s);
      }
    }
  }
}

function paintGround(c: CanvasRenderingContext2D, style: FacadeStyle, base: RGB, variant: number, shop: boolean, lit: boolean, r: () => number) {
  c.fillStyle = rgb(base);
  c.fillRect(0, 0, GPXW, GPXH);
  if (shop) {
    c.fillStyle = rgb(darken(base, 0.18));
    c.fillRect(4, GPXH * 0.16, GPXW - 8, GPXH * 0.76);
    c.fillStyle = lit ? litGlass(r) : 'rgba(60,82,96,0.85)';
    c.fillRect(8, GPXH * 0.24, GPXW - 16, GPXH * 0.5);
    // a couple of mullions splitting the shop window
    c.strokeStyle = 'rgba(20,24,28,0.5)';
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(GPXW * 0.5, GPXH * 0.24);
    c.lineTo(GPXW * 0.5, GPXH * 0.74);
    c.stroke();
    // awning stripe
    const stripes: [string, string][] = [['#c62828', '#fff'], ['#1565c0', '#fff'], ['#2e7d32', '#fff'], ['#f9a825', '#3e2723']];
    const [c1, c2] = stripes[(variant + ((r() * stripes.length) | 0)) % stripes.length];
    for (let i = 0; i < 6; i++) {
      c.fillStyle = i % 2 ? c1 : c2;
      c.fillRect((i * GPXW) / 6, 1, GPXW / 6 + 0.5, GPXH * 0.1);
    }
    c.fillStyle = 'rgba(0,0,0,0.1)';
    c.fillRect(0, GPXH * 0.1, GPXW, GPXH * 0.02);
    // kerb/step
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(0, GPXH * 0.93, GPXW, GPXH * 0.07);
  } else {
    const dw = GPXW * 0.34, dx = (GPXW - dw) / 2, dy = GPXH * 0.16, dh = GPXH * 0.78;
    c.fillStyle = rgb(darken(base, 0.22));
    c.fillRect(dx - 4, dy - 4, dw + 8, dh + 4);
    c.fillStyle = style === 'oldtown' ? '#4b3320' : style === 'panel' ? '#5c4a38' : '#33383d';
    c.fillRect(dx, dy, dw, dh);
    c.fillStyle = lit ? litGlass(r) : 'rgba(120,142,152,0.35)';
    c.fillRect(dx + dw * 0.14, dy + dh * 0.08, dw * 0.72, dh * 0.42);
    c.fillStyle = 'rgba(225,205,150,0.9)';
    c.beginPath();
    c.arc(dx + dw * 0.82, dy + dh * 0.55, 1.5, 0, Math.PI * 2);
    c.fill();
    // plaster reveal either side
    c.fillStyle = 'rgba(0,0,0,0.06)';
    c.fillRect(0, dy - 4, dx - 4, dh + 8);
    c.fillRect(dx + dw + 4, dy - 4, GPXW - (dx + dw + 4), dh + 8);
    // step
    c.fillStyle = 'rgba(0,0,0,0.32)';
    c.fillRect(dx - 6, dy + dh, dw + 12, GPXH * 0.05);
  }
}
