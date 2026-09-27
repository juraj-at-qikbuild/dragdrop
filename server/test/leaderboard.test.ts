// server/src/features/Leaderboard.ts and the scores table in server/src/db.ts
// (docs/plans/leaderboard.md): points into day/week/all-time boards, pages of a board, the pushed
// totals, the hourly caps, seeding players from before the leaderboard, midnight, and GDPR/claims.
import { describe, expect, it } from 'vitest';
import { Room } from '../src/Room';
import { Store, hashToken } from '../src/db';
import { BOARD_ACCOUNT, BOARD_ME, BOARD_ONLINE, PROTOCOL_VERSION, type BoardMsg, type ScoreMsg } from '../../src/shared/net/protocol';
import { HOURLY_CAP, POINTS } from '../../src/shared/sim/rules/points';
import { STYLE, STYLE_PER_POINT } from '../../src/shared/sim/rules/Style';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, TOKEN_C, disabledSupa, loadWorld } from './helpers';

/** Wednesday 23 September 2026, 12:00 in Bratislava (10:00 UTC): mid-week, mid-day */
const WED_NOON = Date.UTC(2026, 8, 23, 10);
const HOUR = 3_600_000;

function setup(opts: { store?: Store | null; at?: number } = {}) {
  const clock = new FakeClock();
  clock.t = opts.at ?? WED_NOON;
  const store = opts.store === undefined ? new Store(':memory:') : opts.store;
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 3, store: store ?? undefined, debug: true, supa: disabledSupa() });
  const join = (token: string, nick: string, extra: Record<string, unknown> = {}) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick, ...extra }));
    const s = room.sessionById(link.last('welcome').id)!;
    // players start on Hlavné námestie, a landmark: every one pre-found, so discovering one never scores
    s.player.profile.found = [...room.sim.world.landmarks.keys()];
    return { link, conn, s, p: s.player };
  };
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  const ask = (conn: ReturnType<typeof room.onJoin>, period: string, board: string) => room.onMessage(conn, JSON.stringify({ t: 'board', period, board }));
  return { clock, store: store!, room, join, tick, ask };
}

/** the most recent `score` push to this link */
const lastScore = (link: FakeLink): ScoreMsg => link.last('score');

describe('Leaderboard: the Štýl board (docs/plans/gameplay.md, Phase 3)', () => {
  it('a combo paid out online scores 1 point per €25 on the style board, capped at 30 an hour', () => {
    const { room, store, join, tick } = setup();
    const { link, s, p } = join(TOKEN_A, 'Anna');
    room.sim.style(p, 'takedown', 1, 2);
    room.sim.style(p, 'takedown', 1, 2);
    tick(90); // 4.5 s: the combo runs out and pays
    const paid = STYLE.takedown.cash * 2 * 3;
    expect(link.json('ev').flatMap((m) => m.p)).toContainEqual(expect.objectContaining({ k: 'payout', reason: 'style', amount: paid }));
    expect(store.scoreOf('all', 'style', s.key)).toBe(Math.round(paid / STYLE_PER_POINT));
    expect(HOURLY_CAP.style).toBe(30);
  });
});

