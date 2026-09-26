// End-to-end social-features check (docs/plans/social-events.md, D1): starts the real game server
// (E2E=1, Supabase off) and a production client build, then drives 2-3 headless Chromium pages
// through the invite link, revive, Horúca Kofolka, Závod? and Rádio Kecy daily puzzle, plus proximity
// voice reusing A4's approach (scripts/e2e-voice.mjs). No Supabase project is touched: the server
// always runs with SUPABASE_SECRET_KEY unset, so `activity`/`reports` never see test data.
//
//   node scripts/e2e-social.mjs
//   E2E_PHASE=social npm run e2e     (see scripts/e2e-mp.mjs, which delegates here)
//   E2E_SKIP_BUILD=1 node scripts/e2e-social.mjs
//
// Uses playwright-core with the preinstalled Chromium, the same way e2e-mp.mjs/e2e-voice.mjs do.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER_PORT = 8789; // distinct from e2e-mp.mjs (8787) and e2e-voice.mjs (8788)
const WEB_PORT = 4175;
const ORIGIN = `http://localhost:${WEB_PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'blava-e2e-social-'));
const DB = path.join(tmp, 'e2e.db');
const procs = new Set();
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e-social]', ...a);
function check(ok, what) {
  if (ok) log('PASS', what);
  else {
    failures++;
    log('FAIL', what);
  }
  return ok;
}

function run(cmd, args, env = {}, name = cmd) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  procs.add(p);
  p.on('exit', () => procs.delete(p));
  return p;
}

function killTree(p, sig) {
  try {
    process.kill(-p.pid, sig);
  } catch {
    p.kill(sig);
  }
}

async function waitHttp(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + url);
}

async function waitFor(page, fn, arg, ms = 15000, what = 'condition') {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
    return true;
  } catch {
    log('timed out waiting for', what);
    return false;
  }
}

// tsx lives in server/node_modules; run it from server/. Supabase is always off here (empty secret
// key, no URL): this phase never writes activity/reports to the real project.
function startServer() {
  const p = spawn('node', ['node_modules/.bin/tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      ALLOWED_ORIGINS: ORIGIN,
      DB_PATH: DB,
      E2E: '1',
      MAP_PATH: path.join(ROOT, 'public/data/bratislava.json'),
      SUPABASE_URL: '',
      SUPABASE_SECRET_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[server] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  procs.add(p);
  p.on('exit', () => procs.delete(p));
  return p;
}

function chromePath() {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const cand = path.join(base, 'chromium-1194/chrome-linux/chrome');
  return existsSync(cand) ? cand : undefined;
}

async function openPlayer(browser, token, nick, hash, errors) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 }, permissions: ['microphone'] });
  await ctx.addInitScript(
    ([token, nick]) => localStorage.setItem('blava-city-online-id', JSON.stringify({ token, nick })),
    [token, nick],
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${nick}: ${e.message}`));
  page.on('console', (m) => {
    // refused sockets are expected while another page's server-restart-free run settles
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g|WebSocket connection to/.test(m.text())) errors.push(`${nick}: ${m.text()}`);
  });
  await page.goto(`${ORIGIN}/${hash}`);
  return page;
}

/** online, and seeing at least n other players' figures */
const online = (page, n) =>
  waitFor(
    page,
    (n) => {
      const h = window.game?.host;
      return h?.mode === 'net' && h.status.state === 'online' && h.peds.filter((p) => p.playerId && p.playerId !== h.me.id).length >= n;
    },
    n,
    20000,
    `online with ${n} other player(s)`,
  );

/** records every GlobalEvent/PrivateEvent this page receives into window.__ge / window.__pe, so
 *  scenarios can assert on the exact event (e.g. raceResult, dailySolved) instead of only its side
 *  effects. Pure test-side instrumentation: it wraps two methods at runtime in this Playwright page,
 *  nothing shipped to real players. */
async function instrument(page) {
  await page.evaluate(() => {
    const w = window, g = w.game;
    w.__ge = [];
    w.__pe = [];
    const origGlobal = g.events.global.bind(g.events);
    g.events.global = (e) => {
      w.__ge.push(e);
      return origGlobal(e);
    };
    const origToPlayer = g.events.toPlayer.bind(g.events);
    g.events.toPlayer = (pid, e) => {
      if (pid === g.host.me.id) w.__pe.push(e);
      return origToPlayer(pid, e);
    };
  });
}

