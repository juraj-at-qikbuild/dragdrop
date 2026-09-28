// Rectangle arithmetic for a toroidal pixel buffer (GroundCache): a canvas of cw x ch pixels holding a
// cw x ch window of an unbounded plane of "global" pixels, global (gx, gy) stored at (gx mod cw,
// gy mod ch). Following a moving view then means drawing only the strips that came into the window;
// what's already there stays where it is. All coordinates are whole pixels; rects are half-open.

export interface IRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** a piece of a global rect that is contiguous in the buffer: global origin (gx, gy), buffer origin
 *  (u, v), size w x h */
export interface Piece {
  gx: number;
  gy: number;
  u: number;
  v: number;
  w: number;
  h: number;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Splits one axis's span [a0, a1) (at most n long) where it wraps: [global start, buffer start, length][] */
function spans(a0: number, a1: number, n: number): [number, number, number][] {
  const len = a1 - a0;
  if (len <= 0) return [];
  const u = mod(a0, n);
  if (u + len <= n) return [[a0, u, len]];
  return [
    [a0, u, n - u],
    [a0 + n - u, 0, len - (n - u)],
  ];
}

/** The pieces (at most 4) of global rect `r`, no larger than the buffer, in a cw x ch toroidal buffer. */
export function wrapPieces(r: IRect, cw: number, ch: number): Piece[] {
  const out: Piece[] = [];
  for (const [gx, u, w] of spans(r.x0, r.x1, cw))
    for (const [gy, v, h] of spans(r.y0, r.y1, ch)) out.push({ gx, gy, u, v, w, h });
  return out;
}

/** Where the buffer's window goes to keep `view` (a global rect) at least `m / 4` inside it, and the
 *  global rects that came into it and must be drawn (none when the view is well inside already). The
 *  window is cw x ch with a margin m round the view on each side (cw = view width + 2m); it moves on
 *  each axis separately, recentred on the view, so the strips drawn are at least m / 4 wide. With no
 *  window yet (or none overlapping the new one) the whole window is drawn. */
export function follow(win: IRect | null, view: IRect, m: number, cw: number, ch: number): { win: IRect; draw: IRect[] } {
  const q = m / 4;
  const moveX = !win || view.x0 < win.x0 + q || view.x1 > win.x1 - q;
  const moveY = !win || view.y0 < win.y0 + q || view.y1 > win.y1 - q;
  if (win && !moveX && !moveY) return { win, draw: [] };
  const x0 = moveX ? view.x0 - m : win!.x0, y0 = moveY ? view.y0 - m : win!.y0;
  const next = { x0, y0, x1: x0 + cw, y1: y0 + ch };
  if (!win || next.x0 >= win.x1 || next.x1 <= win.x0 || next.y0 >= win.y1 || next.y1 <= win.y0) return { win: next, draw: [next] };
  // what of `next` isn't in `win`: a vertical strip the full height, and a horizontal strip across the rest
  const draw: IRect[] = [];
  const ix0 = Math.max(next.x0, win.x0), ix1 = Math.min(next.x1, win.x1);
  if (next.x0 < ix0) draw.push({ x0: next.x0, y0: next.y0, x1: ix0, y1: next.y1 });
  if (next.x1 > ix1) draw.push({ x0: ix1, y0: next.y0, x1: next.x1, y1: next.y1 });
  const iy0 = Math.max(next.y0, win.y0), iy1 = Math.min(next.y1, win.y1);
  if (next.y0 < iy0) draw.push({ x0: ix0, y0: next.y0, x1: ix1, y1: iy0 });
  if (next.y1 > iy1) draw.push({ x0: ix0, y0: iy1, x1: ix1, y1: next.y1 });
  return { win: next, draw };
}
