/** Simple uniform grid for broad-phase neighbour queries. Reusable: clear() + insert() each step, then query(). */
export class SpatialHash<T> {
  private cell: number;
  private map = new Map<number, T[]>();
  /** cells filled since the last clear(): emptied (not freed) on clear, so rebuilding every step makes no garbage */
  private used: T[][] = [];
  /** reusable dedupe sets, one per nesting level of query() */
  private seenPool: Set<T>[] = [];
  private depth = 0;
  /** some item since the last clear() spans several cells, so queries must dedupe */
  private spans = false;

  constructor(cellSize: number) {
    this.cell = cellSize;
  }

  private key(gx: number, gy: number) {
    return (gx + 100000) * 200000 + (gy + 100000);
  }

  clear() {
    for (const c of this.used) c.length = 0;
    this.used.length = 0;
    this.spans = false;
  }

  /** Insert an item, spanning every cell its (x, y, r) bounding box touches. */
  insert(item: T, x: number, y: number, r = 0) {
    const gx0 = Math.floor((x - r) / this.cell), gx1 = Math.floor((x + r) / this.cell);
    const gy0 = Math.floor((y - r) / this.cell), gy1 = Math.floor((y + r) / this.cell);
    if (gx0 !== gx1 || gy0 !== gy1) this.spans = true;
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = this.key(gx, gy);
        let c = this.map.get(k);
        if (!c) this.map.set(k, (c = []));
        if (!c.length) this.used.push(c);
        c.push(item);
      }
  }

  /** Visit each item near (x, y, r), at most once, in no particular order. */
  query(x: number, y: number, r: number, fn: (item: T) => void) {
    const gx0 = Math.floor((x - r) / this.cell), gx1 = Math.floor((x + r) / this.cell);
    const gy0 = Math.floor((y - r) / this.cell), gy1 = Math.floor((y + r) / this.cell);
    let seen: Set<T> | null = null;
    if (this.spans && (gx0 !== gx1 || gy0 !== gy1)) {
      seen = this.seenPool[this.depth] ??= new Set<T>();
      seen.clear();
    }
    this.depth++;
    try {
      for (let gx = gx0; gx <= gx1; gx++)
        for (let gy = gy0; gy <= gy1; gy++) {
          const c = this.map.get(this.key(gx, gy));
          if (!c) continue;
          for (const it of c) {
            if (seen) {
              if (seen.has(it)) continue;
              seen.add(it);
            }
            fn(it);
          }
        }
    } finally {
      this.depth--;
    }
  }
}
