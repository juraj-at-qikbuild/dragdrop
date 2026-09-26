import { describe, expect, it } from 'vitest';
import { Room, type RoomOptions } from '../src/Room';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import { Supa } from '../src/supa';
import { addDays, bratislavaDay, bratislavaReveal18 } from '../src/features/dailyTime';
import type { Daily } from '../src/features/Daily';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, disabledSupa, flush, loadWorld } from './helpers';

interface Row {
  [k: string]: unknown;
}
interface PatchCall {
  table: string;
  day: string;
  values: Record<string, unknown>;
}

/** a fake Supabase: an in-memory table store, `select` filtered by `day=eq.<...>`, `patch` recorded
 *  (and applied back to the store, so a later select sees it) — server/test/supa.test.ts has the
 *  underlying fakeFetch pattern this borrows. */
function fakeSupa(tables: { daily_spots?: Row[]; daily_spot_secrets?: Row[] } = {}, fail: () => boolean = () => false) {
  const db: Record<string, Row[]> = { daily_spots: [], daily_spot_secrets: [], ...tables };
  const patches: PatchCall[] = [];
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    if (fail()) return new Response('{"message":"unavailable"}', { status: 503 });
    const u = new URL(String(url));
    const table = u.pathname.split('/').pop()!;
    const day = /day=eq\.([^&]+)/.exec(u.search)?.[1] ?? '';
    const method = init.method ?? 'GET';
    if (method === 'GET') {
      const rows = (db[table] ?? []).filter((r) => r.day === day);
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (method === 'PATCH') {
      const values = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      patches.push({ table, day, values });
      for (const r of db[table] ?? []) if (r.day === day) Object.assign(r, values);
      return new Response(null, { status: 204 }); // a 204 must have a null body (Fetch spec)
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const supa = new Supa('https://proj.supabase.co', 'sb_secret_test', { fetch: fetchFn });
  return { supa, db, patches };
}

const DAY = '2026-01-15'; // winter: no DST to worry about in these scenarios
const REVEAL_ISO = bratislavaReveal18(DAY); // '2026-01-15T17:00:00.000Z'
const REVEAL_MS = Date.parse(REVEAL_ISO);
const SPOT = { x: 120, y: -80 };
/** far from every landmark (unlike the default spawn, ~the main square): a second player can sit
 *  here without picking up the unrelated "landmark found" $100 that would otherwise confuse a
 *  profile.money assertion (Sim.ts's LANDMARK_REWARD, 45 m radius) */
const PARK = { x: -1600, y: -1550 };

function spotsRow(overrides: Partial<Row> = {}): Row {
  return { day: DAY, image_path: 'abc123.webp', reveal_at: REVEAL_ISO, solved_nick: null, solved_at: null, ...overrides };
}
function secretRow(overrides: Partial<Row> = {}): Row {
  return { day: DAY, x: SPOT.x, y: SPOT.y, level: 0, radius: 6, kind: 'square', hint_district: 'Staré Mesto', hint_quarter: 'Vydrica', hint_street: 'Most SNP', ...overrides };
}

/** a Room whose wall clock starts well before REVEAL_MS, so "before reveal" is the default state */
function setup(extra: Partial<RoomOptions> = {}, startAt = REVEAL_MS - 3 * 3600_000) {
  const clock = new FakeClock();
  clock.t = startAt;
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 1, debug: true, supa: disabledSupa(), ...extra });
  const join = (token: string, nick: string) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick }));
    const w = link.last('welcome');
    return { link, conn, id: w.id as number };
  };
  const tick = (n = 1, dtMs = 50) => {
    for (let i = 0; i < n; i++) {
      clock.advance(dtMs);
      room.tick(dtMs);
    }
  };
  /** stand a joined player's figure exactly on the spot (direct SimPlayer mutation, as the rest of
   *  the suite does for positioning — see room.test.ts): on foot, level 0, state 'play' */
  const standOnSpot = (id: number, x = SPOT.x, y = SPOT.y) => {
    const p = room.sim.players.get(id)!;
    p.ped.x = x;
    p.ped.y = y;
    p.ped.level = 0;
  };
  return { clock, room, join, tick, standOnSpot };
}

