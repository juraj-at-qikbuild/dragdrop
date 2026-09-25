/** Seedable PRNG (mulberry32) for simulation code. Gameplay randomness goes through an Rng so tests are
 *  reproducible and appearance can be derived from a seed; purely cosmetic client code (particles,
 *  weather streaks) keeps using Math.random. */
export class Rng {
  private s: number;

  constructor(seed = (Math.random() * 4294967296) >>> 0) {
    this.s = seed >>> 0;
  }

  /** uniform in [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** uniform in [a, b) */
  range(a: number, b: number) {
    return a + this.next() * (b - a);
  }

  /** integer in [0, n) */
  int(n: number) {
    return Math.floor(this.next() * n);
  }

  /** a fresh 32-bit seed, e.g. for a new ped's appearance */
  seed() {
    return Math.floor(this.next() * 4294967296) >>> 0;
  }

  chance(p: number) {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** pick from [value, weight] pairs */
  weighted<T>(list: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of list) total += w;
    let r = this.next() * total;
    for (const [v, w] of list) if ((r -= w) <= 0) return v;
    return list[0][0];
  }
}
