// Getting about on the tram network, for the mini-games played on the trams (Revízor, Električkár:
// docs/plans/minigames.md). The map's tram graph is the real track, both rails of a double track
// each an edge of their own, and a tram runs either way on either (the AI's trams pick their own
// way at a junction: entities/Tram.ts). These helpers plan a way along it that a tram can actually
// take — no turning back but at the end of the line, no branch sharper than a tram would take —
// keeping to the right-hand track where there are two, so the round's own trams don't meet head-on;
// find the stops on it; and the track ahead of a tram as its driver would take it. DOM-free.
import type { World } from '../../../../world/World';
import { linkPoints, type Link } from '../../../../world/Graph';
import { Tram } from '../../../../entities/Tram';
import type { Rng } from '../../../../util/Rng';
import { dist, hypot } from '../../../../util/math';
import type { Sim } from '../../../Sim';

/** a stop lies on a track this close to its line (m): the tram's own reach (Tram.nextStop) */
const ON_TRACK = 1.6;
/** a branch turning more than this (rad) isn't one a tram takes (Tram.nextLink) */
const MAX_TURN = 1.3;
/** the other rail of a double track runs this far to the side (m), give or take TRACK_TOL */
const TRACK_GAP = 3.5, TRACK_TOL = 1.3;
/** a way on the left-hand track of a double track costs this many times its length */
const LEFT_COST = 3;
/** Tram's pre-roll: a new tram starts this far (m) along the link it's put on */
const PRE_ROLL = 30;

/** a stop on a link: its index into World.tramStops (even) and how far along the link it is (m) */
export interface OnLink {
  i: number;
  s: number;
}

interface Net {
  /** per edge id: the stops on it, by the distance from its start (a) */
  stops: OnLink[][];
  /** per link key: it runs on the left-hand track of a double track */
  left: Map<number, boolean>;
  /** per link key: where a tram goes on from its end (ways) */
  next: Map<number, { l: Link; d: number }[]>;
}

const nets = new WeakMap<World, Net>();

function net(w: World): Net {
  let n = nets.get(w);
  if (n) return n;
  const S = w.tramStops;
  const stops: OnLink[][] = w.tram.edges.map((e) => {
    const out: OnLink[] = [];
    for (let i = 0; i < S.length; i += 2) {
      let best = Infinity, at = 0, acc = 0;
      for (let k = 0; k + 3 < e.p.length; k += 2) {
        const ax = e.p[k], ay = e.p[k + 1], dx = e.p[k + 2] - ax, dy = e.p[k + 3] - ay, L = hypot(dx, dy);
        if (L > 1e-6) {
          const t = Math.max(0, Math.min(1, ((S[i] - ax) * dx + (S[i + 1] - ay) * dy) / (L * L)));
          const d = hypot(ax + dx * t - S[i], ay + dy * t - S[i + 1]);
          if (d < best) (best = d), (at = acc + t * L);
        }
        acc += L;
      }
      if (best <= ON_TRACK) out.push({ i, s: at });
    }
    return out.sort((a, b) => a.s - b.s);
  });
  nets.set(w, (n = { stops, left: new Map(), next: new Map() }));
  return n;
}

/** a link's key: its edge and which way along it */
export const linkKey = (l: Link) => l.edge.id * 2 + (l.fwd ? 1 : 0);

/** the stops on link `l`, by the distance along it the way it goes */
export function stopsOn(w: World, l: Link): OnLink[] {
  const on = net(w).stops[l.edge.id];
  if (l.fwd) return on;
  const len = l.edge.len;
  return on.map((o) => ({ i: o.i, s: len - o.s })).reverse();
}

/** the stop's name ("Kamenné nám."), or a plain word when the map has none */
export function stopName(w: World, i: number): string {
  return w.tramStopNames[i / 2] || 'zastávka';
}

/** stops `i` and `j` are the same stop (its two platforms, or one of them) */
export function sameStop(w: World, i: number, j: number): boolean {
  if (i === j) return true;
  const S = w.tramStops, n = w.tramStopNames[i / 2];
  return !!n && n === w.tramStopNames[j / 2] && dist(S[i], S[i + 1], S[j], S[j + 1]) < 150;
}

/** how far a branch `to` turns off `from` at the node between them (rad, positive: right), the way
 *  Tram.nextLink measures it */
