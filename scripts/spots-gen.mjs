// Generates daily "Kde to je?" puzzles (docs/plans/social-events.md): drives a headless Chromium
// page in ?photo mode to list and render candidate spots (src/shared/world/spots.ts,
// src/game/features/PhotoMode.ts), then either uploads them to Supabase or, with --dry, writes a
// local contact sheet to review instead.
//
//   node scripts/spots-gen.mjs --days 30 [--from YYYY-MM-DD] [--seed N] [--dry]
//
// --days N        how many days to generate (default 30)
// --from DATE     first day, YYYY-MM-DD (default: the day after the latest daily_spots row, or
//                 tomorrow — Bratislava's "tomorrow" — when there is none / Supabase is unset)
// --seed N        candidateSpots' seed (default: a hash of --from, so re-running the same range is
//                 reproducible but a later batch naturally gets a fresh set of spots)
// --dry           write images + an index.html contact sheet to .cache/spots/ instead of uploading;
//                 never touches Supabase writes (a read to skip existing days still happens if
//                 credentials are set, so a dry run previews exactly what a real run would add)
//
// Never prints the secret key. Never runs the real upload itself — see docs/plans/social-events.md
// ("the architect reviews your dry-run images and runs it").
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SPOTS_GEN_PORT) || 4195;
const DRY_DIR = path.join(ROOT, '.cache', 'spots');
const SPOT_KINDS = ['courtyard', 'crossing', 'passage', 'square', 'river', 'roof']; // src/shared/world/spots.ts's SPOT_KINDS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------------------------------- args
function parseArgs(argv) {
  const out = { days: 30, from: null, seed: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--dry') out.dry = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(out.days) || out.days < 1) throw new Error('--days must be a positive integer');
  if (out.from && !/^\d{4}-\d{2}-\d{2}$/.test(out.from)) throw new Error('--from must be YYYY-MM-DD');
  return out;
}
const args = parseArgs(process.argv.slice(2));

// ------------------------------------------------------------------------------------------ env
// Never logged: only the URL (a project ref, not a secret), day strings, HTTP statuses and counts go
// to stdout below.
const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.GTA_BRATISKA_SUPABASE_URL ?? process.env.GTA_BRATISKA_SUPABASE_PROJECT_URL ?? '').replace(/\/+$/, '');
const SECRET = process.env.SUPABASE_SECRET_KEY ?? process.env.GTA_BRATISKA_SUPABASE_SECRET_KEY ?? '';
const supaEnabled = !!SUPABASE_URL && !!SECRET;

// --------------------------------------------------------------------- Bratislava date/time helpers
// Mirrors server/src/features/dailyTime.ts (tested there — see its DST note): this is a plain .mjs
// script with no TypeScript loader, so it keeps its own copy rather than importing across that
// build boundary (scripts/supa-check.mjs does the same for server/src/config.ts's env resolution).
function bratislavaOffsetMinutes(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Bratislava', timeZoneName: 'shortOffset' }).formatToParts(new Date(ms));
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+1');
  if (!m) return 60;
  const sign = m[1].startsWith('-') ? -1 : 1;
  return parseInt(m[1], 10) * 60 + sign * (m[2] ? parseInt(m[2], 10) : 0);
}
function bratislavaReveal18(day) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 18, 0, 0);
  return new Date(guess - bratislavaOffsetMinutes(guess) * 60_000).toISOString();
}
function bratislavaDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function addDays(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}
/** small deterministic string hash, for the --seed default (see the header comment) */
function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// --------------------------------------------------------------------------------------- Supabase
async function supaGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}${pathAndQuery}`, { headers: { apikey: SECRET } });
  if (!res.ok) throw new Error(`GET ${pathAndQuery} failed: ${res.status}`);
  return res.json();
}
async function supaInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SECRET, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`insert ${table} failed: ${res.status} ${await res.text()}`);
}
async function supaUpload(imagePath, buf) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/spots/${imagePath}`, {
    method: 'POST',
    headers: { apikey: SECRET, 'Content-Type': 'image/webp', 'x-upsert': 'false' },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload ${imagePath} failed: ${res.status} ${await res.text()}`);
}
async function dayExists(table, day) {
  const rows = await supaGet(`/rest/v1/${table}?day=eq.${day}&select=day&limit=1`);
  return rows.length > 0;
}

// ------------------------------------------------------------------------------------- day picking
/** the day after the latest daily_spots row, or Bratislava's tomorrow when there is none/no Supabase */
async function defaultFrom() {
  const tomorrow = addDays(bratislavaDay(Date.now()), 1);
  if (!supaEnabled) return tomorrow;
  const rows = await supaGet('/rest/v1/daily_spots?select=day&order=day.desc&limit=1');
  return rows[0] ? addDays(rows[0].day, 1) : tomorrow;
}

/** one spot per day, cycling the starting kind so consecutive days differ; within a kind, spots.ts
 *  already interleaves the three boroughs, so this also rotates districts for free */
function pickPerDay(candidates, from, days) {
  const byKind = new Map(SPOT_KINDS.map((k) => [k, candidates.filter((c) => c.kind === k)]));
  const picks = [];
  let day = from;
  for (let i = 0; i < days; i++) {
    let spot = null;
    for (let t = 0; t < SPOT_KINDS.length && !spot; t++) {
      const pool = byKind.get(SPOT_KINDS[(i + t) % SPOT_KINDS.length]);
      if (pool.length) spot = pool.shift();
    }
    if (!spot) break; // every pool exhausted: fewer candidates than days asked for
    picks.push({ day, spot });
    day = addDays(day, 1);
  }
  return picks;
}

// ------------------------------------------------------------------------------------------- main
async function run(cmd, cmdArgs) {
  await new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(' ')} exited ${code}`))));
  });
}

