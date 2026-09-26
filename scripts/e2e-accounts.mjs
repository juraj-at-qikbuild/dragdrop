// End-to-end accounts check (docs/plans/social-events.md, D1) against the REAL Supabase project:
// creates one confirmed test user through the admin API, signs in by injecting its session the same
// way `src/net/auth.ts` persists one, and checks that account progress follows across devices, that a
// guest can claim into a fresh account exactly once, and that voice is refused for a guest. The test
// user is always deleted afterwards, even on failure.
//
//   GTA_BRATISKA_SUPABASE_SECRET_KEY=… GTA_BRATISKA_SUPABASE_PUBLISHABLE_KEY=… node scripts/e2e-accounts.mjs
//   E2E_PHASE=accounts npm run e2e     (see scripts/e2e-mp.mjs, which delegates here)
//
// The server always runs with SUPABASE_SECRET_KEY unset: it verifies tokens against the project's
// public JWKS, but writes no activity/reports rows. Chromium here doesn't trust this sandbox's HTTPS
// proxy CA (Node does), so every page's traffic to the Supabase project is relayed through Node's own
// fetch (page.route) instead of turning off TLS verification.
process.env.NODE_USE_ENV_PROXY = '1'; // this process's own admin/token-grant fetches need the sandbox's proxy
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PROJECT_URL = 'https://eejvrdvzteyrwlhjfnfx.supabase.co';
const PUBLISHABLE_KEY = process.env.GTA_BRATISKA_SUPABASE_PUBLISHABLE_KEY ?? '';
const SECRET_KEY = process.env.GTA_BRATISKA_SUPABASE_SECRET_KEY ?? '';
const SERVER_PORT = 8792; // distinct from e2e-mp.mjs/e2e-voice.mjs/e2e-social.mjs
const WEB_PORT = 4178;
const ORIGIN = `http://localhost:${WEB_PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'blava-e2e-accounts-'));
const DB = path.join(tmp, 'e2e.db');
const DIST = path.join(tmp, 'dist');
const procs = new Set();
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e-accounts]', ...a);
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

/** tsx lives in server/node_modules; run it from server/. `extraEnv.E2E` picks whether `debug`
 *  messages (money, teleport…) are accepted; everything else is identical between the two phases. */
function startServer(extraEnv) {
  const p = spawn('node', ['node_modules/.bin/tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      ALLOWED_ORIGINS: ORIGIN,
      DB_PATH: DB,
      MAP_PATH: path.join(ROOT, 'public/data/bratislava.json'),
      NODE_USE_ENV_PROXY: '1', // the JWKS fetch (server/src/auth.ts) needs the sandbox's proxy too
      SUPABASE_URL: PROJECT_URL,
      SUPABASE_SECRET_KEY: '', // never the real secret: no activity/reports rows are ever written
      ...extraEnv,
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

/** stop a server started with startServer() and wait for it to actually exit, so the next one can
 *  reuse SERVER_PORT right away */
async function stopServer(p) {
  killTree(p, 'SIGTERM');
  await new Promise((resolve) => {
    if (!procs.has(p)) return resolve();
    p.once('exit', resolve);
    setTimeout(resolve, 4000);
  });
}

function chromePath() {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const cand = path.join(base, 'chromium-1194/chrome-linux/chrome');
  return existsSync(cand) ? cand : undefined;
}

// -------------------------------------------------------------------------------- Supabase admin API
/** never logs `path`'s body, headers, or the response beyond a status code: those can carry secrets */
async function adminFetch(path, opts = {}) {
  const r = await fetch(PROJECT_URL + path, {
    ...opts,
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json };
}

/** one confirmed user, no email sent (email_confirm skips the confirmation mail entirely) */
async function createTestUser() {
  const suffix = randomBytes(6).toString('hex');
  const email = `e2e-${suffix}@example.com`;
  const password = randomBytes(18).toString('base64url') + 'Aa1!'; // long + varied: clears any password policy
  const nickname = `E2E${suffix.slice(0, 4)}`;
  const r = await adminFetch('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { nickname } }) });
  if (r.status < 200 || r.status >= 300 || !r.json?.id) throw new Error(`admin create user failed: HTTP ${r.status}`);
  return { id: r.json.id, email, password, nickname };
}

async function deleteTestUser(id) {
  if (!id) return;
  const r = await adminFetch(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
  log(r.status >= 200 && r.status < 300 ? 'deleted the test user' : `deleting the test user returned HTTP ${r.status}`);
}

/** the exact shape @supabase/auth-js persists under its storageKey (src/net/auth.ts: 'blava-city-auth') */
async function passwordGrantSession(email, password) {
  const r = await fetch(`${PROJECT_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await r.json();
  if (typeof json.access_token !== 'string') throw new Error(`password grant failed: HTTP ${r.status}`);
  return json;
}

