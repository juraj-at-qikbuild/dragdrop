// Where the HUD goes. Pure (no DOM), so test/client/layout.test.ts can check phone screens for
// overlaps. Desktop (no touch) keeps the layout it always had; on a touch screen the thumbs own the
// bottom corners, so the minimap moves to the top-left with a column of small buttons beside it
// (pause, radio), the objective and banners use the gap between that and the top-right panel,
// and everything else keeps out of the thumbs' way. Insets are the notch / home-indicator safe area.

export interface Insets {
  l: number;
  r: number;
  t: number;
  b: number;
}
export const NO_INSETS: Insets = { l: 0, r: 0, t: 0, b: 0 };
/** round buttons beside the minimap on touch: pause, and the radio in a car */
const UTIL_COUNT = 2;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HudLayout {
  W: number;
  H: number;
  touch: boolean;
  /** a phone: the short side under 500 px (touch only) */
  compact: boolean;
  /** the small type sizes */
  small: boolean;
  portrait: boolean;
  /** edge padding per side, safe-area insets included */
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  /** the touch controls' size factor (1 = designed for a 400 px short side) */
  ts: number;
  mini: { cx: number; cy: number; r: number };
  /** touch: the column of round buttons right of the minimap (pause; the radio in a car) */
  util: { x: number; y: number; size: number; gap: number };
  /** ...how many it holds */
  utilCount: number;
  /** the top-right panel (money, stars, clock, health): right edge, top, width; its height varies */
  panel: { right: number; y: number; w: number };
  /** street and district: `y` is the district line's bottom, the street line sits `lineH` above */
  place: { x: number; y: number; align: CanvasTextAlign; lineH: number };
  /** the top-centre band shared by the objective, city-wide banners and the race/job panels */
  band: { cx: number; w: number; top: number };
  /** the mission objective's top and its timer's centre */
  objective: { y: number; timerY: number };
  /** the first message line */
  msgY: number;
  speedo: { cx: number; cy: number; r: number };
  /** hint prompts (and the radio line): centre x, centre y on foot and in a car, and the width they must fit */
  prompt: { cx: number; foot: number; car: number; w: number };
  /** radio text: its bottom and width */
  radio: { y: number; w: number };
  /** touch: where the thumbs rest (the stick's usual spot, the button cluster); the HUD keeps out */
  thumbs: { left: Rect; right: Rect } | null;
  /** what the off-screen arrows treat as "on screen" */
  play: Rect;
  /** touch: where the features' small panels stack (party, world events, the daily card, voice),
   *  under the street name; null on desktop, where each keeps its own corner */
  stack: { x: number; y: number } | null;
}

/** touch: the room the mission objective takes on the band's first line */
const OBJECTIVE_H = 48;
/** the top-right panel's height at its tallest (armour bar showing), see Hud.draw */
export const panelHeight = (small: boolean) => (small ? 86 : 106);
/** a banner at its tallest (title + two lines + margin), see Banners.bandBottom */
export const bandHeight = (small: boolean) => (small ? 30 : 36) + 2 * (small ? 15 : 17) + (small ? 10 : 12);

export function hudLayout(W: number, H: number, touch: boolean, insets: Insets = NO_INSETS): HudLayout {
  return touch ? touchLayout(W, H, insets) : desktopLayout(W, H);
}

function desktopLayout(W: number, H: number): HudLayout {
  const small = W < 700;
  const pad = small ? 10 : 16;
  const r = small ? 60 : 88;
  const speedoR = small ? 42 : 54;
  return {
    W, H, touch: false, compact: false, small, portrait: H > W,
    padL: pad, padR: pad, padT: pad, padB: pad, ts: 1,
    mini: { cx: pad + r, cy: H - pad - r, r },
    util: { x: 0, y: 0, size: 0, gap: 0 },
    utilCount: 0,
    panel: { right: W - pad, y: pad, w: small ? 168 : 214 },
    place: { x: W - pad, y: H - pad, align: 'right', lineH: small ? 20 : 26 },
    band: { cx: W / 2, w: W, top: small ? 92 : 116 },
    objective: { y: pad + (small ? 40 : 4), timerY: pad + (small ? 78 : 60) },
    msgY: H * 0.28,
    speedo: { cx: W / 2, cy: H - (small ? 26 : 32) - speedoR - 14, r: speedoR },
    prompt: { cx: W / 2, foot: H - pad - (small ? 44 : 56), car: H - (small ? 138 : 176), w: W - 2 * pad },
    radio: { y: H - pad - (small ? 40 : 10), w: Math.min(W * 0.6, 700) },
    thumbs: null,
    play: { x: 40, y: 40, w: W - 80, h: H - 80 },
    stack: null,
  };
}

