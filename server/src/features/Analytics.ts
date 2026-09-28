import { randomUUID } from 'node:crypto';
import type { DropReason, Room, Session } from '../Room';
import type { HelloMsg } from '../../../src/shared/net/protocol';
import type { Supa } from '../supa';
import type { RoomFeature } from './RoomFeature';
import type { PlaySnapshot } from '../analytics/types';
import { addInterval } from '../analytics/time';

export const INPUT_IDLE_MS = 60_000;
const CHECKPOINT_MS = 15_000;
interface Run {
  snapshot: PlaySnapshot; session: Session; last: number; wall: number; input: number;
  connected: boolean; away: boolean; measured: boolean;
}

/** Independent from simulation speed. Never awaits network I/O on the game thread. */
export class Analytics implements RoomFeature {
  readonly id = 'analytics';
  private runs = new Map<string, Run>();
  private nextCheckpoint = 0;
  private retryAt = 0;
  private retryMs = 1000;
  private running: Promise<void> | null = null;
  private stopped = false;
  private disposed = false;
  private failures = 0;

  constructor(private room: Room, private supa: Supa) {
    if (!this.enabled) return;
    const store = room.store!.analytics;
    for (const s of store.recover()) {
      s.connected = s.active = false; s.ended_at = s.last_seen; s.revision++;
      store.checkpoint(s);
    }
    store.seed();
  }
  private get enabled() { return this.supa.enabled && !!this.room.store; }
  private get store() { return this.room.store!.analytics; }
  readonly messages = {
    activity: (s: Session) => {
      const r = this.runs.get(s.key);
      if (!r || !r.measured || !s.conn || s.player.away) return;
      const now = this.room.monotonicNow();
      if (now - r.input < 5000) return;
      this.advance(r);
      r.input = now;
      this.status(r);
    },
  };
  onHello(s: Session, _isNew: boolean, msg: HelloMsg) {
    if (!this.enabled || this.stopped) return;
    let r = this.runs.get(s.key);
    if (r) this.advance(r);
    else {
      const at = this.room.wallNow();
      r = { snapshot: { id: randomUUID(), player: s.key, nick: s.player.nick, started_at: new Date(at).toISOString(),
        last_seen: new Date(at).toISOString(), ended_at: null, connected: true, active: false, revision: 0, days: [] },
        session: s, last: this.room.monotonicNow(), wall: at, input: -Infinity,
        connected: true, away: false, measured: msg.analytics === true };
      this.runs.set(s.key, r);
    }
    r.session = s; r.connected = true; r.away = false; r.measured = msg.analytics === true;
    r.input = -Infinity;
    this.checkpoint(r);
  }
  onAway(s: Session, on: boolean) {
    const r = this.runs.get(s.key);
    if (!r) return;
    this.advance(r); r.away = on;
    if (on) r.input = -Infinity;
    this.checkpoint(r);
  }
  onLeave(s: Session) {
    const r = this.runs.get(s.key);
    if (!r) return;
    this.advance(r); r.connected = false; r.input = -Infinity;
    this.checkpoint(r);
  }
  onDrop(s: Session, why: DropReason) {
    const r = this.runs.get(s.key);
    if (why === 'deleted' && this.enabled) {
      this.runs.delete(s.key); this.store.forget(s.key);
      return;
    }
    if (r) this.finish(r);
  }
  onClaim(from: string, to: string) { if (this.enabled) this.store.claim(from, to); }

  private advance(r: Run) {
    const now = this.room.monotonicNow(), wall = this.room.wallNow();
    const dt = Math.max(0, now - r.last);
    if (r.connected) {
      const active = r.measured && !r.away
        ? Math.max(0, Math.min(dt, r.input + INPUT_IDLE_MS - r.last, r.session.lastReportAt + INPUT_IDLE_MS - r.last)) : 0;
      addInterval(r.snapshot.days, r.wall, dt, active, r.measured);
      r.snapshot.last_seen = new Date(wall).toISOString();
    }
    r.last = now; r.wall = wall;
    this.status(r);
  }
  private status(r: Run) {
    r.snapshot.nick = r.session.player.nick;
    r.snapshot.connected = r.connected;
    r.snapshot.active = r.connected && !r.away && r.measured && r.last < r.input + INPUT_IDLE_MS && !r.session.player.afk;
  }
  private checkpoint(r: Run) {
    this.status(r); r.snapshot.revision++;
    this.store.checkpoint({ ...r.snapshot, days: r.snapshot.days.map(d => ({
      day: d.day, connected_ms: Math.floor(d.connected_ms), active_ms: Math.floor(d.active_ms), measured_ms: Math.floor(d.measured_ms),
    })) });
  }
  private finish(r: Run) {
    this.advance(r); r.connected = false;
    r.snapshot.ended_at = r.snapshot.last_seen;
    this.checkpoint(r); this.runs.delete(r.snapshot.player);
  }
  tick() {
    if (!this.enabled || this.stopped) return;
    for (const r of this.runs.values()) this.advance(r);
    const now = this.room.monotonicNow();
    if (now >= this.nextCheckpoint) {
      for (const r of this.runs.values()) this.checkpoint(r);
      this.nextCheckpoint = now + CHECKPOINT_MS;
      void this.flush();
    }
  }
  flush(): Promise<void> {
    if (!this.enabled || this.disposed) return Promise.resolve();
    if (this.running) return this.running;
    if (!this.stopped && this.room.monotonicNow() < this.retryAt) return Promise.resolve();
    const rows = this.store.pending();
    const heartbeat = new Date(this.room.wallNow()).toISOString();
    this.running = this.supa.rpc('analytics_ingest', { p_entries: rows.map(r => JSON.parse(r.payload)), p_heartbeat: heartbeat })
      .then(() => {
        if (this.disposed) return;
        this.store.acknowledge(rows); this.retryMs = 1000; this.retryAt = 0;
      })
      .catch(() => {
        this.failures++;
        this.retryAt = this.room.monotonicNow() + this.retryMs;
        this.retryMs = Math.min(60_000, this.retryMs * 2);
        console.error('analytics upload failed; durable checkpoints retained');
      })
      .finally(() => { this.running = null; });
    return this.running;
  }
  shutdown() {
    if (!this.enabled || this.stopped) return;
    for (const r of [...this.runs.values()]) this.finish(r);
    this.stopped = true;
  }
  async drain(timeoutMs = 3000) {
    if (!this.enabled) return;
    const drain = async () => {
      do {
        const previous = this.failures;
        await this.flush();
        if (this.failures !== previous || this.disposed) break;
      } while (this.store.count());
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([drain(), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
  }
  dispose() { this.disposed = true; }
  stats() {
    return { analyticsPending: this.enabled && !this.disposed ? this.store.count() : 0, analyticsFailures: this.failures };
  }
}
