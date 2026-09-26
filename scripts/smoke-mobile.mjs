// Touch smoke test on an emulated phone (landscape, then upright): the touch controls show, the stick
// walks and runs, the fire button locks onto someone, the use button gets into a car, both driving
// schemes drive, a stick pointed backwards turns the car around, BRAKE stops it, the pause button and
// the minimap work. Real multi-touch through the DevTools protocol. Screenshots land in $SHOTS (if set).
// Run after `vite build`: node scripts/smoke-mobile.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 4176;
const SHOTS = process.env.SHOTS ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => (ok ? console.log('[mobile] PASS', what) : (failures++, console.log('[mobile] FAIL', what)));

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
const exe = path.join(base, 'chromium-1194/chrome-linux/chrome');

/** fingers on the screen, through CDP so several can be down at once */
function touchscreen(cdp) {
  const down = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...down.values()] });
  return {
    async start(id, x, y) {
      down.set(id, { x, y, id });
      await send('touchStart');
    },
    async move(id, x, y) {
      down.set(id, { x, y, id });
      await send('touchMove');
    },
    async end(id) {
      down.delete(id);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [...down.values()] });
    },
    async tap(x, y) {
      await this.start(9, x, y);
      await sleep(80);
      await this.end(9);
    },
  };
}

/** wait until `fn` (run in the page) is truthy, or time out; its last value */
async function until(page, fn, arg, ms = 8000) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) {
    v = await page.evaluate(fn, arg);
    if (v) return v;
    await sleep(100);
  }
  return v;
}