function turn(w: World, from: Link, to: Link): number {
  const g = w.tram, p = linkPoints(from), q = linkPoints(to);
  const dirIn = Math.atan2(g.ny(from.to) - p[p.length - 3], g.nx(from.to) - p[p.length - 4]);
  let d = Math.atan2(q[3] - q[1], q[2] - q[0]) - dirIn;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Where a tram can go on from the end of `from`: the branches it would take (Tram.nextLink), with
 *  how far each turns; at the end of the line (or nothing it could take), back the way it came. */
export function ways(w: World, from: Link): { l: Link; d: number }[] {
  const memo = net(w).next, k = linkKey(from);
  let got = memo.get(k);
  if (got) return got;
  const out = w.tram.out[from.to];
  got = out.filter((l) => l.edge !== from.edge).map((l) => ({ l, d: turn(w, from, l) })).filter((s) => Math.abs(s.d) < MAX_TURN);
  if (!got.length) {
    const back = out.find((l) => l.edge === from.edge) ?? out[0];
    got = back ? [{ l: back, d: Math.PI }] : [];
  }
  memo.set(k, got);
  return got;
}

/** the branch a driver takes steering `steer` (-1..1): as Tram.nextLink picks for a player in the cab */
export function branch(w: World, from: Link, steer = 0): Link | null {
  const opts = ways(w, from);
  if (!opts.length) return null;
  const better = (c: { d: number }, b: { d: number }) => (Math.abs(steer) < 0.3 ? Math.abs(c.d) < Math.abs(b.d) : steer > 0 ? c.d > b.d : c.d < b.d);
  return opts.reduce((b, c) => (better(c, b) ? c : b)).l;
}

/** a point `d` metres along polyline `pts`, and the way it runs there (clamped to its ends) */
export function pointAt(pts: ArrayLike<number>, d: number): { x: number; y: number; a: number } {
  let acc = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const dx = pts[k + 2] - pts[k], dy = pts[k + 3] - pts[k + 1], L = hypot(dx, dy);
    if (acc + L >= d && L > 1e-6) {
      const t = Math.max(0, (d - acc) / L);
      return { x: pts[k] + dx * t, y: pts[k + 1] + dy * t, a: Math.atan2(dy, dx) };
    }
    acc += L;
  }
  const n = pts.length;
  return { x: pts[n - 2], y: pts[n - 1], a: n >= 4 ? Math.atan2(pts[n - 1] - pts[n - 3], pts[n - 2] - pts[n - 4]) : 0 };
}

/** Link `l` runs on the left-hand track of a double track: the other rail is to its right. Trams
 *  keep to the right, so two of the round's own, going opposite ways, never share a rail. */
export function leftHand(w: World, l: Link): boolean {
  const n = net(w);
  const k = linkKey(l);
  const known = n.left.get(k);
  if (known !== undefined) return known;
  const pts = linkPoints(l);
  let votes = 0;
  for (const f of [0.3, 0.5, 0.7]) {
    const p = pointAt(pts, l.edge.len * f);
    const ux = Math.cos(p.a), uy = Math.sin(p.a);
    // the right-hand normal in a y-down world is (-uy, ux)
    const seg = w.tram.segmentAt(p.x - uy * TRACK_GAP, p.y + ux * TRACK_GAP, TRACK_TOL);
    if (seg && seg.edge !== l.edge && Math.abs(seg.dx * ux + seg.dy * uy) > 0.85) votes++;
  }
  n.left.set(k, votes >= 2);
  return votes >= 2;
}

const weight = (w: World, l: Link) => (leftHand(w, l) ? LEFT_COST : 1);

/** how far tram `t`'s nose is along the link it's on (m) */
export function tramAlong(t: Tram): number {
  const p = t.pts;
  let s = 0;
  const last = Math.min(t.idx - 1, p.length / 2 - 1);
  for (let k = 1; k <= last; k++) s += hypot(p[k * 2] - p[k * 2 - 2], p[k * 2 + 1] - p[k * 2 - 1]);
  return s + hypot(t.x - p[last * 2], t.y - p[last * 2 + 1]);
}

/** Every stop a tram can get to from `fromS` metres along link `from`, within `maxLen` metres
 *  along the track, each the cheapest way (the left-hand track costs more), and the way there. */
export class Ways {
  /** each stop reached: the cost of the way, its length (m) and the link it's on */
  readonly at = new Map<number, { cost: number; len: number; key: number }>();
  private prev = new Map<number, number>();
  private links = new Map<number, Link>();
  private fromKey: number;

