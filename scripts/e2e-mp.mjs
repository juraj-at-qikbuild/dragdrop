// End-to-end multiplayer check: starts the game server and a production build of the client, then
// drives several headless Chromium pages through the Online flow and asserts what each one sees.
//
//   npm run e2e                 (builds the client with VITE_SERVER_URL pointing at the test server)
//   E2E_SKIP_BUILD=1 npm run e2e
//
// Uses playwright-core with the preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH) or E2E_CHROMIUM.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER_PORT = 8787;
const WEB_PORT = 4173;
const ORIGIN = `http://localhost:${WEB_PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'blava-e2e-'));
const DB = path.join(tmp, 'e2e.db');
const procs = new Set();
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);
function check(ok, what) {
  if (ok) log('PASS', what);
  else {
    failures++;
    log('FAIL', what);
  }
}

function run(cmd, args, env = {}, name = cmd) {
  // own process group, so killing it also kills what npx spawns underneath
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

// tsx lives in server/node_modules; run it from server/
function startServer() {
  const p = spawn('node', ['node_modules/.bin/tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(SERVER_PORT), ALLOWED_ORIGINS: ORIGIN, DB_PATH: DB, E2E: '1', MAP_PATH: path.join(ROOT, 'public/data/bratislava.json') },
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
  await ctx.addInitScript(
    ([token, nick]) => {
      if (token) localStorage.setItem('blava-city-online-id', JSON.stringify({ token, nick }));
    },
    [token, nick],
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${nick}: ${e.message}`));
  page.on('console', (m) => {
    // refused sockets are expected while the test restarts the server
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g|WebSocket connection to/.test(m.text())) errors.push(`${nick}: ${m.text()}`);
  });
  await page.goto(token ? `${ORIGIN}/#online` : ORIGIN);
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
/** the mirror of another player's figure, as {x, y, dead} */
const mirrorOf = (page, pid) =>
  page.evaluate((pid) => {
    const p = window.game.host.peds.find((q) => q.playerId === pid);
    return p ? { x: p.vehicle ? p.vehicle.x : p.x, y: p.vehicle ? p.vehicle.y : p.y, dead: p.dead } : null;
  }, pid);

async function main() {
  if (!process.env.E2E_SKIP_BUILD) {
    log('building client…');
    execSync('npx vite build', { cwd: ROOT, stdio: 'inherit', env: { ...process.env, VITE_SERVER_URL: `ws://localhost:${SERVER_PORT}` } });
  }
  let server = startServer();
  await waitHttp(`http://localhost:${SERVER_PORT}/healthz`);
  run('npx', ['vite', 'preview', '--port', String(WEB_PORT), '--strictPort'], {}, 'preview');
  await waitHttp(ORIGIN);
  log('server + preview up');

  const browser = await chromium.launch({ executablePath: chromePath(), args: ['--use-gl=swiftshader', '--mute-audio'] });
  const errors = [];
  const A = await openPlayer(browser, '11111111-1111-4111-8111-aaaaaaaaaaaa', 'Anna', errors);
  const B = await openPlayer(browser, '22222222-2222-4222-8222-bbbbbbbbbbbb', 'Boris', errors);

  check(await online(A, 1), 'A is online and sees one other player');
  check(await online(B, 1), 'B is online and sees one other player');

  // A walks right for a second; B's mirror of A must follow
  const aId = await A.evaluate(() => window.game.host.me.id);
  const before = await mirrorOf(B, aId);
  await A.bringToFront();
  await A.keyboard.down('KeyD');
  await sleep(1200);
  await A.keyboard.up('KeyD');
  await sleep(600);
  const after = await mirrorOf(B, aId);
  const moved = Math.hypot(after.x - before.x, after.y - before.y);
  check(moved > 3, `B sees A move (${moved.toFixed(1)} m)`);

  if (process.env.E2E_SHOTS) {
    await B.screenshot({ path: path.join(process.env.E2E_SHOTS, 'b-sees-a.png') });
    await A.screenshot({ path: path.join(process.env.E2E_SHOTS, 'a-sees-b.png') });
  }
  const aPos = await A.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y }));
  const err = Math.hypot(after.x - aPos.x, after.y - aPos.y);
  check(err < 1.5, `B's mirror of A matches A's own position (${err.toFixed(2)} m off)`);

  // phase-specific checks
  const phase = Number(process.env.E2E_PHASE ?? 1);
  if (phase >= 2) await import('./e2e-phase2.mjs').then((m) => m.run({ A, B, check, log, sleep, waitFor }));

  // server restart (fly deploy): both clients reconnect by themselves
  log('restarting server…');
  killTree(server, 'SIGTERM');
  await new Promise((r) => server.once('exit', r));
  await sleep(500);
  server = startServer();
  await waitHttp(`http://localhost:${SERVER_PORT}/healthz`);
  check(await online(A, 1), 'A reconnected after a server restart');
  check(await online(B, 1), 'B reconnected after a server restart');
  if (phase >= 3) await import('./e2e-phase3.mjs').then((m) => m.afterRestart({ A, B, check, log, sleep, waitFor }));

  // offline play is untouched: no socket, local NPCs
  const C = await openPlayer(browser, null, 'Offline', errors);
  await waitFor(C, () => !document.getElementById('menu')?.classList.contains('hidden'), null, 20000, 'menu');
  await C.click('#btn-new');
  await sleep(3000);
  const off = await C.evaluate(() => ({ online: !!window.game.online, peds: window.game.peds.length }));
  check(!off.online && off.peds > 50, `offline game has no connection and ${off.peds} peds`);

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
