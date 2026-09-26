// Verifies a deployed Supabase project matches supabase/migrations/20260926110000_social_events.sql:
// every table exists, RLS actually blocks anon from the secrets/activity/reports/config, the public
// bits are readable, the `spots` bucket is public but can't be listed, and the JWKS is ES256
// (docs/plans/social-events.md). Run after `supabase db push`: node scripts/supa-check.mjs
// Never prints key values — only the URL, table/column names, HTTP statuses and PostgREST error codes.
const URL = (process.env.SUPABASE_URL ?? process.env.GTA_BRATISKA_SUPABASE_URL ?? process.env.GTA_BRATISKA_SUPABASE_PROJECT_URL ?? '').replace(/\/+$/, '');
const SECRET = process.env.SUPABASE_SECRET_KEY ?? process.env.GTA_BRATISKA_SUPABASE_SECRET_KEY ?? '';
const PUBLISHABLE = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.GTA_BRATISKA_SUPABASE_PUBLISHABLE_KEY ?? '';
const TIMEOUT_MS = 10_000;

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** GET/POST `path`; `key` (may be '') goes in `apikey` only, same as the real server (server/src/supa.ts) */
async function req(path, key, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL + path, { ...init, headers: { ...(key && { apikey: key }), ...init.headers }, signal: ac.signal });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: res.ok, json };
  } catch (e) {
    return { status: 0, ok: false, json: undefined, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** the PostgREST error code in parens, if the body has one, for a short, secret-free detail string */
const errCode = (r) => (r.error ? `(${r.error})` : r.json?.code ? `(${r.json.code})` : '');

/** PostgREST refusing a role's privileges, whatever exact status/shape it comes back as */
const isDenied = (r) => r.status === 401 || r.status === 403 || (!r.ok && typeof r.json?.code === 'string');

async function main() {
  console.log(`supa-check: ${URL || '(no project URL configured)'}`);
  if (!URL) {
    check('a Supabase project URL is configured', false, 'set SUPABASE_URL, GTA_BRATISKA_SUPABASE_URL or GTA_BRATISKA_SUPABASE_PROJECT_URL');
    return finish();
  }

  // --------------------------------------------------------------------------------- with the secret key
  if (!SECRET) {
    check('secret key is set', false, 'GTA_BRATISKA_SUPABASE_SECRET_KEY / SUPABASE_SECRET_KEY missing: skipping the secret-key checks');
  } else {
    for (const t of ['daily_spots', 'daily_spot_secrets', 'activity', 'reports', 'game_config']) {
      const r = await req(`/rest/v1/${t}?select=*&limit=1`, SECRET);
      check(`table ${t} exists`, r.ok, `${r.status} ${errCode(r)}`.trim());
    }
    const cfg = await req('/rest/v1/game_config?select=key', SECRET);
    if (cfg.ok && Array.isArray(cfg.json)) {
      const have = new Set(cfg.json.map((row) => row.key));
      const want = ['voice_enabled', 'voice_requires_account', 'voice_blocklist', 'events'];
      const missing = want.filter((k) => !have.has(k));
      check('game_config has the 4 seeded keys', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : undefined);
    } else {
      check('game_config has the 4 seeded keys', false, 'game_config is not readable (see above)');
    }
  }

  // ---------------------------------------------------------------------------- with the publishable key
  if (!PUBLISHABLE) {
    check('publishable key is set', false, 'GTA_BRATISKA_SUPABASE_PUBLISHABLE_KEY / SUPABASE_PUBLISHABLE_KEY missing: skipping the publishable-key checks');
  } else {
    for (const t of ['daily_spot_secrets', 'activity', 'reports', 'game_config']) {
      const r = await req(`/rest/v1/${t}?select=*&limit=1`, PUBLISHABLE);
      check(`anon is denied ${t}`, isDenied(r), `${r.status} ${errCode(r)}`.trim());
    }
    const spots = await req('/rest/v1/daily_spots?select=*&limit=1', PUBLISHABLE);
    check('anon can read daily_spots (possibly empty)', spots.ok && Array.isArray(spots.json), `${spots.status} ${errCode(spots)}`.trim());

    const rpc = await req('/rest/v1/rpc/leaderboard_week', PUBLISHABLE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('rpc/leaderboard_week works for anon', rpc.ok && Array.isArray(rpc.json), `${rpc.status} ${errCode(rpc)}`.trim());
  }

  // ---------------------------------------------------------------------------------------- storage
  if (!SECRET) {
    check('spots bucket exists and is public', false, 'no secret key to check with');
  } else {
    const bucket = await req('/storage/v1/bucket/spots', SECRET);
    check('spots bucket exists and is public', bucket.ok && bucket.json?.public === true, `${bucket.status} ${errCode(bucket)}`.trim());
  }
  if (!PUBLISHABLE) {
    check('spots bucket cannot be listed by anon', false, 'no publishable key to check with');
  } else {
    const list = await req('/storage/v1/object/list/spots', PUBLISHABLE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 100 }) });
    const leaked = list.ok && Array.isArray(list.json) && list.json.length > 0;
    check('spots bucket cannot be listed by anon (empty list or an error, never names)', !leaked, leaked ? `leaked ${list.json.length} object name(s)` : `${list.status} ${errCode(list)}`.trim());
  }

  // ------------------------------------------------------------------------------------------- auth
  const jwks = await req('/auth/v1/.well-known/jwks.json', '');
  const keys = Array.isArray(jwks.json?.keys) ? jwks.json.keys : [];
  const es256 = jwks.ok && keys.some((k) => k.alg === 'ES256' || (k.kty === 'EC' && k.crv === 'P-256'));
  check('JWKS has an ES256 key', es256, `${jwks.status} ${errCode(jwks)}`.trim());

  finish();
}

function finish() {
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exitCode = failures ? 1 : 0;
}

await main();
