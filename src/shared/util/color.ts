import { clamp } from './math';

/** Lighten (amt > 0) or darken (amt < 0) a '#rrggbb' colour; cached. */
const shadeCache = new Map<string, string>();
export function shade(hex: string, amt: number) {
  const key = hex + amt;
  let r = shadeCache.get(key);
  if (r) return r;
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(clamp(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt, 0, 255));
  r = `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  shadeCache.set(key, r);
  return r;
}

/** `shade`, as a '#rrggbb' colour again (so it can be shaded further) */
export function shadeHex(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(clamp(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt, 0, 255));
  return '#' + ((f(n >> 16) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255)).toString(16).padStart(6, '0');
}
