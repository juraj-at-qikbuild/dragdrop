// Najhľadanejší: the server watches for the first player to hit 5★ and puts a bounty on their head.
// While they stay at 5★ the bounty (and their own danger money) grows every minute; a takedown by
// another player pays it out (split with the killer's party, per Party.ts), a bust/police kill/bleed-
// out voids it, and dropping under 5★ for a minute counts as an escape at half the bounty. Anti-
// collusion: no bounty between party-mates, a 60-min cooldown per (killer, target) pair, and the
// target must have spent at least 60 s at 5★ this chase. Online only (MostWantedWatch is server-only).
// Plan: docs/plans/social-events.md ("Najhľadanejší").
import type { Crime, Sim } from '../../Sim';
import type { PlayerState, SimPlayer } from '../../SimPlayer';
import type { SimRule } from '../SimRule';
import { TimedEvent, type WorldEventDef, type WorldEvents } from '../WorldEvents';
import type { EventEntry } from '../types';
import { placeName } from '../placeName';

/** how often MostWantedWatch scans for a new target */
const WATCH_INTERVAL_S = 1;
/** a chase's target can't be re-triggered this soon after their last chase ended */
const RETRIGGER_COOLDOWN_S = 5 * 60;
/** a (killer, target) pair can only collect the bounty once this often (anti-collusion) */
const PAIR_COOLDOWN_S = 60 * 60;
/** the target must have spent at least this long at 5★ (accumulated, this chase) for a takedown or an
 *  escape to pay */
const MIN_STAR_TIME_S = 60;
/** the bounty grows, and the target is paid, every this many seconds spent at 5★ */
const STAR_STEP_S = 60;
const BOUNTY_START = 300;
const BOUNTY_STEP = 150;
const BOUNTY_CAP = 3000;
/** paid to the target itself each STAR_STEP_S, on top of the growing bounty */
const INCOME_PER_STEP = 100;
/** continuous seconds below 5★ before the target counts as having escaped */
const ESCAPE_S = 60;
const ESCAPE_SHARE = 0.5;
/** long safety valve so a stuck chase can't run forever; ends exactly like an escape */
const SAFETY_MAX_S = 20 * 60;
/** `entry().place` is recomputed at most this often */
const PLACE_REFRESH = 10;

// ---- per-Sim state that outlives any one chase (module-level, keyed by Sim so tests never leak
// into each other and a Sim that's garbage-collected takes its cooldowns with it).
/** target player id -> sim.time their re-trigger cooldown ends (read by MostWantedWatch) */
const retriggerUntil = new WeakMap<Sim, Map<number, number>>();
/** "killerId:targetId" -> sim.time the pair's 60-min bounty cooldown ends */
const pairCooldownUntil = new WeakMap<Sim, Map<string, number>>();

function isOnRetriggerCooldown(sim: Sim, playerId: number): boolean {
  const until = retriggerUntil.get(sim)?.get(playerId);
  return until !== undefined && sim.time < until;
}

function markChaseEnded(sim: Sim, playerId: number) {
  let m = retriggerUntil.get(sim);
  if (!m) retriggerUntil.set(sim, (m = new Map()));
  m.set(playerId, sim.time + RETRIGGER_COOLDOWN_S);
}

const pairKey = (killerId: number, targetId: number) => `${killerId}:${targetId}`;

function isPairOnCooldown(sim: Sim, killerId: number, targetId: number): boolean {
  const until = pairCooldownUntil.get(sim)?.get(pairKey(killerId, targetId));
  return until !== undefined && sim.time < until;
}

function markPairPaid(sim: Sim, killerId: number, targetId: number) {
  let m = pairCooldownUntil.get(sim);
  if (!m) pairCooldownUntil.set(sim, (m = new Map()));
  m.set(pairKey(killerId, targetId), sim.time + PAIR_COOLDOWN_S);
}