/** a point `d` metres from (tx,ty), on a clear line of sight, for a page to walk to and shoot from */
async function findApproachSpot(page, tx, ty, d, tries = 16) {
  return page.evaluate(
    ({ tx, ty, d, tries }) => {
      const g = window.game;
      for (let k = 0; k < tries; k++) {
        const a = (k / tries) * Math.PI * 2;
        const x = tx + Math.cos(a) * d, y = ty + Math.sin(a) * d;
        if (g.world.collideCircle(x, y, 0.5) || g.world.raycast(x, y, tx, ty) < 1 || g.world.inWater(x, y, 0)) continue;
        return { x, y };
      }
      return null;
    },
    { tx, ty, d, tries },
  );
}

/** walk the local player to (x,y) in steps the server's checkMove accepts (as e2e-phase2/3.mjs do) */
async function walkTo(page, x, y, maxSteps = 240) {
  for (let i = 0; i < maxSteps; i++) {
    const d = await page.evaluate(
      ({ x, y }) => {
        const p = window.game.player;
        const dx = x - p.x, dy = y - p.y, dd = Math.hypot(dx, dy);
        const s = Math.min(dd, 0.35);
        if (dd > 0.01) {
          p.x += (dx / dd) * s;
          p.y += (dy / dd) * s;
        }
        return dd;
      },
      { x, y },
    );
    if (d < 0.05) return true;
    await sleep(50);
  }
  return false;
}

/** fire `shots` pistol rounds at a player id, regardless of what happens to them (friendly-fire check) */
async function shootAt(shooterPage, targetId, shots = 4) {
  for (let i = 0; i < shots; i++) {
    const pos = await shooterPage.evaluate((id) => {
      const g = window.game;
      const t = g.host.peds.find((q) => q.playerId === id);
      if (!t) return null;
      g.player.weapon = 'pistol';
      return g.worldToScreen(t.x, t.y);
    }, targetId);
    if (!pos) break;
    await shooterPage.mouse.move(pos.x, pos.y);
    await shooterPage.mouse.down();
    await sleep(60);
    await shooterPage.mouse.up();
    await sleep(450);
  }
}

/** fire one shot at a time, stopping the moment the victim leaves 'play' (downed): a further hit
 *  while downed is a finishing blow (Sim.hurtPlayer), which would defeat the revive scenario */
async function downPlayer(shooterPage, targetId, getVictimState, maxShots = 14) {
  let fired = 0;
  for (let i = 0; fired < maxShots && i < 40; i++) {
    if ((await getVictimState()) !== 'play') break;
    const pos = await shooterPage.evaluate((id) => {
      const g = window.game, h = g.host, p = g.player;
      const t = h.peds.find((q) => q.playerId === id);
      if (!t) return null;
      // the shared traceShot hits whichever ped the ray meets first: a wandering civilian standing
      // between the shooter and the target (crowded near the main square) would absorb every shot
      // instead. Skip firing while one is in the way and let the crowd move on.
      const dTarget = Math.hypot(t.x - p.x, t.y - p.y);
      const lx = t.x - p.x, ly = t.y - p.y, len2 = lx * lx + ly * ly || 1;
      for (const q of h.peds) {
        if (q === t || q.playerId === h.me.id || Math.hypot(q.x - p.x, q.y - p.y) >= dTarget) continue;
        const proj = ((q.x - p.x) * lx + (q.y - p.y) * ly) / len2;
        if (proj < 0 || proj > 1) continue;
        const cx = p.x + lx * proj, cy = p.y + ly * proj;
        if (Math.hypot(q.x - cx, q.y - cy) < (q.r ?? 0.34) + 0.3) return 'blocked';
      }
      g.player.weapon = 'pistol';
      return g.worldToScreen(t.x, t.y);
    }, targetId);
    if (pos === 'blocked') {
      await sleep(300); // let the crowd shuffle, then try again (doesn't count against maxShots)
      continue;
    }
    if (!pos) break;
    fired++;
    await shooterPage.mouse.move(pos.x, pos.y);
    await shooterPage.mouse.down();
    await sleep(60);
    await shooterPage.mouse.up();
    await sleep(450);
  }
}

