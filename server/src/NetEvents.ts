// SimEvents sink on the server: collects world events (with their position, for interest filtering)
// and per-player private events during a tick; Room sends them out after building snapshots.
import type { KillCause, PrivateEvent, ShotFx, SimEvents } from '../../src/shared/sim/events';
import type { WorldEvent } from '../../src/shared/net/protocol';

export interface PlacedEvent {
  x: number;
  y: number;
  /** player who caused it and already showed it locally (own shots), 0 = everyone gets it */
  skip: number;
  e: WorldEvent;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export class NetEvents implements SimEvents {
  world: PlacedEvent[] = [];
  private priv = new Map<number, PrivateEvent[]>();

  private add(x: number, y: number, e: WorldEvent, skip = 0) {
    this.world.push({ x, y, skip, e });
  }

  shot(e: ShotFx) {
    this.add(e.x, e.y, { k: 'shot', by: e.by, pid: e.pid, x: r2(e.x), y: r2(e.y), a: r2(e.a), w: e.w, lvl: e.lvl, ends: e.ends.map(r2), sparks: e.sparks }, e.pid);
  }
  melee(x: number, y: number, hit: boolean) {
    this.add(x, y, { k: 'melee', x: r2(x), y: r2(y), hit: hit ? 1 : 0 });
  }
  pedHit(id: number, x: number, y: number, size: number) {
    this.add(x, y, { k: 'pedHit', id, x: r2(x), y: r2(y), s: size });
  }
  spark(x: number, y: number, kind: 0 | 1 | 2) {
    this.add(x, y, { k: 'spark', x: r2(x), y: r2(y), kind });
  }
  explode(x: number, y: number, vid: number, color: string | null) {
    this.add(x, y, { k: 'explode', x: r2(x), y: r2(y), vid, c: color });
  }
  crash(vid: number, x: number, y: number, sev: number, nx: number, ny: number, kick: number) {
    this.add(x, y, { k: 'crash', vid, x: r2(x), y: r2(y), sev: r2(sev), nx: r2(nx), ny: r2(ny), kick: r2(kick) });
  }
  pedKilled(id: number, x: number, y: number, by: number, cause: KillCause) {
    this.add(x, y, { k: 'killed', id, x: r2(x), y: r2(y), by, cause });
  }
  scream(x: number, y: number) {
    this.add(x, y, { k: 'scream', x: r2(x), y: r2(y) });
  }
  bell(x: number, y: number) {
    this.add(x, y, { k: 'bell', x: r2(x), y: r2(y) });
  }
  horn(vid: number, x: number, y: number) {
    this.add(x, y, { k: 'horn', vid, x: r2(x), y: r2(y) });
  }
  say(id: number, x: number, y: number, line: number) {
    this.add(x, y, { k: 'say', id, l: line });
  }
  toPlayer(pid: number, e: PrivateEvent) {
    let q = this.priv.get(pid);
    if (!q) this.priv.set(pid, (q = []));
    q.push(e);
  }

  /** private events for a player (and forget them) */
  takePrivate(pid: number): PrivateEvent[] {
    const q = this.priv.get(pid);
    if (!q) return [];
    this.priv.delete(pid);
    return q;
  }

  /** end of tick: drop world events and private events nobody picked up */
  clear() {
    this.world.length = 0;
    this.priv.clear();
  }
}
