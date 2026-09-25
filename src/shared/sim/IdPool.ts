// Network ids for every simulated entity (vehicles, peds, trams, pickups, props, helicopters share one
// space). u16 on the wire; freed ids are reused only after REUSE_DELAY so a client never confuses a new
// entity with a stale one it still remembers.

export const MAX_ID = 65535;
const REUSE_DELAY = 10; // seconds of sim time

export class IdPool {
  private next = 1;
  private free: number[] = [];
  private freedAt: number[] = [];
  private used = new Set<number>();

  alloc(now: number): number {
    let id: number;
    if (this.free.length && now - this.freedAt[0] >= REUSE_DELAY) id = this.take();
    else if (this.next <= MAX_ID) id = this.next++;
    else if (this.free.length) id = this.take();
    else throw new Error('IdPool exhausted');
    this.used.add(id);
    return id;
  }

  private take() {
    this.freedAt.shift();
    return this.free.shift()!;
  }

  release(id: number, now: number) {
    if (!this.used.delete(id)) return;
    this.free.push(id);
    this.freedAt.push(now);
  }

  /** Free every allocated id that is no longer alive. */
  sweep(alive: Set<number>, now: number) {
    for (const id of this.used) if (!alive.has(id)) this.release(id, now);
  }

  get size() {
    return this.used.size;
  }
}
