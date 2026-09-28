// Tram state and track following. Shared by the browser and the game server; drawing lives in
// src/render/drawTram.ts.
import type { Graph, Link } from '../world/Graph';
import { linkPoints } from '../world/Graph';
import type { Level } from '../world/World';
import type { Rng } from '../util/Rng';
import { rng as seeded } from '../util/math';

const SEG = 9.2; // length of one articulated section
export const TRAM_SECTIONS = 3;
const SECTIONS = TRAM_SECTIONS;
const GAP = 0.6;
export { SEG as TRAM_SEG, GAP as TRAM_GAP };
/** a player in the cab (docs/plans/gameplay.md, Phase 3): pull away (m/s²), brake, roll to a stop
 *  with the controls let go, and the top speed (m/s, 50 km/h: the AI keeps to 40) */
const DRIVE_ACCEL = 1.8;
const DRIVE_BRAKE = 3.5;
const DRIVE_COAST = 0.15;
export const DRIVE_TOP = 14;
/** where the doors are along a section, from its centre (m), and how far outside the body a door's
 *  step is (m) */
const DOOR_AT = 2.8;
const DOOR_OUT = 1.9;

/** Articulated tram (styled after Bratislava's red and white trams) following the real tram tracks. */
export class Tram {
  /** network id, assigned by Sim.addTram (or the server, for mirrors) */
  id = 0;
  /** travelled path history, flat x,y, newest last */
  trail: number[] = [];
  x = 0;
  y = 0;
  angle = 0;
  speed = 0;
  maxSpeed = 11;
  link!: Link;
  pts: number[] = [];
  idx = 1;
  blocked = false;
  bell = 0;
  /** -1 in the tunnel, 0 on the ground or under a bridge deck, 1 on the deck (see World.updateLevel) */
  level: Level = 0;
  /** false until the first level update places it on/under a deck it spawned on (World.spawnLevel) */
  levelInit = false;
  length = SECTIONS * (SEG + GAP);
  sections: { x: number; y: number; a: number }[] = [];
  /** seconds left standing at a stop with the doors open */
  dwell = 0;
  /** the player driving it from the cab (docs/plans/gameplay.md, Phase 3); 0: the AI */
  driver = 0;
  /** the cab's controls while a player drives: `throttle` -1..1 (below 0 it brakes), `steer` -1..1
   *  picks the branch at the next junction (left, straight on, right) */
  ctl = { throttle: 0, steer: 0 };
  /** index (in `stops`) of the stop just served, so it isn't served twice in a row */
  private served = -1;
  /** the next link, picked early so a stop just past the end of this one is seen in time */
  private upcoming: Link | null = null;
  private upcomingPts: number[] | null = null;
  /** the way it keeps to at the junctions ahead, link by link (follow) */
  private route: Link[] = [];

  /** a mirror (client side) has no graph: its sections are set from snapshots. `stops`: the tram
   *  stops on the tracks (World.tramStops), where it halts to let people on */
  constructor(private graph: Graph | null, link: Link | null, private rng?: Rng, private stops: Float32Array = new Float32Array(0)) {
    if (!graph || !link) return;
    this.link = link;
    this.pts = linkPoints(link);
    this.x = this.pts[0];
    this.y = this.pts[1];
    this.trail.push(this.x, this.y);
    // pre-roll so the whole body is on the track
    for (let i = 0; i < 60; i++) this.advance(0.5);
    this.updateSections();
  }

