// The leaderboard (docs/plans/leaderboard.md). Every point the simulation awards (Sim.score →
// Sim.onScore) is added here to the player's day, week and all-time totals in SQLite, per board, so a
// page of any board is one index scan. It answers `board` requests, pushes each player's own totals
// (`score`) right after the welcome and whenever they change (a rank can also change because someone
// else scored: everyone's is refreshed every few seconds while anyone is scoring), tells a player who
// climbs into the top of today's board, and tells the city (Rádio Kecy) who leads it and, at midnight,
// who won the day.
// Without a store (tests, unless given one) it stays off, and nothing scores.
import { HOURLY_CAP, POINTS, SOURCE_BOARD, isBoard, isPeriod, type BoardId, type ScorePeriod, type ScoreSource } from '../../../src/shared/sim/rules/points';
import { BOARD_ACCOUNT, BOARD_ME, BOARD_ONLINE, type BoardMsg, type BoardRow, type ClientMsg } from '../../../src/shared/net/protocol';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import type { Room, Session } from '../Room';
import type { Store } from '../db';
import { addDays, bratislavaDay, bratislavaMidnight, isoWeek, weekStart } from './dailyTime';
import type { FeatureHandlers, RoomFeature } from './RoomFeature';

/** rows on a page of a board */
export const TOP_N = 20;
/** a player's own totals go out at most this often (every point would be a message otherwise) */
const PUSH_MS = 1000;
/** while anyone scores, everyone's rank is refreshed this often (someone else's points move it too) */
const RANKS_MS = 10_000;
/** pushes per cycle at most (a handful of indexed lookups each); the rest wait for the next second */
const PUSH_MAX = 50;
/** days and weeks kept (the previous one is always shown as "yesterday's winner") */
const KEEP_DAYS = 14;
const KEEP_WEEKS = 10;
const HOUR_MS = 3_600_000;
/** "you're 3rd today" at most this often per player */
const RANK_MSG_GAP_MS = 60_000;
/** the city hears about a new leader of the day at most this often, and only past this many points */
const LEADER_NEWS_GAP_MS = 10 * 60_000;
const LEADER_MIN_POINTS = 100;
/** board requests: a burst of this many, then this many a second (each is a handful of queries) */
const QUERY_BURST = 6;
const QUERY_RATE = 3;
/** seeding a player from before the leaderboard: what one past delivery or fare counts for */
const SEED_JOB = 30;

type Board = Exclude<BoardId, 'all'>;

export class Leaderboard implements RoomFeature {
  readonly id = 'leaderboard';
  readonly messages: FeatureHandlers = {
    board: (s, m) => this.onBoard(s, m),
  };
  private store: Store | null;
  /** players whose totals changed since the last push */
  private dirty = new Set<Session>();
  private pushTimer = 0;
  private ranksTimer = RANKS_MS;
  /** anyone scored since everyone's ranks were last refreshed */
  private scored = false;
  /** today, 'YYYY-MM-DD' in Bratislava: a new one names yesterday's winner and resets the day */
  private today: string;
  /** player key → today's rank as last pushed, whether they led the day alone, and when they were
   *  last told about climbing */
  private ranks = new Map<string, { rank: number; led: boolean; toldAt: number }>();
  /** what each session was last sent, so a refresh that changed nothing sends nothing */
  private sent = new WeakMap<Session, string>();
  /** `${player key}|${source}` → when that capped source last scored for them (HOURLY_CAP) */
  private recent = new Map<string, number[]>();
  private leader: string | null = null;
  private leaderNewsAt = -Infinity;
  private buckets = new WeakMap<Session, { tokens: number; at: number }>();
  private counters = { awards: 0, capped: 0, queries: 0, errors: 0 };

  constructor(private room: Room) {
    this.store = room.store;
    this.today = bratislavaDay(room.wallNow());
    if (!this.store) return;
    room.sim.onScore = (p, points, source) => this.award(p, points, source);
    this.prune();
  }

  // ------------------------------------------------------------------------------------- scoring
  /** Sim.onScore: count the points (unless an hourly cap says no) and return how many were taken. */
  private award(p: SimPlayer, points: number, source: ScoreSource): number {
    const store = this.store;
    const s = this.room.sessionById(p.id);
    if (!store || !s || !(points > 0)) return 0;
    const now = this.room.wallNow();
    if (!this.underCap(s.key, source, now)) {
      this.counters.capped++;
      return 0;
    }
    const day = bratislavaDay(now);
    try {
      store.addScore(s.key, p.nick, SOURCE_BOARD[source], points, ['d' + day, 'w' + isoWeek(day), 'all'], now);
    } catch (e) {
      this.counters.errors++;
      console.error('leaderboard: saving points failed', e);
      return 0;
    }
    this.counters.awards++;
    this.dirty.add(s);
    this.scored = true;
    return points;
  }

