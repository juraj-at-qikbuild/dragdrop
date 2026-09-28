// Frame-time benchmark: runs the built game in headless Chromium through a few fixed scenes (day, night
// in the rain, driving, zoomed out, a phone) and prints how long a frame's update and draw take, and
// each drawing pass's share. Run after `vite build`: node scripts/bench-render.mjs
//   BENCH_SECONDS=8     seconds measured per scene
//   BENCH_SCENES=day,night   only these scenes
//   BENCH_PROFILE=dir   also write a CPU profile per scene (.cpuprofile, for DevTools) and print the
//                       top functions by self time (build with `vite build --minify false` to read them)
//   BENCH_DIST=dir      serve this build instead of dist/
//   BENCH_JSON=file     write the results as JSON too
//   BENCH_RUNG=n        hold the Auto graphics setting on rung n of its ladder (src/game/QualityGovernor.ts)
//   BENCH_ABLATE=postfx,light,buildings,ground,hud,windows,weather,bridges,street,posts
//                       each scene again with one pass off: the drop in frame interval is what the pass
//                       costs, the GPU's raster included (headless Chromium draws with SwiftShader, a
//                       software GPU, so fill rate counts for a lot more than on a real one)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = Number(process.env.BENCH_PORT) || 4176;
const SECONDS = Number(process.env.BENCH_SECONDS) || 8;
const PROFILE = process.env.BENCH_PROFILE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// x, y: where the player stands (Hlavné námestie and round it: the densest old town); drive: moves the
// player along this heading (m/s) so the camera crosses the city; zoom: the wheel zoom (0.55 is the
// furthest out)
const SCENES = [
  { name: 'day', t: 12, x: -346.9, y: -261.9 },
  { name: 'night-rain', t: 22, rain: 1, x: -346.9, y: -261.9 },
  { name: 'drive', t: 17, x: -500, y: -262, drive: { vx: 14, vy: 0 } },
  { name: 'zoomed-out', t: 12, x: -346.9, y: -261.9, zoom: 0.55 },
  { name: 'dusk-drive', t: 19.5, rain: 0.6, x: -156.6, y: -700, drive: { vx: 3, vy: 14 }, zoom: 0.7 },
  { name: 'phone-night', t: 21, x: -309.2, y: -60.2, viewport: { width: 412, height: 915 }, dpr: 2.625, touch: true },
];
const only = process.env.BENCH_SCENES?.split(',');
let scenes = only ? SCENES.filter((s) => only.includes(s.name)) : SCENES;
if (process.env.BENCH_RUNG) scenes = scenes.map((s) => ({ ...s, name: `${s.name}-rung${process.env.BENCH_RUNG}`, rung: +process.env.BENCH_RUNG }));
// BENCH_ABLATE=postfx,light,...: each scene again with one of these passes turned off
const ablate = process.env.BENCH_ABLATE?.split(',');
// BENCH_BASE_ABLATE=postfx: these passes off in every run (the baseline too), e.g. to see the 2D passes'
// costs without the post-processing's
const baseOff = process.env.BENCH_BASE_ABLATE?.split(',') ?? [];
if (baseOff.length) scenes = scenes.map((s) => ({ ...s, name: `${s.name}-no-${baseOff.join('-')}`, ablate: baseOff }));
if (ablate) scenes = scenes.flatMap((s) => [s, ...ablate.map((k) => ({ ...s, name: `${s.name}-no-${k}`, ablate: [...(s.ablate ?? []), k] }))]);

const dist = process.env.BENCH_DIST ? path.resolve(process.env.BENCH_DIST) : path.join(ROOT, 'dist');
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', dist], { cwd: ROOT, stdio: 'ignore', detached: true });
const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
const exe = path.join(base, 'chromium-1194/chrome-linux/chrome');