/** two distinct parked, undamaged, level-0 vehicles at most maxD apart, for the race challenge */
async function findClosePairOfCars(page, maxD) {
  return page.evaluate((maxD) => {
    const cars = window.game.host.vehicles.filter((v) => v.parked && !v.wrecked && v.level === 0);
    let best = null;
    for (let i = 0; i < cars.length; i++)
      for (let j = i + 1; j < cars.length; j++) {
        const d = Math.hypot(cars[i].x - cars[j].x, cars[i].y - cars[j].y);
        if (d <= maxD && (!best || d < best.d)) best = { d, a: { id: cars[i].id, x: cars[i].x, y: cars[i].y }, b: { id: cars[j].id, x: cars[j].x, y: cars[j].y } };
      }
    return best;
  }, maxD);
}

async function teleportTo(page, x, y, wait = 300) {
  await page.evaluate(({ x, y }) => window.game.host.conn.send({ t: 'debug', teleport: [x, y] }), { x, y });
  if (wait) await sleep(wait);
}

/** teleport next to a specific vehicle and get in, retrying (with a fresh teleport each time) in case
 *  the first attempt's landing spot ended up just outside enterVehicle's range */
async function enterCar(page, x, y, vid, tries = 3) {
  let entered = false;
  for (let i = 0; i < tries && !entered; i++) {
    await teleportTo(page, x, y);
    await page.evaluate((id) => {
      const v = window.game.host.vehicles.find((x) => x.id === id);
      if (v) window.game.host.requestEnter(v);
    }, vid);
    entered = await waitFor(page, (id) => window.game.player.vehicle?.id === id, vid, 3000, 'to enter a car');
  }
  return entered;
}

/** bring every page within a few metres of the main square, on foot (a debug teleport always exits
 *  any vehicle first): world events and races can otherwise leave A and B far apart */
async function regroup(pages) {
  const main = await pages[0].evaluate(() => {
    const l = window.game.world.landmark('main');
    return window.game.world.walkableNear(l.x, l.y);
  });
  for (let i = 0; i < pages.length; i++) {
    const a = (i / pages.length) * Math.PI * 2;
    await teleportTo(pages[i], main.x + Math.cos(a) * 3, main.y + Math.sin(a) * 3, 0);
  }
  await sleep(400);
}

async function runScenario(name, fn) {
  log(`--- ${name} ---`);
  try {
    await fn();
  } catch (e) {
    check(false, `${name} threw: ${e.message}`);
    console.error(e);
  }
}

// ==================================================================================== scenario 1
/** A mints an invite; B joins from the link, spawns near A, shares a party (roster + pt); friendly
 *  fire between them is off. Returns B (opened here, since its first navigation must be the link). */
async function scenarioInvite({ A, browser, errors }) {
  await A.evaluate(() => window.game.host.conn.send({ t: 'partyInvite' }));
  const gotInvite = await waitFor(A, () => !!window.game.host.live.party?.invite, null, 5000, 'A to receive an invite code');
  const code = gotInvite ? await A.evaluate(() => window.game.host.live.party.invite) : null;
  check(!!code, `A minted a party invite code${code ? ` (${code})` : ''}`);

  const aPos = await A.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y }));
  const hash = code ? `#join=e2e-${code}` : '#online';
  const B = await openPlayer(browser, '72727272-7272-4272-8272-bbbbbbbbbbbb', 'Beta', hash, errors);
  check(await online(B, 1), 'B is online and sees A');
  await instrument(B);
  if (!code) return B; // nothing more to check without a code: B still exists for later scenarios

  const joined = await waitFor(B, () => !!window.game.host.live.party, null, 5000, 'B to join the party from the link');
  check(joined, 'B joined the party from the invite link');
  if (!joined) return B;

  const bPos = await B.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y }));
  const d = Math.hypot(bPos.x - aPos.x, bPos.y - aPos.y);
  check(d <= 20, `B spawned within ~20 m of A (${d.toFixed(1)} m)`);

  const aId = await A.evaluate(() => window.game.host.me.id);
  const bId = await B.evaluate(() => window.game.host.me.id);
  await waitFor(A, (bId) => (window.game.host.net.roster.find((r) => r[0] === bId)?.[7] ?? 0) > 0, bId, 3000, "A's roster to show B in a party");
  const [rowA, rowB, tags] = await A.evaluate(
    ([aId, bId]) => {
      const roster = window.game.host.net.roster;
      return [roster.find((r) => r[0] === aId) ?? null, roster.find((r) => r[0] === bId) ?? null, [...window.game.host.live.partyTags.entries()]];
    },
    [aId, bId],
  );
  const sharedParty = !!rowA && !!rowB && rowA[7] > 0 && rowA[7] === rowB[7];
  check(sharedParty, `both roster rows share a partyId (A=${rowA?.[7]}, B=${rowB?.[7]})`);
  const tag = sharedParty ? tags.find(([id]) => id === rowA[7]) : null;
  check(!!tag, `the roster's pt carries the party tag${tag ? ` ([${tag[1].tag}] ${tag[1].color})` : ''}`);

  // friendly fire: A empties a clip into B; no damage, same party
  await A.evaluate(() => window.game.host.conn.send({ t: 'debug', give: 'pistol' }));
  await B.evaluate(() => window.game.host.conn.send({ t: 'debug', hp: 100 }));
  await sleep(300);
  const bPos2 = await B.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y }));
  const spot = await findApproachSpot(A, bPos2.x, bPos2.y, 4);
  if (!check(!!spot, 'found a spot for A to shoot B from')) return B;
  await walkTo(A, spot.x, spot.y);
  await sleep(300);
  const hpBefore = await B.evaluate(() => window.game.player.health);
  await shootAt(A, bId, 4);
  await sleep(500);
  const hpAfter = await B.evaluate(() => window.game.player.health);
  check(hpAfter === hpBefore, `friendly fire is off: B took no damage from A (${hpBefore} -> ${hpAfter})`);
  return B;
}