describe('Leaderboard: scoring', () => {
  it("sends the player's own totals right after the welcome", () => {
    const { join } = setup();
    const { link } = join(TOKEN_A, 'Anna');
    const types = link.json().map((m) => m.t);
    expect(types.indexOf('score')).toBeGreaterThan(types.indexOf('welcome'));
    expect(lastScore(link)).toEqual({ t: 'score', d: 0, w: 0, a: 0, r: 0, n: 0 });
  });

  it("counts points into today's, this week's and the all-time totals, on the source's board and on the whole", () => {
    const { room, store, join, tick } = setup();
    const { link, s, p } = join(TOKEN_A, 'Anna');
    room.sim.score(p, 30, 'courier', 1, 2);
    for (const period of ['d2026-09-23', 'w2026-W39', 'all']) {
      expect(store.scoreOf(period, 'jobs', s.key)).toBe(30);
      expect(store.scoreOf(period, 'all', s.key)).toBe(30);
      expect(store.scoreOf(period, 'races', s.key)).toBe(0);
    }
    tick(21);
    expect(lastScore(link)).toEqual({ t: 'score', d: 30, w: 30, a: 30, r: 1, n: 1 });
    const pts = link.json('ev').flatMap((m) => m.p).filter((e) => e.k === 'points');
    expect(pts).toEqual([{ k: 'points', n: 30, src: 'courier', x: 1, y: 2 }]);
  });

  it('holds repeatable sources to their hourly cap', () => {
    const { room, store, join, clock } = setup();
    const { s, p } = join(TOKEN_A, 'Anna');
    const cap = HOURLY_CAP.getaway!;
    for (let i = 0; i < cap + 3; i++) {
      room.sim.score(p, 5, 'getaway');
      clock.advance(60_000);
    }
    expect(store.scoreOf('all', 'police', s.key)).toBe(5 * cap);
    clock.advance(HOUR);
    room.sim.score(p, 5, 'getaway');
    expect(store.scoreOf('all', 'police', s.key)).toBe(5 * (cap + 1));
    // an uncapped source is never held back
    for (let i = 0; i < 20; i++) room.sim.score(p, 1, 'landmark');
    expect(store.scoreOf('all', 'city', s.key)).toBe(20);
  });

  it("a party splits the points for the sources it splits the money for (Party.ts)", () => {
    const { room, store, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onMessage(a.conn, JSON.stringify({ t: 'partyInvite' }));
    tick();
    const code = a.link.json('ev').flatMap((m) => m.p).find((e) => e.k === 'invite') as { code: string };
    const b = join(TOKEN_B, 'Boris', { join: code.code });
    tick();
    expect(b.p.partyId).toBe(a.p.partyId);
    room.sim.score(a.p, 31, 'courier');
    expect(store.scoreOf('all', 'jobs', a.s.key)).toBe(16);
    expect(store.scoreOf('all', 'jobs', b.s.key)).toBe(15);
    room.sim.score(a.p, 30, 'race'); // never split
    expect(store.scoreOf('all', 'races', a.s.key)).toBe(30);
    expect(store.scoreOf('all', 'races', b.s.key)).toBe(0);
  });

  it('without a store nothing scores and nothing is pushed', () => {
    const { room, join } = setup({ store: null });
    const { link, p } = join(TOKEN_A, 'Anna');
    expect(room.sim.onScore).toBeUndefined();
    room.sim.score(p, 30, 'courier');
    expect(link.json('score')).toEqual([]);
  });
});

describe('Leaderboard: board pages', () => {
  it('answers with the top, shared ranks for ties, flags, the asker, the board size and when it ends', () => {
    const { room, store, join, clock, ask } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    const c = join(TOKEN_C, 'Cyril');
    room.sim.score(a.p, 50, 'courier');
    clock.advance(1000);
    room.sim.score(b.p, 50, 'taxi');
    clock.advance(1000);
    room.sim.score(c.p, 20, 'courier');
    room.sim.score(c.p, 40, 'race');
    // someone who isn't in the city right now, on an account
    store.addScore('acct:u1', 'Dana', 'jobs', 10, ['d2026-09-23', 'w2026-W39', 'all'], clock.t);
    ask(c.conn, 'day', 'jobs');
    const m: BoardMsg = c.link.last('board');
    expect(m.period).toBe('day');
    expect(m.board).toBe('jobs');
    expect(m.rows).toEqual([
      [1, 'Anna', 50, BOARD_ONLINE],
      [1, 'Boris', 50, BOARD_ONLINE],
      [3, 'Cyril', 20, BOARD_ONLINE | BOARD_ME],
      [4, 'Dana', 10, BOARD_ACCOUNT],
    ]);
    expect(m.me).toEqual([3, 20]);
    expect(m.n).toBe(4);
    expect(m.prev).toBeUndefined();
    expect(m.ends).toBe(Math.round((Date.UTC(2026, 8, 23, 22) - clock.t) / 1000)); // midnight in Bratislava
    ask(c.conn, 'all', 'all');
    const all: BoardMsg = c.link.last('board');
    expect(all.rows.map((r) => [r[1], r[2]])).toEqual([['Cyril', 60], ['Anna', 50], ['Boris', 50], ['Dana', 10]]);
    expect(all.rows.map((r) => r[0])).toEqual([1, 2, 2, 4]);
    expect(all.ends).toBeUndefined();
    ask(a.conn, 'week', 'races');
    const week: BoardMsg = a.link.last('board');
    expect(week.me).toEqual([0, 0]); // not on this board
    expect(week.rows).toEqual([[1, 'Cyril', 40, BOARD_ONLINE]]);
    expect(week.ends).toBe(Math.round((Date.UTC(2026, 8, 27, 22) - clock.t) / 1000)); // Monday 00:00
  });

  it("shows yesterday's winner, and the same week goes on", () => {
    const { room, join, clock, ask } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.sim.score(a.p, 70, 'landmark');
    clock.advance(24 * HOUR);
    ask(a.conn, 'day', 'all');
    const day: BoardMsg = a.link.last('board');
    expect(day.rows).toEqual([]);
    expect(day.prev).toEqual(['Anna', 70]);
    ask(a.conn, 'week', 'city');
    expect(a.link.last('board').rows).toEqual([[1, 'Anna', 70, BOARD_ONLINE | BOARD_ME]]);
  });

  it('ignores a request for a board or period that does not exist, and a flood of them', () => {
    const { join, ask } = setup();
    const a = join(TOKEN_A, 'Anna');
    ask(a.conn, 'year', 'all');
    ask(a.conn, 'day', 'nope');
    expect(a.link.json('board')).toEqual([]);
    for (let i = 0; i < 20; i++) ask(a.conn, 'day', 'all');
    expect(a.link.json('board').length).toBeLessThanOrEqual(6);
  });
});

describe('Leaderboard: the day', () => {
  it('a new leader of the day makes the news, and the player hears they lead', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.sim.score(b.p, 10, 'landmark');
    room.sim.score(a.p, 150, 'daily');
    tick(21);
    tick(2);
    const globals = a.link.json('ev').flatMap((m) => m.g ?? []);
    expect(globals).toContainEqual({ k: 'leader', nick: 'Anna', pts: 150 });
    const msgs = a.link.json('ev').flatMap((m) => m.p).filter((e) => e.k === 'msg').map((e) => (e as { text: string }).text);
    expect(msgs).toContain('🏆 Vedieš dnešný rebríček!');
    // everyone hears it, once
    const heard = b.link.json('ev').flatMap((m) => m.g ?? []).filter((e) => e.k === 'leader');
    expect(heard).toEqual([{ k: 'leader', nick: 'Anna', pts: 150 }]);
  });

  it("at midnight yesterday's winner makes the news and today's totals start over", () => {
    const { room, join, tick, clock } = setup({ at: Date.UTC(2026, 8, 23, 21, 59) }); // 23:59 in Bratislava
    const a = join(TOKEN_A, 'Anna');
    room.sim.score(a.p, 120, 'daily');
    tick(21);
    expect(lastScore(a.link)).toMatchObject({ d: 120, w: 120, a: 120, r: 1 });
    clock.advance(2 * 60_000);
    tick(21);
    tick(2);
    expect(lastScore(a.link)).toEqual({ t: 'score', d: 0, w: 120, a: 120, r: 0, n: 0 });
    const globals = a.link.json('ev').flatMap((m) => m.g ?? []);
    expect(globals).toContainEqual({ k: 'dayWinner', nick: 'Anna', pts: 120 });
  });

  it('keeps two weeks of days and ten weeks of weeks', () => {
    const store = new Store(':memory:');
    const now = WED_NOON;
    store.addScore('k', 'A', 'jobs', 5, ['d2026-09-01', 'd2026-09-10', 'w2026-W20', 'w2026-W35', 'all'], now);
    const { store: s } = setup({ store });
    expect(s.scoreOf('d2026-09-01', 'jobs', 'k')).toBe(0);
    expect(s.scoreOf('d2026-09-10', 'jobs', 'k')).toBe(5);
    expect(s.scoreOf('w2026-W20', 'jobs', 'k')).toBe(0);
    expect(s.scoreOf('w2026-W35', 'jobs', 'k')).toBe(5);
    expect(s.scoreOf('all', 'jobs', 'k')).toBe(5);
  });
});