  private nextLink() {
    const graph = this.graph!;
    const node = this.link.to;
    // on a way it was given (follow): the next link of it, as long as that goes on from here and
    // nobody's taken the cab; else it's off it for good
    const via = this.route.shift();
    if (via && !this.driver && graph.out[node].includes(via)) return via;
    this.route.length = 0;
    const opts = graph.out[node].filter((l) => l.edge !== this.link.edge);
    // prefer continuing straight
    const px = this.pts[this.pts.length - 4], py = this.pts[this.pts.length - 3];
    const nx = graph.nx(node), ny = graph.ny(node);
    const dirIn = Math.atan2(ny - py, nx - px);
    // `d`: how far each branch turns (positive: right, clockwise)
    const scored = opts
      .map((l) => {
        const p = linkPoints(l);
        let d = Math.atan2(p[3] - p[1], p[2] - p[0]) - dirIn;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        return { l, d };
      })
      .filter((s) => Math.abs(s.d) < 1.3);
    if (scored.length && this.driver) {
      // a player in the cab: the branch furthest the way they steer, else the straightest
      const s = this.ctl.steer;
      const better = (c: { d: number }, b: { d: number }) => (Math.abs(s) < 0.3 ? Math.abs(c.d) < Math.abs(b.d) : s > 0 ? c.d > b.d : c.d < b.d);
      return scored.reduce((b, c) => (better(c, b) ? c : b)).l;
    }
    const r = this.rng;
    if (scored.length) return scored.length > 1 && r && r.chance(0.35) ? r.pick(scored).l : scored.sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0].l;
    // dead end: turn back (trams at terminals)
    return graph.out[node].find((l) => l.edge === this.link.edge) ?? graph.out[node][0];
  }

  advance(dist: number) {
    while (dist > 0) {
      const tx = this.pts[this.idx * 2], ty = this.pts[this.idx * 2 + 1];
      const d = Math.hypot(tx - this.x, ty - this.y);
      if (d <= dist) {
        this.x = tx;
        this.y = ty;
        dist -= d;
        this.idx++;
        if (this.idx * 2 >= this.pts.length) {
          const next = this.upcoming ?? this.nextLink();
          this.upcoming = this.upcomingPts = null;
          if (!next) return;
          if (next.edge === this.link.edge) {
            // reverse at terminal: flip trail so the tram drives back
            this.trail = [];
          }
          this.link = next;
          this.pts = linkPoints(next);
          this.idx = 1;
        }
      } else {
        this.x += ((tx - this.x) / d) * dist;
        this.y += ((ty - this.y) / d) * dist;
        dist = 0;
      }
      this.trail.push(this.x, this.y);
    }
    // trim trail to body length
    let len = 0;
    for (let i = this.trail.length - 2; i >= 2; i -= 2) {
      len += Math.hypot(this.trail[i] - this.trail[i - 2], this.trail[i + 1] - this.trail[i - 1]);
      if (len > this.length + 5) {
        this.trail.splice(0, i - 2);
        break;
      }
    }
  }

  /** position along the trail at distance d behind the front */
  private back(d: number): [number, number] {
    let acc = 0;
    for (let i = this.trail.length - 2; i >= 2; i -= 2) {
      const ax = this.trail[i], ay = this.trail[i + 1], bx = this.trail[i - 2], by = this.trail[i - 1];
      const l = Math.hypot(bx - ax, by - ay);
      if (acc + l >= d) {
        const t = (d - acc) / (l || 1);
        return [ax + (bx - ax) * t, ay + (by - ay) * t];
      }
      acc += l;
    }
    // not enough trail yet: extrapolate backwards along the heading
    return [this.x - Math.cos(this.angle) * d, this.y - Math.sin(this.angle) * d];
  }

  updateSections() {
    this.sections = [];
    let front: [number, number] = [this.x, this.y];
    for (let i = 0; i < SECTIONS; i++) {
      const rear = this.back((i + 1) * (SEG + GAP) - GAP);
      const a = Math.atan2(front[1] - rear[1], front[0] - rear[0]);
      if (i === 0) this.angle = a;
      this.sections.push({ x: (front[0] + rear[0]) / 2, y: (front[1] + rear[1]) / 2, a });
      front = this.back((i + 1) * (SEG + GAP));
    }
  }

  update(dt: number) {
    if (this.bell > 0) this.bell -= dt;
    if (this.served >= 0 && Math.hypot(this.stops[this.served] - this.x, this.stops[this.served + 1] - this.y) > 30) this.served = -1;
    if (this.dwell > 0) {
      // at a stop: doors open
      this.dwell -= dt;
      this.speed = 0;
      return;
    }
    let target = this.blocked ? 0 : this.maxSpeed;
    // brake for the next stop on this track and halt at it
    const stop = this.nextStop(50);
    if (stop) {
      if (stop.d < 0.8 && this.speed < 0.9) {
        // 10-18 s, fixed per stop
        this.dwell = 10 + seeded(stop.i * 2654435761)() * 8;
        this.served = stop.i;
        this.speed = 0;
        return;
      }
      target = Math.min(target, Math.sqrt(2 * 1.3 * Math.max(0, stop.d - 0.5)) + 0.3);
    }
    this.speed += Math.sign(target - this.speed) * Math.min(Math.abs(target - this.speed), (this.blocked ? 6 : 1.6) * dt);
    if (this.speed > 0) this.advance(this.speed * dt);
    this.updateSections();
  }

  /** Keep to `links` at the junctions ahead, one after the other from the end of the link it's on
   *  (a mini-game's own tram running to where its passengers are going:
   *  rules/minigames/games/tramline.ts); [] lets it pick its own way again. Whatever it had already
   *  picked ahead is picked again. */
  follow(links: Link[]) {
    this.route = links.slice();
    this.upcoming = this.upcomingPts = null;
  }

  /** A player takes the cab (`pid`), or hands it back to the AI (0): whatever junction the AI had
   *  already picked is theirs to pick again. */
  takeCab(pid: number) {
    this.driver = pid;
    this.ctl.throttle = this.ctl.steer = 0;
    this.dwell = 0;
    this.upcoming = this.upcomingPts = null;
  }

  /** a player at the controls: the throttle pulls up to DRIVE_TOP and the brake stops it; nothing else
   *  does (it keeps to no stops, and it waits for nobody in the way) */
  drive(dt: number) {
    if (this.bell > 0) this.bell -= dt;
    const th = this.ctl.throttle;
    const a = th > 0.05 ? DRIVE_ACCEL * th : th < -0.05 ? DRIVE_BRAKE * th : -DRIVE_COAST;
    this.speed = Math.max(0, Math.min(DRIVE_TOP, this.speed + a * dt));
    if (this.speed > 0) this.advance(this.speed * dt);
    this.updateSections();
  }

  /** Where the doors let people on and off: a step outside each door, on both sides (flat x, y). */
  doorSpots(): number[] {
    const out: number[] = [];
    for (const s of this.sections) {
      const ux = Math.cos(s.a), uy = Math.sin(s.a);
      for (const o of [DOOR_AT, -DOOR_AT])
        for (const side of [1, -1]) out.push(s.x + ux * o - uy * DOOR_OUT * side, s.y + uy * o + ux * DOOR_OUT * side);
    }
    return out;
  }

  /** The nearest tram stop ahead on this track (within `maxD` metres along it), or null. */
  private nextStop(maxD: number): { i: number; d: number } | null {
    const S = this.stops;
    if (!S.length) return null;
    let best: { i: number; d: number } | null = null;
    let px = this.x, py = this.y, acc = 0;
    const scan = (pts: number[], from: number) => {
      for (let k = from; k < pts.length / 2 && acc < maxD; k++) {
        const qx = pts[k * 2], qy = pts[k * 2 + 1];
        const L = Math.hypot(qx - px, qy - py);
        if (L > 1e-6)
          for (let i = 0; i < S.length; i += 2) {
            if (i === this.served) continue;
            const t = ((S[i] - px) * (qx - px) + (S[i + 1] - py) * (qy - py)) / (L * L);
            if (t < 0 || t > 1) continue;
            const ex = px + (qx - px) * t - S[i], ey = py + (qy - py) * t - S[i + 1];
            if (ex * ex + ey * ey > 1.6 * 1.6) continue;
            const d = acc + t * L;
            if (!best || d < best.d) best = { i, d };
          }
        if (best) return;
        acc += L;
        px = qx;
        py = qy;
      }
    };
    scan(this.pts, this.idx);
    if (!best && acc < maxD) {
      this.upcoming ??= this.nextLink();
      if (this.upcoming) scan((this.upcomingPts ??= linkPoints(this.upcoming)), 1);
    }
    return best;
  }

  /** Is a point inside the tram body (with margin)? */
  hits(x: number, y: number, margin = 0.3) {
    for (const s of this.sections) {
      const dx = x - s.x, dy = y - s.y;
      const lx = dx * Math.cos(s.a) + dy * Math.sin(s.a);
      const ly = -dx * Math.sin(s.a) + dy * Math.cos(s.a);
      if (Math.abs(lx) < SEG / 2 + margin && Math.abs(ly) < 1.2 + margin) return s;
    }
    return null;
  }
}