describe('Daily: reveal', () => {
  it('nothing before reveal_at; the reveal fires (with wev.daily and dailyReveal) once wallNow crosses it', async () => {
    const { room, join, tick, clock } = setup({ supa: fakeSupa({ daily_spots: [spotsRow()], daily_spot_secrets: [secretRow()] }).supa });
    await flush(); // let the constructor's fire-and-forget poll() land before asserting
    const a = join(TOKEN_A, 'Anna');
    tick(1);
    expect(room.wevMsg().daily).toBeNull();
    expect(a.link.json('ev').flatMap((m) => m.g ?? []).some((e) => e.k === 'dailyReveal')).toBe(false);

    clock.t = REVEAL_MS + 500; // cross reveal_at
    tick(1);
    const daily = room.wevMsg().daily;
    expect(daily).toEqual({ day: DAY, img: 'https://proj.supabase.co/storage/v1/object/public/spots/abc123.webp', hints: [], solvedBy: null });
    // a feature's tick() runs after that same tick's event flush (Room.tick), so the GlobalEvent it
    // just queued only reaches clients on the room's *next* tick — one more, cheap and event-only
    tick(1);
    const globals = a.link.json('ev').flatMap((m) => m.g ?? []);
    const reveal = globals.find((e) => e.k === 'dailyReveal');
    expect(reveal).toMatchObject({ k: 'dailyReveal', img: daily!.img });
  });

  it('no puzzle at all when no row exists for today: wev.daily stays null', async () => {
    const { room, tick } = setup({ supa: fakeSupa().supa }, REVEAL_MS + 1000);
    await flush();
    tick(1);
    expect(room.wevMsg().daily).toBeNull();
  });

  it("emits dailyAnswer for yesterday's spot when it was left unsolved, right at today's reveal", async () => {
    const yDay = addDays(DAY, -1);
    const { supa } = fakeSupa({
      daily_spots: [spotsRow(), spotsRow({ day: yDay, image_path: 'yesterday.webp', reveal_at: bratislavaReveal18(yDay), solved_nick: null })],
      daily_spot_secrets: [secretRow(), secretRow({ day: yDay, x: -50, y: 300 })],
    });
    const { join, tick, clock } = setup({ supa });
    await flush();
    const a = join(TOKEN_A, 'Anna');
    clock.t = REVEAL_MS + 500;
    tick(2); // reveal, then one more to flush the GlobalEvent it queued (see the reveal test above)
    const answer = a.link.json('ev').flatMap((m) => m.g ?? []).find((e) => e.k === 'dailyAnswer');
    expect(answer).toMatchObject({ k: 'dailyAnswer', x: -50, y: 300 });
  });

  it("does not answer yesterday's spot when it was already solved", async () => {
    const yDay = addDays(DAY, -1);
    const { supa } = fakeSupa({
      daily_spots: [spotsRow(), spotsRow({ day: yDay, solved_nick: 'Fero', solved_at: '2026-01-14T18:00:00Z' })],
      daily_spot_secrets: [secretRow(), secretRow({ day: yDay })],
    });
    const { join, tick, clock } = setup({ supa });
    await flush();
    const a = join(TOKEN_A, 'Anna');
    clock.t = REVEAL_MS + 500;
    tick(1);
    expect(a.link.json('ev').flatMap((m) => m.g ?? []).some((e) => e.k === 'dailyAnswer')).toBe(false);
  });
});

