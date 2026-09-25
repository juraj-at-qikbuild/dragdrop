// Tram state and track following. Shared by the browser and the game server; drawing lives in
// src/render/drawTram.ts.
import type { Graph, Link } from '../world/Graph';
import { linkPoints } from '../world/Graph';
import type { Rng } from '../util/Rng';

const SEG = 9.2; // length of one articulated section
export const TRAM_SECTIONS = 3;
const SECTIONS = TRAM_SECTIONS;
const GAP = 0.6;
export { SEG as TRAM_SEG, GAP as TRAM_GAP };

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
  /** bridge deck level: 0 ground/underneath, 1 on the deck (see World.updateLevel) */
  level: 0 | 1 = 0;
  /** false until the first level update places it on/under a deck it spawned on (World.spawnLevel) */
  levelInit = false;
  length = SECTIONS * (SEG + GAP);
  sections: { x: number; y: number; a: number }[] = [];

  /** a mirror (client side) has no graph: its sections are set from snapshots */
  constructor(private graph: Graph | null, link: Link | null, private rng?: Rng) {
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
    const opts = graph.out[node].filter((l) => l.edge !== this.link.edge);
    // prefer continuing straight
    const px = this.pts[this.pts.length - 4], py = this.pts[this.pts.length - 3];
    const nx = graph.nx(node), ny = graph.ny(node);
    const dirIn = Math.atan2(ny - py, nx - px);
    const scored = opts
      .map((l) => {
        const p = linkPoints(l);
        const a = Math.atan2(p[3] - p[1], p[2] - p[0]);
        let d = Math.abs(a - dirIn) % (Math.PI * 2);
        if (d > Math.PI) d = Math.PI * 2 - d;
        return { l, d };
      })
      .filter((s) => s.d < 1.3);
    const r = this.rng;
    if (scored.length) return scored.length > 1 && r && r.chance(0.35) ? r.pick(scored).l : scored.sort((a, b) => a.d - b.d)[0].l;
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
          const next = this.nextLink();
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
    const target = this.blocked ? 0 : this.maxSpeed;
    this.speed += Math.sign(target - this.speed) * Math.min(Math.abs(target - this.speed), (this.blocked ? 6 : 1.6) * dt);
    if (this.speed > 0) this.advance(this.speed * dt);
    this.updateSections();
    if (this.bell > 0) this.bell -= dt;
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
