// Závod?: pull up next to another player and hold the horn to challenge them. The server picks a
// landmark 1-2 km away by road, both players stake money, and the first to get there wins — no set
// track, so knowing the real streets is the skill. Server only — see rules/index.ts.
// Plan: docs/plans/social-events.md ("Závod?")
import type { Sim } from '../Sim';
import type { SimPlayer } from '../SimPlayer';
import type { SimRule } from './SimRule';
import type { Vehicle } from '../../entities/Vehicle';
import { dist } from '../../util/math';

/** metres apart to send a challenge (client-side prediction: RaceUi) */
export const CHALLENGE_RANGE = 8;
/** metres apart still allowed when the target accepts (players drift while the 15 s ticks down) */
const ACCEPT_RANGE = 30;
/** seconds a challenge waits for an answer */
const CHALLENGE_TIMEOUT = 15;
/** seconds of "3-2-1-ŠTART" before a race goes live */
const COUNTDOWN = 3;
/** a race that nobody finishes this long is called off and refunded */
const RACE_TIME = 300;
/** metres from the destination node that counts as finishing */
const FINISH_RADIUS = 20;
/** moving this far from the line during the countdown is a false start (forfeit) */
const FALSE_START_M = 15;
/** seconds before the same pair can race again */
const PAIR_COOLDOWN = 120;
const MAX_STAKE = 250;
/** below this much money, it's a stakeless friendly race instead */
const FRIENDLY_THRESHOLD = 20;
const FRIENDLY_PRIZE = 50;
/** friendly prizes per player per day (a day of sim time: the shared rule has no wall clock) */
const FRIENDLY_DAILY_CAP = 3;
const DAY_S = 24 * 60 * 60;
/** candidate landmarks: straight-line distance from the start, sorted toward the middle of this range */
const DEST_MIN = 700, DEST_MAX = 1800, DEST_TARGET = 1300;
const MAX_CANDIDATES = 12;
/** by-road route length accepted for a candidate, then the wider retry if none qualified */
const ROUTE_MIN = 1000, ROUTE_MAX = 2000;
const ROUTE_MIN_RETRY = 800, ROUTE_MAX_RETRY = 2500;

interface Destination {
  x: number;
  y: number;
  /** the landmark's plain name (RaceState/ChallengeState.dest) */
  label: string;
}

interface Pending {
  from: SimPlayer;
  to: SimPlayer;
  stake: number;
  friendly: boolean;
  dest: Destination;
  /** seconds left for `to` to answer */
  left: number;
  sendTimer: number;
}

interface Racer {
  p: SimPlayer;
  /** the car's position when the countdown started, for the false-start check */
  startX: number;
  startY: number;
}

interface ActiveRace {
  id: number;
  a: Racer;
  b: Racer;
  dest: Destination;
  stake: number;
  friendly: boolean;
  phase: 'countdown' | 'running';
  countdown: number;
  left: number;
  sendTimer: number;
}

export class Race implements SimRule {
  readonly id = 'race';
  private pending: Pending[] = [];
  private races: ActiveRace[] = [];
  /** "loId:hiId" -> sim.time a race between them last ended */
  private pairCooldown = new Map<string, number>();
  /** nick -> friendly prizes paid on `day` (days of sim.time), for the daily cap */
  private friendlyToday = new Map<string, { day: number; n: number }>();
  private nextId = 1;

  constructor(private sim: Sim) {}