describe('Daily: loading', () => {
  it('a restart 45 min after the reveal keeps the reveal and the hints due so far, without re-announcing them', async () => {
    const { supa } = fakeSupa({ daily_spots: [spotsRow()], daily_spot_secrets: [secretRow()] });
    const { room, join, tick } = setup({ supa }, REVEAL_MS + 45 * 60_000);
    await flush();
    const a = join(TOKEN_A, 'Anna');
    tick(3);
    expect(room.wevMsg().daily!.hints).toEqual(['Mestská časť: Staré Mesto', 'Štvrť: Vydrica']);
    const g = a.link.json('ev').flatMap((m) => m.g ?? []);
    expect(g.some((e) => e.k === 'dailyReveal' || e.k === 'dailyHint')).toBe(false);
  });

  it('a failed load is retried on the next poll instead of skipping the day', async () => {
    let fail = true;
    const { supa } = fakeSupa({ daily_spots: [spotsRow()], daily_spot_secrets: [secretRow()] }, () => fail);
    const { room, tick } = setup({ supa }, REVEAL_MS + 1000);
    await flush();
    tick(1);
    expect(room.wevMsg().daily).toBeNull();
    fail = false;
    await (room.feature<Daily>('daily') as unknown as { poll(): Promise<void> }).poll();
    tick(1);
    expect(room.wevMsg().daily?.img).toContain('abc123.webp');
  });

  it("a missing row is looked for again later, not only at tomorrow's rollover", async () => {
    const { supa, db } = fakeSupa();
    const { room, tick, clock } = setup({ supa }, REVEAL_MS + 1000);
    await flush();
    tick(1);
    expect(room.wevMsg().daily).toBeNull();
    db.daily_spots.push(spotsRow());
    db.daily_spot_secrets.push(secretRow());
    const daily = room.feature<Daily>('daily') as unknown as { poll(): Promise<void> };
    await daily.poll(); // a minute later: still inside the retry wait
    expect(room.wevMsg().daily).toBeNull();
    clock.t += 16 * 60_000;
    await daily.poll();
    tick(1);
    expect(room.wevMsg().daily?.img).toContain('abc123.webp');
  });
});

describe('Daily: hints', () => {
  it('reveals district at +20 min, quarter at +40, street at +60, each with a dailyHint event', async () => {
    const { room, join, tick, clock } = setup({ supa: fakeSupa({ daily_spots: [spotsRow()], daily_spot_secrets: [secretRow()] }).supa });
    await flush();
    const a = join(TOKEN_A, 'Anna');
    clock.t = REVEAL_MS + 1000;
    tick(1);
    expect(room.wevMsg().daily!.hints).toEqual([]);

    clock.t = REVEAL_MS + 20 * 60_000 + 1000;
    tick(2); // the threshold tick, then one more to flush its dailyHint GlobalEvent
    expect(room.wevMsg().daily!.hints).toEqual(['Mestská časť: Staré Mesto']);
    let hint = a.link.json('ev').flatMap((m) => m.g ?? []).find((e) => e.k === 'dailyHint');
    expect(hint).toMatchObject({ k: 'dailyHint', level: 1, text: 'Staré Mesto' });

    clock.t = REVEAL_MS + 40 * 60_000 + 1000;
    tick(1);
    expect(room.wevMsg().daily!.hints).toEqual(['Mestská časť: Staré Mesto', 'Štvrť: Vydrica']);

    clock.t = REVEAL_MS + 60 * 60_000 + 1000;
    tick(2);
    expect(room.wevMsg().daily!.hints).toEqual(['Mestská časť: Staré Mesto', 'Štvrť: Vydrica', 'Ulica: Most SNP']);
    hint = a.link.json('ev').flatMap((m) => m.g ?? []).filter((e) => e.k === 'dailyHint').pop();
    expect(hint).toMatchObject({ level: 3, text: 'Most SNP' });
  });

  it('skips a tier with no hint value but still keeps the schedule for the next one', async () => {
    const { room, tick, clock } = setup({
      supa: fakeSupa({ daily_spots: [spotsRow()], daily_spot_secrets: [secretRow({ hint_quarter: null })] }).supa,
    });
    await flush();
    clock.t = REVEAL_MS + 40 * 60_000 + 1000; // past both the district and (empty) quarter thresholds
    tick(1);
    expect(room.wevMsg().daily!.hints).toEqual(['Mestská časť: Staré Mesto']); // quarter silently skipped
    clock.t = REVEAL_MS + 60 * 60_000 + 1000;
    tick(1);
    expect(room.wevMsg().daily!.hints).toEqual(['Mestská časť: Staré Mesto', 'Ulica: Most SNP']);
  });
});

