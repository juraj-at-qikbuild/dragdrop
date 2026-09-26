// The world-event director. Every few minutes it starts a timed event somewhere in the city (the
// Horúca Kofolka van, a golden Čumil hunt, an armoured cash van, a demolition derby), which announces
// itself, runs and ends; anyone who shows up is in. Each kind is a plug-in (WorldEventDef, registered
// in rules/index.ts); the most wanted chase is started by trigger() rather than the schedule.
// Plan: docs/plans/social-events.md
import type { Sim } from '../Sim';
import type { SimRule } from './SimRule';
import type { EventEntry, EventKind, EventPhase } from './types';

export type RulesMode = 'offline' | 'server';

export interface WorldEventDef {
  kind: EventKind;
  /** players online needed to start it (online) */
  minPlayers: number;
  /** also runs in single-player */
  offline: boolean;
  /** picked by the scheduler (false: only started through trigger()) */
  scheduled: boolean;
  /** relative chance among the scheduled kinds that can start */
  weight: number;
  /** seconds before this kind may run again after it ended */
  cooldown: number;
  /** set it up, or null when it can't start now (no spot found, …). `arg`: trigger()'s argument */
  create(sim: Sim, director: WorldEvents, id: number, arg?: unknown): EventInstance | null;
}

/** A running event. It also gets the SimRule hooks (forwarded by the director while it's active). */
export interface EventInstance extends Omit<SimRule, 'id' | 'step'> {
  readonly id: number;
  readonly kind: EventKind;
  readonly phase: EventPhase;
  /** advance by dt; return false once it's over (the director drops it) */
  update(dt: number): boolean;
  /** what the map and HUD show */
  entry(): EventEntry;
  /** end it now (debug, shutdown): clean up its entities */
  stop(reason: string): void;
}

/** Common plumbing: an announce phase, then a live one, each with a countdown. */
export abstract class TimedEvent implements EventInstance {
  phase: EventPhase;
  /** seconds left in the current phase */
  left: number;

  constructor(
    protected sim: Sim,
    protected director: WorldEvents,
    readonly id: number,
    readonly kind: EventKind,
    announce: number,
    protected liveFor: number,
  ) {
    this.phase = announce > 0 ? 'announce' : 'live';
    this.left = announce > 0 ? announce : liveFor;
  }

  /** counts the phases down and calls onLive() / onTimeout(); subclasses call it first in update() */
  protected tick(dt: number) {
    this.left -= dt;
    if (this.left > 0) return;
    if (this.phase === 'announce') {
      this.phase = 'live';
      this.left = this.liveFor;
      this.director.changed();
      this.onLive();
    } else if (this.phase === 'live') this.onTimeout();
  }

  /** the announce phase is over */
  protected onLive() {}
  /** the live phase ran out */
  protected onTimeout() {}

  abstract update(dt: number): boolean;
  abstract entry(): EventEntry;
  abstract stop(reason: string): void;
}

export class WorldEvents implements SimRule {
  readonly id = 'worldEvents';
  readonly defs = new Map<EventKind, WorldEventDef>();
  readonly active: EventInstance[] = [];
  /** bumped when an event starts, ends or changes phase: hosts push `wev` then */
  version = 0;
  /** tunables (the server can override them from game_config) */
  config = {
    /** seconds between scheduled events: online, and offline (longer) */
    gap: [7 * 60, 11 * 60] as [number, number],
    offlineGap: [12 * 60, 18 * 60] as [number, number],
    /** the first one after a (re)start comes sooner */
    first: [3 * 60, 5 * 60] as [number, number],
    /** try again this soon when nothing could start */
    retry: 30,
    enabled: true,
  };
  private timer: number;
  private nextId = 1;
  private endedAt = new Map<EventKind, number>();

  constructor(
    private sim: Sim,
    readonly mode: RulesMode,
  ) {
    this.timer = sim.rng.range(this.config.first[0], this.config.first[1]);
  }

  register(def: WorldEventDef) {
    this.defs.set(def.kind, def);
  }

  /** players who count: connected and not idle (online), or the one local player */
  playerCount() {
    let n = 0;
    for (const p of this.sim.players.values()) if (p.observing) n++;
    return n;
  }