function touchLayout(W: number, H: number, ins: Insets): HudLayout {
  const compact = Math.min(W, H) < 500;
  const small = W < 700 || compact;
  const portrait = H > W;
  const ts = Math.max(0.85, Math.min(1.15, Math.min(W, H) / 400));
  const padL = ins.l + 10, padR = ins.r + 10, padT = ins.t + 8, padB = ins.b + 8;
  const r = compact ? 48 : 64;
  const mini = { cx: padL + r, cy: padT + r, r };
  const util = { x: padL + 2 * r + 10, y: padT, size: Math.round(40 * ts), gap: 8 };
  const panel = { right: W - padR, y: padT, w: small ? 168 : 214 };
  const place = { x: padL, y: padT + 2 * r + (small ? 40 : 46), align: 'left' as CanvasTextAlign, lineH: small ? 18 : 22 };
  // the thumbs: the stick's usual spot bottom-left, the button cluster bottom-right
  const right = { x: W - padR - 250 * ts, y: H - padB - 215 * ts, w: 250 * ts, h: 215 * ts };
  const left = { x: padL, y: H - padB - 200 * ts, w: 220 * ts, h: 200 * ts };
  // the band: in landscape between the minimap column and the top-right panel (there's no height
  // to spare), in portrait its own row under both
  const leftCol = util.x + util.size + 10;
  const panelLeft = panel.right - panel.w - 10;
  const half = Math.min(W / 2 - leftCol, panelLeft - W / 2);
  const topRow = Math.max(place.y, padT + panelHeight(small)) + 8;
  // the mission objective on the band's first line, city-wide banners (seconds at a time) under it
  const objY = portrait ? topRow : padT;
  const band = { cx: W / 2, w: portrait ? W - padL - padR : half * 2, top: objY + OBJECTIVE_H };
  const objective = { y: objY, timerY: band.top + 12 };
  const msgY = Math.max(H * 0.28, objY + OBJECTIVE_H + 30);
  const speedoR = compact ? 34 : 44;
  // between the thumbs in landscape; above the buttons in portrait, where the thumbs span the width
  const gap = right.x - (left.x + left.w) - 16;
  const gapCx = (right.x + left.x + left.w) / 2;
  const speedo = portrait
    ? { cx: W / 2, cy: right.y - speedoR - 16, r: speedoR }
    : { cx: gapCx, cy: H - padB - speedoR - 10, r: speedoR };
  const prompt = portrait
    ? { cx: (padL + W - padR) / 2, foot: right.y - 22, car: speedo.cy - speedoR - 24, w: W - padL - padR }
    : { cx: gapCx, foot: H - padB - 22, car: speedo.cy - speedoR - 24, w: gap };
  const radio = { y: prompt.car - 20, w: portrait ? W - padL - padR : gap };
  const playY = Math.max(padT + 2 * r, portrait ? topRow : 0) + 8;
  return {
    W, H, touch: true, compact, small, portrait, padL, padR, padT, padB, ts,
    mini, util, utilCount: UTIL_COUNT, panel, place, band, objective, msgY, speedo, prompt, radio,
    thumbs: { left, right },
    play: { x: padL + 8, y: playY, w: W - padL - padR - 16, h: H - padB - 8 - playY },
    stack: { x: padL, y: place.y + 10 },
  };
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** is a screen point where an on-screen marker can be seen (not under the thumbs or at the edge)? */
export function inPlay(L: HudLayout, x: number, y: number) {
  if (!inside(L.play, x, y)) return false;
  return !L.thumbs || (!inside(L.thumbs.left, x, y) && !inside(L.thumbs.right, x, y));
}

/** Where an off-screen marker points from, toward `angle` from the screen centre: a ring of 38% of
 *  the short side on desktop; on touch an ellipse in the play area, lifted above the thumbs.
 *  `inset` pulls it further in (the distance label under the arrow). */
export function edgePoint(L: HudLayout, angle: number, inset = 0): { x: number; y: number } {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (!L.thumbs) {
    const r = Math.min(L.W, L.H) * 0.38 - inset;
    return { x: L.W / 2 + c * r, y: L.H / 2 + s * r };
  }
  const p = L.play;
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  const rx = p.w / 2 - 24 - inset, ry = p.h / 2 - 24 - inset;
  let x = cx + c * rx, y = cy + s * ry;
  for (const t of [L.thumbs.left, L.thumbs.right]) if (inside(t, x, y)) y = t.y - 12 - inset;
  return { x, y };
}