  constructor(w: World, from: Link, fromS: number, maxLen = 3000) {
    const k0 = (this.fromKey = linkKey(from));
    const reached = (i: number, cost: number, len: number, key: number) => {
      const was = this.at.get(i);
      if (!was || cost < was.cost) this.at.set(i, { cost, len, key });
    };
    for (const o of stopsOn(w, from)) if (o.s > fromS + 0.5) reached(o.i, o.s - fromS, o.s - fromS, k0);
    const open: { k: number; l: Link; cost: number; len: number }[] = [];
    const best = new Map<number, number>();
    const done = new Set<number>([k0]);
    const push = (l: Link, cost: number, len: number, prev: number) => {
      const k = linkKey(l);
      if (done.has(k) || cost >= (best.get(k) ?? Infinity)) return;
      best.set(k, cost);
      this.prev.set(k, prev);
      this.links.set(k, l);
      open.push({ k, l, cost, len });
    };
    const rest = Math.max(0, from.edge.len - fromS);
    for (const s of ways(w, from)) push(s.l, rest, rest, k0);
    while (open.length) {
      let bi = 0;
      for (let j = 1; j < open.length; j++) if (open[j].cost < open[bi].cost) bi = j;
      const cur = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (done.has(cur.k) || cur.cost > (best.get(cur.k) ?? Infinity)) continue;
      done.add(cur.k);
      if (cur.len > maxLen) continue;
      const wt = weight(w, cur.l);
      for (const o of stopsOn(w, cur.l)) reached(o.i, cur.cost + o.s * wt, cur.len + o.s, cur.k);
      for (const s of ways(w, cur.l)) push(s.l, cur.cost + cur.l.edge.len * wt, cur.len + cur.l.edge.len, cur.k);
    }
  }

  /** the links after `from` a tram keeps to for stop `i` (the one it's on last), or null */
  to(i: number): Link[] | null {
    const r = this.at.get(i);
    if (!r) return null;
    const out: Link[] = [];
    for (let k = r.key; k !== this.fromKey; k = this.prev.get(k)!) out.push(this.links.get(k)!);
    return out.reverse();
  }
}

/** the links through stop `i` (both ways along each track it's on), with how far along each it is */
export function linksAt(w: World, i: number): { l: Link; s: number }[] {
  const out: { l: Link; s: number }[] = [];
  const stops = net(w).stops;
  for (const e of w.tram.edges) {
    const o = stops[e.id].find((q) => q.i === i);
    if (!o) continue;
    for (const l of w.tram.out[e.a].concat(w.tram.out[e.b])) if (l.edge === e && !out.some((q) => q.l === l)) out.push({ l, s: l.fwd ? o.s : e.len - o.s });
  }
  return out;
}

/** How many times a way along these links changes tram line (each edge knows the lines running
 *  along it; one with none known goes with any). */
export function lineChanges(links: Link[]): number {
  let cur = 0, changes = 0;
  for (const l of links) {
    const m = l.edge.lines;
    if (!m) continue;
    if (cur & m) cur &= m;
    else {
      if (cur) changes++;
      cur = m;
    }
  }
  return changes;
}

/** The links leading into link `to` from behind, `len` metres of them or more (fewer at the end of
 *  the line), each the straightest a tram coming that way would have been on: the way a tram of
 *  the round's comes in to a stop from out of sight. First to last. */
export function leadIn(w: World, to: Link, len: number): Link[] {
  const g = w.tram;
  const out: Link[] = [];
  let cur = to, acc = 0;
  for (let n = 0; n < 12 && acc < len; n++) {
    // the links into the node `cur` starts at: the other way along each link out of it
    const from = cur.fwd ? cur.edge.a : cur.edge.b;
    let best: Link | null = null, bd = Infinity;
    for (const o of g.out[from]) {
      if (o.edge === cur.edge) continue;
      const into = g.out[o.to].find((l) => l.edge === o.edge && l.to === from);
      if (!into || !ways(w, into).some((s) => s.l === cur)) continue;
      const d = Math.abs(turn(w, into, cur)) + (leftHand(w, into) ? 1 : 0);
      if (d < bd) (bd = d), (best = into);
    }
    if (!best) break;
    out.unshift(best);
    acc += best.edge.len;
    cur = best;
  }
  return out;
}

/** A new tram put on `link` (from its start, rolled on as Tram does to have its whole body on the
 *  track), keeping to `then` after it, its nose `at` metres along the way (at least the roll-on).
 *  Null when the link is too short to hold it. */