// Wraps the draw passes in timers (in the page). Each frame's times go into window.__bench.frames.
function instrument() {
  const g = window.game;
  const B = (window.__bench = { frames: [], cur: null, on: false });
  const wrap = (obj, name, label) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const f = obj[name];
    obj[name] = function (...a) {
      if (!B.cur) return f.apply(this, a);
      const t0 = performance.now();
      try {
        return f.apply(this, a);
      } finally {
        B.cur[label] = (B.cur[label] || 0) + performance.now() - t0;
      }
    };
  };
  const r = g.renderer;
  for (const m of ['drawGround', 'drawPortals', 'drawBarriers', 'drawPosts', 'drawBuildings', 'drawNightWindows', 'emitLights', 'drawBridges', 'drawTrafficLights', 'emitTrafficLights', 'drawTunnelInterior'])
    wrap(r, m, 'r.' + m);
  wrap(r.street, 'drawLow', 'street.drawLow');
  wrap(r.street, 'update', 'street.update');
  wrap(g.light, 'begin', 'light.begin');
  wrap(g.light, 'composite', 'light.composite');
  wrap(g.postFx, 'render', 'postFx.render');
  wrap(g.weather, 'drawWorld', 'weather.drawWorld');
  wrap(g.weather, 'drawScreen', 'weather.drawScreen');
  wrap(g.weather, 'update', 'weather.update');
  wrap(g.fx, 'drawParticles', 'fx.drawParticles');
  wrap(g.fx, 'drawDecals', 'fx.drawDecals');
  wrap(g.fx, 'emitLights', 'fx.emitLights');
  wrap(g.fx, 'update', 'fx.update');
  wrap(g.hud, 'draw', 'hud.draw');
  wrap(g.banners, 'draw', 'banners.draw');
  wrap(g.pigeons, 'draw', 'pigeons.draw');
  wrap(g.pigeons, 'update', 'pigeons.update');
  wrap(g.bubbles, 'draw', 'bubbles.draw');
  wrap(g.missions, 'drawWorld', 'missions.drawWorld');
  wrap(g.entityFx, 'update', 'entityFx.update');
  wrap(g.host, 'update', 'host.update');
  wrap(g.atmos, 'update', 'atmos.update');
  wrap(g.touchUi, 'update', 'touchUi.update');
  for (const f of g.features) {
    const n = f.constructor?.name || 'feature';
    wrap(f, 'drawWorld', 'feat.' + n + '.drawWorld');
    wrap(f, 'drawHud', 'feat.' + n + '.drawHud');
    wrap(f, 'update', 'feat.' + n + '.update');
  }
  for (const m of ['drawSigns', 'drawLandmarks', 'drawPickups', 'drawPlayerMarker', 'emitAtmosphereLights', 'updateCamera'])
    wrap(g, m, 'g.' + m);
  // the frame: update then draw, as main.ts runs them
  const upd = g.update, drw = g.draw;
  let last = 0;
  g.update = function (dt) {
    const now = performance.now();
    if (B.on) {
      B.cur = { interval: last ? now - last : 0 };
      if (B.drive) {
        const p = g.player;
        p.x += B.drive.vx * dt;
        p.y += B.drive.vy * dt;
        if (p.vehicle) (p.vehicle.x = p.x), (p.vehicle.y = p.y);
      }
    }
    last = now;
    const t0 = performance.now();
    try {
      return upd.call(this, dt);
    } finally {
      if (B.cur) B.cur.update = performance.now() - t0;
    }
  };
  g.draw = function (hud) {
    const t0 = performance.now();
    try {
      return drw.call(this, hud);
    } finally {
      if (B.cur) {
        B.cur.draw = performance.now() - t0;
        B.frames.push(B.cur);
        B.cur = null;
      }
    }
  };
}

const stats = (xs) => {
  if (!xs.length) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
};
const f1 = (x) => x.toFixed(2).padStart(7);

