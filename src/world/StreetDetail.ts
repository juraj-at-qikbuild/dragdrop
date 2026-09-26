// The small things in the street, drawn each frame over the baked ground (see Renderer): traffic
// signs, lift gates (their booms snap), street furniture (benches, bins, hydrants, bus shelters,
// billboards, café umbrellas… which cars knock flying) and tram stop signs. Client only.
import type { World } from '../shared/world/World';
import { FURNITURE, F_HYDRANT } from '../shared/world/Street';
import { ROOF_ADS } from '../data/brands';
import { hash01 } from './BuildingGeometry';
import type { View } from './Renderer';

/** grid cell (m) for finding what's in view */
const CELL = 64;
/** a knocked-over piece of furniture lies there this long, then it's put back (s) */
const KNOCK_TIME = 180;

/** where knocked furniture went: slid off along the car's path and fallen over */
interface Knock {
  t: number;
  dx: number;
  dy: number;
  rot: number;
}

export class StreetDetail {
  private cells = new Map<number, { furn: number[]; gates: number[]; signs: number[]; stops: number[] }>();
  /** furniture index (into World.furniture, a multiple of 4) -> how it was knocked over */
  knocked = new Map<number, Knock>();
  /** hydrants gushing water: furniture index -> seconds left */
  geysers = new Map<number, number>();
  /** tram-stop name plates: real, place-identifying text, off for photo mode (Renderer.labels) */
  labels = true;