/** the centre of a touch control (by its data-id), or null when it isn't shown */
const centre = (page, id) =>
  page.evaluate((id) => {
    const e = document.querySelector(`#touch [data-id="${id}"]`);
    if (!e || e.classList.contains('off')) return null;
    const r = e.getBoundingClientRect();
    return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, id);

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

async function boot(browser, device, name) {
  const ctx = await browser.newContext({ ...device, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://localhost:${PORT}/?t=12`);
  await page.waitForFunction(() => !document.getElementById('menu')?.classList.contains('hidden'), null, { timeout: 30000 });
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  if (!coarse) await page.goto(`http://localhost:${PORT}/?t=12&touch=1`);
  const fingers = touchscreen(await ctx.newCDPSession(page));
  const b = await page.evaluate(() => {
    const r = document.getElementById('btn-new').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await fingers.tap(b.x, b.y);
  const ready = await until(page, () => document.getElementById('touch')?.dataset.ctx === 'foot', null, 20000);
  check(!!ready, `${name}: touch controls shown on foot`);
  // quiet the first-run tips (they're tested by their own run below)
  return { ctx, page, fingers, errors };
}

/** metres the player (or their car) covers in `ms` while the stick is held at (dx, dy) px */
async function stickFor(page, fingers, dx, dy, ms) {
  const vp = page.viewportSize();
  const sx = Math.round(vp.width * 0.18), sy = Math.round(vp.height - 90);
  const p0 = await page.evaluate(() => window.game.focus());
  await fingers.start(1, sx, sy);
  await sleep(50);
  await fingers.move(1, sx + dx / 2, sy + dy / 2);
  await fingers.move(1, sx + dx, sy + dy);
  await sleep(ms);
  const p1 = await page.evaluate(() => window.game.focus());
  await fingers.end(1);
  return Math.hypot(p1.x - p0.x, p1.y - p0.y);
}

try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://localhost:${PORT}/`);
      break;
    } catch {
      await sleep(200);
    }
  }
  const browser = await chromium.launch({ executablePath: existsSync(exe) ? exe : undefined, args: ['--use-gl=swiftshader', '--mute-audio'] });

  // ------------------------------------------------------------------ landscape
  const land = await boot(browser, devices['Pixel 7 landscape'], 'landscape');
  const { page, fingers } = land;
  await page.evaluate(() => window.game.touchUi.tips.reset());
  await shot(page, 'land-foot');
  const tip = await until(page, () => !document.querySelector('.t-tip')?.classList.contains('off') && document.querySelector('.t-tip').textContent);
  check(!!tip, `a first-run tip shows (${tip})`);

  // walk, then run
  const walked = await stickFor(page, fingers, 25, 0, 1200);
  check(walked > 1, `the stick walks (${walked.toFixed(1)} m)`);
  const t0 = Date.now();
  const ran = await stickFor(page, fingers, 0, -80, 1500);
  const speed = ran / ((Date.now() - t0) / 1000);
  const runSpeed = await page.evaluate(() => Math.hypot(window.game.player.vx, window.game.player.vy));
  check(ran > 3, `a full push runs (${ran.toFixed(1)} m, ${speed.toFixed(1)} m/s wall clock)`);
  void runSpeed;

  // the fire button locks onto a civilian nearby, turning the last bit toward them
  const target = await page.evaluate(() => {
    const g = window.game, p = g.player;
    g.ammo.pistol = 50;
    p.weapon = 'pistol';
    for (const q of g.peds) {
      if (q.kind !== 'civ' || q.dead || q.vehicle || q.level !== 0) continue;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const x = q.x + Math.cos(a) * 5, y = q.y + Math.sin(a) * 5;
        if (g.world.collideCircle(x, y, 0.5) || g.world.raycast(x, y, q.x, q.y) < 1 || g.world.inWater(x, y, 0)) continue;
        p.x = x;
        p.y = y;
        p.levelInit = false;
        // looking a little to the side of them (auto-aim picks from the cone ahead)
        p.angle = Math.atan2(q.y - y, q.x - x) + 0.6;
        return { id: q.id };
      }
    }
    return null;
  });
  check(!!target, 'found a civilian to stand next to');
  if (target) {
    await sleep(300);
    const fire = await centre(page, 'fire');
    const ammo0 = await page.evaluate(() => window.game.ammo.pistol);
    await fingers.start(2, fire.x, fire.y);
    // locked onto someone (this civilian, or another passer-by who's a better pick), facing them
    const locked = await until(page, () => {
      const g = window.game, t = g.aimTarget;
      if (!t) return null;
      const a = Math.atan2(t.y - g.player.y, t.x - g.player.x);
      const off = Math.abs(Math.atan2(Math.sin(a - g.player.angle), Math.cos(a - g.player.angle)));
      return off < 0.25 ? `${Math.hypot(t.x - g.player.x, t.y - g.player.y).toFixed(1)} m away` : null;
    }, null, 3000);
    await sleep(500);
    await shot(page, 'land-aim');
    await fingers.end(2);
    const ammo1 = await page.evaluate(() => window.game.ammo.pistol);
    check(!!locked, `holding fire locks onto someone and turns to them (${locked})`);
    check(ammo1 < ammo0, `holding fire shoots (${ammo0} → ${ammo1})`);
  }

  // dragging from the fire button aims by hand: straight up the screen
  {
    await page.evaluate(() => {
      // nobody around to snap onto
      const g = window.game;
      for (const q of g.peds) if (q !== g.player && Math.hypot(q.x - g.player.x, q.y - g.player.y) < 60) q.x += 500;
    });
    const fire = await centre(page, 'fire');
    await fingers.start(2, fire.x, fire.y);
    await fingers.move(2, fire.x, fire.y - 30);
    await fingers.move(2, fire.x, fire.y - 70);
    const aimed = await until(page, () => {
      const g = window.game;
      return g.input.touch.aim.on && Math.abs(Math.atan2(Math.sin(g.player.angle + Math.PI / 2), Math.cos(g.player.angle + Math.PI / 2))) < 0.2;
    });
    await fingers.end(2);
    check(!!aimed, 'dragging from fire aims where the drag points');
  }

  // the weapon button cycles
  {
    const w0 = await page.evaluate(() => window.game.player.weapon);
    const wb = await centre(page, 'weapon');
    await fingers.tap(wb.x, wb.y);
    const w1 = await until(page, (w0) => window.game.player.weapon !== w0 && window.game.player.weapon, w0);
    check(!!w1, `the weapon button switches weapons (${w0} → ${w1})`);
  }

  // up to a parked car: the use button says what it does, and gets in
  {
    await page.evaluate(() => {
      const g = window.game, p = g.player;
      let best = null, bd = 1e9;
      for (const v of g.vehicles) if (!v.driver && v.parked && !v.wrecked) {
        const d = Math.hypot(v.x - p.x, v.y - p.y);
        if (d < bd) (bd = d), (best = v);
      }
      p.x = best.x + Math.sin(best.angle) * 2;
      p.y = best.y - Math.cos(best.angle) * 2;
      p.levelInit = false;
    });
    const label = await until(page, () => {
      const e = document.querySelector('#touch [data-id="use"]');
      return e && !e.classList.contains('off') && e.textContent;
    });
    // "Nastúpiť", or "Vytiahnuť vodiča" when someone is sitting in the car next to it
    check(['Nastúpiť', 'Vytiahnuť vodiča', 'Ukradnúť policajné auto', 'Vytiahnuť policajta'].includes(label), `the use button says what it does (${label})`);
    const ub = await centre(page, 'use');
    if (ub) await fingers.tap(ub.x, ub.y);
    const inCar = await until(page, () => document.getElementById('touch').dataset.ctx === 'car-d');
    check(!!inCar, 'the use button gets into the car (driving controls shown)');
  }

  // drive: out in the open, the stick points the way; pointed back, the car turns around
  {
    const open = await page.evaluate(() => {
      const g = window.game, v = g.player.vehicle;
      // a spot with 14 m of room all round, near where we are
      for (let r = 0; r < 800; r += 20)
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2, x = v.x + Math.cos(a) * r, y = v.y + Math.sin(a) * r;
          if (g.world.collideCircle(x, y, 14, 0) || g.world.inWater(x, y, 0)) continue;
          v.x = x;
          v.y = y;
          v.vx = v.vy = v.av = 0;
          v.angle = 0;
          v.levelInit = false;
          return { x, y };
        }
      return null;
    });
    check(!!open, 'found open ground to drive on');
    await sleep(300);
    await shot(page, 'land-car');
    const moved = await stickFor(page, fingers, 80, 0, 1500);
    check(moved > 4, `the direction stick drives (${moved.toFixed(1)} m)`);
    // stick straight back (west): no endless reverse, the car comes round to face it
    const vp = page.viewportSize();
    const sx = Math.round(vp.width * 0.18), sy = Math.round(vp.height - 90);
    await page.evaluate(() => {
      const v = window.game.player.vehicle;
      v.vx = v.vy = v.av = 0;
      v.angle = 0;
    });
    await fingers.start(1, sx, sy);
    await fingers.move(1, sx - 80, sy);
    const turned = await until(page, () => {
      const v = window.game.player.vehicle;
      const off = Math.abs(Math.atan2(Math.sin(v.angle - Math.PI), Math.cos(v.angle - Math.PI)));
      return off < 0.5 && v.fwdSpeed > 1 ? off : null;
    }, null, 15000);
    const after = await page.evaluate(() => ({ a: window.game.player.vehicle.angle, v: window.game.player.vehicle.fwdSpeed }));
    await fingers.end(1);
    check(turned !== null && turned !== undefined, `a stick pointed back turns the car around (heading ${after.a.toFixed(2)}, ${after.v.toFixed(1)} m/s)`);
    // BRAKE stops it
    await stickFor(page, fingers, 80, 0, 1200);
    const bb = await centre(page, 'brake');
    await fingers.start(3, bb.x, bb.y);
    const stopped = await until(page, () => window.game.player.vehicle.speed < 0.6, null, 5000);
    await fingers.end(3);
    check(!!stopped, 'BRAKE stops the car');
  }

  // classic: the pedals
  {
    await page.evaluate(() => (window.game.driveControls = 'classic'));
    const classic = await until(page, () => document.getElementById('touch').dataset.ctx === 'car-c');
    check(!!classic, 'the classic scheme shows its pedals');
    const pedal = await page.evaluate(() => {
      const r = document.querySelector('#touch [data-id="pedal"]').getBoundingClientRect();
      return { gas: { x: r.right - r.width / 4, y: r.top + r.height / 2 }, brake: { x: r.left + r.width / 4, y: r.top + r.height / 2 } };
    });
    await shot(page, 'land-classic');
    const p0 = await page.evaluate(() => window.game.focus());
    await fingers.start(3, pedal.gas.x, pedal.gas.y);
    await sleep(1500);
    const p1 = await page.evaluate(() => window.game.focus());
    // slide onto the brake
    await fingers.move(3, pedal.brake.x, pedal.brake.y);
    const braking = await until(page, () => window.game.input.touchButtons.has('brake') && !window.game.input.touchButtons.has('gas'));
    await fingers.end(3);
    check(Math.hypot(p1.x - p0.x, p1.y - p0.y) > 3, 'GAS drives');
    check(!!braking, 'sliding the thumb from GAS onto BRAKE brakes');
    await page.evaluate(() => (window.game.driveControls = 'direction'));
  }

  // out of the car
  {
    await until(page, () => window.game.player.vehicle.speed < 0.5, null, 5000);
    const ub = await centre(page, 'use');
    if (ub) await fingers.tap(ub.x, ub.y);
    const out = await until(page, () => document.getElementById('touch').dataset.ctx === 'foot');
    check(!!out, 'the use button ("Vystúpiť") gets out');
  }

  // the pause button, and back
  {
    const pb = await centre(page, 'pause');
    await fingers.tap(pb.x, pb.y);
    const paused = await until(page, () => !document.getElementById('pause').classList.contains('hidden'));
    check(!!paused, 'the pause button opens the pause menu');
    await shot(page, 'land-pause');
    const r = await page.evaluate(() => {
      const b = document.getElementById('btn-resume').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await fingers.tap(r.x, r.y);
    check(!!(await until(page, () => !window.game.paused && document.getElementById('touch').dataset.ctx === 'foot')), 'resume brings the controls back');
  }

  // the minimap opens the city map, ✕ closes it
  {
    const mb = await centre(page, 'map');
    await fingers.tap(mb.x, mb.y);
    const open = await until(page, () => window.game.showMap && document.getElementById('touch').dataset.ctx === 'map');
    check(!!open, 'tapping the minimap opens the city map');
    await sleep(300);
    await shot(page, 'land-map');
    const zb = await centre(page, 'zoomIn');
    const z0 = await page.evaluate(() => window.game.mapView.zoom);
    if (zb) await fingers.tap(zb.x, zb.y);
    const z1 = await until(page, (z0) => window.game.mapView.zoom > z0, z0);
    check(!!z1, 'the map zooms in with +');
    const cb = await centre(page, 'mapClose');
    await fingers.tap(cb.x, cb.y);
    check(!!(await until(page, () => !window.game.showMap)), '✕ closes the map');
  }
  check(land.errors.length === 0, 'no page errors (landscape)' + (land.errors.length ? '\n' + land.errors.join('\n') : ''));
  await land.ctx.close();

  // ------------------------------------------------------------------ upright
  const up = await boot(browser, devices['Pixel 7'], 'portrait');
  await up.page.evaluate(() => window.game.touchUi.tips.reset());
  await sleep(500);
  await shot(up.page, 'port-foot');
  const rot = await up.page.evaluate(() => !document.querySelector('.t-rotate').classList.contains('off'));
  check(rot, 'upright: the "turn it sideways" hint shows');
  const walkedUp = await stickFor(up.page, up.fingers, 30, -30, 1200);
  check(walkedUp > 1, `upright: the stick walks (${walkedUp.toFixed(1)} m)`);
  check(up.errors.length === 0, 'no page errors (portrait)' + (up.errors.length ? '\n' + up.errors.join('\n') : ''));
  await browser.close();
} catch (e) {
  failures++;
  console.log('[mobile] FAIL', e);
} finally {
  process.kill(-preview.pid);
}
console.log(failures ? `[mobile] ${failures} FAILED` : '[mobile] ALL PASSED');
process.exit(failures ? 1 : 0);
