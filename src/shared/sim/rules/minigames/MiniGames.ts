// The mini-games ("Minihry", docs/plans/minigames.md): a player starts one whenever they like, from the
// Aktivity panel. It opens a round with a lobby that the players around (or their party) can join, and
// alone it just counts in and starts; then the game plays (games/, each a MiniGame), shows its result
// and pays out. This rule runs the rounds for every game: who's in which, the lobby, what each player
// is sent (the private `mini` event, whenever it changes), the payout and the points, the news, and
// cleaning up. Both modes: offline it's the one player, online everyone.
import type { Sim } from '../../Sim';
import type { PlayerState, SimPlayer } from '../../SimPlayer';
import type { SimRule } from '../SimRule';
import type { WorldEvents, RulesMode } from '../WorldEvents';
import type { Jobs } from '../jobs/Jobs';
import { dist } from '../../../util/math';
import { POINTS } from '../points';
import { MINI_INFO } from './catalog';
import type { MiniGame, MiniGameDef, MiniOutcome, MiniRound } from './MiniGame';
import type { MiniKind, MiniOpen, MiniReq, MiniState } from './types';
import { MINI_DEFS } from './games';

/** the lobby's wait for others (s), unless a game says otherwise */
export const LOBBY_S = 20;
/** alone (nobody else who could join), the lobby is just a count-in */
export const LOBBY_SOLO_S = 3;
/** the result stays on screen this long (s) before the round is gone */
export const DONE_S = 6;
/** a player can join a round from this far from it (m), or from anywhere in its starter's party */
export const JOIN_R = 600;
/** players this close to a new round (m) could join it: the lobby waits for them */
const NEAR_R = 400;
/** what a player is shown is checked this often (s), and sent when it changed */
const SEND_EVERY = 0.25;
/** ...or anyway this often (s), so the countdown stays right */
const RESEND_EVERY = 2;
/** a round pays at most this much a player */
export const MAX_PAY = 600;
/** at most this many rounds on at once (the server) */
const MAX_ROUNDS = 24;
/** a player's next round, at the soonest this long after they started the last one (s) */
const START_GAP = 3;
/** Rádio Kecy tells the city about a player's lobby at most this often (s) */
const NEWS_GAP = 180;

interface Round extends MiniRound {
  def: MiniGameDef;
  game: MiniGame;
  /** each player's outcome, once it's over */
  results: Map<number, { text: string; pay: number; place?: number }>;
}

/** points for a round that paid `pay` (the game can say otherwise) */
export function miniPoints(pay: number) {
  return pay > 0 ? Math.max(1, Math.round(pay * POINTS.minigamePerDollar)) : 0;
}

export class MiniGames implements SimRule {
  readonly id = 'minigames';
  readonly defs = new Map<MiniKind, MiniGameDef>();
  /** bumped whenever the rounds others can join change (the `wev` message carries them) */
  version = 0;
  private rounds: Round[] = [];
  private nextId = 1;
  private sendAcc = 0;
  private sent = new Map<number, { s: string; at: number }>();
  private startedAt = new Map<number, number>();
  private newsAt = new Map<number, number>();

  constructor(
    private sim: Sim,
    readonly mode: RulesMode,
    defs: MiniGameDef[] = MINI_DEFS,
  ) {
    for (const d of defs) this.register(d);
  }

  register(def: MiniGameDef) {
    this.defs.set(def.kind, def);
  }

  /** the round `p` is in */
  roundOf(p: SimPlayer): Round | undefined {
    return this.rounds.find((r) => r.players.includes(p));
  }

  /** the game `p` is playing, if any (tests) */
  gameOf(p: SimPlayer): MiniGame | null {
    return this.roundOf(p)?.game ?? null;
  }

  /** every round on (tests, the server's stats) */
  get all(): readonly MiniRound[] {
    return this.rounds;
  }

  /** a request from `p` (the Game offline, the `mini` message online) */
  req(p: SimPlayer, r: MiniReq) {
    switch (r.op) {
      case 'start':
        return this.start(p, r.kind);
      case 'join':
        return this.join(p, r.id);
      case 'leave':
        return this.leave(p, 'left');
      case 'go':
        return this.go(p);
      case 'act':
        return this.act(p);
    }
  }

