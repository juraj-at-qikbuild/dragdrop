// Offline single-player smoke test on the shared simulation: start a game, check NPCs spawn, drive,
// shoot, get wanted, get police, die and respawn, shop (with a click, and with a gamepad), and a new
// player's introduction. Run after `vite build`: node scripts/smoke-offline.mjs
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

  // get into the nearest car and drive (a car: not one of the scooters and bikes at the docks, nor a
  // boat at a pier)
  await page.evaluate(() => {
    const g = window.game, p = g.player;
    let best = null, bd = 1e9;
    for (const v of g.vehicles) if (!v.driver && v.parked && !v.spec.twoWheeler && !v.spec.boat) {
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
  // (stopped at a garage's or a workshop's door, its panel opened and has the keys: close it first)
  if (await page.$('.kit-shop-card')) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }
  await page.keyboard.press('KeyF');
  await sleep(300);
  check(await page.evaluate(() => !window.game.player.vehicle), 'left the car with F');

  // a scooter (docs/plans/gameplay.md, Phase 3): get on it, ride it with no engine noise or nitro,
  // and a knock hard enough throws the rider off
  const scooter = await page.evaluate(() => {
    const g = window.game, sim = g.host.sim, p = g.player, w = g.world;
    // near the player, facing 8 m of clear way (riding into a wall would throw them off)
    const clear = (x, y, a) => {
      for (let d = 0; d <= 8; d += 0.5) {
        const cx = x + Math.cos(a) * d, cy = y + Math.sin(a) * d;
        if (w.collideCircle(cx, cy, 0.4, 0, false) || w.inWater(cx, cy, 0)) return false;
        for (const o of g.vehicles)
          for (let i = 0; i < o.circles.length; i++) if (Math.hypot(o.circleX(i) - cx, o.circleY(i) - cy) < o.spec.width / 2 + 0.5) return false;
      }
      return true;
    };
    let at = null;
    for (let r = 1.5; r <= 4.5 && !at; r += 1.5)
      for (let k = 0; k < 32 && !at; k++) {
        const a = (k / 32) * Math.PI * 2;
        for (const side of [1, -1]) {
          const x = p.x + Math.cos(a + (side * Math.PI) / 2) * r, y = p.y + Math.sin(a + (side * Math.PI) / 2) * r;
          if (!at && clear(x, y, a)) at = { x, y, a, side };
        }
      }
    if (!at) return null;
    const V = sim.vehicles[0].constructor;
    const v = sim.addVehicle(new V('scooter', at.x, at.y, at.a, '#34d186'));
    v.parked = true;
    v.setControls(0, 0, true);
    // right beside it, so it's the nearest thing to get on (not a car going by)
    p.x = at.x - Math.cos(at.a + (at.side * Math.PI) / 2) * 0.8;
    p.y = at.y - Math.sin(at.a + (at.side * Math.PI) / 2) * 0.8;
    p.levelInit = false;
    return { id: v.id, x: v.x, y: v.y };
  });
  if (!scooter) check(false, 'room beside the player for a scooter');
  else {
    await sleep(200);
    const onText = await page.evaluate(() => window.game.prompt()?.text);
    await page.keyboard.press('KeyF');
    await sleep(300);
    check(await page.evaluate((id) => window.game.player.vehicle?.id === id, scooter.id), `got on a scooter with F ("${onText}")`);
    await page.keyboard.down('KeyW');
    await sleep(1500);
    await page.keyboard.up('KeyW');
    const rode = await page.evaluate(({ x, y }) => {
      const v = window.game.player.vehicle;
      return v ? { d: Math.hypot(v.x - x, v.y - y), nitro: v.nitro } : null;
    }, scooter);
    check(!!rode && rode.d > 1.5 && rode.nitro === 0, `the scooter rides, with no nitro (${JSON.stringify(rode)})`);
    const fell = await page.evaluate(async () => {
      const g = window.game, v = g.player.vehicle;
      v.knock = 9;
      await new Promise((r) => setTimeout(r, 300));
      return { off: !g.player.vehicle, hp: g.player.health };
    });
    check(fell.off && fell.hp < 100, `a hard knock throws the rider off (${JSON.stringify(fell)})`);
  }

  // a tram (docs/plans/gameplay.md, Phase 3): the nearest one stops; F at its nose takes the cab, W
  // drives it, S stops it, F climbs out
  const tram = await page.evaluate(() => {
    const g = window.game, sim = g.host.sim, p = g.player;
    // the nearest one, or one the AI puts down on the nearest tracks (out of sight, as it does)
    let t = null, bd = 400;
    for (const q of sim.trams) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) (bd = d), (t = q);
    }
    for (let k = 0; k < 40 && !t; k++) {
      const before = new Set(sim.trams);
      sim.ai.spawnTram(p.x, p.y, 60, 300 + k * 40);
      t = sim.trams.find((q) => !before.has(q)) ?? null;
    }
    if (!t) return null;
    t.dwell = 30;
    t.speed = 0;
    // at its nose at once (a tram far from the player would be gone by the next frame)
    p.x = t.x + Math.cos(t.angle) * 1.2;
    p.y = t.y + Math.sin(t.angle) * 1.2;
    p.level = t.level;
    p.levelInit = true;
    return { id: t.id };
  });
  if (!tram) check(false, 'a tram to drive');
  else {
    await sleep(300);
    const cabText = await page.evaluate(() => window.game.prompt()?.text);
    if (cabText !== 'Ukradnúť električku')
      console.log('[smoke] at the tram:', JSON.stringify(await page.evaluate((id) => {
        const g = window.game, p = g.player, t = g.host.trams.find((q) => q.id === id);
        return { state: g.state, paused: g.paused, map: g.showMap, car: !!p.vehicle, tram: !!t, d: t && Math.hypot(t.x + Math.cos(t.angle) * 0.8 - p.x, t.y + Math.sin(t.angle) * 0.8 - p.y), lvl: [p.level, t?.level], speed: t?.speed, driver: t?.driver, dwell: t?.dwell };
      }, tram.id)));
    await page.keyboard.press('KeyF');
    await sleep(300);
    check(await page.evaluate((id) => window.game.host.live.tram?.id === id && window.game.host.live.tram.cab, tram.id), `took a tram's cab with F ("${cabText}")`);
    const t0 = await page.evaluate((id) => { const t = window.game.host.trams.find((q) => q.id === id); return { x: t.x, y: t.y }; }, tram.id);
    await page.keyboard.down('KeyW');
    await sleep(2500);
    await page.keyboard.up('KeyW');
    const drove = await page.evaluate(({ id, x, y }) => {
      const g = window.game, t = g.host.trams.find((q) => q.id === id);
      return { d: Math.hypot(t.x - x, t.y - y), withIt: Math.hypot(g.player.x - t.x, g.player.y - t.y) < 3, wanted: g.wanted };
    }, { id: tram.id, ...t0 });
    check(drove.d > 3 && drove.withIt && drove.wanted >= 2, `the tram drives, with the player in its cab, and stealing it is a crime (${JSON.stringify(drove)})`);
    await page.keyboard.down('KeyS');
    await sleep(3000);
    await page.keyboard.up('KeyS');
    await page.keyboard.press('KeyF');
    await sleep(300);
    check(await page.evaluate(() => !window.game.host.live.tram), 'stopped, and climbed out with F');
    // (the stars from stealing it would get in the way of the police checks below)
    await page.evaluate(() => (window.game.wanted = 0));
  }

  // the Danube (docs/plans/gameplay.md, Phase 3): swimming for a moment, then a boat off the pier
  const river = await page.evaluate(() => {
    const g = window.game, w = g.world, p = g.player;
    const m = w.moorings(5.6, 2.2);
    if (!m.length) return null;
    p.x = m[0];
    p.y = m[1];
    p.level = 0;
    p.levelInit = true;
    return { x: m[0], y: m[1], a: m[2] };
  });
  if (!river) check(false, 'a mooring on the Danube');
  else {
    await sleep(2500);
    const swam = await page.evaluate(() => ({ swimT: window.game.swimT, state: window.game.state }));
    check(swam.swimT > 1.5 && swam.state === 'play', `swimming in the Danube (${JSON.stringify(swam)})`);
    await page.evaluate(({ x, y, a }) => {
      const g = window.game, sim = g.host.sim;
      const V = sim.vehicles[0].constructor;
      const b = sim.addVehicle(new V('boat', x, y, a, '#fafafa'));
      b.parked = true;
      g.player.x = x - Math.sin(a) * 2;
      g.player.y = y + Math.cos(a) * 2;
    }, river);
    await sleep(200);
    await page.keyboard.press('KeyF');
    await sleep(300);
    check(await page.evaluate(() => window.game.player.vehicle?.kind === 'boat'), 'got into a boat from the water with F');
    await page.keyboard.down('KeyW');
    await sleep(2000);
    await page.keyboard.up('KeyW');
    const boated = await page.evaluate(({ x, y }) => {
      const g = window.game, v = g.player.vehicle;
      return v && { d: Math.hypot(v.x - x, v.y - y), afloat: g.world.inWater(v.x, v.y, 0), sinking: v.sinking };
    }, river);
    check(!!boated && boated.d > 3 && boated.afloat && boated.sinking === 0, `the boat goes, on the water (${JSON.stringify(boated)})`);
    await page.keyboard.press('KeyF');
    await sleep(300);
    check(await page.evaluate(() => !window.game.player.vehicle && window.game.state === 'play'), 'off the boat with F');
    // back on dry land for what follows
    await page.evaluate(() => {
      const g = window.game, s = g.world.walkableNear(g.player.x, g.player.y);
      g.player.x = s.x;
      g.player.y = s.y;
    });
    await sleep(300);
  }

  // soak the nearest civilian with the water pistol
  const shot = await page.evaluate(async () => {
    const g = window.game, p = g.player;
    g.ammo.pistol = 50;
    p.weapon = 'pistol';
    // any civilian we can stand 4 m from with a clear line of fire
    for (const q of g.peds) {
      if (q.kind !== 'civ' || q.dazed || q.vehicle || q.level !== 0) continue;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const x = q.x + Math.cos(a) * 4, y = q.y + Math.sin(a) * 4;
        if (g.world.collideCircle(x, y, 0.5) || g.world.raycast(x, y, q.x, q.y) < 1 || g.world.inWater(x, y, 0)) continue;
        p.x = x;
        p.y = y;
        // (the camera there too, so the clicks land where the target is on screen)
        g.cam.x = x;
        g.cam.y = y;
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
        if (!t || t.dazed) return null;
        return g.worldToScreen(t.x, t.y);
      }, shot.id);
      if (!pos) break;
      await page.mouse.move(pos.x, pos.y);
      await page.mouse.down();
      await sleep(80);
      await page.mouse.up();
      await sleep(400);
    }
    const res = await page.evaluate((id) => ({ dazed: window.game.host.pedById(id)?.dazed ?? true, wanted: window.game.wanted, money: window.game.save.money }), shot.id);
    check(res.dazed, 'soaked a civilian till they sat down');
    check(res.wanted >= 1, `soaking someone raised the wanted level (${res.wanted})`);
  } else check(false, 'found a civilian to squirt');

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

  // the shops (docs/plans/gameplay.md, Phase 2): walking into the Hračkárstvo (the toy shop) opens its panel, a
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
  check(shopOpen && (await page.textContent('.kit-shop-card h2'))?.includes('Hračkárstvo'), 'walking into the toy shop opens its panel');
  if (shopOpen) {
    await page.click('.kit-shop-row button[data-k="pistol"]');
    await sleep(300);
    const bought = await page.evaluate(() => ({ ammo: window.game.ammo.pistol, money: window.game.save.money, status: document.querySelector('.kit-shop-status')?.textContent }));
    check(bought.ammo >= 36 && bought.money === 4750 && /Vodná pištoľ \+36/.test(bought.status ?? ''), `bought a water pistol with a click (${JSON.stringify(bought)})`);
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

  // the introduction (src/game/features/OnboardingUi.ts): a new player's first game opens it by itself
  // (an automated browser only gets it with ?intro=1, so this page passes for a person), three cards,
  // the greeting once it's closed, the pause menu brings it back, the first world event brings a tip,
  // and starting over doesn't show it again
  {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
    await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
    await p.goto(`http://localhost:${PORT}/?t=12`);
    await p.waitForFunction(() => !document.getElementById('menu')?.classList.contains('hidden'), null, { timeout: 30000 });
    await p.click('#btn-new');
    const opened = await p.waitForSelector('.kit-intro-card', { timeout: 5000 }).then(() => true, () => false);
    const card = () => p.evaluate(() => ({ title: document.querySelector('.kit-intro-card h2')?.textContent, items: [...document.querySelectorAll('.kit-intro-grid b')].map((b) => b.textContent) }));
    check(opened && (await p.evaluate(() => window.game.paused)), 'a new player\'s first game opens the introduction, paused');
    const cards = [await card()];
    for (let i = 0; i < 2; i++) {
      await p.keyboard.press('ArrowRight');
      cards.push(await card());
    }
    const titles = cards.map((c) => c.title).join(' | ');
    check(titles === 'Vitaj v Bratislave | Udalosti v meste | Čo môžeš robiť', `→ pages through its three cards (${titles})`);
    check(cards[1].items.join() === 'Hon na Čumila,Obrnené auto', `offline, the world events card has the two that run alone (${cards[1].items.join(', ')})`);
    await p.keyboard.press('ArrowLeft');
    check((await card()).title === 'Udalosti v meste', '← goes back a card');
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('Enter'); // "Hrať!" has the focus
    await sleep(200);
    const after = await p.evaluate(() => ({ open: !!document.querySelector('.kit-intro-card'), paused: window.game.paused, msg: window.game.messages.map((m) => m.text).join(' / ') }));
    check(!after.open && !after.paused && after.msg.includes('telefónnu búdku'), `"Hrať!" closes it into the game, with the greeting (${after.msg})`);
    await p.keyboard.press('Escape');
    await sleep(150);
    await p.evaluate(() => [...document.querySelectorAll('#pause button')].find((b) => b.textContent.includes('Úvod do hry'))?.click());
    const again = await p.evaluate(() => ({ open: !!document.querySelector('.kit-intro-card'), menu: !document.getElementById('pause').classList.contains('hidden') }));
    await p.keyboard.press('Escape');
    await sleep(150);
    const back = await p.evaluate(() => ({ open: !!document.querySelector('.kit-intro-card'), menu: !document.getElementById('pause').classList.contains('hidden'), paused: window.game.paused }));
    check(again.open && !again.menu && !back.open && back.menu && back.paused, '"📖 Úvod do hry" in the pause menu opens it again, and Escape goes back to the menu');
    await p.click('#btn-resume');
    const started = await p.evaluate(() => !!window.game.host.sim.rule('worldEvents').start('cumil'));
    const tip = await p.waitForFunction(() => window.game.messages.some((m) => m.text.startsWith('💡')), null, { timeout: 10000 }).then(() => true, () => false);
    const why = tip ? '' : JSON.stringify(await p.evaluate(() => ({ paused: window.game.paused, state: window.game.state, events: window.game.host.live.events.length, messages: window.game.messages.map((m) => m.text), seen: localStorage.getItem('blava-city-onboarding-v1') })));
    check(started && tip, `the first world event brings a tip about the Aktivity panel ${why}`);
    // starting over: a new game (the old one isn't written back over it on the way out), and it starts
    // without the introduction
    await p.evaluate(() => {
      window.game.save.done.push('smoke');
      window.game.persist();
    });
    await p.keyboard.press('Escape');
    await p.click('#btn-quit');
    // (a new game over a save reloads the page)
    await Promise.all([p.waitForEvent('load', { timeout: 30000 }), p.click('#btn-new')]);
    await p.waitForFunction(() => window.game?.running, null, { timeout: 30000 });
    await sleep(1000);
    const over = await p.evaluate(() => ({ open: !!document.querySelector('.kit-intro-card'), done: window.game.save.done, msg: window.game.messages.map((m) => m.title).join(' / '), seen: localStorage.getItem('blava-city-onboarding-v1') }));
    check(!over.done.length, `"Nová hra" over a save starts afresh (${JSON.stringify(over.done)})`);
    check(!over.open && over.msg.includes('Vitaj v Bratislave') && over.seen?.includes('offline'), `starting over, only the greeting (${JSON.stringify(over)})`);
    await ctx.close();
  }

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