describe('Daily: solving', () => {
  it('the first player to hold the spot for 1s within the radius wins: payout, stats, patch, dailySolved', async () => {
    const { supa, patches } = fakeSupa({ daily_spots: [spotsRow()], daily_spot_secrets: [secretRow()] });
    const { room, join, tick, clock, standOnSpot } = setup({ supa });
    await flush();
    const a = join(TOKEN_A, 'Anna');
    standOnSpot(a.id); // before the first tick: the default spawn is near a landmark (an unrelated find/reward)
    const p = room.sim.players.get(a.id)!;
    clock.t = REVEAL_MS + 1000;
    tick(1);
    expect(p.profile.money).toBe(0);

    tick(15, 50); // 750 ms: not yet 1 s
    expect(room.wevMsg().daily!.solvedBy).toBeNull();
    expect(p.profile.money).toBe(0);

    tick(10, 50); // +500 ms = 1.25 s total: past the 1 s hold
    expect(p.profile.money).toBe(1000);
    expect(p.profile.stats?.dailyWins).toBe(1);
    expect(room.wevMsg().daily!.solvedBy).toBe('Anna');
    tick(1); // flush the dailySolved GlobalEvent queued by the winning tick
    const solved = a.link.json('ev').flatMap((m) => m.g ?? []).find((e) => e.k === 'dailySolved');
    expect(solved).toMatchObject({ k: 'dailySolved', nick: 'Anna' });

    await flush(); // the patch() call is fire-and-forget
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ table: 'daily_spots', day: DAY, values: { solved_nick: 'Anna' } });
    expect(typeof patches[0].values.solved_at).toBe('string');
  });

  it('leaving the radius resets the hold: no win until 1s continuous', async () => {
    const { room, join, tick, clock, standOnSpot } = setup({
      supa: fakeSupa({ daily_spots: [spotsRow()], daily_spot_secrets: [secretRow()] }).supa,
    });
    await flush();
    const a = join(TOKEN_A, 'Anna');
    standOnSpot(a.id);
    clock.t = REVEAL_MS + 1000;
    tick(1);
    tick(15, 50); // 750 ms in
    const p = room.sim.players.get(a.id)!;
    p.ped.x += 100; // step off the spot
    tick(1, 50);
    p.ped.x = SPOT.x; // and back on: the hold should have reset, not resumed
    tick(15, 50); // another 750 ms: still short of a full continuous second
    expect(p.profile.money).toBe(0);
    tick(5, 50); // completes the second continuously this time
    expect(p.profile.money).toBe(1000);
  });

  it('no second winner: once solved, a later arrival (or the winner staying) never pays out again', async () => {
    const { room, join, tick, clock, standOnSpot } = setup({
      supa: fakeSupa({ daily_spots: [spotsRow()], daily_spot_secrets: [secretRow()] }).supa,
    });
    await flush();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    standOnSpot(a.id);
    standOnSpot(b.id, PARK.x, PARK.y); // parked well away until he "arrives" below
    clock.t = REVEAL_MS + 1000;
    tick(1);
    tick(25, 50); // Anna wins
    expect(room.sim.players.get(a.id)!.profile.money).toBe(1000);

    standOnSpot(b.id); // Boris arrives on the (now solved) spot afterwards
    tick(25, 50);
    expect(room.sim.players.get(b.id)!.profile.money).toBe(0);
    expect(room.sim.players.get(a.id)!.profile.money).toBe(1000); // unchanged, not paid twice either
    tick(1); // flush events
    const solves = a.link.json('ev').flatMap((m) => m.g ?? []).filter((e) => e.k === 'dailySolved');
    expect(solves).toHaveLength(1);
  });

  it('a restart onto an already-solved row stays solved: no second winner', async () => {
    const { supa } = fakeSupa({ daily_spots: [spotsRow({ solved_nick: 'Existing', solved_at: '2026-01-15T17:05:00Z' })], daily_spot_secrets: [secretRow()] });
    const { room, join, tick, standOnSpot } = setup({ supa }, REVEAL_MS + 1000);
    await flush();
    expect(room.wevMsg().daily!.solvedBy).toBe('Existing');
    const a = join(TOKEN_A, 'Anna');
    standOnSpot(a.id);
    tick(25, 50);
    expect(room.sim.players.get(a.id)!.profile.money).toBe(0);
    expect(a.link.json('ev').flatMap((m) => m.g ?? []).some((e) => e.k === 'dailySolved')).toBe(false);
  });
});