  /** Start a round of `kind` for `p`: a lobby if anyone could join, else a count-in. Null (and a
   *  line on their screen) when they can't. */
  start(p: SimPlayer, kind: MiniKind): MiniRound | null {
    const sim = this.sim;
    const def = this.defs.get(kind);
    const no = (text: string) => {
      this.say(p, text, '#ff8a80');
      return null;
    };
    if (!def) return no('Túto minihru tu zatiaľ nemáme.');
    if (p.state !== 'play') return null;
    // the last round's result still on screen: that's done with
    if (this.roundOf(p)?.phase === 'done') this.leave(p, 'left');
    if (this.roundOf(p)) return no('Už hráš – najprv skonči túto hru.');
    if (this.inJob(p)) return no('Najprv ukonči prácu (J).');
    if (p.wanted > 0) return no('S políciou v pätách sa hrať nedá.');
    if (this.rounds.length >= MAX_ROUNDS) return no('V meste sa teraz hrá priveľa hier – skús o chvíľu.');
    if (sim.time - (this.startedAt.get(p.id) ?? -1e9) < START_GAP) return null;
    const why = def.check?.(sim, p);
    if (why) return no(why);
    const f = p.focus();
    const round: Round = {
      id: this.nextId++, kind, owner: p, players: [p], x: f.x, y: f.y, phase: 'lobby', left: 0, started: 0,
      def, game: null as unknown as MiniGame, results: new Map(),
    };
    const game = def.create(sim, round);
    if (typeof game === 'string') return no(game);
    round.game = game;
    const others = this.couldJoin(round);
    round.left = others ? (def.lobby ?? LOBBY_S) : LOBBY_SOLO_S;
    this.rounds.push(round);
    this.startedAt.set(p.id, sim.time);
    this.changed();
    // news of a lobby others could join (at most every few minutes a player)
    if (others && this.mode === 'server' && sim.time - (this.newsAt.get(p.id) ?? -1e9) >= NEWS_GAP) {
      this.newsAt.set(p.id, sim.time);
      sim.events.global({ k: 'miniOpen', kind, nick: p.nick, x: round.x, y: round.y });
    }
    this.sendNow(round);
    return round;
  }

  /** `p` joins round `id`: in its lobby, or later when the game takes latecomers */
  join(p: SimPlayer, id: number): boolean {
    const r = this.rounds.find((q) => q.id === id);
    const no = (text: string) => {
      this.say(p, text, '#ff8a80');
      return false;
    };
    if (!r || r.phase === 'done' || (r.phase === 'live' && !r.game.late)) return no('Do tejto hry sa už pridať nedá.');
    if (p.state !== 'play' || r.players.includes(p)) return false;
    if (this.roundOf(p)?.phase === 'done') this.leave(p, 'left');
    if (this.roundOf(p)) return no('Už hráš inú hru.');
    if (this.inJob(p)) return no('Najprv ukonči prácu (J).');
    if (p.wanted > 0) return no('S políciou v pätách sa hrať nedá.');
    if (r.players.length >= MINI_INFO[r.kind].max) return no('Hra je plná.');
    const f = p.focus();
    const party = p.partyId && r.owner.partyId === p.partyId;
    if (!party && dist(f.x, f.y, r.x, r.y) > JOIN_R) return no('Si od hry priďaleko – príď bližšie.');
    const why = r.def.check?.(this.sim, p);
    if (why) return no(why);
    r.players.push(p);
    r.game.onJoin?.(p);
    for (const q of r.players) if (q !== p) this.say(q, `${p.nick} sa pridal!`, '#69f0ae');
    this.changed();
    this.sendNow(r);
    return true;
  }

  /** `p` leaves their round (or drops out of it): they get nothing from it */
  leave(p: SimPlayer, why: 'left' | 'out' | 'gone' = 'left') {
    const r = this.roundOf(p);
    if (!r) return;
    if (r.phase === 'live' && !r.game.over) r.game.onLeave?.(p);
    r.players.splice(r.players.indexOf(p), 1);
    this.sent.delete(p.id);
    if (why !== 'gone') {
      this.sim.events.toPlayer(p.id, { k: 'mini', s: null });
      if (why === 'out' && r.phase === 'live') this.say(p, 'Vypadol si z hry.', '#ff8a80');
    }
    if (!r.players.length) return this.remove(r);
    if (r.owner === p) r.owner = r.players[0];
    for (const q of r.players) if (r.phase !== 'done') this.say(q, `${p.nick} odišiel z hry.`, '#ffd740');
    this.changed();
    this.sendNow(r);
  }

  /** the starter doesn't wait out the lobby */
  go(p: SimPlayer) {
    const r = this.roundOf(p);
    if (!r || r.phase !== 'lobby' || r.owner !== p) return;
    r.left = Math.min(r.left, LOBBY_SOLO_S);
    this.sendNow(r);
  }