/** Watches every connected, non-afk player for the first to reach 5★ and triggers the chase for
 *  whoever's been there longest. Server only (registered in rules/index.ts next to Revive). */
export class MostWantedWatch implements SimRule {
  readonly id = 'mostWantedWatch';
  /** player id -> sim.time they became (continuously) 5★; cleared in onRemove */
  private since = new Map<number, number>();
  private acc = 0;

  constructor(private sim: Sim) {}

  onRemove(p: SimPlayer) {
    this.since.delete(p.id);
  }

  step(dt: number) {
    this.acc += dt;
    if (this.acc < WATCH_INTERVAL_S) return;
    this.acc -= WATCH_INTERVAL_S;

    const sim = this.sim;
    const at5 = new Set<number>();
    for (const p of sim.players.values()) {
      if (Math.ceil(p.wanted) < 5) continue;
      at5.add(p.id);
      if (!this.since.has(p.id)) this.since.set(p.id, sim.time);
    }
    for (const id of [...this.since.keys()]) if (!at5.has(id)) this.since.delete(id);

    const director = sim.rule<WorldEvents>('worldEvents');
    if (!director || director.playerCount() < 2) return;

    let best: SimPlayer | null = null;
    let bestSince = Infinity;
    for (const p of sim.players.values()) {
      if (!at5.has(p.id) || p.state !== 'play' || !p.connected || p.afk) continue;
      if (isOnRetriggerCooldown(sim, p.id)) continue;
      const since = this.since.get(p.id) ?? sim.time;
      if (since < bestSince) (bestSince = since), (best = p);
    }
    if (best) director.trigger('wanted', best);
  }
}

class MostWanted extends TimedEvent {
  private bounty = BOUNTY_START;
  /** total seconds spent at 5★ this chase (accumulated, not reset by dropping below 5★) */
  private starAccum = 0;
  /** how many STAR_STEP_S-sized bounty/income steps have already been paid */
  private starStep = 0;
  /** continuous seconds spent below 5★ (reset the moment the target is back at 5★) */
  private belowTimer = 0;
  private done = false;
  private place: string;
  private placeAt: number;

  constructor(
    sim: Sim,
    director: WorldEvents,
    id: number,
    private target: SimPlayer,
  ) {
    super(sim, director, id, 'wanted', 0, SAFETY_MAX_S); // announce 0: live at once
    const f = target.focus();
    this.place = placeName(sim.world, f.x, f.y);
    this.placeAt = sim.time;
    sim.events.global({ k: 'mostWanted', nick: target.nick, x: f.x, y: f.y, bounty: this.bounty });
    director.changed();
  }

  update(dt: number): boolean {
    this.tick(dt); // only matters here for the 20-min safety timeout (onTimeout below)
    if (this.done) return false;
    const sim = this.sim, t = this.target;
    const { x, y } = t.focus();
    if (Math.ceil(t.wanted) >= 5) {
      this.belowTimer = 0;
      this.starAccum += dt;
      const wantStep = Math.floor(this.starAccum / STAR_STEP_S);
      while (this.starStep < wantStep) {
        this.starStep++;
        this.bounty = Math.min(BOUNTY_CAP, this.bounty + BOUNTY_STEP);
        sim.payout(t, INCOME_PER_STEP, 'wanted', x, y);
        this.director.changed();
      }
    } else {
      this.belowTimer += dt;
      if (this.belowTimer >= ESCAPE_S) return this.endEscape();
    }
    if (sim.time - this.placeAt >= PLACE_REFRESH) {
      this.placeAt = sim.time;
      this.place = placeName(sim.world, x, y);
    }
    return true;
  }

  /** the 20-min safety valve: treat it exactly like an escape */
  protected onTimeout() {
    this.endEscape();
  }