export function tramOn(w: World, rng: Rng, link: Link, then: Link[], at = PRE_ROLL): Tram | null {
  if (link.edge.len < PRE_ROLL + 4) return null;
  const t = new Tram(w.tram, link, rng, w.tramStops);
  if (t.link !== link) return null;
  t.follow(then);
  if (at > PRE_ROLL) {
    t.advance(at - PRE_ROLL);
    t.updateSections();
  }
  return t;
}

/** Where to put a tram that's to come in to stop `s` metres along link `to` from `back` metres up
 *  the track (along `lead`, the links before `to`, first to last): the link to put it on, how far
 *  along the way from that link's start its nose goes, and the way on from there. Null when the
 *  track behind doesn't go back that far. */
export function upTrack(lead: Link[], to: Link, s: number, back: number): { link: Link; at: number; then: Link[] } | null {
  const chain = [...lead, to];
  // how far each link's start is before the stop
  let before = s;
  for (let k = chain.length - 1; k >= 0; k--) {
    if (k < chain.length - 1) before += chain[k].edge.len;
    if (before - PRE_ROLL < back || chain[k].edge.len < PRE_ROLL + 4) continue;
    return { link: chain[k], at: before - back, then: chain.slice(k + 1) };
  }
  return null;
}

/** Tram `t`'s track ahead, `maxD` metres of it, as its driver would go steering `steer` (as it
 *  would itself when it keeps to a way: `way`, its links after the one it's on): the line of it
 *  (from its nose) and the stops on it with how far along each is. */
export function trackAhead(w: World, t: Tram, maxD: number, steer = 0, way: Link[] = []): { pts: number[]; stops: { i: number; d: number }[]; links: Link[] } {
  const pts = [t.x, t.y];
  for (let k = t.idx; k < t.pts.length / 2; k++) pts.push(t.pts[k * 2], t.pts[k * 2 + 1]);
  return trackFrom(w, t.link, tramAlong(t), maxD, steer, way, pts);
}

/** The track ahead from `at` metres along link `from`, as trackAhead (`pts`: the line of it so far,
 *  from there to the end of `from`, when the caller has it). */
export function trackFrom(w: World, from: Link, at: number, maxD: number, steer = 0, way: Link[] = [], pts?: number[]): { pts: number[]; stops: { i: number; d: number }[]; links: Link[] } {
  if (!pts) {
    const p = linkPoints(from);
    const start = pointAt(p, at);
    pts = [start.x, start.y];
    let acc = 0;
    for (let k = 2; k < p.length; k += 2) {
      acc += hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
      if (acc > at) pts.push(p[k], p[k + 1]);
    }
  }
  const stops: { i: number; d: number }[] = [];
  for (const o of stopsOn(w, from)) if (o.s > at) stops.push({ i: o.i, d: o.s - at });
  let acc = Math.max(0, from.edge.len - at);
  const links = [from];
  let cur = from;
  for (let n = 0; acc < maxD && n < 30; n++) {
    const next = way[n] && ways(w, cur).some((s) => s.l === way[n]) ? way[n] : branch(w, cur, steer);
    if (!next) break;
    // (a stop right at a node is on the links either side of it: once)
    for (const o of stopsOn(w, next)) if (!stops.some((q) => q.i === o.i && Math.abs(q.d - acc - o.s) < 5)) stops.push({ i: o.i, d: acc + o.s });
    const p = linkPoints(next);
    for (let k = 2; k < p.length; k += 2) pts.push(p[k], p[k + 1]);
    acc += next.edge.len;
    links.push(next);
    cur = next;
  }
  return { pts, stops: stops.filter((s) => s.d <= maxD), links };
}

/** the point of polyline `pts` nearest (x, y): how far off it (m), how far along it, and the way it
 *  runs there */
export function nearLine(pts: ArrayLike<number>, x: number, y: number): { d: number; s: number; a: number } {
  let best = { d: Infinity, s: 0, a: 0 }, acc = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const dx = pts[k + 2] - pts[k], dy = pts[k + 3] - pts[k + 1], L = hypot(dx, dy);
    if (L > 1e-6) {
      const t = Math.max(0, Math.min(1, ((x - pts[k]) * dx + (y - pts[k + 1]) * dy) / (L * L)));
      const d = hypot(pts[k] + dx * t - x, pts[k + 1] + dy * t - y);
      if (d < best.d) best = { d, s: acc + t * L, a: Math.atan2(dy, dx) };
    }
    acc += L;
  }
  return best;
}

