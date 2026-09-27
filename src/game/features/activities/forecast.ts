// What's coming next, worked out from the world-event director's plan (EventSchedule: `wev.up` online,
// read straight off the rules offline): when the next world event can start at the earliest, which
// kinds it could be, and where every kind stands. Pure, for the Aktivity panel (ActivitiesUi) and its
// HUD chip (Hud.drawActivities); test/client/forecast.test.ts checks it.
import type { EventKind, EventSchedule } from '../../../shared/sim/rules/types';
import type { LiveState } from '../../SimHost';

export type KindStatus =
  /** on right now (announced or live) */
  | { s: 'live' }
  /** off cooldown, with enough players: it can be the next one */
  | { s: 'ready' }
  /** it ran lately: it can come again in `secs` */
  | { s: 'cooldown'; secs: number }
  /** it needs `need` players and there are `have` */
  | { s: 'players'; need: number; have: number }
  /** not on the schedule: it starts by itself (the most wanted, when someone reaches 5★); `need`
   *  players at least */
  | { s: 'trigger'; need: number; have: number }
  /** never runs here (the online-only kinds, offline) */
  | { s: 'never' }
  /** the schedule is switched off */
  | { s: 'off' };

export interface Forecast {
  /** seconds until the next scheduled event can start, at the earliest; null: none can (switched
   *  off, or every kind needs more players) */
  next: number | null;
  /** a scheduled event is on: the next one waits for it to end */
  busy: boolean;
  /** the kinds that could be picked at `next` */
  candidates: EventKind[];
  kinds: { kind: EventKind; status: KindStatus }[];
  /** players who count, this one included (see `awayMe`) */
  players: number;
}

/**
 * @param s the plan as it was sent
 * @param elapsed seconds since it was sent
 * @param running the kinds on right now
 * @param awayMe this player is away (the pause menu): the server doesn't count them just now, but will
 *   the moment they're back, so the forecast does
 */
export function forecast(s: EventSchedule, elapsed: number, running: readonly EventKind[], awayMe = false): Forecast {
  const players = s.players + (awayMe ? 1 : 0);
  const timer = Math.max(0, s.next - elapsed);
  const kinds: Forecast['kinds'] = [];
  const open: { kind: EventKind; cd: number }[] = [];
  let busy = false;
  for (const k of s.kinds) {
    let status: KindStatus;
    if (running.includes(k.kind)) {
      status = { s: 'live' };
      if (k.sched) busy = true;
    } else if (k.never) status = { s: 'never' };
    else if (!k.sched) status = { s: 'trigger', need: k.min, have: players };
    else if (!s.on) status = { s: 'off' };
    else if (!s.offline && players < k.min) status = { s: 'players', need: k.min, have: players };
    else {
      const cd = Math.max(0, k.cd - elapsed);
      status = cd > 0 ? { s: 'cooldown', secs: cd } : { s: 'ready' };
      open.push({ kind: k.kind, cd });
    }
    kinds.push({ kind: k.kind, status });
  }
  // the director tries when its timer runs out, picking among the kinds off cooldown by then; with
  // none ready it tries again every 30 s, so the first one off cooldown comes up soon after
  const next = open.length ? Math.max(timer, Math.min(...open.map((o) => o.cd))) : null;
  const candidates = next === null ? [] : open.filter((o) => o.cd <= next + 0.5).map((o) => o.kind);
  return { next, busy, candidates, kinds, players };
}

/** the forecast from the host's live state, now; null without a plan (a server from before it) */
export function liveForecast(live: LiveState, awayMe: boolean, now = performance.now()): Forecast | null {
  const s = live.schedule;
  if (!s) return null;
  return forecast(s, (now - live.eventsAt) / 1000, live.events.map((e) => e.kind), awayMe);
}