  constructor(private world: World) {
    const cell = (x: number, y: number) => {
      const k = (Math.floor(x / CELL) + 500) * 1000 + Math.floor(y / CELL) + 500;
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = { furn: [], gates: [], signs: [], stops: [] }));
      return c;
    };
    const f = world.furniture;
    for (let i = 0; i < f.length; i += 4) cell(f[i], f[i + 1]).furn.push(i);
    const g = world.gates;
    for (let i = 0; i < g.n; i++) cell(g.px[i], g.py[i]).gates.push(i);
    world.marks.signs.forEach((m, i) => cell(m.x, m.y).signs.push(i));
    const ts = world.tramStops;
    for (let i = 0; i < ts.length; i += 2) cell(ts[i], ts[i + 1]).stops.push(i);
  }

  private forCells(v: View, pad: number, fn: (c: { furn: number[]; gates: number[]; signs: number[]; stops: number[] }) => void) {
    for (let gx = Math.floor((v.x0 - pad) / CELL); gx <= Math.floor((v.x1 + pad) / CELL); gx++)
      for (let gy = Math.floor((v.y0 - pad) / CELL); gy <= Math.floor((v.y1 + pad) / CELL); gy++) {
        const c = this.cells.get((gx + 500) * 1000 + gy + 500);
        if (c) fn(c);
      }
  }

  /** Cars knock street furniture flying (every car this client sees: the knocks are its own
   *  business, nothing else in the world depends on them). Calls `hit` for each knock (effects). */
  update(dt: number, cars: Iterable<{ x: number; y: number; vx: number; vy: number; level: number; spec: { width: number; length: number } }>, hit: (x: number, y: number, kind: number, speed: number) => void) {
    for (const [i, k] of this.knocked) if ((k.t -= dt) <= 0) this.knocked.delete(i);
    for (const [i, t] of this.geysers) if (t - dt <= 0) this.geysers.delete(i);
    else this.geysers.set(i, t - dt);
    const f = this.world.furniture;
    for (const v of cars) {
      if (v.level !== 0) continue;
      const sp = Math.hypot(v.vx, v.vy);
      if (sp < 2) continue;
      const reach = v.spec.length / 2 + 1.8;
      this.world.forFurnitureNear(v.x, v.y, reach, (i) => {
        const kind = f[i + 3], F = FURNITURE[kind];
        if (!F?.knock || this.knocked.has(i)) return;
        const dx = f[i] - v.x, dy = f[i + 1] - v.y;
        // in the car's footprint (a capsule along its heading), grown by the thing's size
        const ux = v.vx / sp, uy = v.vy / sp;
        const along = dx * ux + dy * uy, lat = Math.abs(-dx * uy + dy * ux);
        if (Math.abs(along) > v.spec.length / 2 + F.r * 0.6 || lat > v.spec.width / 2 + F.r * 0.6) return;
        const fling = Math.min(6, sp * 0.35);
        this.knocked.set(i, { t: KNOCK_TIME, dx: ux * fling + (hash01(i, 3) - 0.5), dy: uy * fling + (hash01(i, 5) - 0.5), rot: (hash01(i, 7) - 0.5) * 2.4 });
        if (kind === F_HYDRANT) this.geysers.set(i, 25);
        hit(f[i], f[i + 1], kind, sp);
      });
    }
  }

  /** Street-level detail: sign posts and plates, gates, benches, bins, bus stops, café chairs… */
  drawLow(ctx: CanvasRenderingContext2D, v: View, t: number) {
    if (v.scale < 2) return;
    const w = this.world, f = w.furniture;
    ctx.save();
    this.forCells(v, 12, (c) => {
      for (const i of c.furn) {
        const x = f[i], y = f[i + 1];
        if (x < v.x0 - 4 || x > v.x1 + 4 || y < v.y0 - 4 || y > v.y1 + 4) continue;
        const k = this.knocked.get(i);
        ctx.save();
        ctx.translate(x + (k?.dx ?? 0), y + (k?.dy ?? 0));
        ctx.rotate(f[i + 2] + (k?.rot ?? 0));
        drawFurniture(ctx, f[i + 3], !!k, i);
        ctx.restore();
      }
      for (const i of c.gates) this.drawGate(ctx, v, i);
      for (const i of c.signs) this.drawSign(ctx, v, i);
      for (const i of c.stops) this.drawTramStop(ctx, v, i);
    });
    ctx.restore();
    void t;
  }

  /** What stands above the people: café umbrellas, bus shelter roofs, billboards and flags,
   *  leaning away from the camera like the buildings (`lift` gives a point's screen shift at a
   *  height). Drawn with the trees. */
  drawHigh(ctx: CanvasRenderingContext2D, v: View, lift: (x: number, y: number, h: number) => [number, number], t: number) {
    if (v.scale < 2) return;
    const f = this.world.furniture;
    ctx.save();
    this.forCells(v, 20, (c) => {
      for (const i of c.furn) {
        const kind = f[i + 3];
        if (kind !== 9 && kind !== 4 && kind !== 5 && kind !== 12) continue;
        const x = f[i], y = f[i + 1];
        if (x < v.x0 - 10 || x > v.x1 + 10 || y < v.y0 - 10 || y > v.y1 + 10) continue;
        if (this.knocked.has(i)) continue;
        const a = f[i + 2];
        if (kind === 9) {
          // a café umbrella, 2.3 m up
          const [ox, oy] = lift(x, y, 2.3);
          const col = UMBRELLAS[(hash01(i, 11) * UMBRELLAS.length) | 0];
          ctx.fillStyle = 'rgba(0,0,0,0.12)';
          ctx.beginPath();
          ctx.arc(x + 0.5, y + 0.6, 1.25, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = col;
          ctx.beginPath();
          for (let s = 0; s < 8; s++) {
            const aa = a + (s / 8) * Math.PI * 2;
            ctx.lineTo(x + ox + Math.cos(aa) * 1.3, y + oy + Math.sin(aa) * 1.3);
          }
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 0.05;
          ctx.beginPath();
          for (let s = 0; s < 8; s += 2) {
            const aa = a + (s / 8) * Math.PI * 2;
            ctx.moveTo(x + ox, y + oy);
            ctx.lineTo(x + ox + Math.cos(aa) * 1.3, y + oy + Math.sin(aa) * 1.3);
          }
          ctx.stroke();
        } else if (kind === 4) {
          // the bus shelter's glass roof, 2.5 m up
          const [ox, oy] = lift(x, y, 2.5);
          ctx.save();
          ctx.translate(x + ox, y + oy);
          ctx.rotate(a + Math.PI / 2);
          ctx.fillStyle = 'rgba(150,190,210,0.45)';
          ctx.fillRect(-2.1, -0.85, 4.2, 1.7);
          ctx.strokeStyle = 'rgba(40,44,48,0.8)';
          ctx.lineWidth = 0.08;
          ctx.strokeRect(-2.1, -0.85, 4.2, 1.7);
          ctx.restore();
        } else if (kind === 5) {
          this.drawBillboard(ctx, x, y, a, i, lift);
        } else {
          // a flag on its pole, 8 m up, waving
          const [ox, oy] = lift(x, y, 8);
          ctx.strokeStyle = 'rgba(90,90,90,0.9)';
          ctx.lineWidth = 0.08;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + ox, y + oy);
          ctx.stroke();
          const wave = Math.sin(t * 3 + i) * 0.15;
          ctx.save();
          ctx.translate(x + ox, y + oy);
          ctx.rotate(0.6 + wave);
          ctx.fillStyle = '#f5f5f5';
          ctx.fillRect(0, -0.5, 1.5, 0.34);
          ctx.fillStyle = '#1d4fa3';
          ctx.fillRect(0, -0.16, 1.5, 0.33);
          ctx.fillStyle = '#e02b2b';
          ctx.fillRect(0, 0.17, 1.5, 0.33);
          ctx.restore();
        }
      }
    });
    ctx.restore();
  }

  /** A billboard on its posts: a board 5 m up, facing the street, with a parody ad on it. */
  private drawBillboard(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, i: number, lift: (x: number, y: number, h: number) => [number, number]) {
    const ad = ROOF_ADS[(hash01(i, 13) * ROOF_ADS.length) | 0];
    // along the board (perpendicular to the way it faces)
    const ux = -Math.sin(a), uy = Math.cos(a), L = 3.6;
    const x0 = x - ux * (L / 2), y0 = y - uy * (L / 2), x1 = x + ux * (L / 2), y1 = y + uy * (L / 2);
    const [b0x, b0y] = lift(x0, y0, 2.4), [b1x, b1y] = lift(x1, y1, 2.4);
    const [t0x, t0y] = lift(x0, y0, 5);
    // posts
    ctx.strokeStyle = '#3a3c40';
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    for (const s of [0.25, 0.75]) {
      const px = x0 + (x1 - x0) * s, py = y0 + (y1 - y0) * s;
      const [qx, qy] = lift(px, py, 2.4);
      ctx.moveTo(px, py);
      ctx.lineTo(px + qx, py + qy);
    }
    ctx.stroke();
    // the board: 3.6 m by 2.6 m, from 2.4 m to 5 m up, in board metres (u along it, v up it), the
    // ad painted on it and foreshortened by the view like a wall
    const H = 2.6;
    ctx.save();
    const ax = x0 + b0x, ay = y0 + b0y;
    const ex = x1 + b1x - ax, ey = y1 + b1y - ay;
    const fx = x0 + t0x - ax, fy = y0 + t0y - ay;
    ctx.transform(ex / L, ey / L, fx / H, fy / H, ax, ay);
    ctx.fillStyle = ad.bg;
    ctx.fillRect(0, 0, L, H);
    ctx.strokeStyle = ad.accent;
    ctx.lineWidth = 0.1;
    ctx.strokeRect(0.1, 0.1, L - 0.2, H - 0.2);
    ctx.fillStyle = ad.fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 0.9px "Arial Black", Impact, sans-serif';
    // letters stand up the board (+v), read along it
    ctx.translate(L / 2, H * 0.55);
    ctx.scale(1, -1);
    const w = ctx.measureText(ad.title).width;
    const fit = Math.min(1, (L * 0.88) / Math.max(0.01, w));
    ctx.scale(fit, fit);
    ctx.fillText(ad.title, 0, 0);
    ctx.restore();
  }

  private drawGate(ctx: CanvasRenderingContext2D, v: View, i: number) {
    const g = this.world.gates;
    const px = g.px[i], py = g.py[i];
    if (px < v.x0 - 10 || px > v.x1 + 10 || py < v.y0 - 10 || py > v.y1 + 10) return;
    const L = g.len[i];
    let ux = g.ux[i], uy = g.uy[i];
    const broken = g.broken[i] > 0;
    // the post with its motor box
    ctx.fillStyle = '#e6e4de';
    ctx.fillRect(px - 0.3, py - 0.3, 0.6, 0.6);
    ctx.strokeStyle = '#2f3134';
    ctx.lineWidth = 0.06;
    ctx.strokeRect(px - 0.3, py - 0.3, 0.6, 0.6);
    let bx = px, by = py;
    if (broken) {
      // the snapped boom lies where it fell for a while, then it's cleared away
      const since = 150 - g.broken[i];
      if (since > 60) return;
      const rot = g.spin[i] * 1.1;
      const c = Math.cos(rot), s = Math.sin(rot);
      [ux, uy] = [ux * c - uy * s, ux * s + uy * c];
      bx += ux * 0.6;
      by += uy * 0.6;
    }
    // the red and white boom
    ctx.lineCap = 'butt';
    ctx.lineWidth = 0.14;
    ctx.strokeStyle = '#f4f4f0';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + ux * L * (broken ? 0.7 : 1), by + uy * L * (broken ? 0.7 : 1));
    ctx.stroke();
    ctx.strokeStyle = '#d32f2f';
    ctx.setLineDash([0.45, 0.45]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
  }

  private drawSign(ctx: CanvasRenderingContext2D, v: View, i: number) {
    const m = this.world.marks.signs[i];
    // the post at the right-hand kerb, a little before the line
    const nx = -m.uy, ny = m.ux, off = m.hw + 0.7;
    const x = m.x + nx * off - m.ux * 0.5, y = m.y + ny * off - m.uy * 0.5;
    if (x < v.x0 - 6 || x > v.x1 + 6 || y < v.y0 - 6 || y > v.y1 + 6) return;
    if (m.kind === 0 && v.scale > 4) {
      // STOP painted on the lane before the line, read by the driver coming up to it
      ctx.save();
      const tx = m.x + nx * Math.max(1, m.hw / 2) - m.ux * 2.6, ty = m.y + ny * Math.max(1, m.hw / 2) - m.uy * 2.6;
      ctx.translate(tx, ty);
      ctx.rotate(Math.atan2(m.uy, m.ux) + Math.PI / 2);
      ctx.fillStyle = 'rgba(245,244,238,0.85)';
      ctx.font = '700 1.1px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.scale(1, 1.6);
      ctx.fillText('STOP', 0, 0);
      ctx.restore();
    }
    // the post and the plate (seen from above, turned to face the traffic)
    ctx.fillStyle = '#55585c';
    ctx.beginPath();
    ctx.arc(x, y, 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(m.uy, m.ux) - Math.PI / 2);
    if (m.kind === 0) {
      ctx.fillStyle = '#d32f2f';
      ctx.beginPath();
      for (let k = 0; k < 8; k++) ctx.lineTo(Math.cos((k + 0.5) * (Math.PI / 4)) * 0.38, Math.sin((k + 0.5) * (Math.PI / 4)) * 0.38);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 0.05;
      ctx.stroke();
    } else {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#d32f2f';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(-0.4, -0.25);
      ctx.lineTo(0.4, -0.25);
      ctx.lineTo(0, 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTramStop(ctx: CanvasRenderingContext2D, v: View, i: number) {
    const ts = this.world.tramStops;
    const x = ts[i], y = ts[i + 1];
    if (x < v.x0 - 8 || x > v.x1 + 8 || y < v.y0 - 8 || y > v.y1 + 8) return;
    // the stop's sign: a pole with the DPB plate, 2.5 m off the track
    const sx = x + 2.4, sy = y;
    ctx.fillStyle = '#4a4d52';
    ctx.beginPath();
    ctx.arc(sx, sy, 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d71920';
    ctx.fillRect(sx - 0.35, sy - 0.25, 0.7, 0.5);
    ctx.fillStyle = '#fff';
    ctx.font = '800 0.28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Z', sx, sy + 0.02);
    const name = this.world.tramStopNames[i / 2];
    if (this.labels && name && v.scale > 5) {
      ctx.font = '700 0.55px system-ui, sans-serif';
      const w = ctx.measureText(name).width + 0.4;
      ctx.fillStyle = 'rgba(20,24,30,0.72)';
      ctx.fillRect(sx - w / 2, sy + 0.4, w, 0.75);
      ctx.fillStyle = '#fff';
      ctx.fillText(name, sx, sy + 0.78);
    }
  }
}

const UMBRELLAS = ['#c62828', '#f5f0e1', '#2e7d32', '#1565c0', '#6d4c41', '#ef6c00', '#37474f'];

/** One piece of street furniture at the origin, facing +x (its seat or sign toward the street). */
function drawFurniture(ctx: CanvasRenderingContext2D, kind: number, knocked: boolean, i: number) {
  switch (kind) {
    case 0: {
      // bench: wooden slats between cast-iron ends, a backrest behind
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(-0.2, -0.85, 0.55, 1.8);
      ctx.fillStyle = '#8b6a47';
      for (const o of [-0.18, -0.02, 0.14]) ctx.fillRect(o, -0.85, 0.12, 1.7);
      ctx.fillStyle = '#2f3134';
      ctx.fillRect(-0.24, -0.9, 0.5, 0.12);
      ctx.fillRect(-0.24, 0.73, 0.5, 0.12);
      break;
    }
    case 1: {
      // litter bin
      ctx.fillStyle = '#3f4a3f';
      ctx.beginPath();
      ctx.arc(0, 0, 0.27, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#6b7a6b';
      ctx.beginPath();
      ctx.arc(0, 0, 0.17, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 2: {
      // pillar fire hydrant
      ctx.fillStyle = knocked ? '#7a1f1f' : '#c62828';
      ctx.beginPath();
      ctx.arc(0, 0, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-0.06, -0.3, 0.12, 0.6);
      ctx.fillStyle = '#e57373';
      ctx.beginPath();
      ctx.arc(-0.04, -0.04, 0.08, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 3: {
      // bus stop: a pole with the red DPB plate
      ctx.fillStyle = '#4a4d52';
      ctx.beginPath();
      ctx.arc(0, 0, 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#d71920';
      ctx.fillRect(-0.1, -0.35, 0.2, 0.7);
      break;
    }
    case 4: {
      // bus shelter: glass back wall and sides, a bench inside (the roof is drawn up high)
      ctx.fillStyle = 'rgba(40,44,48,0.25)';
      ctx.fillRect(-0.8, -2.1, 1.6, 4.2);
      ctx.strokeStyle = 'rgba(180,215,230,0.9)';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(0.8, -2.1);
      ctx.lineTo(-0.8, -2.1);
      ctx.lineTo(-0.8, 2.1);
      ctx.lineTo(0.8, 2.1);
      ctx.stroke();
      ctx.fillStyle = '#6d6f73';
      ctx.fillRect(-0.7, -1.4, 0.4, 2.8);
      break;
    }
    case 5: {
      // billboard posts' feet (the board is drawn up high)
      ctx.fillStyle = '#3a3c40';
      ctx.fillRect(-0.12, -0.95, 0.24, 0.24);
      ctx.fillRect(-0.12, 0.71, 0.24, 0.24);
      break;
    }
    case 6: {
      // advertising column: a round pillar pasted with posters, a dome cap
      ctx.fillStyle = '#2e5f3e';
      ctx.beginPath();
      ctx.arc(0, 0, 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e8dcc0';
      ctx.beginPath();
      ctx.arc(0, 0, 0.42, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 7: {
      // bicycle stands, a bike or two in them
      ctx.strokeStyle = '#5f6368';
      ctx.lineWidth = 0.06;
      ctx.beginPath();
      for (const o of [-0.6, 0, 0.6]) {
        ctx.moveTo(-0.35, o);
        ctx.lineTo(0.35, o);
      }
      ctx.stroke();
      if (hash01(i, 17) < 0.7) {
        ctx.strokeStyle = BIKES[(hash01(i, 19) * BIKES.length) | 0];
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        ctx.moveTo(-0.85, -0.3);
        ctx.lineTo(0.85, -0.3);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(-0.6, -0.3, 0.3, 0, Math.PI * 2);
        ctx.arc(0.6, -0.3, 0.3, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case 8: {
      // post box (Slovenská pošta orange)
      ctx.fillStyle = '#ef8a1e';
      ctx.fillRect(-0.22, -0.3, 0.44, 0.6);
      ctx.fillStyle = '#1b3f8b';
      ctx.fillRect(-0.18, -0.08, 0.36, 0.16);
      break;
    }
    case 9: {
      // café table and chairs (the umbrella is drawn up high)
      ctx.fillStyle = '#5b4a3a';
      for (let s = 0; s < 4; s++) {
        const a = (s / 4) * Math.PI * 2 + 0.3;
        ctx.fillRect(Math.cos(a) * 0.62 - 0.17, Math.sin(a) * 0.62 - 0.17, 0.34, 0.34);
      }
      ctx.fillStyle = '#f2ede2';
      ctx.beginPath();
      ctx.arc(0, 0, 0.36, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 10: {
      // drinking fountain
      ctx.fillStyle = '#707478';
      ctx.fillRect(-0.18, -0.18, 0.36, 0.36);
      ctx.fillStyle = '#4fc3f7';
      ctx.beginPath();
      ctx.arc(0, 0, 0.1, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 11: {
      // recycling containers: glass, paper, plastic
      const cols = ['#2e7d32', '#1565c0', '#f9a825'];
      cols.forEach((c, k) => {
        ctx.fillStyle = c;
        ctx.fillRect(-0.55, -1.6 + k * 1.1, 1.1, 1.0);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(-0.55, -1.6 + k * 1.1 + 0.85, 1.1, 0.15);
      });
      break;
    }
    case 12: {
      // flagpole foot
      ctx.fillStyle = '#8a8d91';
      ctx.beginPath();
      ctx.arc(0, 0, 0.12, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 13: {
      // bike-share dock: the terminal and a row of green bikes
      ctx.fillStyle = '#3d4247';
      ctx.fillRect(-0.25, -1.4, 0.5, 0.4);
      ctx.strokeStyle = '#43a047';
      ctx.lineWidth = 0.06;
      for (let k = 0; k < 4; k++) {
        if (hash01(i, 23 + k) < 0.35) continue;
        const o = -0.8 + k * 0.6;
        ctx.beginPath();
        ctx.moveTo(-0.8, o);
        ctx.lineTo(0.8, o);
        ctx.stroke();
      }
      break;
    }
    case 14: {
      // picnic table with its benches
      ctx.fillStyle = '#8b6a47';
      ctx.fillRect(-0.4, -0.9, 0.8, 1.8);
      ctx.fillStyle = '#76593b';
      ctx.fillRect(-0.75, -0.9, 0.22, 1.8);
      ctx.fillRect(0.53, -0.9, 0.22, 1.8);
      break;
    }
    case 15: {
      // charging station
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(-0.25, -0.2, 0.5, 0.4);
      ctx.fillStyle = '#43a047';
      ctx.fillRect(-0.08, -0.08, 0.16, 0.16);
      break;
    }
  }
}

const BIKES = ['#263238', '#c62828', '#1565c0', '#2e7d32', '#6d4c41', '#9e9e9e'];
