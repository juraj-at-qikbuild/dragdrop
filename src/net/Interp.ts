// Snapshot interpolation for one remote entity. Samples arrive ~20 Hz stamped with server time;
// the client renders INTERP_DELAY_MS in the past, interpolating between the two samples around the
// render time. Past the newest sample it extrapolates along the velocity for at most MAX_EXTRAP_MS.

export const MAX_EXTRAP_MS = 250;
const CAP = 8;

export class Interp {
  private ts = new Float64Array(CAP);
  private vs: Float64Array;
  private n = 0;
  private head = 0; // index of the next write

  /**
   * @param fields number of numeric fields per sample
   * @param angles indices of fields that are angles (interpolated along the shortest arc)
   * @param extrap [positionField, velocityField] pairs used past the newest sample
   */
  constructor(
    private fields: number,
    private angles: readonly number[] = [],
    private extrap: readonly (readonly [number, number])[] = [],
  ) {
    this.vs = new Float64Array(CAP * fields);
  }

  get size() {
    return this.n;
  }

  /** newest sample's time, or -Infinity */
  get newest() {
    return this.n ? this.ts[(this.head - 1 + CAP) % CAP] : -Infinity;
  }

  push(t: number, vals: ArrayLike<number>) {
    if (this.n && t <= this.newest) return; // out of order / duplicate
    this.ts[this.head] = t;
    this.vs.set(Array.prototype.slice.call(vals, 0, this.fields), this.head * this.fields);
    this.head = (this.head + 1) % CAP;
    if (this.n < CAP) this.n++;
  }

  /** Seed with the same state at two times (ownership hand-off, first sight) so rendering doesn't jump. */
  reset(t: number, vals: ArrayLike<number>) {
    this.n = 0;
    this.head = 0;
    this.push(t, vals);
  }

  clear() {
    this.n = 0;
    this.head = 0;
  }

  /** Writes the state at render time `rt` into `out`; returns false if there is no sample yet. */
  sample(rt: number, out: Float64Array | number[]): boolean {
    if (!this.n) return false;
    const F = this.fields;
    const idx = (k: number) => (this.head - this.n + k + CAP) % CAP; // k = 0 oldest
    // find the pair a <= rt < b
    let bi = -1;
    for (let k = 0; k < this.n; k++) {
      if (this.ts[idx(k)] > rt) {
        bi = k;
        break;
      }
    }
    if (bi === 0) {
      // older than anything buffered: hold the oldest
      this.copy(idx(0), out);
      return true;
    }
    if (bi === -1) {
      // newer than the newest: extrapolate a little, then hold
      const last = idx(this.n - 1);
      this.copy(last, out);
      const dt = Math.min(rt - this.ts[last], MAX_EXTRAP_MS) / 1000;
      if (dt > 0) for (const [p, v] of this.extrap) out[p] += out[v] * dt;
      return true;
    }
    const a = idx(bi - 1), b = idx(bi);
    const ta = this.ts[a], tb = this.ts[b];
    const f = tb > ta ? (rt - ta) / (tb - ta) : 1;
    for (let i = 0; i < F; i++) {
      const va = this.vs[a * F + i], vb = this.vs[b * F + i];
      if (this.angles.includes(i)) {
        let d = (vb - va) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        out[i] = va + d * f;
      } else out[i] = va + (vb - va) * f;
    }
    return true;
  }

  private copy(slot: number, out: Float64Array | number[]) {
    const F = this.fields;
    for (let i = 0; i < F; i++) out[i] = this.vs[slot * F + i];
  }
}
