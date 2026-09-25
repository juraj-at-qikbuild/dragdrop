// How many NPCs to keep around each player, and hard caps for the whole world. Offline (one player,
// no caps, governor 1) this reproduces the original single-player densities exactly.

export interface Density {
  traffic: number;
  parked: number;
  peds: number;
  trams: number;
}

export interface Caps extends Density {
  police: number;
  helis: number;
  roadblocks: number;
}

export const BASE_DENSITY: Density = { traffic: 45, parked: 32, peds: 120, trams: 5 };

export const NO_CAPS: Caps = { traffic: Infinity, parked: Infinity, peds: Infinity, trams: Infinity, police: Infinity, helis: Infinity, roadblocks: Infinity };

/** server defaults, sized for one shared vCPU (see docs/deploy.md); scale with NPC_SCALE on bigger machines */
export const SERVER_CAPS: Caps = { traffic: 220, parked: 260, peds: 700, trams: 16, police: 40, helis: 4, roadblocks: 6 };

export function scaleCaps(c: Caps, k: number): Caps {
  const out = { ...c };
  for (const key of Object.keys(out) as (keyof Caps)[]) out[key] = Math.max(1, Math.round(out[key] * k));
  return out;
}

/** per-player share of the base density when N players are spread out; overlapping players share NPCs anyway */
export function playerScale(n: number) {
  return n <= 4 ? 1 : Math.max(0.3, Math.sqrt(4 / n));
}

/** target counts around one player: base × quality × time of day × crowd scale × load governor */
export function targetDensity(base: Density, quality: number, hour: number, scale: number): Density {
  const q = quality === 0 ? 0.6 : 1;
  const rush = (hour >= 7 && hour < 9) || (hour >= 16 && hour < 18);
  const night = hour >= 23 || hour < 5;
  return {
    traffic: Math.round(base.traffic * q * (rush ? 1.3 : night ? 0.7 : 1) * scale),
    parked: Math.round(base.parked * q * scale),
    peds: Math.round(base.peds * q * (night ? 0.6 : 1) * scale),
    trams: Math.max(1, Math.round(base.trams * q * scale)),
  };
}

/** Coarse 100 m grid of per-category counts, for "how many NPCs are around this player" queries. */
export class CountGrid {
  private cells = new Map<number, Int32Array>();
  constructor(private cats: number, private cell = 100) {}
  clear() {
    this.cells.clear();
  }
  private key(gx: number, gy: number) {
    return (gx + 1000) * 4000 + (gy + 1000);
  }
  add(x: number, y: number, cat: number) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, (c = new Int32Array(this.cats)));
    c[cat]++;
  }
  /** approximate count within radius r (whole cells whose centre is inside r + half a diagonal) */
  within(x: number, y: number, r: number, cat: number) {
    const C = this.cell;
    const gx0 = Math.floor((x - r) / C), gx1 = Math.floor((x + r) / C);
    const gy0 = Math.floor((y - r) / C), gy1 = Math.floor((y + r) / C);
    const lim = (r + C * 0.71) ** 2;
    let n = 0;
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        const cx = (gx + 0.5) * C - x, cy = (gy + 0.5) * C - y;
        if (cx * cx + cy * cy > lim) continue;
        const c = this.cells.get(this.key(gx, gy));
        if (c) n += c[cat];
      }
    return n;
  }
}