  /** the challenger's client sends `challenge` after a 1.2 s horn hold; returns a Slovak error for a
   *  private msg, or null once the target has been sent the challenge (Race.ts feature). */
  challenge(from: SimPlayer, to: SimPlayer): string | null {
    if (from === to) return 'Nemôžeš vyzvať sám seba.';
    if (from.state !== 'play' || to.state !== 'play') return 'Obaja musíte byť v hre.';
    const fc = from.ped.vehicle, tc = to.ped.vehicle;
    if (!fc || !tc) return 'Obaja musíte sedieť za volantom.';
    if (dist(fc.x, fc.y, tc.x, tc.y) > CHALLENGE_RANGE) return 'Ste príliš ďaleko od seba.';
    if (this.raceOf(from) || this.raceOf(to)) return 'Niekto z vás už závodí.';
    if (this.busy(from) || this.busy(to)) return 'Niekto z vás už má nevybavenú výzvu.';
    const cdAt = this.pairCooldown.get(pairKey(from.id, to.id));
    if (cdAt !== undefined && this.sim.time - cdAt < PAIR_COOLDOWN) return 'S týmto hráčom môžeš závodiť znova až o chvíľu.';
    const dest = this.pickDestination((fc.x + tc.x) / 2, (fc.y + tc.y) / 2);
    if (!dest) return 'Nenašiel sa vhodný cieľ.';
    const { stake, friendly } = stakeFor(from, to);
    const pend: Pending = { from, to, stake, friendly, dest, left: CHALLENGE_TIMEOUT, sendTimer: 1 };
    this.pending.push(pend);
    this.sendChallengeState(pend);
    const stakeText = friendly ? `mestskú odmenu €${FRIENDLY_PRIZE}` : `€${stake}`;
    this.sim.events.toPlayer(from.id, { k: 'msg', title: '', text: `Vyzval si ${to.nick} na závod do cieľa ${dest.label} o ${stakeText}`, time: 3, color: '#ffd740' });
    return null;
  }

  /** `to`'s client answers within 15 s (holding H to accept); `fromId` guards against a stale/second challenge */
  answer(to: SimPlayer, fromId: number, ok: boolean) {
    const pend = this.pending.find((p) => p.to === to && p.from.id === fromId);
    if (!pend) return;
    this.clearPending(pend);
    const sim = this.sim;
    sim.events.toPlayer(to.id, { k: 'challenge', s: null }); // resolved one way or another: clear it for the target
    const from = pend.from;
    if (!ok) {
      sim.events.toPlayer(from.id, { k: 'msg', title: '', text: `${to.nick} tvoju výzvu na závod odmietol.`, time: 3, color: '#ff8a80' });
      return;
    }
    const fc = from.ped.vehicle, tc = to.ped.vehicle;
    const stillValid = fc && tc && dist(fc.x, fc.y, tc.x, tc.y) <= ACCEPT_RANGE && from.profile.money >= pend.stake && to.profile.money >= pend.stake;
    if (!stillValid) {
      const msg = { k: 'msg' as const, title: '', text: 'Výzva už nie je platná.', time: 3, color: '#ff8a80' };
      sim.events.toPlayer(from.id, msg);
      sim.events.toPlayer(to.id, msg);
      return;
    }
    this.startRace(pend, fc, tc);
  }

  step(dt: number) {
    for (const pend of [...this.pending]) {
      pend.left -= dt;
      if (pend.left <= 0) {
        this.clearPending(pend);
        this.sim.events.toPlayer(pend.to.id, { k: 'challenge', s: null });
        this.sim.events.toPlayer(pend.from.id, { k: 'msg', title: '', text: `${pend.to.nick} na výzvu nereagoval.`, time: 3, color: '#ffd740' });
        continue;
      }
      pend.sendTimer -= dt;
      if (pend.sendTimer <= 0) {
        pend.sendTimer = 1;
        this.sendChallengeState(pend);
      }
    }
    for (const race of [...this.races]) {
      if (race.phase === 'countdown') {
        race.countdown -= dt;
        if (this.checkFalseStart(race)) continue;
        if (race.countdown <= 0) {
          race.countdown = 0;
          race.phase = 'running';
        }
      } else {
        race.left -= dt;
        if (race.left <= 0) {
          this.timeoutRefund(race);
          continue;
        }
        if (this.reached(race.a.p, race.dest)) {
          this.finish(race, race.a.p, race.b.p);
          continue;
        }
        if (this.reached(race.b.p, race.dest)) {
          this.finish(race, race.b.p, race.a.p);
          continue;
        }
      }
      race.sendTimer -= dt;
      if (race.sendTimer <= 0) {
        race.sendTimer = 1;
        this.sendRaceState(race);
      }
    }
  }

  onRemove(p: SimPlayer) {
    for (const pend of [...this.pending]) {
      if (pend.to === p) {
        this.clearPending(pend);
        this.sim.events.toPlayer(pend.from.id, { k: 'msg', title: '', text: 'Súper zmizol zo sveta.', time: 3, color: '#ffd740' });
      } else if (pend.from === p) {
        this.clearPending(pend);
        this.sim.events.toPlayer(pend.to.id, { k: 'challenge', s: null });
      }
    }
    const race = this.raceOf(p);
    if (race) this.finish(race, race.a.p === p ? race.b.p : race.a.p, p);
  }