  /** the action key: the game's, while it's on */
  act(p: SimPlayer) {
    const r = this.roundOf(p);
    if (!r) return;
    if (r.phase === 'lobby' && r.owner === p) return this.go(p);
    if (r.phase !== 'live' || r.game.over || p.state !== 'play') return;
    r.game.act?.(p);
    this.sendNow(r);
  }

  /** the rounds others can still join: the Aktivity panel's list and the map's markers */
  open(): MiniOpen[] {
    const out: MiniOpen[] = [];
    for (const r of this.rounds) {
      if (r.phase === 'done' || (r.phase === 'live' && !r.game.late)) continue;
      if (r.players.length >= MINI_INFO[r.kind].max) continue;
      out.push({ id: r.id, kind: r.kind, x: Math.round(r.x), y: Math.round(r.y), phase: r.phase, left: Math.ceil(r.left), n: r.players.length, max: MINI_INFO[r.kind].max, nick: r.owner.nick });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------ the step
  step(dt: number) {
    for (const r of [...this.rounds]) this.stepRound(r, dt);
    this.sendAcc += dt;
    if (this.sendAcc >= SEND_EVERY) {
      this.sendAcc = 0;
      for (const r of this.rounds) this.send(r, false);
    }
  }

  private stepRound(r: Round, dt: number) {
    const g = r.game;
    if (r.phase === 'lobby') {
      r.left -= dt;
      // anyone who's no longer playing (hospital, arrest) waits out the lobby outside it
      if (r.left > 0) return;
      r.phase = 'live';
      r.started = r.players.length;
      r.left = g.duration;
      g.start();
      this.changed();
      this.sendNow(r);
      return;
    }
    if (r.phase === 'live') {
      if (!g.over) g.update(dt);
      if (!g.over && g.duration > 0) {
        r.left -= dt;
        if (r.left <= 0) g.onTimeout();
      }
      if (g.over) this.end(r);
      return;
    }
    r.left -= dt;
    if (r.left <= 0) this.remove(r);
  }

  /** It's over: pay everyone still in it, show the result for a moment, and tell the city when it was
   *  a group round. */
  private end(r: Round) {
    const sim = this.sim, g = r.game;
    r.phase = 'done';
    r.left = DONE_S;
    const group = r.started >= 2 && r.players.length >= 2;
    const coop = !!MINI_INFO[r.kind].coop;
    const ranked = g.ranked();
    for (const p of r.players) {
      const o: MiniOutcome = g.outcomeOf(p) ?? { pay: 0, text: 'Koniec hry.' };
      const pay = Math.min(MAX_PAY, Math.max(0, Math.round(o.pay)));
      const f = p.focus();
      if (pay > 0) sim.payout(p, pay, 'minigame', f.x, f.y);
      const pts = o.points ?? miniPoints(pay);
      if (pts > 0) sim.score(p, pts, 'minigame', f.x, f.y);
      const place = group && !coop ? ranked.indexOf(p) + 1 : undefined;
      r.results.set(p.id, { text: o.text, pay, place });
      sim.events.toPlayer(p.id, { k: 'jingle', good: pay > 0 });
      const stats = (p.profile.stats ??= {});
      stats[`mini_${r.kind}`] = (stats[`mini_${r.kind}`] ?? 0) + 1;
    }
    if (group) {
      const best = ranked[0];
      const won = coop ? (g.outcomeOf(best)?.pay ?? 0) > 0 : true;
      sim.events.global({ k: 'miniResult', kind: r.kind, winner: coop ? undefined : best?.nick, n: r.players.length, won, x: r.x, y: r.y });
    }
    this.changed();
    this.sendNow(r);
  }

  /** gone for good: the players are told, and the game's things leave the city */
  private remove(r: Round) {
    const i = this.rounds.indexOf(r);
    if (i >= 0) this.rounds.splice(i, 1);
    for (const p of r.players) {
      this.sent.delete(p.id);
      this.sim.events.toPlayer(p.id, { k: 'mini', s: null });
    }
    r.players.length = 0;
    r.game.dispose();
    this.changed();
  }

  // --------------------------------------------------------------------------- what they see
  /** the state `p` is shown now */
  stateOf(r: Round, p: SimPlayer): MiniState {
    const base = { id: r.id, kind: r.kind, phase: r.phase, left: Math.max(0, Math.ceil(r.left)), owner: r.owner === p, n: r.players.length };
    if (r.phase === 'done') {
      const res = r.results.get(p.id) ?? { text: 'Koniec hry.', pay: 0 };
      return { ...base, goal: res.text, result: res, board: r.game.board() };
    }
    if (r.phase === 'lobby') {
      const v = r.game.lobbyView?.(p);
      const solo = r.players.length === 1;
      const wait = solo ? 'Priprav sa…' : `Čaká sa na hráčov (${r.players.length}/${MINI_INFO[r.kind].max})…`;
      return { ...base, ...v, goal: v?.goal ?? wait, act: r.owner === p && r.left > LOBBY_SOLO_S ? 'Začať hneď' : undefined };
    }
    const v = r.game.view(p);
    return { ...base, ...v, board: v.board ?? r.game.board() };
  }

  private send(r: Round, force: boolean) {
    const now = this.sim.time;
    for (const p of r.players) {
      const s = this.stateOf(r, p);
      const json = JSON.stringify(s);
      const last = this.sent.get(p.id);
      if (!force && last && last.s === json && now - last.at < RESEND_EVERY) continue;
      this.sent.set(p.id, { s: json, at: now });
      this.sim.events.toPlayer(p.id, { k: 'mini', s });
    }
  }

  private sendNow(r: Round) {
    this.send(r, true);
  }

  // ------------------------------------------------------------------------------- the hooks
  onState(p: SimPlayer, from: PlayerState, to: PlayerState, by?: SimPlayer) {
    for (const r of [...this.rounds]) if (r.phase === 'live') r.game.onState?.(p, from, to, by);
    if (to !== 'wasted' && to !== 'busted') return;
    const r = this.roundOf(p);
    if (!r || r.phase !== 'live' || r.game.keepAfterRespawn?.(p)) return;
    this.leave(p, 'out');
  }

  onRemove(p: SimPlayer) {
    this.leave(p, 'gone');
    this.startedAt.delete(p.id);
    this.newsAt.delete(p.id);
  }

  onEnter(...a: Parameters<NonNullable<SimRule['onEnter']>>) {
    for (const r of this.rounds) if (r.phase === 'live') r.game.onEnter?.(...a);
  }
  onExit(...a: Parameters<NonNullable<SimRule['onExit']>>) {
    for (const r of this.rounds) if (r.phase === 'live') r.game.onExit?.(...a);
  }
  onVehicleHit(...a: Parameters<NonNullable<SimRule['onVehicleHit']>>) {
    for (const r of this.rounds) if (r.phase === 'live') r.game.onVehicleHit?.(...a);
  }
  allowCrime(...a: Parameters<NonNullable<SimRule['allowCrime']>>) {
    return this.rounds.every((r) => r.phase !== 'live' || r.game.allowCrime?.(...a) !== false);
  }
  allowPvp(...a: Parameters<NonNullable<SimRule['allowPvp']>>) {
    return this.rounds.every((r) => r.phase !== 'live' || r.game.allowPvp?.(...a) !== false);
  }
  /** stepping away (the pause menu, online) mustn't be a way out of a round others play too */
  allowShield(p: SimPlayer) {
    const r = this.roundOf(p);
    return !r || r.phase !== 'live' || r.players.length < 2;
  }

  /** end every round (the server shutting down, tests): nobody's paid */
  stopAll() {
    for (const r of [...this.rounds]) this.remove(r);
  }

  // ---------------------------------------------------------------------------------- inside
  private inJob(p: SimPlayer) {
    return !!this.sim.rule<Jobs>('jobs')?.active(p);
  }

  /** anyone else around who could join a round just opened (online: near it, or in the party) */
  private couldJoin(r: Round) {
    if (this.mode === 'offline') return false;
    for (const q of this.sim.players.values()) {
      if (q === r.owner || !q.active || q.state !== 'play' || this.roundOf(q)) continue;
      if (r.owner.partyId && q.partyId === r.owner.partyId) return true;
      const f = q.focus();
      if (dist(f.x, f.y, r.x, r.y) <= NEAR_R) return true;
    }
    return false;
  }

  private say(p: SimPlayer, text: string, color: string) {
    this.sim.events.toPlayer(p.id, { k: 'msg', title: '', text, time: 3, color });
  }

  /** the joinable rounds changed: the `wev` message goes out again soon (it rides the director's
   *  version, which the server watches) */
  private changed() {
    this.version++;
    this.sim.rule<WorldEvents>('worldEvents')?.changed();
  }
}
