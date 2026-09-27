// End-to-end check of pausing, leaving and coming back online (docs/plans/pause-resume.md): starts the
// real game server (E2E=1, Supabase off) and a production client build, then drives two headless
// Chromium pages through the pause menu (away, then shielded, as the other player sees it), leaving
// the city, "Pokračovať online", a reload, a hidden page and the idle timeout.
//
//   node scripts/e2e-presence.mjs
//   E2E_PHASE=presence npm run e2e     (see scripts/e2e-mp.mjs, which delegates here)
//   E2E_SKIP_BUILD=1 node scripts/e2e-presence.mjs
//
// Uses playwright-core with the preinstalled Chromium, the same way the other e2e scripts do.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER_PORT = 8793; // distinct from the other e2e scripts (8787-8792)
const WEB_PORT = 4179;
const ORIGIN = `http://localhost:${WEB_PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'blava-e2e-presence-'));
const DB = path.join(tmp, 'e2e.db');
const procs = new Set();
let failures = 0;
/** roster flags (src/shared/net/protocol.ts) */
const ROSTER_AWAY = 8;
const ROSTER_SHIELD = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e-presence]', ...a);
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

async function openPlayer(browser, token, nick, errors) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  await ctx.addInitScript(([token, nick]) => localStorage.setItem('blava-city-online-id', JSON.stringify({ token, nick })), [token, nick]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${nick}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g|WebSocket connection to/.test(m.text())) errors.push(`${nick}: ${m.text()}`);
  });
  await page.goto(`${ORIGIN}/#online`);
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
/** the roster flags B's client has for player `id` */
const flagsOn = (page, id, mask, want, ms, what) =>
  waitFor(page, ([id, mask, want]) => !!((window.game.host.net.roster.find((r) => r[0] === id)?.[8] ?? 0) & mask) === want, [id, mask, want], ms, what);
const goneFrom = (page, id, ms, what) => waitFor(page, (id) => !window.game.host.net.roster.some((r) => r[0] === id), id, ms, what);

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
  const A = await openPlayer(browser, '81818181-8181-4181-8181-aaaaaaaaaaaa', 'Adam', errors);
  const B = await openPlayer(browser, '82828282-8282-4282-8282-bbbbbbbbbbbb', 'Beta', errors);
  check(await online(A, 1), 'A is online and sees B');
  check(await online(B, 1), 'B is online and sees A');
  check(A.url().endsWith('#online'), `the address keeps #online while playing (${A.url()})`);
  // A's player id: a new one each time the server builds a fresh session for A (after leaving)
  let aId = await A.evaluate(() => window.game.host.me.id);

  // -------------------------------------------------------------- the pause menu: away, then safe
  await A.bringToFront();
  await A.keyboard.press('Escape');
  check(await waitFor(A, () => !document.getElementById('pause').classList.contains('hidden'), null, 3000, 'the pause menu'), 'Esc opens the pause menu');
  check(await waitFor(A, () => document.getElementById('pause-note').textContent.includes('Mesto beží ďalej'), null, 3000, 'the note'), 'the menu says the city keeps going');
  check(await flagsOn(B, aId, ROSTER_AWAY, true, 5000, 'A away'), 'B sees A away (⏸)');
  check(await flagsOn(B, aId, ROSTER_SHIELD, true, 8000, 'A shielded'), 'B sees A shielded (🛡) a few seconds later');
  check(
    await waitFor(A, () => window.game.host.shielded && document.getElementById('pause-note').textContent.includes('V menu si v bezpečí'), null, 3000, "A's note"),
    "A's menu says they're safe",
  );
  await A.click('#btn-resume');
  check(await flagsOn(B, aId, ROSTER_AWAY | ROSTER_SHIELD, false, 5000, 'A back'), '"Pokračovať": B sees A back, no longer shielded');

  // -------------------------------------------------------------- leaving, and one click back
  const before = await A.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y }));
  await A.keyboard.press('Escape');
  check((await A.textContent('#btn-quit')) === 'Odísť z mesta', 'online, the menu button reads "Odísť z mesta"');
  await A.click('#btn-quit');
  check(await waitFor(A, () => [...document.querySelectorAll('.kit-modal h2')].some((h) => h.textContent === 'Odísť z mesta?'), null, 3000, 'the confirmation'), 'leaving asks first, saying what it keeps');
  await A.click('.kit-modal button.primary');
  check(await goneFrom(B, aId, 4000, 'A to leave'), 'B sees A leave at once');
  check(await waitFor(A, () => !!window.game && !document.getElementById('menu').classList.contains('hidden'), null, 20000, 'the menu'), 'A lands on the main menu');
  check(A.url() === `${ORIGIN}/`, `…with #online gone from the address (${A.url()})`);
  const menu = await A.evaluate(() => ({ label: document.getElementById('btn-online').textContent, first: document.querySelector('#menu .buttons').firstElementChild.id }));
  check(menu.label.startsWith('Pokračovať online'), `the menu offers "${menu.label}"`);
  check(menu.first === 'btn-online', 'first in the menu, since online is what A played last');
  await A.click('#btn-online');
  check(await online(A, 1), 'one click: A is back online (no chooser)');
  aId = await A.evaluate(() => window.game.host.me.id);
  const back = await A.evaluate(() => ({ resumed: window.game.host.resumed, x: window.game.player.x, y: window.game.player.y }));
  check(back.resumed === 'saved', `the server restored A's last session (resumed: ${back.resumed})`);
  const moved = Math.hypot(back.x - before.x, back.y - before.y);
  check(moved < 5, `A is back where they left (${moved.toFixed(1)} m away)`);

  // -------------------------------------------------------------- a reload goes straight back in
  await A.reload();
  check(await online(A, 1), 'a reload goes straight back online');
  check((await A.evaluate(() => window.game.host.me.id)) === aId, '…with the same player id (the session was still in the city)');
  const reloaded = await A.evaluate(() => ({ resumed: window.game.host.resumed, menu: !document.getElementById('menu').classList.contains('hidden') }));
  check(reloaded.resumed === 'live' && !reloaded.menu, `…as the same figure, no menu in between (resumed: ${reloaded.resumed})`);

  // -------------------------------------------------------------- a hidden page, then the idle timeout
  await A.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check(await waitFor(A, () => window.game.paused && !document.getElementById('pause').classList.contains('hidden'), null, 3000, 'the auto-pause'), 'a hidden page opens the pause menu');
  check(await flagsOn(B, aId, ROSTER_AWAY, true, 5000, 'A away (hidden)'), 'B sees A away');
  await A.evaluate(() => window.game.host.conn.send({ t: 'debug', presence: { idle_min: 0.1 } })); // 6 s, for the test
  check(
    await waitFor(A, () => [...document.querySelectorAll('.kit-modal h2')].some((h) => h.textContent === 'Bol si dlho preč'), null, 20000, 'the idle dialog'),
    'away too long: A is moved out and offered the way back',
  );
  check(await goneFrom(B, aId, 4000, 'A to be moved out'), 'B sees A leave the city');
  await A.click('.kit-modal button.primary');
  check(await online(A, 1), '"Vrátiť sa do mesta": A is back online');
  check((await A.evaluate(() => window.game.host.resumed)) === 'saved', "…from A's saved session");
  await A.evaluate(() => window.game.host.conn.send({ t: 'debug', presence: { idle_min: 15 } }));

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
