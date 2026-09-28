/** Simple uniform grid for broad-phase neighbour queries. Reusable: clear() + insert() each step, then query(). */
export class SpatialHash<T> {
  private cell: number;
  /** cell -> indices into `items` (a key small enough to stay a small integer: Map lookups by a
   *  heap-number key are several times slower) */
  private map = new Map<number, number[]>();
  /** cells filled since the last clear(): emptied (not freed) on clear, so rebuilding every step makes no garbage */
  private used: number[][] = [];
  /** everything inserted since the last clear(), with the first cell of its box */
  private items: T[] = [];
  private gx0: number[] = [];
  private gy0: number[] = [];
  /** some item since the last clear() spans several cells, so queries must dedupe */
  private spans = false;

  constructor(cellSize: number) {
    this.cell = cellSize;
  }

  private key(gx: number, gy: number) {
    return gx > -8192 && gx < 8192 && gy > -8192 && gy < 8192 ? (gx + 8192) * 16384 + (gy + 8192) : (gx + 100000) * 200000 + (gy + 100000) + 0.5;
  }

  clear() {
    for (const c of this.used) c.length = 0;
    this.used.length = 0;
    this.items.length = 0;
    this.gx0.length = 0;
    this.gy0.length = 0;
    this.spans = false;
  }

  /** Insert an item, spanning every cell its (x, y, r) bounding box touches. */
  insert(item: T, x: number, y: number, r = 0) {
    const gx0 = Math.floor((x - r) / this.cell), gx1 = Math.floor((x + r) / this.cell);
    const gy0 = Math.floor((y - r) / this.cell), gy1 = Math.floor((y + r) / this.cell);
    if (gx0 !== gx1 || gy0 !== gy1) this.spans = true;
    const e = this.items.length;
    this.items.push(item);
    this.gx0.push(gx0);
    this.gy0.push(gy0);
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = this.key(gx, gy);
        let c = this.map.get(k);
        if (!c) this.map.set(k, (c = []));
        if (!c.length) this.used.push(c);
        c.push(e);
      }
  }

  /** Visit each item near (x, y, r), at most once, in no particular order. (An item spanning several
   *  cells of the query is visited in the first of them the loops reach: the same order a "seen" set
   *  gives.) */
  query(x: number, y: number, r: number, fn: (item: T) => void) {
    const gx0 = Math.floor((x - r) / this.cell), gx1 = Math.floor((x + r) / this.cell);
    const gy0 = Math.floor((y - r) / this.cell), gy1 = Math.floor((y + r) / this.cell);
    const dedupe = this.spans && (gx0 !== gx1 || gy0 !== gy1);
    const items = this.items, X0 = this.gx0, Y0 = this.gy0;
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        const c = this.map.get(this.key(gx, gy));
        if (!c) continue;
        for (let i = 0; i < c.length; i++) {
          const e = c[i];
          if (dedupe && (gx !== (X0[e] > gx0 ? X0[e] : gx0) || gy !== (Y0[e] > gy0 ? Y0[e] : gy0))) continue;
          fn(items[e]);
        }
      }
  }
}
