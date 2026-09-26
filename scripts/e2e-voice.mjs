// End-to-end proximity-voice check: starts the real game server (E2E=1) and a production client
// build, then drives two headless Chromium pages — each with a fake mic (a synthesized beep) — through
// enabling voice chat, and asserts the WebRTC mesh actually forms between them.
//
// No real accounts exist in this environment yet (server/src/auth.ts is I3's); this instead relies on
// the server's own e2e override of voice_requires_account (RemoteConfig.ts, gated on E2E=1) plus a
// narrow, explicitly-named `window.__voiceE2E` flag the client checks only to let a *guest* session
// through its own "accounts only" UI gate (src/game/features/voice/VoiceFeature.ts) — see the comment
// there. Neither exists (or does anything) for a real player.
//
//   node scripts/e2e-voice.mjs
//   E2E_SKIP_BUILD=1 node scripts/e2e-voice.mjs
//
// Uses playwright-core with the preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH) or E2E_CHROMIUM, the
// same way scripts/e2e-mp.mjs does.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER_PORT = 8788; // distinct from e2e-mp.mjs's 8787, so both could run concurrently
const WEB_PORT = 4174;
const ORIGIN = `http://localhost:${WEB_PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'blava-e2e-voice-'));
const DB = path.join(tmp, 'e2e.db');
const procs = new Set();
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e-voice]', ...a);
function check(ok, what) {
  if (ok) log('PASS', what);
  else {
    failures++;
    log('FAIL', what);
  }
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
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 }, permissions: ['microphone'] });
  await ctx.addInitScript(
    ([token, nick]) => localStorage.setItem('blava-city-online-id', JSON.stringify({ token, nick })),
    [token, nick],
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${nick}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g|WebSocket connection to/.test(m.text())) errors.push(`${nick}: ${m.text()}`);
  });
  await page.goto(`${ORIGIN}/#online`);
  return page;
}

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

/** opens the pause menu, flips the e2e guest bypass, clicks the voice mode button once (off → ptt),
 *  then accepts the first-enable warning modal (VoiceFeature.showWarning) that follows */
async function enableVoice(page) {
  await page.keyboard.press('Escape'); // opens #pause (src/game/Game.ts: Escape/P toggles `paused`)
  await page.waitForSelector('#voice-mode-btn:not(.hidden)', { timeout: 10000 });
  await page.evaluate(() => {
    window.__voiceE2E = true;
  });
  await page.click('#voice-mode-btn');
  const modal = await page.waitForSelector('.kit-modal', { timeout: 5000 }).catch(() => null);
  if (modal) await page.click('.kit-modal button.primary'); // "Zapnúť"
  await page.keyboard.press('Escape'); // close #pause again; online play never actually freezes (Game.ts)
}

const peerIds = (page) =>
  page.evaluate(() => window.game.features.find((f) => f.id === 'voice').client.peerIds());

const connectionState = (page, id) =>
  page.evaluate((id) => window.game.features.find((f) => f.id === 'voice').client.connectionState(id), id);

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
      '--use-fake-ui-for-media-stream', // auto-grants the mic permission prompt
      '--use-fake-device-for-media-stream', // a synthesized beep tone stands in for the microphone
      '--autoplay-policy=no-user-gesture-required', // Playwright's evaluate()-driven flow isn't always seen as a gesture
    ],
  });
  const errors = [];
  const A = await openPlayer(browser, '44444444-4444-4444-8444-aaaaaaaaaaaa', 'Adam', errors);
  const B = await openPlayer(browser, '55555555-5555-4555-8555-bbbbbbbbbbbb', 'Beta', errors);

  check(await online(A, 1), 'A is online and sees one other player');
  check(await online(B, 1), 'B is online and sees one other player');

  const aId = await A.evaluate(() => window.game.host.me.id);
  const bId = await B.evaluate(() => window.game.host.me.id);

  await enableVoice(A);
  await enableVoice(B);

  const gotPeersA = await waitFor(A, (bId) => window.game.features.find((f) => f.id === 'voice').client.peerIds().includes(bId), bId, 15000, 'A to see B as a voice peer');
  const gotPeersB = await waitFor(B, (aId) => window.game.features.find((f) => f.id === 'voice').client.peerIds().includes(aId), aId, 15000, 'B to see A as a voice peer');
  check(gotPeersA, `A received voicePeers naming B (${JSON.stringify(await peerIds(A))})`);
  check(gotPeersB, `B received voicePeers naming A (${JSON.stringify(await peerIds(B))})`);

  const connectedA = await waitFor(
    A, (bId) => window.game.features.find((f) => f.id === 'voice').client.connectionState(bId) === 'connected', bId, 20000, "A's peer connection to reach 'connected'",
  );
  check(connectedA, `A's RTCPeerConnection to B is connected (state: ${await connectionState(A, bId)})`);
  const connectedB = await waitFor(
    B, (aId) => window.game.features.find((f) => f.id === 'voice').client.connectionState(aId) === 'connected', aId, 20000, "B's peer connection to reach 'connected'",
  );
  check(connectedB, `B's RTCPeerConnection to A is connected (state: ${await connectionState(B, aId)})`);

  // best-effort: real audio flowing (the fake device's beep, PTT held so the track isn't silenced) —
  // informative, not a hard requirement, since headless audio processing can be flaky independent of
  // the signalling/negotiation this script exists to check
  if (connectedA && connectedB) {
    await B.bringToFront();
    await B.keyboard.down('KeyV'); // push-to-talk: unmutes B's outgoing track
    await sleep(3000);
    const micB = await B.evaluate(() => window.game.features.find((f) => f.id === 'voice').client.micLevel());
    const levelA = await A.evaluate((bId) => window.game.features.find((f) => f.id === 'voice').client.speakingLevel(bId), bId);
    await B.keyboard.up('KeyV');
    log(`(informational) B's own local mic level while holding V: ${micB}; A's received audioLevel from B: ${levelA}`);
  }

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