async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.log('dist/ missing, building…');
    await run('npm', ['run', 'build']);
  }

  const from = args.from ?? (await defaultFrom());
  const seed = args.seed ?? hashSeed(from);
  console.log(`spots-gen: ${args.days} day(s) from ${from}, seed ${seed}${args.dry ? ' (dry run)' : ''}`);
  console.log(supaEnabled ? `Supabase: ${SUPABASE_URL}` : 'Supabase: not configured (dry-only)');
  if (!args.dry && !supaEnabled) throw new Error('no Supabase URL/secret key configured: pass --dry, or set SUPABASE_URL and SUPABASE_SECRET_KEY');

  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
  const exe = process.env.PLAYWRIGHT_BROWSERS_PATH ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : '/opt/pw-browsers/chromium';
  let browser;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://localhost:${PORT}/`);
        break;
      } catch {
        await sleep(200);
      }
    }
    browser = await chromium.launch({ executablePath: existsSync(exe) ? exe : undefined, args: ['--use-gl=swiftshader', '--mute-audio'] });
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    await page.goto(`http://localhost:${PORT}/?photo`);
    await page.waitForFunction(() => window.__photo?.ready === true, null, { timeout: 30_000 });

    const candidates = await page.evaluate(({ n, s }) => window.__photo.candidates(n, s), { n: args.days * 3, s: seed });
    const picks = pickPerDay(candidates, from, args.days);
    if (picks.length < args.days) console.log(`only found ${picks.length} usable spot(s) for ${args.days} requested day(s)`);

    let dryDir = null;
    const sheet = [];
    if (args.dry) {
      dryDir = DRY_DIR;
      rmSync(dryDir, { recursive: true, force: true });
      mkdirSync(dryDir, { recursive: true });
    }

    for (const { day, spot } of picks) {
      if (!args.dry && (await dayExists('daily_spots', day))) {
        console.log(`${day}: already exists, skipping`);
        continue;
      }
      const dataUrl = await page.evaluate((s) => window.__photo.render(s), spot);
      const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      const revealAt = bratislavaReveal18(day);
      const place = [spot.district, spot.quarter, spot.street].filter(Boolean).join(' / ');

      if (args.dry) {
        const file = `${day}-${spot.kind}.webp`;
        writeFileSync(path.join(dryDir, file), buf);
        sheet.push({ day, file, revealAt, ...spot });
        console.log(`${day}: ${spot.kind.padEnd(9)} ${place}`);
      } else {
        const imagePath = `${randomUUID()}.webp`;
        await supaUpload(imagePath, buf);
        await supaInsert('daily_spots', { day, image_path: imagePath, reveal_at: revealAt });
        await supaInsert('daily_spot_secrets', {
          day, x: spot.x, y: spot.y, level: spot.level, radius: 6, kind: spot.kind,
          hint_district: spot.district, hint_quarter: spot.quarter, hint_street: spot.street,
        });
        console.log(`${day}: ${spot.kind.padEnd(9)} ${place} — uploaded`);
      }
    }

    if (args.dry) writeContactSheet(dryDir, sheet);
  } finally {
    try {
      process.kill(-preview.pid, 'SIGKILL');
    } catch {
      preview.kill();
    }
    await browser?.close();
  }
}

function writeContactSheet(dir, rows) {
  const card = (r) => `
    <figure>
      <img src="${r.file}" alt="${r.kind}" loading="lazy">
      <figcaption>
        <strong>${r.day}</strong> · ${r.kind}<br>
        ${[r.district, r.quarter, r.street].filter(Boolean).join(' / ') || '(no hints)'}<br>
        <code>${r.x.toFixed(1)}, ${r.y.toFixed(1)} · lvl ${r.level}</code><br>
        <span class="reveal">reveal ${r.revealAt}</span>
      </figcaption>
    </figure>`;
  const html = `<!doctype html>
<html lang="sk"><head><meta charset="utf-8"><title>Kde to je? — dry run</title>
<style>
  body { margin: 0; padding: 24px; background: #17181c; color: #e8e6e1; font: 14px/1.4 system-ui, sans-serif; }
  h1 { font-size: 18px; font-weight: 700; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin-top: 16px; }
  figure { margin: 0; background: #23252b; border: 1px solid #34363d; border-radius: 8px; overflow: hidden; }
  img { display: block; width: 100%; aspect-ratio: 3/2; object-fit: cover; background: #000; }
  figcaption { padding: 8px 10px; }
  code { color: #9fb3c8; }
  .reveal { color: #8a8f98; }
</style></head>
<body>
  <h1>Kde to je? — ${rows.length} spot(s), dry run</h1>
  <div class="grid">${rows.map(card).join('')}</div>
</body></html>`;
  writeFileSync(path.join(dir, 'index.html'), html);
  console.log(`contact sheet: ${path.join(dir, 'index.html')}`);
}

await main();