// ------------------------------------------------------------------------------------------ pages
/** relays this context's Supabase traffic through Node's own fetch (which trusts the sandbox's proxy
 *  CA; Chromium here doesn't), so TLS verification stays on throughout — see the file header. */
async function relaySupabase(ctx) {
  await ctx.route(`${PROJECT_URL}/**`, async (route) => {
    const req = route.request();
    const headers = {};
    const h = req.headers();
    for (const k of ['apikey', 'authorization', 'content-type', 'x-client-info']) if (h[k]) headers[k] = h[k];
    try {
      const method = req.method();
      const body = method === 'GET' || method === 'HEAD' ? undefined : (req.postDataBuffer() ?? undefined);
      const resp = await fetch(req.url(), { method, headers, body });
      const buf = Buffer.from(await resp.arrayBuffer());
      const respHeaders = {};
      resp.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) respHeaders[k] = v;
      });
      await route.fulfill({ status: resp.status, headers: respHeaders, body: buf });
    } catch (e) {
      log('Supabase relay failed (not a TLS issue: this is Node itself):', e.message);
      await route.abort();
    }
  });
}

/** a fresh guest identity, optionally with a Supabase session pre-stashed (as a signed-in device would
 *  have it) and/or a pending claim flag, then navigated straight into online play. */
async function openAccountPage(browser, { nick = 'E2E', session = null, claimPending = false } = {}, errors) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  await relaySupabase(ctx);
  const token = randomUUID();
  await ctx.addInitScript(
    ([token, nick, session, claimPending]) => {
      // this also runs against the intermediate about:blank hop reloadOnline() uses to force a real
      // reload (see there): that document's storage access can throw, harmlessly for this script.
      try {
        localStorage.setItem('blava-city-online-id', JSON.stringify({ token, nick }));
        if (session) localStorage.setItem('blava-city-auth', JSON.stringify(session));
        if (claimPending) localStorage.setItem('blava-city-claim-pending', '1');
      } catch {
        /* about:blank (or similar): nothing to seed there anyway */
      }
    },
    [token, nick, session, claimPending],
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${nick}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g|WebSocket connection to/.test(m.text())) errors.push(`${nick}: ${m.text()}`);
  });
  await page.goto(`${ORIGIN}/#online`);
  return page;
}

/** reload the same page fresh into #online: how a real device picks up a just-added session (and any
 *  pending claim) — main.ts's onlineBoot path runs again from scratch, unlike a same-page reconnect */
async function reloadOnline(page, { session, claimPending } = {}) {
  if (session || claimPending) {
    await page.evaluate(
      ([session, claimPending]) => {
        if (session) localStorage.setItem('blava-city-auth', JSON.stringify(session));
        if (claimPending) localStorage.setItem('blava-city-claim-pending', '1');
      },
      [session ?? null, !!claimPending],
    );
  }
  // main.ts strips '#online' from the URL right after its first boot (history.replaceState), and
  // navigating to a URL that only differs by hash from the current one is a same-document
  // hash-only navigation in the browser — it fires hashchange but never re-runs boot(). Go via a
  // blank page first so the next goto is a genuine, fresh load.
  await page.goto('about:blank');
  await page.goto(`${ORIGIN}/#online`);
}

const online = (page) =>
  waitFor(
    page,
    () => {
      const h = window.game?.host;
      return h?.mode === 'net' && h.status.state === 'online';
    },
    null,
    20000,
    'online',
  );

async function instrumentPrivate(page) {
  await page.evaluate(() => {
    window.__pe = [];
    const g = window.game;
    const orig = g.events.toPlayer.bind(g.events);
    g.events.toPlayer = (pid, e) => {
      if (pid === g.host.me.id) window.__pe.push(e);
      return orig(pid, e);
    };
  });
}

