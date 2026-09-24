import type { Atmosphere } from '../world/Atmosphere';
import type { LightLayer } from '../world/Lighting';
import type { Graph, Link } from '../world/Graph';
import { linkPoints } from '../world/Graph';
import { pick } from '../util/math';

const SEG = 9.2; // length of one articulated section
const SECTIONS = 3;
const GAP = 0.6;

/** Articulated tram (styled after Bratislava's red and white trams) following the real tram tracks. */
export class Tram {
  /** travelled path history, flat x,y, newest last */
  trail: number[] = [];
  x = 0;
  y = 0;
  angle = 0;
  speed = 0;
  maxSpeed = 11;
  link: Link;
  pts: number[];
  idx = 1;
  blocked = false;
  bell = 0;
  length = SECTIONS * (SEG + GAP);
  sections: { x: number; y: number; a: number }[] = [];

  constructor(private graph: Graph, link: Link) {
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
    const node = this.link.to;
    const opts = this.graph.out[node].filter((l) => l.edge !== this.link.edge);
    // prefer continuing straight
    const px = this.pts[this.pts.length - 4], py = this.pts[this.pts.length - 3];
    const nx = this.graph.nx(node), ny = this.graph.ny(node);
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
    if (scored.length) return scored.length > 1 && Math.random() < 0.35 ? pick(scored).l : scored.sort((a, b) => a.d - b.d)[0].l;
    // dead end: turn back (trams at terminals)
    return this.graph.out[node].find((l) => l.edge === this.link.edge) ?? this.graph.out[node][0];
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

  /** Headlights and interior glow. */
  emitLights(_L: LightLayer, _atmos: Atmosphere) {
    // TODO(visual): implement
  }

  draw(ctx: CanvasRenderingContext2D, _atmos?: Atmosphere) {
    for (let i = this.sections.length - 1; i >= 0; i--) {
      const s = this.sections[i];
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.a);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-SEG / 2 + 0.3, -1.2 + 0.4, SEG, 2.4);
      ctx.fillStyle = '#d7141a';
      ctx.fillRect(-SEG / 2, -1.2, SEG, 2.4);
      ctx.fillStyle = '#f4f4f4';
      ctx.fillRect(-SEG / 2 + 0.3, -0.95, SEG - 0.6, 1.9);
      ctx.fillStyle = '#9ea3a8';
      ctx.fillRect(-1.2, -0.4, 2.4, 0.8); // roof equipment
      if (i === 1) {
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.1;
        ctx.beginPath();
        ctx.moveTo(-0.8, -0.5);
        ctx.lineTo(0.8, 0.5);
        ctx.moveTo(-0.8, 0.5);
        ctx.lineTo(0.8, -0.5);
        ctx.stroke();
      }
      if (i === 0) {
        ctx.fillStyle = '#27343f';
        ctx.fillRect(SEG / 2 - 0.5, -1.05, 0.4, 2.1);
        ctx.fillStyle = '#fff6c4';
        ctx.fillRect(SEG / 2 - 0.1, -1.05, 0.1, 0.35);
        ctx.fillRect(SEG / 2 - 0.1, 0.7, 0.1, 0.35);
      }
      ctx.restore();
    }
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
