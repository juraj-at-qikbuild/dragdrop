// End-to-end check of the leaderboard (docs/plans/leaderboard.md): starts the real game server (E2E=1,
// Supabase off) and a production client build, then drives two headless Chromium pages: points for
// discovering Hlavné námestie on arrival, points pushed to the HUD, L opening the boards (and pausing,
// like the menu does), switching periods and boards, the pause menu's "Rebríček", and the city
// hearing about a new leader of the day.
//
//   node scripts/e2e-board.mjs
//   E2E_PHASE=board npm run e2e     (see scripts/e2e-mp.mjs, which delegates here)
//   E2E_SKIP_BUILD=1 node scripts/e2e-board.mjs
//   E2E_SHOTS=<dir> node scripts/e2e-board.mjs    (also saves screenshots of the panel there)
//
// Uses playwright-core with the preinstalled Chromium, the same way the other e2e scripts do.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER_PORT = 8794; // distinct from the other e2e scripts (8787-8793)
const WEB_PORT = 4180;
const ORIGIN = `http://localhost:${WEB_PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'blava-e2e-board-'));
const DB = path.join(tmp, 'e2e.db');
const SHOTS = process.env.E2E_SHOTS;
const procs = new Set();
let failures = 0;
/** the points for a landmark (src/shared/sim/rules/points.ts POINTS.landmark) */
const LANDMARK = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e-board]', ...a);
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

// tsx lives in server/node_modules; run it from server/. Supabase is always off here.
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

async function openPlayer(browser, token, nick, errors, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1100, height: 720 }, hasTouch: !!opts.touch, isMobile: !!opts.touch });
  await ctx.addInitScript(([token, nick]) => localStorage.setItem('blava-city-online-id', JSON.stringify({ token, nick })), [token, nick]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${nick}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g|WebSocket connection to/.test(m.text())) errors.push(`${nick}: ${m.text()}`);
  });
  await page.goto(`${ORIGIN}/${opts.touch ? '?touch=1' : ''}#online`);
  return page;
}

/** online (the connection up and the game running), seeing at least n other players' figures */
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
/** this page's own points, as the server last pushed them */
const score = (page) => page.evaluate(() => window.game.host.live.score);
const scoreIs = (page, d, what) => waitFor(page, (d) => window.game.host.live.score?.d === d, d, 8000, what);
/** the rows the open panel shows: [rank, nick, points, is me] */
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.kit-board-list li')].map((li) => [
      li.querySelector('.rank').textContent, li.querySelector('.nick').firstChild.textContent, li.querySelector('.pts').textContent, li.classList.contains('me'),
    ]),
  );
const rowsAre = (page, want, what) =>
  waitFor(
    page,
    (want) =>
      JSON.stringify([...document.querySelectorAll('.kit-board-list li')].map((li) => [li.querySelector('.nick').firstChild.textContent, li.querySelector('.pts').textContent])) ===
      JSON.stringify(want),
    want,
    6000,
    what,
  );
const panelOpen = (page) => page.evaluate(() => !!document.querySelector('.kit-board'));
const shot = async (page, name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, name) }));
const clickButton = (page, scope, label) =>
  page.evaluate(([scope, label]) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.includes(label))?.click(), [scope, label]);