  // ----------------------------------------------------------------- destination
  /** Midpoint of the two cars -> its nearest car-graph node -> a landmark 1-2 km away by road.
   *  Candidates are landmarks 700-1800 m away straight-line, closest to 1300 m first; the first of
   *  up to 12 whose A* route is 1000-2000 m long wins, or 800-2500 m on a wider retry. */
  private pickDestination(mx: number, my: number): Destination | null {
    const graph = this.sim.world.car;
    const start = graph.nearest(mx, my, 400);
    if (start < 0) return null;
    const sx = graph.nx(start), sy = graph.ny(start);
    const candidates = [...this.sim.world.landmarks.values()]
      .map((l) => ({ l, d: dist(sx, sy, l.x, l.y) }))
      .filter((c) => c.d >= DEST_MIN && c.d <= DEST_MAX)
      .sort((a, b) => Math.abs(a.d - DEST_TARGET) - Math.abs(b.d - DEST_TARGET))
      .slice(0, MAX_CANDIDATES);
    const routed: { x: number; y: number; label: string; len: number }[] = [];
    for (const c of candidates) {
      const node = graph.nearest(c.l.x, c.l.y, 400);
      if (node < 0) continue;
      const links = graph.path(start, node);
      if (!links) continue;
      let len = 0;
      for (const lk of links) len += lk.edge.len;
      routed.push({ x: graph.nx(node), y: graph.ny(node), label: c.l.name, len });
    }
    const pick = (lo: number, hi: number) => routed.find((r) => r.len >= lo && r.len <= hi);
    const hit = pick(ROUTE_MIN, ROUTE_MAX) ?? pick(ROUTE_MIN_RETRY, ROUTE_MAX_RETRY);
    return hit ? { x: hit.x, y: hit.y, label: hit.label } : null;
  }

  // ----------------------------------------------------------------------- race
  private startRace(pend: Pending, fc: Vehicle, tc: Vehicle) {
    const sim = this.sim;
    const { from, to, stake, friendly, dest } = pend;
    if (stake > 0) {
      sim.addMoney(from, -stake);
      sim.addMoney(to, -stake);
      sim.onProfileChange?.(from);
      sim.onProfileChange?.(to);
    }
    const race: ActiveRace = {
      id: this.nextId++,
      a: { p: from, startX: fc.x, startY: fc.y },
      b: { p: to, startX: tc.x, startY: tc.y },
      dest, stake, friendly,
      phase: 'countdown', countdown: COUNTDOWN, left: RACE_TIME, sendTimer: 1,
    };
    this.races.push(race);
    sim.events.global({ k: 'raceStart', a: from.nick, b: to.nick, dest: dest.label, stake });
    this.sendRaceState(race);
  }

  /** either car straying more than 15 m from its line during the countdown forfeits (a false start) */
  private checkFalseStart(race: ActiveRace): boolean {
    for (const [racer, other] of [[race.a, race.b], [race.b, race.a]] as const) {
      const v = racer.p.ped.vehicle;
      if (v && dist(v.x, v.y, racer.startX, racer.startY) > FALSE_START_M) {
        this.finish(race, other.p, racer.p);
        return true;
      }
    }
    return false;
  }

  private reached(p: SimPlayer, dest: Destination): boolean {
    const f = p.focus();
    return dist(f.x, f.y, dest.x, dest.y) <= FINISH_RADIUS;
  }

