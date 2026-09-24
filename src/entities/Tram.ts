import type { Atmosphere } from '../world/Atmosphere';
import type { LightLayer } from '../world/Lighting';
import type { Graph, Link } from '../world/Graph';
import { linkPoints } from '../world/Graph';
import { pick } from '../util/math';
import { roundRect } from './Vehicle';

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
  emitLights(L: LightLayer, atmos?: Atmosphere) {
    if (!atmos) return;
    const k = Math.max(atmos.night, atmos.rain * 0.5);
    if (k <= 0.02) return;
    const front = this.sections[0];
    if (front) {
      const fx = Math.cos(front.a), fy = Math.sin(front.a);
      const nx = front.x + fx * (SEG / 2 - 0.3), ny = front.y + fy * (SEG / 2 - 0.3);
      L.cone(nx, ny, front.a, 14, 0.3, '#fff1c8', k);
      L.point(nx, ny, 1.6, '#fff1c8', 0.6 * k);
    }
    for (const s of this.sections) L.point(s.x, s.y, 2.4, '#ffd98a', 0.28 * k);
  }

  draw(ctx: CanvasRenderingContext2D, atmos?: Atmosphere) {
    const night = atmos?.night ?? 0;
    for (let i = this.sections.length - 1; i >= 0; i--) {
      const s = this.sections[i];
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.a);
      // shadow along the sun (tight contact shadow at night)
      let shx = 0.3, shy = 0.4, salpha = 0.35;
      if (atmos) {
        if (night > 0.72) { shx = 0.12; shy = 0.16; salpha = 0.3; }
        else {
          const h = 1.4, ca = Math.cos(s.a), sa = Math.sin(s.a);
          const wx = atmos.sun.dx * h, wy = atmos.sun.dy * h;
          shx = wx * ca + wy * sa;
          shy = -wx * sa + wy * ca;
          salpha = 0.25 + 0.2 * atmos.daylight;
        }
      }
      ctx.fillStyle = `rgba(0,0,0,${salpha})`;
      ctx.fillRect(-SEG / 2 + shx, -1.2 + shy, SEG, 2.4);
      // cream roof peeking behind the red sides
      ctx.fillStyle = '#efe6d2';
      roundRect(ctx, -SEG / 2 - 0.05, -1.15, SEG + 0.1, 2.3, 0.3);
      ctx.fill();
      // red body
      ctx.fillStyle = i === 0 ? '#c8102e' : '#d7141a';
      if (i === 0) {
        // rounded cab front
        ctx.beginPath();
        ctx.moveTo(-SEG / 2, -1.2);
        ctx.lineTo(SEG / 2 - 0.5, -1.2);
        ctx.quadraticCurveTo(SEG / 2 + 0.15, -1.2, SEG / 2 + 0.15, -0.55);
        ctx.lineTo(SEG / 2 + 0.15, 0.55);
        ctx.quadraticCurveTo(SEG / 2 + 0.15, 1.2, SEG / 2 - 0.5, 1.2);
        ctx.lineTo(-SEG / 2, 1.2);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(-SEG / 2, -1.2, SEG, 2.4);
      }
      // cream window strip, both sides, with a subtle reflection gradient in the glass
      ctx.fillStyle = '#f4f0e6';
      ctx.fillRect(-SEG / 2 + 0.3, -0.95, SEG - 0.9, 1.9);
      const glassGrad = ctx.createLinearGradient(0, -0.72, 0, 0.72);
      glassGrad.addColorStop(0, '#3a4954');
      glassGrad.addColorStop(0.45, '#27343f');
      glassGrad.addColorStop(0.55, '#27343f');
      glassGrad.addColorStop(1, '#1c262e');
      ctx.fillStyle = glassGrad;
      for (let w = 0; w < 3; w++) ctx.fillRect(-SEG / 2 + 0.65 + w * (SEG - 1.6) / 2.6, -0.72, (SEG - 1.6) / 3.4, 1.44);
      // door lines
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.05;
      for (const dx of [-SEG * 0.22, SEG * 0.22]) {
        ctx.beginPath();
        ctx.moveTo(dx, -1.15);
        ctx.lineTo(dx, 1.15);
        ctx.stroke();
      }
      ctx.fillStyle = '#9ea3a8';
      ctx.fillRect(-1.2, -0.4, 2.4, 0.8); // roof equipment
      if (i === 1) {
        // pantograph
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.06;
        ctx.beginPath();
        ctx.moveTo(-0.55, -0.4);
        ctx.lineTo(0.15, -0.05);
        ctx.lineTo(0.15, 0.05);
        ctx.lineTo(-0.55, 0.4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0.6, 0);
        ctx.lineTo(0.15, -0.05);
        ctx.moveTo(0.6, 0);
        ctx.lineTo(0.15, 0.05);
        ctx.stroke();
      }
      if (i === 0) {
        ctx.fillStyle = '#27343f';
        ctx.fillRect(SEG / 2 - 0.5, -1.05, 0.5, 2.1);
        ctx.fillStyle = '#fff6c4';
        ctx.fillRect(SEG / 2 - 0.1, -1.05, 0.15, 0.35);
        ctx.fillRect(SEG / 2 - 0.1, 0.7, 0.15, 0.35);
      }
      // rubber bellows joint between sections
      if (i < this.sections.length - 1) {
        ctx.fillStyle = '#2b2b2b';
        ctx.fillRect(-SEG / 2 - GAP, -0.55, GAP, 1.1);
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