describe('Daily: player lifecycle', () => {
  it("a dropped player's held-seconds entry is cleared, not left to leak into a later id reuse", async () => {
    const { room, join, tick, clock, standOnSpot } = setup({ supa: fakeSupa({ daily_spots: [spotsRow()], daily_spot_secrets: [secretRow()] }).supa });
    await flush();
    const a = join(TOKEN_A, 'Anna');
    standOnSpot(a.id);
    clock.t = REVEAL_MS + 1000;
    tick(1);
    tick(15, 50); // holding the spot for a while: not yet the 1s needed to solve it
    const daily = room.feature<Daily>('daily') as unknown as { holding: Map<number, number> };
    expect(daily.holding.get(a.id)).toBeGreaterThan(0);

    room.onMessage(a.conn, JSON.stringify({ t: 'leave' })); // drops the session for good (Sim ids get recycled)
    expect(daily.holding.has(a.id)).toBe(false);
  });
});

describe('Daily: debug injection', () => {
  it('msg.daily injects a spot for today, revealed immediately, with no Supabase', async () => {
    const { room, join, tick, standOnSpot } = setup({ supa: disabledSupa() }); // no rows at all
    await flush();
    const a = join(TOKEN_A, 'Anna');
    standOnSpot(a.id); // before any tick: keep clear of the default spawn's unrelated landmark find
    tick(1);
    expect(room.wevMsg().daily).toBeNull();

    room.onMessage(a.conn, JSON.stringify({ t: 'debug', daily: { x: SPOT.x, y: SPOT.y, r: 6 } }));
    tick(1);
    const daily = room.wevMsg().daily;
    expect(daily).toMatchObject({ img: '', solvedBy: null });
    expect(daily!.day).toBe(bratislavaDay(room.wallNow()));

    tick(25, 50);
    expect(room.sim.players.get(a.id)!.profile.money).toBe(1000);
    expect(room.wevMsg().daily!.solvedBy).toBe('Anna');
  });
});

describe('bratislavaReveal18 / bratislavaDay (pure helpers)', () => {
  it('18:00 Bratislava in winter is 17:00 UTC (CET, UTC+1)', () => {
    expect(bratislavaReveal18('2026-01-15')).toBe('2026-01-15T17:00:00.000Z');
  });

  it('18:00 Bratislava in summer is 16:00 UTC (CEST, UTC+2)', () => {
    expect(bratislavaReveal18('2026-07-15')).toBe('2026-07-15T16:00:00.000Z');
  });

  it('handles both 2026 DST transition dates correctly', () => {
    expect(bratislavaReveal18('2026-03-28')).toBe('2026-03-28T17:00:00.000Z'); // still CET the evening before
    expect(bratislavaReveal18('2026-03-29')).toBe('2026-03-29T16:00:00.000Z'); // clocks sprang forward that morning
    expect(bratislavaReveal18('2026-10-25')).toBe('2026-10-25T17:00:00.000Z'); // clocks fell back that morning
    expect(bratislavaReveal18('2026-10-26')).toBe('2026-10-26T17:00:00.000Z'); // still CET the day after
  });

  it('bratislavaDay round-trips a reveal instant back to the same calendar day', () => {
    for (const day of ['2026-01-15', '2026-07-15', '2026-03-29', '2026-10-25']) expect(bratislavaDay(Date.parse(bratislavaReveal18(day)))).toBe(day);
  });

  it('addDays shifts a calendar date without needing a timezone', () => {
    expect(addDays('2026-01-15', -1)).toBe('2026-01-14');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28'); // month boundary
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31'); // year boundary
  });
});
