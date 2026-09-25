// About one second of recent positions per entity. Clients render the world ~100 ms (+ half their
// ping) in the past and aim at what they see, so a hit they claim is checked against where the target
// was at *their* render time, not where it is now (lag compensation, validation only).

const N = 24; // samples per entity (1.2 s at 20 Hz)

interface Ring {
  t: Float64Array;
  x: Float32Array;
  y: Float32Array;
  lvl: Uint8Array;
  alive: Uint8Array;
  head: number;
  n: number;
  seen: number;
}

export interface Past {
  x: number;
  y: number;
  lvl: 0 | 1;
  alive: boolean;
  /** speed around that time, m/s */
  speed: number;
}

export class History {
  private rings = new Map<number, Ring>();
  private tick = 0;

  record(t: number, id: number, x: number, y: number, lvl: 0 | 1, alive: boolean) {
    let r = this.rings.get(id);
    if (!r) {
      r = { t: new Float64Array(N), x: new Float32Array(N), y: new Float32Array(N), lvl: new Uint8Array(N), alive: new Uint8Array(N), head: 0, n: 0, seen: 0 };
      this.rings.set(id, r);
    }
    const i = r.head;
    r.t[i] = t;
    r.x[i] = x;
    r.y[i] = y;
    r.lvl[i] = lvl;
    r.alive[i] = alive ? 1 : 0;
    r.head = (i + 1) % N;
    if (r.n < N) r.n++;
    r.seen = this.tick;
  }

  /** call once per tick after recording: forgets entities that weren't recorded for a few ticks */
  endTick() {
    this.tick++;
    if (this.tick % 20) return;
    for (const [id, r] of this.rings) if (this.tick - r.seen > 40) this.rings.delete(id);
  }

  /** where entity `id` was at time `t` (interpolated), or null if unknown */
  at(id: number, t: number): Past | null {
    const r = this.rings.get(id);
    if (!r || !r.n) return null;
    const idx = (k: number) => (r.head - r.n + k + N) % N; // k = 0 oldest
    let b = -1;
    for (let k = 0; k < r.n; k++)
      if (r.t[idx(k)] >= t) {
        b = k;
        break;
      }
    const last = idx(r.n - 1);
    if (b === -1) return this.sample(r, last, last, 0);
    if (b === 0) return this.sample(r, idx(0), idx(Math.min(1, r.n - 1)), 0);
    const i0 = idx(b - 1), i1 = idx(b);
    const f = r.t[i1] > r.t[i0] ? (t - r.t[i0]) / (r.t[i1] - r.t[i0]) : 1;
    return this.sample(r, i0, i1, f);
  }

  private sample(r: Ring, i0: number, i1: number, f: number): Past {
    const dt = Math.max(1e-3, (r.t[i1] - r.t[i0]) / 1000);
    const speed = i0 === i1 ? 0 : Math.hypot(r.x[i1] - r.x[i0], r.y[i1] - r.y[i0]) / dt;
    return {
      x: r.x[i0] + (r.x[i1] - r.x[i0]) * f,
      y: r.y[i0] + (r.y[i1] - r.y[i0]) * f,
      lvl: (f < 0.5 ? r.lvl[i0] : r.lvl[i1]) as 0 | 1,
      alive: !!(f < 0.5 ? r.alive[i0] : r.alive[i1]),
      speed,
    };
  }
}
