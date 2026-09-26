// Revive: another player standing next to someone downed brings them back to their feet, for a
// "Dobrý samaritán" cash bonus (anti-farmed). Server only — see rules/index.ts. The downed core
// itself (down/wasted/revive/bleed-out) lives in Sim.ts; this rule only decides *when* a revive
// happens and pays for it. Plan: docs/plans/social-events.md ("Revive").
import type { Sim } from '../Sim';
import type { PlayerState, SimPlayer } from '../SimPlayer';
import type { SimRule } from './SimRule';
import { dist } from '../../util/math';
import { DOWNED_BLEED } from '../SimPlayer';

/** metres a reviver must stay within, continuously, to revive someone (also client-side prediction: ReviveUi) */
export const REVIVE_RANGE = 2;
/** seconds of continuous proximity to revive (also client-side prediction: ReviveUi) */
export const REVIVE_TIME = 3;
const REVIVE_HEALTH = 40;
const SAMARITAN_BONUS = 100;
/** no bonus if the reviver hurt the victim more recently than this (s) */
const HURT_WINDOW = 60;
/** one paid revive per (reviver, victim) pair per this many seconds */
const PAIR_COOLDOWN = 600;
/** at most this many paid revives per reviver per rolling hour */
const HOURLY_CAP = 10;
const HOUR = 3600;
/** progress pings to both players, at most this often (s) */
const PROGRESS_GAP = 1 / 5;

interface Progress {
  by: SimPlayer;
  /** seconds standing close, continuously */
  t: number;
  /** sim.time a progress event was last sent for this pair */
  sentAt: number;
}

export class Revive implements SimRule {
  readonly id = 'revive';
  /** downed player -> who's reviving them and how far along */
  private progress = new Map<SimPlayer, Progress>();
  /** reviver id -> sim times of bonuses paid, for the hourly cap */
  private paidAt = new Map<number, number[]>();
  /** "loId:hiId" -> sim time of the last paid revive, for the per-pair cooldown */
  private pairPaidAt = new Map<string, number>();

  constructor(private sim: Sim) {}

  onState(p: SimPlayer, from: PlayerState, to: PlayerState) {
    if (to === 'downed') this.sim.events.toPlayer(p.id, { k: 'revive', s: { bleed: DOWNED_BLEED } });
    else if (from === 'downed') {
      this.sim.events.toPlayer(p.id, { k: 'revive', s: null });
      // a revive in progress being cut short (busted, finished off, or bled out) never gets its own
      // success message below (step()'s own `s: null` to the reviver only fires on that path), so tell
      // the reviver here too, before dropping the entry — otherwise their HUD is stuck mid-revive
      const prog = this.progress.get(p);
      if (prog) this.sim.events.toPlayer(prog.by.id, { k: 'revive', s: null });
      this.progress.delete(p);
    }
  }

  onRemove(p: SimPlayer) {
    this.progress.delete(p);
  }

  step(dt: number) {
    const sim = this.sim;
    for (const p of sim.players.values()) {
      if (p.state !== 'downed') continue;
      const by = this.candidate(p);
      let prog = this.progress.get(p);
      if (by !== (prog?.by ?? null)) {
        // the reviver changed (someone new stepped in, or the old one left/moved away): start over
        if (prog) sim.events.toPlayer(prog.by.id, { k: 'revive', s: null });
        if (by) this.progress.set(p, (prog = { by, t: 0, sentAt: -1e9 }));
        else {
          this.progress.delete(p);
          prog = undefined;
        }
      }
      if (!prog) continue;
      prog.t += dt;
      if (prog.t >= REVIVE_TIME) {
        this.progress.delete(p);
        const reviver = prog.by;
        const { x, y } = p.ped;
        sim.revive(p, reviver, REVIVE_HEALTH); // fires onState('downed'->'play'), which tells `p` itself
        sim.events.toPlayer(reviver.id, { k: 'revive', s: null }); // …but the reviver needs its own final null
        sim.events.global({ k: 'revived', by: reviver.nick, who: p.nick, x, y });
        this.payBonus(reviver, p, x, y);
        continue;
      }
      if (sim.time - prog.sentAt >= PROGRESS_GAP) {
        prog.sentAt = sim.time;
        const progress = prog.t / REVIVE_TIME;
        sim.events.toPlayer(p.id, { k: 'revive', s: { bleed: p.stateTimer, progress, other: prog.by.id } });
        sim.events.toPlayer(prog.by.id, { k: 'revive', s: { progress, other: p.id } });
      }
    }
  }

  /** the nearest other player who could be reviving `p` right now: playing, on foot, same level, close */
  private candidate(p: SimPlayer): SimPlayer | null {
    let best: SimPlayer | null = null, bd = REVIVE_RANGE;
    for (const q of this.sim.players.values()) {
      if (q === p || q.state !== 'play' || q.ped.vehicle || q.ped.level !== p.ped.level) continue;
      const d = dist(q.ped.x, q.ped.y, p.ped.x, p.ped.y);
      if (d <= bd) (bd = d), (best = q);
    }
    return best;
  }

  /** the "Dobrý samaritán" bonus, unless one of the anti-farm checks blocks it */
  private payBonus(by: SimPlayer, victim: SimPlayer, x: number, y: number) {
    const sim = this.sim;
    if (victim.lastAttacker === by.id && sim.time - victim.lastAttackedAt < HURT_WINDOW) {
      return this.deny(by, 'Bez odmeny – nedávno si ho zranil.');
    }
    const pair = pairKey(by.id, victim.id);
    const lastPair = this.pairPaidAt.get(pair);
    if (lastPair !== undefined && sim.time - lastPair < PAIR_COOLDOWN) {
      return this.deny(by, 'Bez odmeny – tohto hráča si už nedávno zachránil.');
    }
    const recent = (this.paidAt.get(by.id) ?? []).filter((t) => sim.time - t < HOUR);
    if (recent.length >= HOURLY_CAP) {
      this.paidAt.set(by.id, recent);
      return this.deny(by, 'Bez odmeny – hodinový limit záchran je vyčerpaný.');
    }
    recent.push(sim.time);
    this.paidAt.set(by.id, recent);
    this.pairPaidAt.set(pair, sim.time);
    sim.payout(by, SAMARITAN_BONUS, 'samaritan', x, y);
  }

  private deny(by: SimPlayer, text: string) {
    this.sim.events.toPlayer(by.id, { k: 'msg', title: '', text, time: 3, color: '#ffd740' });
  }
}

/** an unordered pair key, so A reviving B and B reviving A share one cooldown (no swap-farming) */
function pairKey(a: number, b: number) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