  /** `winner` reached the finish, forced a false start, or is the one left when `loser` forfeits by
   *  leaving the world: pay them, tell the city, clear both HUDs, bump their win count. */
  private finish(race: ActiveRace, winner: SimPlayer, loser: SimPlayer) {
    this.removeRace(race);
    const sim = this.sim;
    winner.profile.stats ??= {};
    winner.profile.stats.racesWon = (winner.profile.stats.racesWon ?? 0) + 1;
    let amount = race.friendly ? FRIENDLY_PRIZE : race.stake * 2;
    if (race.friendly) {
      if (this.friendlyAllowed(winner.nick)) this.markFriendly(winner.nick);
      else amount = 0;
    }
    if (amount > 0) {
      const f = winner.focus();
      sim.payout(winner, amount, 'race', f.x, f.y); // 'race' is never party-split
    } else {
      sim.onProfileChange?.(winner); // the win count above still needs saving
      sim.events.toPlayer(winner.id, { k: 'msg', title: '', text: 'Bez odmeny – dnešný limit priateľských závodov je vyčerpaný.', time: 3, color: '#ffd740' });
    }
    sim.events.global({ k: 'raceResult', winner: winner.nick, loser: loser.nick, dest: race.dest.label, amount });
    sim.events.toPlayer(winner.id, { k: 'race', s: null });
    sim.events.toPlayer(loser.id, { k: 'race', s: null });
    this.pairCooldown.set(pairKey(winner.id, loser.id), sim.time);
  }

  private timeoutRefund(race: ActiveRace) {
    this.removeRace(race);
    const sim = this.sim;
    for (const r of [race.a.p, race.b.p]) {
      if (race.stake > 0) {
        sim.addMoney(r, race.stake);
        sim.onProfileChange?.(r);
      }
      sim.events.toPlayer(r.id, { k: 'msg', title: '', text: 'Závod vypršal – vklady vrátené.', time: 3, color: '#ffd740' });
      sim.events.toPlayer(r.id, { k: 'race', s: null });
    }
    this.pairCooldown.set(pairKey(race.a.p.id, race.b.p.id), sim.time);
  }

  /** the server is shutting down: every stake held for a race in progress goes back to its owner
   *  (server/src/features/Race.ts calls this before Room's final save) */
  refundAll() {
    for (const race of [...this.races]) this.timeoutRefund(race);
  }

  // --------------------------------------------------------------------- misc
  private sendChallengeState(pend: Pending) {
    this.sim.events.toPlayer(pend.to.id, {
      k: 'challenge',
      s: { from: pend.from.id, nick: pend.from.nick, stake: pend.stake, dest: pend.dest.label, left: Math.max(0, Math.ceil(pend.left)) },
    });
  }

  private sendRaceState(race: ActiveRace) {
    const startsIn = Math.max(0, Math.ceil(race.countdown));
    const left = Math.max(0, Math.ceil(race.left));
    for (const [me, opp] of [[race.a, race.b], [race.b, race.a]] as const) {
      this.sim.events.toPlayer(me.p.id, {
        k: 'race',
        s: { id: race.id, opponent: opp.p.id, opponentNick: opp.p.nick, dest: race.dest.label, x: race.dest.x, y: race.dest.y, stake: race.stake, startsIn, left },
      });
    }
  }

  private busy(p: SimPlayer): boolean {
    return this.pending.some((pd) => pd.from === p || pd.to === p);
  }
  private raceOf(p: SimPlayer): ActiveRace | undefined {
    return this.races.find((r) => r.a.p === p || r.b.p === p);
  }
  private clearPending(pend: Pending) {
    const i = this.pending.indexOf(pend);
    if (i >= 0) this.pending.splice(i, 1);
  }
  private removeRace(race: ActiveRace) {
    const i = this.races.indexOf(race);
    if (i >= 0) this.races.splice(i, 1);
  }

  private friendlyAllowed(nick: string): boolean {
    const e = this.friendlyToday.get(nick);
    return !e || e.day !== this.day() || e.n < FRIENDLY_DAILY_CAP;
  }
  private markFriendly(nick: string) {
    const day = this.day(), e = this.friendlyToday.get(nick);
    this.friendlyToday.set(nick, { day, n: e && e.day === day ? e.n + 1 : 1 });
  }
  private day(): number {
    return Math.floor(this.sim.time / DAY_S);
  }
}

/** min($250, the poorer player's money rounded down to $10); under $20 it's a free "friendly" race
 *  for a flat city prize instead of a stake. */
function stakeFor(a: SimPlayer, b: SimPlayer): { stake: number; friendly: boolean } {
  const poorer = Math.min(a.profile.money, b.profile.money);
  if (poorer < FRIENDLY_THRESHOLD) return { stake: 0, friendly: true };
  return { stake: Math.min(MAX_STAKE, Math.floor(poorer / 10) * 10), friendly: false };
}

/** an unordered pair key, so A vs B and B vs A share one cooldown */
function pairKey(a: number, b: number) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
