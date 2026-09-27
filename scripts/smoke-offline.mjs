// Offline single-player smoke test on the shared simulation: start a game, check NPCs spawn, drive,
// shoot, get wanted, get police, die and respawn, shop (with a click, and with a gamepad). Run after `vite build`: node scripts/smoke-offline.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// SMOKE_PORT lets parallel runs (several worktrees) use their own preview server
const PORT = Number(process.env.SMOKE_PORT) || 4174;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => (ok ? console.log('[smoke] PASS', what) : (failures++, console.log('[smoke] FAIL', what)));

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
const exe = path.join(base, 'chromium-1194/chrome-linux/chrome');

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
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://localhost:${PORT}/?t=12`);
  await page.waitForFunction(() => !document.getElementById('menu')?.classList.contains('hidden'), null, { timeout: 30000 });
  await page.click('#btn-new');
  await sleep(4000);
  const s1 = await page.evaluate(() => {
    const g = window.game;
    return { peds: g.peds.length, cars: g.vehicles.length, trams: g.host.trams.length, state: g.state, pickups: g.host.pickups.length };
  });
  console.log('[smoke] after start', s1);
  check(s1.peds > 60 && s1.cars > 30, `NPCs spawned (${s1.peds} peds, ${s1.cars} cars, ${s1.trams} trams)`);
  check(s1.pickups >= 15, `pickups placed (${s1.pickups})`);
  check(await page.evaluate(() => document.getElementById('touch').classList.contains('hidden')), 'no touch controls on a desktop');

  // get into the nearest car and drive
  await page.evaluate(() => {
    const g = window.game, p = g.player;
    let best = null, bd = 1e9;
    for (const v of g.vehicles) if (!v.driver && v.parked) {
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if (d < bd) (bd = d), (best = v);
    }
    p.x = best.x + Math.sin(best.angle) * 2;
    p.y = best.y - Math.cos(best.angle) * 2;
    p.levelInit = false;
  });
  await page.keyboard.press('KeyF');
  await sleep(300);
  const inCar = await page.evaluate(() => !!window.game.player.vehicle);
  check(inCar, 'entered a car with F');
  const start = await page.evaluate(() => ({ x: window.game.player.vehicle.x, y: window.game.player.vehicle.y }));
  const driveFor = async (key) => {
    await page.keyboard.down(key);
    await sleep(2500);
    const d = await page.evaluate(() => {
      const v = window.game.player.vehicle;
      return { x: v.x, y: v.y, speed: v.speed };
    });
    await page.keyboard.up(key);
    return d;
  };
  let drive = await driveFor('KeyW');
  let moved = Math.hypot(drive.x - start.x, drive.y - start.y);
  // parked with its nose against a wall or another car: back out instead
  if (moved <= 4) {
    drive = await driveFor('KeyS');
    moved = Math.max(moved, Math.hypot(drive.x - start.x, drive.y - start.y));
  }
  check(moved > 4, `the car drives (${moved.toFixed(1)} m, ${drive.speed.toFixed(1)} m/s)`);
  await page.keyboard.down('Space');
  await sleep(1500);
  await page.keyboard.up('Space');
  await page.keyboard.press('KeyF');
  await sleep(300);
  check(await page.evaluate(() => !window.game.player.vehicle), 'left the car with F');

  // shoot the nearest civilian with a pistol
  const shot = await page.evaluate(async () => {
    const g = window.game, p = g.player;
    g.ammo.pistol = 50;
    p.weapon = 'pistol';
    // any civilian we can stand 4 m from with a clear line of fire
    for (const q of g.peds) {
      if (q.kind !== 'civ' || q.dead || q.vehicle || q.level !== 0) continue;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const x = q.x + Math.cos(a) * 4, y = q.y + Math.sin(a) * 4;
        if (g.world.collideCircle(x, y, 0.5) || g.world.raycast(x, y, q.x, q.y) < 1 || g.world.inWater(x, y, 0)) continue;
        p.x = x;
        p.y = y;
        return { ok: true, id: q.id };
      }
    }
    return { ok: false };
  });
  if (shot.ok) {
    for (let i = 0; i < 6; i++) {
      const pos = await page.evaluate((id) => {
        const g = window.game;
        const t = g.host.pedById(id);
        if (!t || t.dead) return null;
        return g.worldToScreen(t.x, t.y);
      }, shot.id);
      if (!pos) break;
      await page.mouse.move(pos.x, pos.y);
      await page.mouse.down();
      await sleep(80);
      await page.mouse.up();
      await sleep(400);
    }
    const res = await page.evaluate((id) => ({ dead: window.game.host.pedById(id)?.dead ?? true, wanted: window.game.wanted, money: window.game.save.money }), shot.id);
    check(res.dead, 'shot a civilian dead');
    check(res.wanted >= 1, `killing raised the wanted level (${res.wanted})`);
  } else check(false, 'found a civilian to shoot');

  // 3 stars: police show up
  // by the Eurovea riverside roads: some spots (the Old Town square, the castle) have no streets for police cars nearby
  await page.evaluate(() => {
    const g = window.game;
    const l = g.world.landmark('eurovea');
    const s = g.world.walkableNear(l.x, l.y - 40);
    g.player.x = s.x;
    g.player.y = s.y;
    g.wanted = 3;
  });
  let police = 0;
  for (let t = 0; t < 15000 && police < 2; t += 1000) {
    await sleep(1000);
    police = await page.evaluate(() => window.game.vehicles.filter((v) => v.kind === 'police' && v.siren).length);
  }
  const where = await page.evaluate(() => ({ x: Math.round(window.game.player.x), y: Math.round(window.game.player.y), wanted: window.game.wanted }));
  check(police >= 2, `police cars chase at 3 stars (${police} at ${JSON.stringify(where)})`);

  // die and respawn at a hospital with a fee (after any combo from the shooting has paid out)
  // (the combo runs in the simulation, rules/Style.ts: wait for it as well as for the meter)
  const comboOn = () => page.evaluate(() => window.game.juice.combo.timer > 0 || !!window.game.host.sim.rule('style')?.combo(window.game.host.me));
  for (let t = 0; t < 10000 && (await comboOn()); t += 250) await sleep(250);
  const before = await page.evaluate(() => {
    const g = window.game;
    g.save.money = 1000;
    g.host.sim.hurtPlayer(g.host.me, 1000, g.player.x, g.player.y);
    return g.state;
  });
  check(before === 'wasted', 'player can be wasted');
  await sleep(5500);
  const after = await page.evaluate(() => ({ state: window.game.state, money: window.game.save.money, hp: window.game.player.health, wanted: window.game.wanted }));
  check(after.state === 'play' && after.money === 900 && after.hp === 100 && after.wanted === 0, `respawned with a 10% fee (${JSON.stringify(after)})`);

  // missions: walking into the first phone booth starts one
  const mission = await page.evaluate(async () => {
    const g = window.game;
    const b = g.missions.available()[0];
    g.player.x = b.x;
    g.player.y = b.y;
    return !!b;
  });
  await sleep(500);
  check(mission && (await page.evaluate(() => !!window.game.missions.active)), 'a phone booth starts a mission');

  // jobs (Vlk courier): the shared rule runs offline too, with no server round-trip
  const job = await page.evaluate(() => {
    const g = window.game;
    g.host.jobStart('courier');
    return g.host.live.job;
  });
  check(!!job && job.kind === 'courier' && job.stage === 'pickup', `offline courier job starts (${JSON.stringify(job)})`);
  await page.evaluate(() => window.game.host.jobStop());
  check(!(await page.evaluate(() => window.game.host.live.job)), 'jobStop ends the shift');

  // the shops (docs/plans/gameplay.md, Phase 2): walking into Poľovnícke potreby opens its panel, a
  // click buys, Escape closes it (and it stays closed until the next visit)
  await page.evaluate(() => {
    const g = window.game;
    if (g.missions.active) g.missions.fail('');
    g.save.money = 5000;
    // every landmark already found: no discovery reward lands on the money checks
    g.save.found = [...g.world.landmarks.keys()];
    const l = g.world.landmark('michael');
    const at = g.world.walkableNear(l.x, l.y);
    g.player.x = at.x;
    g.player.y = at.y;
    g.player.levelInit = false;
  });
  const shopOpen = await page.waitForSelector('.kit-shop-card', { timeout: 3000 }).then(() => true, () => false);
  check(shopOpen && (await page.textContent('.kit-shop-card h2'))?.includes('Poľovnícke potreby'), 'walking into a gun shop opens its panel');
  if (shopOpen) {
    await page.click('.kit-shop-row button[data-k="pistol"]');
    await sleep(300);
    const bought = await page.evaluate(() => ({ ammo: window.game.ammo.pistol, money: window.game.save.money, status: document.querySelector('.kit-shop-status')?.textContent }));
    check(bought.ammo >= 36 && bought.money === 4750 && /Pištoľ \+36/.test(bought.status ?? ''), `bought a pistol with a click (${JSON.stringify(bought)})`);
    await page.keyboard.press('Escape');
    await sleep(400);
    check(!(await page.$('.kit-shop-card')) && !(await page.evaluate(() => window.game.paused)), 'Escape closes the shop, not into the pause menu, and it stays closed');
  }
  // the Butik with a gamepad (a fake one): the d-pad moves along the jackets, A buys, B leaves
  await page.evaluate(() => {
    const pad = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
    const g = window.game;
    const l = g.world.landmark('kamenne');
    const at = g.world.walkableNear(l.x, l.y);
    g.player.x = at.x;
    g.player.y = at.y;
    g.player.levelInit = false;
  });
  const padPress = async (i) => {
    await page.evaluate((b) => (window.__pad.buttons[b].pressed = true), i);
    await sleep(120);
    await page.evaluate((b) => (window.__pad.buttons[b].pressed = false), i);
    await sleep(120);
  };
  if (await page.waitForSelector('.kit-shop-card', { timeout: 3000 }).then(() => true, () => false)) {
    const look0 = await page.evaluate(() => window.game.player.look);
    await sleep(100);
    await padPress(15);
    const focused = await page.evaluate(() => document.activeElement?.dataset?.k);
    await padPress(0);
    await sleep(200);
    const dressed = await page.evaluate(() => ({ look: window.game.player.look, money: window.game.save.money }));
    check(focused === 'jacket:1' && dressed.look === 1 && dressed.look !== look0 && dressed.money === 4600, `a gamepad buys a jacket in the Butik (${focused}, ${JSON.stringify(dressed)})`);
    if (process.env.SMOKE_SHOP_SHOT) await page.screenshot({ path: process.env.SMOKE_SHOP_SHOT });
    await padPress(1);
    check(!(await page.$('.kit-shop-card')), 'the pad\'s B leaves the shop');
  } else check(false, 'walking into the Butik opens its panel');
  await page.evaluate(() => delete navigator.getGamepads);

  // persistence
  const saved = await page.evaluate(() => {
    window.game.persist();
    return JSON.parse(localStorage.getItem('blava-city-save-v1') || 'null');
  });
  check(saved && typeof saved.money === 'number' && typeof saved.clock === 'number', 'progress saved to localStorage');
  check(saved?.gear?.look === 1, 'the jacket bought is in the save');

  if (process.env.SMOKE_SHOT) await page.screenshot({ path: process.env.SMOKE_SHOT });
  check(errors.length === 0, `no page errors${errors.length ? ':\n' + errors.slice(0, 5).join('\n') : ''}`);
  await browser.close();
} catch (e) {
  failures++;
  console.error(e);
} finally {
  try {
    process.kill(-preview.pid, 'SIGKILL');
  } catch {
    preview.kill();
  }
  console.log(failures ? `[smoke] ${failures} FAILED` : '[smoke] ALL PASSED');
  process.exit(failures ? 1 : 0);
}