async function main() {
  if (!process.env.E2E_SKIP_BUILD) {
    log('building client…');
    execSync('npx vite build', { cwd: ROOT, stdio: 'inherit', env: { ...process.env, VITE_SERVER_URL: `ws://localhost:${SERVER_PORT}` } });
  }
  startServer();
  await waitHttp(`http://localhost:${SERVER_PORT}/healthz`);
  run('npx', ['vite', 'preview', '--port', String(WEB_PORT), '--strictPort'], {}, 'preview');
  await waitHttp(ORIGIN);
  log('server + preview up');

  const browser = await chromium.launch({ executablePath: chromePath(), args: ['--use-gl=swiftshader', '--mute-audio'] });
  const errors = [];
  const A = await openPlayer(browser, '91919191-9191-4191-8191-aaaaaaaaaaaa', 'Adam', errors);
  const B = await openPlayer(browser, '92929292-9292-4292-8292-bbbbbbbbbbbb', 'Beta', errors, { touch: true, viewport: { width: 844, height: 390 } });
  check(await online(A, 1), 'A is online and sees B');
  check(await online(B, 1), 'B is online and sees A');

  // ------------------------------------------------------------- points arrive on their own
  check(await scoreIs(A, LANDMARK, 'A to discover Hlavné námestie'), `arriving on Hlavné námestie discovers it: +${LANDMARK} b, pushed to the HUD`);
  check(await scoreIs(B, LANDMARK, 'B too'), 'B too');
  await A.evaluate(() => window.game.host.conn.send({ t: 'debug', score: [120, 'courier'] }));
  check(await scoreIs(A, LANDMARK + 120, "A's delivery"), 'a delivery worth 120 b lands on A\'s total');
  const s = await score(A);
  check(s.r === 1 && s.n === 2 && s.w === LANDMARK + 120 && s.a === LANDMARK + 120, `A leads today (${JSON.stringify(s)})`);
  check(await waitFor(B, () => window.game.host.live.score?.r === 2, null, 15000, "B's rank"), 'B learns they are second now (ranks refresh when someone else scores)');
  check(
    await waitFor(B, () => JSON.stringify(window.game.banners).includes('Adam vedie dnešný rebríček'), null, 6000, 'the leader banner'),
    'B hears that Adam leads the day',
  );

  // ------------------------------------------------------------- L opens the boards
  await A.bringToFront();
  await A.keyboard.press('KeyL');
  check(await waitFor(A, () => !!document.querySelector('.kit-board'), null, 3000, 'the panel'), 'L opens the leaderboard');
  check(await A.evaluate(() => window.game.paused), '…and pauses, like the menu (online: away)');
  check(await rowsAre(A, [['Adam', '135'], ['Beta', '15']], 'the day board'), 'today: Adam 135, Beta 15');
  const r = await rows(A);
  check(r[0][0] === '🥇' && r[0][3] === true && r[1][3] === false, `a medal for first, and A's own row marked (${JSON.stringify(r)})`);
  const me = await A.evaluate(() => document.querySelector('.kit-board-me').textContent);
  check(me.includes('135 b · 1. z 2'), `the header has A's day, week and all-time totals (${me})`);
  await shot(A, 'board-day.png');
  await clickButton(A, '.kit-board-chips', 'Práca');
  check(await rowsAre(A, [['Adam', '120']], 'the jobs board'), 'the "Práca" board: only the delivery');
  await clickButton(A, '.kit-board-chips', 'Mesto');
  check(await rowsAre(A, [['Adam', '15'], ['Beta', '15']], 'the city board'), 'the "Mesto" board: both discovered the square');
  await clickButton(A, '.kit-board-tabs', 'Celkovo');
  check(await rowsAre(A, [['Adam', '15'], ['Beta', '15']], 'all-time city'), 'all time: the same so far');
  await clickButton(A, '.kit-board-chips', 'Závody');
  check(await waitFor(A, () => document.querySelector('.kit-board-empty')?.textContent.includes('Buď prvý'), null, 5000, 'the empty board'), 'an empty board says so');
  await clickButton(A, '.kit-board-chips', 'Spolu');
  await A.evaluate(() => document.querySelector('.kit-board-help summary').click());
  check(await A.evaluate(() => document.querySelectorAll('.kit-board-help li').length >= 8), '"Za čo sú body" lists what everything is worth');
  await shot(A, 'board-all.png');
  await A.keyboard.press('KeyL');
  check(await waitFor(A, () => !document.querySelector('.kit-board'), null, 3000, 'the panel to close'), 'L closes it again');
  check(!(await A.evaluate(() => window.game.paused)), '…and unpauses');

  // ------------------------------------------------------------- the pause menu's button (a phone)
  await B.bringToFront();
  await B.evaluate(() => window.game.setPaused(true));
  check(await waitFor(B, () => !document.getElementById('pause').classList.contains('hidden'), null, 3000, 'the pause menu'), 'B pauses');
  const btn = await B.evaluate(() => [...document.querySelectorAll('#pause-extra button')].some((b) => b.textContent.includes('Rebríček') && !b.classList.contains('hidden')));
  check(btn, 'the pause menu has "🏆 Rebríček" online');
  await clickButton(B, '#pause-extra', 'Rebríček');
  check(await waitFor(B, () => !!document.querySelector('.kit-board'), null, 3000, 'the panel'), 'it opens the leaderboard over the menu');
  check(await rowsAre(B, [['Adam', '135'], ['Beta', '15']], "B's day board"), 'B sees the same board');
  const modals = await B.evaluate(() => [...document.querySelectorAll('.kit-modal h2')].map((h) => h.textContent));
  check(modals.length === 1, `one panel, nothing else open under it (${JSON.stringify(modals)})`);
  await shot(B, 'board-phone.png');
  await B.keyboard.press('Escape');
  check(await waitFor(B, () => !document.querySelector('.kit-board'), null, 3000, 'the panel to close'), 'Esc closes it');
  check(await B.evaluate(() => window.game.paused && !document.getElementById('pause').classList.contains('hidden')), '…back to the pause menu, still paused');
  await B.evaluate(() => window.game.setPaused(false));
  await shot(B, 'hud-phone.png');
  await A.bringToFront();
  await shot(A, 'hud-desktop.png');

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