  /** Sim.down()/killedBy() call onKill before the state actually flips to 'downed' (see onState) */
  onKill(victim: SimPlayer, killer: SimPlayer) {
    if (this.done || victim !== this.target) return;
    const sim = this.sim, target = this.target;
    const { x, y } = target.focus();
    const sameParty = !!(killer.partyId && killer.partyId === target.partyId);
    let paid = 0;
    if (
      killer !== target &&
      !sameParty &&
      this.starAccum >= MIN_STAR_TIME_S &&
      !isPairOnCooldown(sim, killer.id, target.id)
    ) {
      paid = this.bounty;
      sim.payout(killer, this.bounty, 'bounty', x, y);
      markPairPaid(sim, killer.id, target.id);
    }
    sim.events.global({ k: 'mostWantedEnd', nick: target.nick, how: 'taken', by: killer.nick, amount: paid, x, y });
    this.finishChase();
  }

  /** a bust, a police kill/bleed-out (no player `by`), or an irrelevant revive after the chase ended */
  onState(p: SimPlayer, _from: PlayerState, to: PlayerState, by?: SimPlayer) {
    if (this.done || p !== this.target) return;
    if (to === 'busted') this.endVoid('busted');
    else if ((to === 'downed' || to === 'wasted') && !by) this.endVoid('died');
  }

  /** no stars for hunting the target: neither hurting nor finishing them off counts as a crime */
  allowCrime(_p: SimPlayer, kind: Crime, target?: SimPlayer): boolean {
    return !(target === this.target && (kind === 'hitPlayer' || kind === 'killPlayer'));
  }

  onRemove(p: SimPlayer) {
    if (this.done || p !== this.target) return;
    const { x, y } = p.focus();
    this.sim.events.global({ k: 'mostWantedEnd', nick: this.target.nick, how: 'left', amount: 0, x, y });
    this.finishChase();
  }

  entry(): EventEntry {
    const { x, y } = this.target.focus();
    const atStar = Math.ceil(this.target.wanted) >= 5;
    const into = this.starAccum - this.starStep * STAR_STEP_S;
    const left = atStar ? STAR_STEP_S - into : ESCAPE_S - this.belowTimer;
    return {
      id: this.id, kind: 'wanted', phase: this.phase, left: Math.max(0, Math.round(left)),
      x, y, holder: this.target.id, holderNick: this.target.nick, pot: Math.round(this.bounty), place: this.place,
    };
  }

  /** debug/shutdown: end quietly, no payout or broadcast, but still start the re-trigger cooldown */
  stop() {
    this.finishChase();
  }

  private endEscape(): false {
    if (this.done) return false;
    const sim = this.sim, target = this.target;
    const { x, y } = target.focus();
    // only a chase that was actually on pays: otherwise hitting 5★ and hiding at once is free money
    const amount = this.starAccum >= MIN_STAR_TIME_S ? Math.round(this.bounty * ESCAPE_SHARE) : 0;
    if (amount) sim.payout(target, amount, 'escape', x, y);
    sim.events.global({ k: 'mostWantedEnd', nick: target.nick, how: 'escaped', amount, x, y });
    this.finishChase();
    return false;
  }

  private endVoid(how: 'busted' | 'died') {
    const target = this.target;
    const { x, y } = target.focus();
    this.sim.events.global({ k: 'mostWantedEnd', nick: target.nick, how, amount: 0, x, y });
    this.finishChase();
  }

  private finishChase() {
    if (this.done) return;
    this.done = true;
    markChaseEnded(this.sim, this.target.id);
  }
}

export const MOST_WANTED_DEF: WorldEventDef = {
  kind: 'wanted',
  minPlayers: 2,
  offline: false,
  scheduled: false, // triggered only (WorldEvents.trigger, from MostWantedWatch)
  weight: 0,
  cooldown: 0,
  create(sim, director, id, arg) {
    const target = arg as SimPlayer | undefined;
    if (!target || sim.players.get(target.id) !== target || target.state !== 'play') return null;
    if (director.playerCount() < 2) return null;
    return new MostWanted(sim, director, id, target);
  },
};