  /** the hourly caps on the sources a player could otherwise repeat at will */
  private underCap(key: string, source: ScoreSource, now: number): boolean {
    const cap = HOURLY_CAP[source];
    if (cap === undefined) return true;
    const k = `${key}|${source}`;
    const times = (this.recent.get(k) ?? []).filter((t) => now - t < HOUR_MS);
    const ok = times.length < cap;
    if (ok) times.push(now);
    this.recent.set(k, times);
    return ok;
  }

  // -------------------------------------------------------------------------------------- sessions
  onHello(s: Session, isNew: boolean) {
    if (!this.store) return;
    if (isNew) this.seed(s);
    // right after every welcome, even when nothing changed (a reloaded page is a new client on the
    // same session): it's also how the client learns this server keeps a leaderboard
    this.sent.delete(s);
    this.push(s);
  }

  onDrop(s: Session) {
    this.dirty.delete(s);
  }

  /** E2E only: score points straight away, through the same path as the game (splits, caps) */
  onDebug(s: Session, m: Extract<ClientMsg, { t: 'debug' }>) {
    const sc = m.score;
    if (Array.isArray(sc) && typeof sc[0] === 'number' && typeof sc[1] === 'string' && Object.hasOwn(SOURCE_BOARD, sc[1])) this.room.sim.score(s.player, sc[0], sc[1] as ScoreSource);
  }

  /** A player from before the leaderboard: what they'd already done online counts once, on the
   *  all-time boards (not today's or this week's): landmarks and statues found, and the wins and jobs
   *  in their stats. Someone who has ever scored is never seeded again. */
  private seed(s: Session) {
    const store = this.store!;
    try {
      if (store.hasScores(s.key)) return;
      const pr = s.player.profile;
      const st = pr.stats ?? {};
      const n = (k: string) => (Number.isFinite(st[k]) ? Math.max(0, st[k]) : 0);
      const seed: Record<Board, number> = {
        events: n('derbyWins') * POINTS.derby[0] + n('golden') * POINTS.cumil,
        police: 0,
        jobs: (n('deliveries') + n('fares')) * SEED_JOB,
        races: n('racesWon') * POINTS.race,
        city: pr.found.length * POINTS.landmark + pr.cumils.length * POINTS.statue + n('dailyWins') * POINTS.daily,
        help: 0,
        style: 0,
        games: 0,
      };
      const now = this.room.wallNow();
      for (const [board, points] of Object.entries(seed)) {
        if (points > 0) store.addScore(s.key, s.player.nick, board, Math.round(points), ['all'], now);
      }
    } catch (e) {
      this.counters.errors++;
      console.error('leaderboard: seeding failed', e);
    }
  }

  // ------------------------------------------------------------------------------------ requests
  private onBoard(s: Session, m: Extract<ClientMsg, { t: 'board' }>) {
    const store = this.store;
    if (!store || !isPeriod(m.period) || !isBoard(m.board) || !this.take(s)) return;
    const now = this.room.wallNow();
    const day = bratislavaDay(now);
    const id = periodId(m.period, day);
    try {
      const rows: BoardRow[] = [];
      let rank = 0, last = -1;
      store.topScores(id, m.board, TOP_N).forEach((r, i) => {
        if (r.points !== last) (rank = i + 1), (last = r.points);
        rows.push([rank, r.nick, r.points, this.flags(r.key, s)]);
      });
      const mine = store.scoreOf(id, m.board, s.key);
      const msg: BoardMsg = { t: 'board', period: m.period, board: m.board, rows, me: [mine > 0 ? store.rankOf(id, m.board, mine) : 0, mine], n: store.boardSize(id, m.board) };
      if (m.period !== 'all') {
        const prev = store.topScores(periodId(m.period, addDays(day, m.period === 'day' ? -1 : -7)), m.board, 1)[0];
        if (prev) msg.prev = [prev.nick, prev.points];
        msg.ends = Math.max(0, Math.round((periodEnd(m.period, day) - now) / 1000));
      }
      this.counters.queries++;
      this.room.sendTo(s, msg);
    } catch (e) {
      this.counters.errors++;
      console.error('leaderboard: a board query failed', e);
    }
  }

  private flags(key: string, asker: Session): number {
    return (key.startsWith('acct:') ? BOARD_ACCOUNT : 0) | (this.room.sessions.get(key)?.conn ? BOARD_ONLINE : 0) | (key === asker.key ? BOARD_ME : 0);
  }