// ==================================================================================== scenario 2
/** A downs C (debug hp:1 then a lethal pistol hit — SimOptions.downed turns it into a down, not a
 *  kill, same as server/test/room.test.ts's Revive suite); B, uninvolved in the hit, stands next to
 *  C for 3 s and revives them for the $100 "Dobrý samaritán" bonus. */
async function scenarioRevive({ A, B, C }) {
  await C.evaluate(() => window.game.host.conn.send({ t: 'debug', hp: 1 }));
  await A.evaluate(() => window.game.host.conn.send({ t: 'debug', give: 'pistol' }));
  await sleep(300);

  const cId = await C.evaluate(() => window.game.host.me.id);
  const cPos = await C.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y }));
  // close range (not just <45 m weapon range): keeps the pistol's random spread from being enough to
  // clear C's hit radius, since only one shot needs to land while C has 1 hp
  const spot = await findApproachSpot(A, cPos.x, cPos.y, 2.5);
  if (!check(!!spot, 'found a spot for A to shoot C from')) return;
  await walkTo(A, spot.x, spot.y);
  await sleep(500); // let the camera settle after walking: the click angle is derived from it

  await downPlayer(A, cId, () => C.evaluate(() => window.game.state));
  const downed = await waitFor(C, () => window.game.state === 'downed', null, 4000, 'C to be downed by A');
  check(downed, 'a lethal hit downed C instead of killing them');
  if (!downed) return;

  const bSpot = (await findApproachSpot(B, cPos.x, cPos.y, 1.2)) ?? cPos;
  await walkTo(B, bSpot.x, bSpot.y);
  const bMoneyBefore = await B.evaluate(() => window.game.save.money);
  await sleep(3800); // > REVIVE_TIME (3 s) of continuous proximity within REVIVE_RANGE (2 m)

  const revived = await waitFor(C, () => window.game.state === 'play', null, 3000, 'C to be revived back to play');
  check(revived, "B revived C (C's state is back to play)");
  const bMoneyAfter = await B.evaluate(() => window.game.save.money);
  check(bMoneyAfter - bMoneyBefore === 100, `B got the $100 Samaritan bonus (+$${bMoneyAfter - bMoneyBefore})`);
}

// ==================================================================================== scenario 3
/** debug{event:'kofolka'} reaches every page through wev; A teleports to the van, waits out the 30 s
 *  announce phase, enters it, and earns roughly $10/s out of the pot. */
