// Visual regression check for rendering changes: renders the same fixed scenes from two builds and
// compares the screenshots pixel by pixel. Each page runs deterministically: Math.random is seeded,
// requestAnimationFrame and the clock are driven by hand at a fixed 60 Hz, so both builds simulate and
// draw exactly the same frames.
//   node scripts/visual-diff.mjs <baseline dist dir> <candidate dist dir> [out dir]
//   VDIFF_SCENES=day,night   only these scenes
// Prints per scene the largest channel difference, the mean, and how many pixels differ by more than
// 2, 8 and 32 (of 255); writes both screenshots and an amplified difference image to the out dir.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [baseDir, candDir, outArg] = process.argv.slice(2);
if (!baseDir || !candDir) {
  console.log('usage: node scripts/visual-diff.mjs <baseline dist> <candidate dist> [out dir]');
  process.exit(2);
}
const OUT = path.resolve(outArg ?? 'visual-diff');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// as in bench-render.mjs; frames: how many 60 Hz frames to run after moving there
const SCENES = [
  { name: 'day', t: 12, x: -346.9, y: -261.9 },
  { name: 'night-rain', t: 22, rain: 1, x: -346.9, y: -261.9 },
  { name: 'dusk-rain', t: 19.5, rain: 0.6, x: -156.6, y: -700, zoom: 0.7 },
  { name: 'zoomed-out', t: 12, x: -346.9, y: -261.9, zoom: 0.55 },
  { name: 'morning-car', t: 8, x: -309.2, y: -60.2, car: true },
  { name: 'phone-night', t: 21, x: -309.2, y: -60.2, viewport: { width: 412, height: 915 }, dpr: 2.625, touch: true },
  { name: 'hidpi-dusk', t: 18.3, x: -156.6, y: -507.7, viewport: { width: 1280, height: 720 }, dpr: 2 },
];
const only = process.env.VDIFF_SCENES?.split(',');
const scenes = only ? SCENES.filter((s) => only.includes(s.name)) : SCENES;

const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
const exe = path.join(base, 'chromium-1194/chrome-linux/chrome');

function deterministic() {
  let s = 20260928;
  Math.random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let now = 1000;
  const q = [];
  const t0 = Date.parse('2026-09-28T12:00:00Z');
  performance.now = () => now;
  Date.now = () => t0 + now;
  window.requestAnimationFrame = (cb) => (q.push(cb), q.length);
  window.cancelAnimationFrame = () => {};
  window.__pump = (n) => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      for (const cb of q.splice(0)) cb(now);
    }
  };
  try {
    localStorage.setItem('blava-city-quality', 'high');
  } catch {
    /* ignore */
  }
}