/** Trams of the city's coming the other way on `t`'s track ahead (`pts`, from its nose): two trams
 *  nose to nose on one rail wait for each other for ever (the AI's trams run either way on either
 *  rail), so the round takes such a one out of the city — while nobody sees it, or, once `t` has
 *  stood stuck behind it (`stuck`), right away. `ahead` too: the ones going the same way in front
 *  of it (a player driving to a timetable can't be kept behind one). `keep`: trams that stay
 *  whatever (the round's own, anyone's aboard or driving). */
export function clearAhead(sim: Sim, t: Tram, pts: number[], stuck: boolean, keep: (o: Tram) => boolean, ahead = false) {
  const gone = new Set<Tram>();
  for (const o of sim.trams) {
    if (o === t || o.driver || o.level !== t.level || Math.abs(o.x - t.x) > 300 || Math.abs(o.y - t.y) > 300 || keep(o)) continue;
    const n = nearLine(pts, o.x, o.y);
    const facing = Math.cos(o.angle - n.a) < -0.3;
    if (n.d > 2.5 || (!facing && !ahead)) continue;
    if ((stuck && n.s < 45) || !sim.visibleToAny(o.x, o.y, 20)) gone.add(o);
  }
  if (gone.size) sim.trams = sim.trams.filter((o) => !gone.has(o));
}

/** is anyone (a player: rules/Trams.ts) aboard tram `t`, or driving it */
export function carrying(sim: Sim, t: Tram): boolean {
  if (t.driver) return true;
  for (const p of sim.players.values()) if (p.ped.aboard === t) return true;
  return false;
}

/** the stop a tram (or anyone) at (x, y) stands at: within `r` metres of it (the way Trams.atTramStop
 *  and the crowd see it), or -1 */
export function stopAt(w: World, x: number, y: number, r = 4): number {
  const S = w.tramStops;
  for (let i = 0; i < S.length; i += 2) if (Math.abs(S[i] - x) < r && Math.abs(S[i + 1] - y) < r) return i;
  return -1;
}

/** the nearest stop to (x, y) within `r` metres, or -1 */
export function nearestStop(w: World, x: number, y: number, r: number, ok: (i: number) => boolean = () => true): number {
  const S = w.tramStops;
  let best = -1, bd = r;
  for (let i = 0; i < S.length; i += 2) {
    const d = dist(S[i], S[i + 1], x, y);
    if (d <= bd && ok(i)) (bd = d), (best = i);
  }
  return best;
}

/** A spot to wait on the platform of stop `i`: beside the track on its kerb side (away from the
 *  other rail), `along` metres along it, facing the track; the other side when there's no room. */
export function platform(w: World, i: number, along = 0): { x: number; y: number; a: number } {
  const S = w.tramStops, x = S[i], y = S[i + 1];
  const seg = w.tram.segmentAt(x, y, 3);
  const ux = seg?.dx ?? 1, uy = seg?.dy ?? 0;
  // the kerb side: the one without the other rail next to it
  const other = (s: number) => {
    const q = w.tram.segmentAt(x - uy * TRACK_GAP * s, y + ux * TRACK_GAP * s, TRACK_TOL);
    return !!q && q.edge !== seg?.edge;
  };
  const first = other(1) ? -1 : 1;
  for (const s of [first, -first]) {
    for (const off of [2.8, 2.3, 3.4]) {
      const px = x + ux * along - uy * off * s, py = y + uy * along + ux * off * s;
      if (w.collideCircle(px, py, 0.45, 0) || w.inWater(px, py, 0) || w.insideBuilding(px, py)) continue;
      return { x: px, y: py, a: Math.atan2(y + uy * along - py, x + ux * along - px) };
    }
  }
  return { ...w.walkableNear(x, y), a: 0 };
}

/** the step outside tram `t`'s door nearest (x, y) */
export function doorNear(t: Tram, x: number, y: number): { x: number; y: number } {
  const s = t.doorSpots();
  let bx = t.x, by = t.y, bd = Infinity;
  for (let k = 0; k < s.length; k += 2) {
    const d = dist(s[k], s[k + 1], x, y);
    if (d < bd) (bd = d), (bx = s[k]), (by = s[k + 1]);
  }
  return { x: bx, y: by };
}