async function scenarioKofolka({ A, B, C }) {
  let entry = null;
  for (let attempt = 0; attempt < 3 && !entry; attempt++) {
    await A.evaluate(() => window.game.host.conn.send({ t: 'debug', event: 'kofolka' }));
    const got = await waitFor(A, () => window.game.host.live.events.some((e) => e.kind === 'kofolka'), null, 6000, 'the kofolka event to appear in wev');
    if (got) entry = await A.evaluate(() => window.game.host.live.events.find((e) => e.kind === 'kofolka'));
  }
  if (!check(!!entry, 'a kofolka world event started')) return;

  for (const [name, pg] of [['A', A], ['B', B], ['C', C]]) {
    const got = await waitFor(pg, () => window.game.host.live.events.some((e) => e.kind === 'kofolka'), null, 5000, `${name} to see the kofolka wev entry`);
    check(got, `${name} received the kofolka world event via wev`);
  }

  // wait out the 30 s announce phase from wherever A already is: parking a pedestrian at the van's
  // curbside spot for 30 s risks getting clipped by passing traffic and shoved off it, so don't stand
  // there for it — teleport in only once it's actually time to get in (the van is parked, stationary).
  const live = await waitFor(A, () => window.game.host.live.events.find((e) => e.kind === 'kofolka')?.phase === 'live', null, 35000, 'the kofolka event to reach its live phase');
  check(live, 'the kofolka event went live after its announce phase');
  if (!live) return;

  // the van sits outside A's 300 m snapshot interest radius until A is teleported close to it (the
  // wev entry's x/y are always known, regardless of range; the van itself, parked, never moves)
  const vid = entry.vid;
  let entered = false;
  for (let attempt = 0; attempt < 3 && !entered; attempt++) {
    await teleportTo(A, entry.x, entry.y, 300);
    const gotVan = await waitFor(A, (vid) => window.game.host.vehicles.some((v) => v.id === vid), vid, 3000, 'the Kofolka van to enter snapshot range');
    if (!gotVan) continue;
    await A.evaluate((vid) => {
      const v = window.game.host.vehicles.find((x) => x.id === vid);
      if (v) window.game.host.requestEnter(v);
    }, vid);
    entered = await waitFor(A, (vid) => window.game.player.vehicle?.id === vid, vid, 3000, 'A to enter the Kofolka van');
  }
  if (!check(entered, 'A entered the Kofolka van')) return;

  const before = await A.evaluate(() => window.game.save.money);
  await sleep(5000);
  const after = await A.evaluate(() => window.game.save.money);
  const gained = after - before;
  check(gained >= 20 && gained <= 60, `A's money rose roughly $10/s while driving the van (+$${gained} over 5 s)`);
}

// ==================================================================================== scenario 4
/** A and B, each in a car within a few metres of the other, challenge and accept; both get race
 *  state; teleporting A to the destination after the countdown wins the race and its stake. */
async function scenarioRace({ A, B }) {
  await regroup([A, B]);
  await A.evaluate(() => window.game.host.conn.send({ t: 'debug', money: 1000 }));
  await B.evaluate(() => window.game.host.conn.send({ t: 'debug', money: 1000 }));
  await sleep(300);

  let pair = null;
  for (const d of [5, 6, 7, 8, 8, 8]) {
    pair = await findClosePairOfCars(A, d);
    if (pair) break;
    await sleep(500);
  }
  if (!check(!!pair, `found two parked cars close together${pair ? ` (${pair.d.toFixed(1)} m apart)` : ''}`)) return;

  const [aIn, bIn] = await Promise.all([enterCar(A, pair.a.x, pair.a.y, pair.a.id), enterCar(B, pair.b.x, pair.b.y, pair.b.id)]);
  if (!check(aIn && bIn, 'A and B are each in a car, close together')) return;

  const bId = await B.evaluate(() => window.game.host.me.id);
  await A.evaluate((bid) => window.game.host.challenge(bid), bId);
  const gotChallenge = await waitFor(B, () => !!window.game.host.live.challenge, null, 5000, 'B to receive the race challenge');
  if (!check(gotChallenge, 'B received the challenge')) return;
  const fromId = await B.evaluate(() => window.game.host.live.challenge.from);
  await B.evaluate((from) => window.game.host.challengeAnswer(from, true), fromId);

  const gotRaceA = await waitFor(A, () => !!window.game.host.live.race, null, 5000, 'A to get race state');
  const gotRaceB = await waitFor(B, () => !!window.game.host.live.race, null, 5000, 'B to get race state');
  if (!check(gotRaceA && gotRaceB, 'both A and B got race state')) return;

  const dest = await A.evaluate(() => {
    const r = window.game.host.live.race;
    return r && { x: r.x, y: r.y };
  });
  if (!check(!!dest, 'the race carries a destination')) return;

  await sleep(3500); // outlast the 3 s countdown: moving during it is a false start (a forfeit)
  const moneyBefore = await A.evaluate(() => window.game.save.money);
  await teleportTo(A, dest.x, dest.y, 500);
  const gotResult = await waitFor(A, () => window.__ge.some((e) => e.k === 'raceResult'), null, 5000, 'the raceResult event to reach A');
  check(gotResult, 'A got the raceResult event');
  const moneyAfter = await A.evaluate(() => window.game.save.money);
  check(moneyAfter > moneyBefore, `A received the stake payout (+$${moneyAfter - moneyBefore})`);
  const cleared = await waitFor(A, () => !window.game.host.live.race, null, 3000, "the race state to clear");
  check(cleared, 'race state cleared for both players after finishing');
}