describe('Leaderboard: players from before it, and leaving for good', () => {
  it('seeds what a returning player had already done, on the all-time boards only, once', () => {
    const { room, store, join, tick } = setup();
    const first = join(TOKEN_A, 'Anna');
    const landmarks = [...room.sim.world.landmarks.keys()].slice(0, 3);
    first.p.profile.found = landmarks;
    first.p.profile.cumils = [1, 2];
    first.p.profile.stats = { deliveries: 1, fares: 1, racesWon: 1, derbyWins: 1, golden: 1, dailyWins: 1 };
    room.onMessage(first.conn, JSON.stringify({ t: 'leave' }));
    tick();
    const again = join(TOKEN_A, 'Anna');
    const key = again.s.key;
    expect(store.scoreOf('all', 'city', key)).toBe(3 * POINTS.landmark + 2 * POINTS.statue + POINTS.daily);
    expect(store.scoreOf('all', 'jobs', key)).toBe(60);
    expect(store.scoreOf('all', 'races', key)).toBe(POINTS.race);
    expect(store.scoreOf('all', 'events', key)).toBe(POINTS.derby[0] + POINTS.cumil);
    expect(store.scoreOf('d2026-09-23', 'all', key)).toBe(0);
    const seeded = store.scoreOf('all', 'all', key);
    room.onMessage(again.conn, JSON.stringify({ t: 'leave' }));
    tick();
    join(TOKEN_A, 'Anna');
    expect(store.scoreOf('all', 'all', key)).toBe(seeded); // never twice
  });

  it("deleting a player (GDPR) takes their points with them; claiming moves a guest's into the account", () => {
    const store = new Store(':memory:');
    const fake = { profile: { money: 0, done: [], found: [], cumils: [] }, ped: { level: 0, health: 100, armor: 0, weapon: 'fist' }, ammo: { pistol: 0, uzi: 0, shotgun: 0 }, state: 'play', wanted: 0, focus: () => ({ x: 0, y: 0 }) } as unknown as SimPlayer;
    const guest = hashToken(TOKEN_A);
    store.savePlayers([{ key: guest, nick: 'Anna', player: fake }]);
    store.addScore(guest, 'Anna', 'jobs', 40, ['d2026-09-23', 'all'], 1);
    expect(store.movePlayer(guest, 'acct:u1')).toBe(true);
    expect(store.hasScores(guest)).toBe(false);
    expect(store.scoreOf('all', 'jobs', 'acct:u1')).toBe(40);
    expect(store.scoreOf('d2026-09-23', 'all', 'acct:u1')).toBe(40);
    store.deletePlayer('acct:u1');
    expect(store.hasScores('acct:u1')).toBe(false);
    expect(store.topScores('all', 'all', 10)).toEqual([]);
  });
});
