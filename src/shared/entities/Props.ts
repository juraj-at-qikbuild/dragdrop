// Static road props for police escalation: barriers/cones (visual, roadblock dressing)
// and spike strips (functional: burst tyres of anything that drives over them).
export type PropKind = 'barrier' | 'cone' | 'spike';

export class Prop {
  /** network id, assigned by the Sim */
  id = 0;
  /** the player whose pursuit spawned it */
  owner = 0;
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