// ==================================================================================== scenario 5
/** Reuses A4's scripts/e2e-voice.mjs approach verbatim: the fake-media Chromium flags, the server's
 *  e2e override of voice_requires_account, and the client's window.__voiceE2E guest bypass. */
async function enableVoice(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('#voice-mode-btn:not(.hidden)', { timeout: 10000 });
  await page.evaluate(() => {
    window.__voiceE2E = true;
  });
  await page.click('#voice-mode-btn');
  const modal = await page.waitForSelector('.kit-modal', { timeout: 5000 }).catch(() => null);
  if (modal) await page.click('.kit-modal button.primary');
  await page.keyboard.press('Escape');
}
const voicePeerIds = (page) => page.evaluate(() => window.game.features.find((f) => f.id === 'voice').client.peerIds());
const voiceConnectionState = (page, id) => page.evaluate((id) => window.game.features.find((f) => f.id === 'voice').client.connectionState(id), id);

async function scenarioVoice({ A, B }) {
  await regroup([A, B]); // world-event/race teleports can leave A and B beyond the 45 m voice pairing radius
  const aId = await A.evaluate(() => window.game.host.me.id);
  const bId = await B.evaluate(() => window.game.host.me.id);

  await enableVoice(A);
  await enableVoice(B);

  const gotPeersA = await waitFor(A, (bId) => window.game.features.find((f) => f.id === 'voice').client.peerIds().includes(bId), bId, 15000, 'A to see B as a voice peer');
  const gotPeersB = await waitFor(B, (aId) => window.game.features.find((f) => f.id === 'voice').client.peerIds().includes(aId), aId, 15000, 'B to see A as a voice peer');
  check(gotPeersA, `A received voicePeers naming B (${JSON.stringify(await voicePeerIds(A))})`);
  check(gotPeersB, `B received voicePeers naming A (${JSON.stringify(await voicePeerIds(B))})`);

  // VoiceClient.poll() tears down a peer stuck connecting past CONNECT_TIMEOUT_MS (10 s) and only
  // retries it after RETRY_BACKOFF_MS (60 s) — an occasional stalled first attempt (ICE hiccups happen
  // under headless Chromium) is otherwise indistinguishable from a real failure to a short-timeout
  // check. Wait long enough to see that self-healing retry through, not just the first attempt.
  const CONNECT_WAIT_MS = 80_000;
  const connectedA = await waitFor(
    A, (bId) => window.game.features.find((f) => f.id === 'voice').client.connectionState(bId) === 'connected', bId, CONNECT_WAIT_MS, "A's peer connection to reach 'connected'",
  );
  check(connectedA, `A's RTCPeerConnection to B is connected (state: ${await voiceConnectionState(A, bId)})`);
  const connectedB = await waitFor(
    B, (aId) => window.game.features.find((f) => f.id === 'voice').client.connectionState(aId) === 'connected', aId, CONNECT_WAIT_MS, "B's peer connection to reach 'connected'",
  );
  check(connectedB, `B's RTCPeerConnection to A is connected (state: ${await voiceConnectionState(B, aId)})`);

  // best-effort, informational only (see e2e-voice.mjs: headless audio can be flaky independent of signalling)
  if (connectedA && connectedB) {
    await B.bringToFront();
    await B.keyboard.down('KeyV');
    await sleep(3000);
    const micB = await B.evaluate(() => window.game.features.find((f) => f.id === 'voice').client.micLevel());
    const levelA = await A.evaluate((bId) => window.game.features.find((f) => f.id === 'voice').client.speakingLevel(bId), bId);
    await B.keyboard.up('KeyV');
    log(`(informational) B's own mic level while holding V: ${micB}; A's received audioLevel from B: ${levelA}`);
  }
}