async function shoot(browser, url, sc, file) {
  const ctx = await browser.newContext({ viewport: sc.viewport ?? { width: 960, height: 600 }, deviceScaleFactor: sc.dpr ?? 1, hasTouch: !!sc.touch, isMobile: !!sc.touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(deterministic);
  const q = new URLSearchParams({ t: String(sc.t), freeze: '1', ...(sc.rain ? { rain: String(sc.rain) } : {}), ...(sc.touch ? { touch: '1' } : {}) });
  await page.goto(`${url}/?${q}`);
  await page.waitForFunction(() => window.game && !document.getElementById('menu')?.classList.contains('hidden'), null, { timeout: 30000, polling: 100 });
  await page.evaluate(() => window.__pump(5));
  await page.click('#btn-new');
  await page.waitForFunction(() => window.game?.state === 'play', null, { timeout: 30000, polling: 100 });
  await page.evaluate(() => window.__pump(30));
  await page.evaluate((sc) => {
    const g = window.game;
    g.qualityPref = 'high';
    g.player.x = sc.x;
    g.player.y = sc.y;
    if (sc.car) {
      let best = null, bd = 1e9;
      for (const v of g.vehicles) if (!v.driver && v.parked && !v.spec.twoWheeler && !v.spec.boat) {
        const d = Math.hypot(v.x - sc.x, v.y - sc.y);
        if (d < bd) (bd = d), (best = v);
      }
      if (best) {
        g.player.x = best.x + Math.sin(best.angle) * 2;
        g.player.y = best.y - Math.cos(best.angle) * 2;
      }
    }
    g.cam.x = g.player.x;
    g.cam.y = g.player.y;
    if (sc.zoom) g.zoomPref = sc.zoom;
    g.prewarm();
  }, sc);
  if (sc.car) {
    await page.keyboard.press('KeyF');
  }
  await page.evaluate(() => window.__pump(120));
  await sleep(300);
  const png = await page.screenshot({ type: 'png', timeout: 180000 });
  writeFileSync(file, png);
  const state = await page.evaluate(() => {
    const g = window.game;
    return { peds: g.host.peds.length, cars: g.host.vehicles.length, x: +g.player.x.toFixed(3), y: +g.player.y.toFixed(3), scale: +g.cam.scale.toFixed(4), tier: g.qualityTier, inCar: !!g.player.vehicle };
  });
  await ctx.close();
  return { png, state, errors };
}

// compares two PNGs in a page (no PNG decoder needed in node); returns stats and an amplified diff image
async function compare(browser, a, b) {
  const page = await browser.newPage();
  const r = await page.evaluate(
    async ([a, b]) => {
      const load = (src) => new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = src;
      });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: [ia.width, ia.height, ib.width, ib.height] };
      const W = ia.width, H = ia.height;
      const px = (im) => {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const x = c.getContext('2d');
        x.drawImage(im, 0, 0);
        return x.getImageData(0, 0, W, H).data;
      };
      const da = px(ia), db = px(ib);
      const out = document.createElement('canvas');
      out.width = W;
      out.height = H;
      const oc = out.getContext('2d');
      const od = oc.createImageData(W, H);
      let max = 0, sum = 0, n2 = 0, n8 = 0, n32 = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        if (d > max) max = d;
        sum += d;
        if (d > 2) n2++;
        if (d > 8) n8++;
        if (d > 32) n32++;
        const v = Math.min(255, d * 8);
        od.data[i] = v;
        od.data[i + 1] = d > 32 ? 0 : v;
        od.data[i + 2] = d > 32 ? 0 : v;
        od.data[i + 3] = 255;
      }
      oc.putImageData(od, 0, 0);
      const N = W * H;
      return { W, H, max, mean: sum / N, pct2: (100 * n2) / N, pct8: (100 * n8) / N, pct32: (100 * n32) / N, diff: out.toDataURL('image/png') };
    },
    [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`],
  );
  await page.close();
  return r;
}

const servers = [];
const serve = (dir, port) => {
  const p = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort', '--outDir', path.resolve(dir)], { cwd: ROOT, stdio: 'ignore', detached: true });
  servers.push(p);
  return `http://localhost:${port}`;
};
try {
  const urlA = serve(baseDir, 4181), urlB = serve(candDir, 4182);
  for (const u of [urlA, urlB])
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(u + '/');
        break;
      } catch {
        await sleep(200);
      }
    }
  const browser = await chromium.launch({ executablePath: existsSync(exe) ? exe : undefined, args: ['--use-gl=swiftshader', '--mute-audio'] });
  let worst = 0;
  for (const sc of scenes) {
    const A = await shoot(browser, urlA, sc, path.join(OUT, `${sc.name}-a.png`));
    const B = await shoot(browser, urlB, sc, path.join(OUT, `${sc.name}-b.png`));
    const same = JSON.stringify(A.state) === JSON.stringify(B.state);
    const r = await compare(browser, A.png, B.png);
    if (r.diff) writeFileSync(path.join(OUT, `${sc.name}-diff.png`), Buffer.from(r.diff.split(',')[1], 'base64'));
    worst = Math.max(worst, r.max ?? 255);
    console.log(
      `${sc.name.padEnd(12)} max ${String(r.max).padStart(3)}  mean ${r.mean?.toFixed(4)}  >2: ${r.pct2?.toFixed(3)}%  >8: ${r.pct8?.toFixed(3)}%  >32: ${r.pct32?.toFixed(3)}%` +
        (same ? '' : `  STATE DIFFERS a=${JSON.stringify(A.state)} b=${JSON.stringify(B.state)}`) +
        (r.sizeMismatch ? ` SIZE ${r.sizeMismatch}` : ''),
    );
    for (const e of [...A.errors, ...B.errors]) console.log('  page error:', e);
  }
  await browser.close();
  console.log(`worst max diff ${worst}; images in ${OUT}`);
} finally {
  for (const p of servers)
    try {
      process.kill(-p.pid);
    } catch {
      /* ignore */
    }
}