// top functions by self time from a CDP profile
function topSelf(profile, n = 25) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
  const dt = new Map();
  for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) || 0) + (profile.timeDeltas[i] || 0));
  let total = 0;
  for (const [id, us] of dt) {
    const nd = byId.get(id);
    const cf = nd.callFrame;
    const key = `${cf.functionName || '(anon)'} ${cf.url ? path.basename(cf.url) : ''}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + us);
    total += us;
  }
  return { total: total / 1000, top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => ({ fn: k, ms: us / 1000, pct: (100 * us) / total })) };
}

const results = [];
try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://localhost:${PORT}/`);
      break;
    } catch {
      await sleep(200);
    }
  }
  const browser = await chromium.launch({ executablePath: existsSync(exe) ? exe : undefined, args: ['--use-gl=swiftshader', '--mute-audio', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
  for (const sc of scenes) {
    const ctx = await browser.newContext({ viewport: sc.viewport ?? { width: 1280, height: 720 }, deviceScaleFactor: sc.dpr ?? 1, hasTouch: !!sc.touch, isMobile: !!sc.touch });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      try {
        localStorage.setItem('blava-city-quality', 'high');
      } catch {
        /* ignore */
      }
    });
    const q = new URLSearchParams({ t: String(sc.t), freeze: '1', ...(sc.rain ? { rain: String(sc.rain) } : {}), ...(sc.touch ? { touch: '1' } : {}) });
    await page.goto(`http://localhost:${PORT}/?${q}`);
    await page.waitForFunction(() => !document.getElementById('menu')?.classList.contains('hidden'), null, { timeout: 30000 });
    await page.click('#btn-new');
    await page.waitForFunction(() => window.game?.state === 'play', null, { timeout: 30000 });
    await page.evaluate(instrument);
    await page.evaluate((sc) => {
      const g = window.game;
      g.qualityPref = 'high';
      // BENCH_RUNG=n: hold the Auto setting on this rung of its ladder (QualityGovernor)
      if (sc.rung !== undefined && g.governor) {
        g.qualityPref = 'auto';
        g.governor.rung = sc.rung;
        g.governor.sample = () => false;
      }
      g.player.x = sc.x;
      g.player.y = sc.y;
      g.cam.x = sc.x;
      g.cam.y = sc.y;
      if (sc.zoom) g.zoomPref = sc.zoom;
      g.prewarm();
      window.__bench.drive = sc.drive ?? null;
      // ablation: turn one pass off to see what it costs (its GPU raster included, which the pass's own
      // timer doesn't see)
      const noop = (obj, m, ret) => obj && (obj[m] = () => ret);
      const off = {
        postfx: () => noop(g.postFx, 'render', false),
        light: () => (noop(g.light, 'begin'), noop(g.light, 'composite')),
        buildings: () => noop(g.renderer, 'drawBuildings'),
        ground: () => noop(g.renderer, 'drawGround'),
        hud: () => (noop(g.hud, 'draw'), noop(g.banners, 'draw')),
        windows: () => noop(g.renderer, 'drawNightWindows'),
        weather: () => (noop(g.weather, 'drawScreen'), noop(g.weather, 'drawWorld')),
        bridges: () => noop(g.renderer, 'drawBridges'),
        street: () => noop(g.renderer.street, 'drawLow'),
        posts: () => (noop(g.renderer, 'drawPosts'), noop(g.renderer, 'drawBarriers')),
      };
      for (const k of sc.ablate ?? []) off[k]();
    }, sc);
    await sleep(2500); // settle: chunk caches, the crowd round the player, the camera's zoom
    let cdp = null;
    if (PROFILE) {
      cdp = await ctx.newCDPSession(page);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    }
    await page.evaluate(() => {
      window.__bench.frames = [];
      window.__bench.on = true;
    });
    await sleep(SECONDS * 1000);
    const frames = await page.evaluate(() => {
      window.__bench.on = false;
      return window.__bench.frames;
    });
    const info = await page.evaluate(() => {
      const g = window.game;
      return { tier: g.qualityTier, peds: g.host.peds.length, cars: g.host.vehicles.length, canvas: [g.canvas.width, g.canvas.height], scale: +g.cam.scale.toFixed(2), paused: g.paused };
    });
    let prof = null;
    if (cdp) {
      const { profile } = await cdp.send('Profiler.stop');
      mkdirSync(PROFILE, { recursive: true });
      writeFileSync(path.join(PROFILE, `${sc.name}.cpuprofile`), JSON.stringify(profile));
      prof = topSelf(profile);
    }
    frames.shift(); // the first interval straddles the start
    const keys = new Set();
    for (const f of frames) for (const k of Object.keys(f)) keys.add(k);
    const phases = {};
    for (const k of keys) phases[k] = stats(frames.map((f) => f[k] || 0));
    const fps = 1000 / (phases.interval?.mean || 1);
    results.push({ scene: sc.name, frames: frames.length, fps, info, phases, profile: prof, errors });
    console.log(`\n=== ${sc.name}  ${frames.length} frames, ${fps.toFixed(1)} fps  ${JSON.stringify(info)}`);
    console.log('phase'.padEnd(34) + '   mean     p50     p95     max');
    const order = [...keys].sort((a, b) => (phases[b].mean || 0) - (phases[a].mean || 0));
    for (const k of order) {
      const s = phases[k];
      if (s.mean < 0.02 && !['interval', 'update', 'draw'].includes(k)) continue;
      console.log(k.padEnd(34) + f1(s.mean) + ' ' + f1(s.p50) + ' ' + f1(s.p95) + ' ' + f1(s.max));
    }
    if (prof) {
      console.log(`-- top self time (${prof.total.toFixed(0)} ms sampled)`);
      for (const t of prof.top) console.log(`${t.pct.toFixed(1).padStart(5)}%  ${t.ms.toFixed(0).padStart(6)} ms  ${t.fn}`);
    }
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
    await ctx.close();
  }
  await browser.close();
  if (process.env.BENCH_JSON) writeFileSync(process.env.BENCH_JSON, JSON.stringify(results, null, 1));
} finally {
  try {
    process.kill(-preview.pid);
  } catch {
    /* ignore */
  }
}