// ==================================================================================== scenario 6
/** debug{daily:{x,y,r}} at A's own position reveals the puzzle there and then, for everyone; A is
 *  already standing on it, so holding still for a moment past SOLVE_HOLD_S wins it. */
async function scenarioDaily({ A, B, C }) {
  await A.evaluate(() => {
    if (window.game.player.vehicle) window.game.host.requestExit();
  });
  await sleep(300);
  const spot = await A.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y }));
  await A.evaluate(({ x, y }) => window.game.host.conn.send({ t: 'debug', daily: { x, y, r: 6 } }), spot);

  for (const [name, pg] of [['A', A], ['B', B], ['C', C]]) {
    const got = await waitFor(pg, () => !!window.game.host.live.daily, null, 5000, `${name} to see the wev.daily card`);
    check(got, `${name} sees the daily puzzle card`);
  }

  const before = await A.evaluate(() => window.game.save.money);
  await sleep(1800); // > SOLVE_HOLD_S (1 s) with margin
  const solved = await waitFor(A, () => !!window.game.host.live.daily?.solvedBy, null, 4000, 'A to solve the daily spot');
  check(solved, 'A solved the daily spot standing on it');
  const after = await A.evaluate(() => window.game.save.money);
  check(after - before === 1000, `A won the $1000 daily reward (+$${after - before})`);
  const gotEvent = await waitFor(A, () => window.__ge.some((e) => e.k === 'dailySolved'), null, 3000, 'the dailySolved event to reach A');
  check(gotEvent, 'A received the dailySolved event');
}

// ======================================================================================== main
async function main() {
  if (!process.env.E2E_SKIP_BUILD) {
    log('building client…');
    execSync('npx vite build', { cwd: ROOT, stdio: 'inherit', env: { ...process.env, VITE_SERVER_URL: `ws://localhost:${SERVER_PORT}` } });
  }
  const server = startServer();
  await waitHttp(`http://localhost:${SERVER_PORT}/healthz`);
  run('npx', ['vite', 'preview', '--port', String(WEB_PORT), '--strictPort'], {}, 'preview');
  await waitHttp(ORIGIN);
  log('server + preview up');

  const browser = await chromium.launch({
    executablePath: chromePath(),
    args: [
      '--use-gl=swiftshader',
      '--use-fake-ui-for-media-stream', // auto-grants the mic permission prompt (scenario 5)
      '--use-fake-device-for-media-stream', // a synthesized tone stands in for the microphone
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const errors = [];

  const A = await openPlayer(browser, '71717171-7171-4171-8171-aaaaaaaaaaaa', 'Adam', '#online', errors);
  check(await online(A, 0), 'A is online');
  await instrument(A);

  let B, C;
  await runScenario('invite link', async () => {
    B = await scenarioInvite({ A, browser, errors });
  });
  if (!B) B = await openPlayer(browser, '72727272-7272-4272-8272-bbbbbbbbbbbb', 'Beta', '#online', errors); // last-resort fallback

  C = await openPlayer(browser, '73737373-7373-4373-8373-cccccccccccc', 'Cyril', '#online', errors);
  check(await online(C, 1), 'C is online');
  await instrument(C);

  await runScenario('revive', () => scenarioRevive({ A, B, C }));
  await runScenario('kofolka', () => scenarioKofolka({ A, B, C }));
  await runScenario('race', () => scenarioRace({ A, B }));
  await runScenario('voice', () => scenarioVoice({ A, B }));
  await runScenario('daily', () => scenarioDaily({ A, B, C }));

  check(errors.length === 0, `no page errors${errors.length ? ':\n  ' + errors.slice(0, 10).join('\n  ') : ''}`);
  await browser.close();
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(() => {
    for (const p of procs) killTree(p, 'SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
    log(failures ? `${failures} FAILED` : 'ALL PASSED');
    process.exit(failures ? 1 : 0);
  });