  /** a small token bucket per session: paging through the boards is fine, a flood of queries isn't */
  private take(s: Session): boolean {
    const now = this.room.wallNow();
    const b = this.buckets.get(s) ?? { tokens: QUERY_BURST, at: now };
    b.tokens = Math.min(QUERY_BURST, b.tokens + ((now - b.at) / 1000) * QUERY_RATE);
    b.at = now;
    this.buckets.set(s, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }

  // ---------------------------------------------------------------------------------------- tick
  tick(dtMs: number) {
    if (!this.store) return;
    this.pushTimer -= dtMs;
    if (this.pushTimer > 0) return;
    this.pushTimer = PUSH_MS;
    const day = bratislavaDay(this.room.wallNow());
    if (day !== this.today) this.newDay(day);
    this.ranksTimer -= PUSH_MS;
    if (this.ranksTimer <= 0) {
      this.ranksTimer = RANKS_MS;
      if (this.scored) for (const s of this.room.sessions.values()) if (s.conn) this.dirty.add(s);
      this.scored = false;
    }
    let budget = PUSH_MAX;
    for (const s of this.dirty) {
      if (budget-- <= 0) break;
      this.dirty.delete(s);
      this.push(s);
    }
  }

  /** Midnight in Bratislava: yesterday's winner makes the news, today's board starts empty (everyone
   *  online gets their fresh totals), and whatever the caps and ranks remembered is forgotten. */
  private newDay(day: string) {
    const store = this.store!;
    const yesterday = this.today;
    this.today = day;
    try {
      const best = store.topScores('d' + yesterday, 'all', 1)[0];
      if (best) this.room.sim.events.global({ k: 'dayWinner', nick: best.nick, pts: best.points });
    } catch (e) {
      this.counters.errors++;
      console.error('leaderboard: naming the day winner failed', e);
    }
    this.leader = null;
    this.ranks.clear();
    const now = this.room.wallNow();
    for (const [k, times] of this.recent) if (!times.some((t) => now - t < HOUR_MS)) this.recent.delete(k);
    for (const s of this.room.sessions.values()) if (s.conn) this.dirty.add(s);
    this.prune();
  }

  private prune() {
    try {
      const day = bratislavaDay(this.room.wallNow());
      this.store!.pruneScores('d' + addDays(day, -KEEP_DAYS), 'w' + isoWeek(addDays(day, -7 * KEEP_WEEKS)));
    } catch (e) {
      this.counters.errors++;
      console.error('leaderboard: pruning failed', e);
    }
  }

  /** send `s` their own totals (unless nothing changed), and react to a climb up today's board */
  private push(s: Session) {
    const store = this.store!;
    if (!s.conn) return;
    const now = this.room.wallNow();
    const day = 'd' + bratislavaDay(now);
    try {
      const d = store.scoreOf(day, 'all', s.key);
      const r = d > 0 ? store.rankOf(day, 'all', d) : 0;
      const n = store.boardSize(day, 'all');
      const msg = { t: 'score' as const, d, w: store.scoreOf('w' + isoWeek(day.slice(1)), 'all', s.key), a: store.scoreOf('all', 'all', s.key), r, n };
      const json = JSON.stringify(msg);
      if (this.sent.get(s) !== json) {
        this.sent.set(s, json);
        this.room.sendTo(s, msg);
      }
      // alone at the top: a tie for first isn't leading
      const top = r === 1 && n >= 2 ? store.topScores(day, 'all', 2) : [];
      const leads = top.length === 2 && top[0].key === s.key && top[0].points > top[1].points;
      this.climbed(s, r, n, d, leads, now);
    } catch (e) {
      this.counters.errors++;
      console.error('leaderboard: pushing a score failed', e);
    }
  }

  /** Tell a player who just took the lead of today's board, or climbed into its top 3 or top 10 (a
   *  board of a few players doesn't count), and the whole city about a new leader. */
  private climbed(s: Session, rank: number, n: number, points: number, leads: boolean, now: number) {
    const was = this.ranks.get(s.key);
    const before = was?.rank ?? 0;
    const entry = { rank, led: leads, toldAt: was?.toldAt ?? -Infinity };
    this.ranks.set(s.key, entry);
    const p = s.player;
    if (leads && points >= LEADER_MIN_POINTS && this.leader !== s.key && now - this.leaderNewsAt >= LEADER_NEWS_GAP_MS) {
      this.leader = s.key;
      this.leaderNewsAt = now;
      this.room.sim.events.global({ k: 'leader', nick: p.nick, pts: points });
    }
    const into = (top: number) => rank <= top && (!before || before > top);
    const text =
      leads && !was?.led ? 'Vedieš dnešný rebríček!'
      : !leads && into(3) && n >= 4 ? `Si ${rank}. v dnešnom rebríčku!`
      : !leads && into(10) && n >= 11 ? `Si v top 10 dnešného rebríčka (${rank}.)`
      : null;
    if (!text || now - entry.toldAt < RANK_MSG_GAP_MS) return;
    entry.toldAt = now;
    this.room.sim.events.toPlayer(p.id, { k: 'msg', title: '', text: `🏆 ${text}`, time: 3.5, color: '#ffd740' });
  }

  stats() {
    const c = this.counters;
    return { lbAwards: c.awards, lbCapped: c.capped, lbQueries: c.queries, lbErrors: c.errors };
  }
}

/** a period's id in the scores table: 'd2026-09-27', 'w2026-W39' or 'all' */
function periodId(period: ScorePeriod, day: string): string {
  return period === 'day' ? 'd' + day : period === 'week' ? 'w' + isoWeek(day) : 'all';
}

/** when `day`'s day, or its week, is over (ms) */
function periodEnd(period: 'day' | 'week', day: string): number {
  return bratislavaMidnight(period === 'day' ? addDays(day, 1) : addDays(weekStart(day), 7));
}
