// Static road props for police escalation: barriers/cones (visual, roadblock dressing)
// and spike strips (functional: burst tyres of anything that drives over them).
export type PropKind = 'barrier' | 'cone' | 'spike';

export class Prop {
  kind: PropKind;
  x: number;
  y: number;
  angle: number; // direction of the road the prop sits across
  level: 0 | 1;
  /** half-length across the road (the strip/barrier's own long axis) */
  len: number;
  /** half-thickness along the road direction, used for spike collision */
  hw = 0.35;
  age = 0;
  life: number;
  /** spikes: still armed? set false after it has done its job a few times */
  active = true;
  hits = 0;

  constructor(kind: PropKind, x: number, y: number, angle: number, level: 0 | 1 = 0, len = 3, life = 60) {
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.level = level;
    this.len = len;
    this.life = life;
  }
}

/** Circle (x,y,r) vs a prop's footprint rectangle (rotated by `angle`). */
export function propHit(p: Prop, x: number, y: number, r: number): boolean {
  const dx = x - p.x, dy = y - p.y;
  const ca = Math.cos(p.angle), sa = Math.sin(p.angle);
  const lx = dx * ca + dy * sa; // along the road
  const ly = -dx * sa + dy * ca; // across the road
  return Math.abs(lx) < p.hw + r && Math.abs(ly) < p.len / 2 + r;
}

export function drawProps(ctx: CanvasRenderingContext2D, props: Prop[], level: 0 | 1) {
  for (const p of props) {
    if (p.level !== level) continue;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    if (p.kind === 'spike') {
      const fade = p.active ? 1 : 0.5;
      ctx.globalAlpha = fade;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-0.3, -p.len / 2 - 0.1, 0.6, p.len + 0.2);
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(-0.22, -p.len / 2, 0.44, p.len);
      ctx.strokeStyle = '#f5c518';
      ctx.lineWidth = 0.06;
      ctx.setLineDash([0.22, 0.14]);
      ctx.beginPath();
      ctx.moveTo(0, -p.len / 2 + 0.1);
      ctx.lineTo(0, p.len / 2 - 0.1);
      ctx.stroke();
      ctx.setLineDash([]);
      if (p.active) {
        ctx.fillStyle = '#cfd8dc';
        const n = Math.max(3, Math.round(p.len / 0.45));
        for (let i = 0; i < n; i++) {
          const t = -p.len / 2 + 0.25 + i * ((p.len - 0.5) / Math.max(1, n - 1));
          ctx.beginPath();
          ctx.moveTo(-0.1, t - 0.06);
          ctx.lineTo(0.16, t);
          ctx.lineTo(-0.1, t + 0.06);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    } else if (p.kind === 'barrier') {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(-0.16, -p.len / 2 + 0.05, 0.32, p.len);
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(-0.14, -p.len / 2, 0.28, p.len * 0.42);
      ctx.fillStyle = '#d32f2f';
      ctx.fillRect(-0.14, -p.len / 2 + p.len * 0.42, 0.28, p.len * 0.16);
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(-0.14, -p.len / 2 + p.len * 0.58, 0.28, p.len * 0.42);
      ctx.fillStyle = '#d32f2f';
      ctx.fillRect(-0.14, p.len / 2 - 0.16, 0.28, 0.08);
    } else {
      // cone
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(0, 0.05, 0.26, 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff6d00';
      ctx.beginPath();
      ctx.moveTo(0, -0.55);
      ctx.lineTo(0.24, 0.12);
      ctx.lineTo(-0.24, 0.12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(-0.19, -0.1, 0.38, 0.1);
    }
    ctx.restore();
  }
}