// ============================================================================ account progress + claim
/** server started with E2E=1 (for the debug{money} shortcut only — voice isn't touched in this phase) */
async function scenarioAccountProgress({ browser, errors, user }) {
  const session = await passwordGrantSession(user.email, user.password);

  // 1) a guest earns some money, then claims it into the fresh account
  const p1 = await openAccountPage(browser, { nick: 'Guest1' }, errors);
  if (!check(await online(p1), 'guest device 1 is online')) return;
  await p1.evaluate(() => window.game.host.conn.send({ t: 'debug', money: 4242 }));
  check(await waitFor(p1, () => window.game.save.money === 4242, null, 3000, 'guest 1 to have $4242'), 'guest device 1 earned $4242 before claiming');
  const tokenBefore = await p1.evaluate(() => JSON.parse(localStorage.getItem('blava-city-online-id')).token);

  await reloadOnline(p1, { session, claimPending: true });
  if (!check(await online(p1), 'device 1 reconnected online after claiming')) return;
  const account1 = await p1.evaluate(() => window.game.host.net.account);
  check(account1, 'device 1 is now playing as the account, not a guest');
  const moneyAfterClaim = await p1.evaluate(() => window.game.save.money);
  check(moneyAfterClaim === 4242, `the claim moved the guest's $4242 into the fresh account (money=$${moneyAfterClaim})`);
  const tokenAfter = await p1.evaluate(() => JSON.parse(localStorage.getItem('blava-city-online-id')).token);
  check(tokenAfter !== tokenBefore, "the claimed device's guest token was rotated (server confirmed claimed=true)");
  await p1.close();

  // 2) claims exactly once: a second guest, with different money, claiming into the now-non-empty
  // account is refused — the account's own money must stay exactly what it was, not merged
  const p1b = await openAccountPage(browser, { nick: 'Guest2' }, errors);
  if (!check(await online(p1b), 'guest device 2 is online')) return;
  await p1b.evaluate(() => window.game.host.conn.send({ t: 'debug', money: 999 }));
  await waitFor(p1b, () => window.game.save.money === 999, null, 3000, 'guest 2 to have $999');
  await reloadOnline(p1b, { session, claimPending: true });
  if (!check(await online(p1b), 'device 2 reconnected online after its claim attempt')) return;
  const account1b = await p1b.evaluate(() => window.game.host.net.account);
  const moneyAfterSecondClaim = await p1b.evaluate(() => window.game.save.money);
  check(account1b && moneyAfterSecondClaim === 4242, `a second claim into a non-empty account is refused (still $${moneyAfterSecondClaim}, guest's $999 not merged)`);
  await p1b.close();

  // 3) progress follows: a third, never-before-seen guest token signs into the same account directly
  const p2 = await openAccountPage(browser, { nick: 'Guest3', session }, errors);
  if (!check(await online(p2), 'device 3 (a different guest token, signed in directly) is online')) return;
  const account2 = await p2.evaluate(() => window.game.host.net.account);
  const moneyOnP2 = await p2.evaluate(() => window.game.save.money);
  check(account2 && moneyOnP2 === 4242, `account progress followed to a second page with a different guest token (money=$${moneyOnP2})`);
  await p2.close();
}

// ==================================================================================== voice: guests
/** server started WITHOUT E2E, so RemoteConfig's e2e override never fires and voice_requires_account
 *  keeps its real (Supabase-unset) default of true — the one thing this phase needs a separate,
 *  non-debug server for (see the file's Implementation note in the report). */
async function scenarioVoiceGuestRefused({ browser, errors }) {
  const p = await openAccountPage(browser, { nick: 'GuestVoice' }, errors);
  if (!check(await online(p), 'guest is online (voice-refusal check)')) return;
  await instrumentPrivate(p);
  await p.evaluate(() => window.game.host.conn.send({ t: 'voice', on: true }));
  const refused = await waitFor(p, () => window.__pe.some((e) => e.k === 'msg' && /prihlásených/.test(e.text)), null, 3000, "the guest's voice refusal message");
  const text = refused ? await p.evaluate(() => window.__pe.find((e) => e.k === 'msg' && /prihlásených/.test(e.text)).text) : null;
  check(refused, `voice is refused for a guest with the server's private message${text ? ` ("${text}")` : ''}`);
  await p.close();
}

// ======================================================================================== main
async function main() {
  if (!SECRET_KEY || !PUBLISHABLE_KEY) {
    log('GTA_BRATISKA_SUPABASE_SECRET_KEY / GTA_BRATISKA_SUPABASE_PUBLISHABLE_KEY are not set in this environment; skipping.');
    return;
  }
  log('building client for the real Supabase project…');
  execSync('npx vite build --outDir ' + DIST + ' --emptyOutDir', {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_SERVER_URL: `ws://localhost:${SERVER_PORT}`, VITE_SUPABASE_URL: PROJECT_URL, VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY },
  });
  run('npx', ['vite', 'preview', '--outDir', DIST, '--port', String(WEB_PORT), '--strictPort'], {}, 'preview');
  await waitHttp(ORIGIN);

  const browser = await chromium.launch({ executablePath: chromePath(), args: ['--use-gl=swiftshader', '--mute-audio'] });
  const errors = [];
  let userId = null;
  try {
    log('creating one confirmed test user…');
    const user = await createTestUser();
    userId = user.id;

    let server = startServer({ E2E: '1' }); // debug{money} only; see the scenario's own comment
    await waitHttp(`http://localhost:${SERVER_PORT}/healthz`);
    log('server (E2E=1) up');
    await runScenario('account progress + claim', () => scenarioAccountProgress({ browser, errors, user }));
    await stopServer(server);

    server = startServer({}); // no E2E: the real voice_requires_account default applies
    await waitHttp(`http://localhost:${SERVER_PORT}/healthz`);
    log('server (no E2E) up');
    await runScenario('voice refused for a guest', () => scenarioVoiceGuestRefused({ browser, errors }));
    await stopServer(server);
  } finally {
    await deleteTestUser(userId);
  }

  check(errors.length === 0, `no page errors${errors.length ? ':\n  ' + errors.slice(0, 10).join('\n  ') : ''}`);
  await browser.close();
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