  step(dt: number) {
    for (const e of [...this.active]) if (!e.update(dt)) this.finish(e);
    if (!this.config.enabled) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.config.retry;
    // one scheduled event at a time (the most wanted chase and races run alongside)
    if (this.active.some((e) => this.defs.get(e.kind)?.scheduled)) return;
    const n = this.playerCount();
    const now = this.sim.time;
    const ready = [...this.defs.values()].filter(
      (d) => d.scheduled && (this.mode === 'offline' ? d.offline : n >= d.minPlayers) && now - (this.endedAt.get(d.kind) ?? -1e9) >= d.cooldown,
    );
    if (!ready.length) return;
    const def = this.sim.rng.weighted(ready.map((d) => [d, d.weight] as const));
    if (this.start(def.kind)) {
      const [a, b] = this.mode === 'offline' ? this.config.offlineGap : this.config.gap;
      this.timer = this.sim.rng.range(a, b);
    }
  }

  /** start an event of this kind now (the schedule, a trigger, a debug command); null if it can't */
  start(kind: EventKind, arg?: unknown): EventInstance | null {
    const def = this.defs.get(kind);
    if (!def) return null;
    const e = def.create(this.sim, this, this.nextId++, arg);
    if (!e) return null;
    this.active.push(e);
    this.changed();
    return e;
  }

  /** for triggered kinds (the most wanted): start unless one of this kind is already running */
  trigger(kind: EventKind, arg?: unknown): EventInstance | null {
    return this.get(kind) ? null : this.start(kind, arg);
  }

  get(kind: EventKind): EventInstance | undefined {
    return this.active.find((e) => e.kind === kind);
  }

  /** something the map shows changed (phase, holder): hosts resend `wev` */
  changed() {
    this.version++;
  }

  entries(): EventEntry[] {
    return this.active.map((e) => e.entry());
  }

  /** end everything (server shutdown, tests) */
  stopAll(reason = 'stopped') {
    for (const e of [...this.active]) {
      e.stop(reason);
      this.finish(e);
    }
  }

  private finish(e: EventInstance) {
    const i = this.active.indexOf(e);
    if (i >= 0) this.active.splice(i, 1);
    this.endedAt.set(e.kind, this.sim.time);
    this.changed();
  }

  // ---- SimRule hooks, forwarded to the running events
  allowPvp(a: Parameters<NonNullable<SimRule['allowPvp']>>[0], v: Parameters<NonNullable<SimRule['allowPvp']>>[1]) {
    return this.active.every((e) => e.allowPvp?.(a, v) !== false);
  }
  allowCrime(...args: Parameters<NonNullable<SimRule['allowCrime']>>) {
    return this.active.every((e) => e.allowCrime?.(...args) !== false);
  }
  onState(...args: Parameters<NonNullable<SimRule['onState']>>) {
    for (const e of [...this.active]) e.onState?.(...args);
  }
  onKill(...args: Parameters<NonNullable<SimRule['onKill']>>) {
    for (const e of [...this.active]) e.onKill?.(...args);
  }
  onEnter(...args: Parameters<NonNullable<SimRule['onEnter']>>) {
    for (const e of [...this.active]) e.onEnter?.(...args);
  }
  onExit(...args: Parameters<NonNullable<SimRule['onExit']>>) {
    for (const e of [...this.active]) e.onExit?.(...args);
  }
  onVehicleHit(...args: Parameters<NonNullable<SimRule['onVehicleHit']>>) {
    for (const e of [...this.active]) e.onVehicleHit?.(...args);
  }
  onPickup(...args: Parameters<NonNullable<SimRule['onPickup']>>) {
    for (const e of [...this.active]) e.onPickup?.(...args);
  }
  onAdd(...args: Parameters<NonNullable<SimRule['onAdd']>>) {
    for (const e of [...this.active]) e.onAdd?.(...args);
  }
  onRemove(...args: Parameters<NonNullable<SimRule['onRemove']>>) {
    for (const e of [...this.active]) e.onRemove?.(...args);
  }
}
