// The shops online (docs/plans/gameplay.md, Phase 2), with two real clients: the server's price list,
// buying a jacket and a hat through the panel (and the other player seeing them), and the garage: a
// car parked in it leaves the street for both players, comes back at the door held for its owner, and
// the gear outlives a server restart. The rules themselves: test/shared/shops.test.ts.

/** the shops as the client works them out (ShopsUi.places) */
const place = (page, id) => page.evaluate((id) => window.game.features.find((f) => f.id === 'shops').places.find((s) => s.id === id), id);
const send = (page, msg) => page.evaluate((m) => window.game.host.conn.send(m), msg);
const near = (page, x, y, r = 3) => page.evaluate(({ x, y, r }) => Math.hypot(window.game.player.x - x, window.game.player.y - y) < r, { x, y, r });

async function teleport(page, x, y, waitFor) {
  await send(page, { t: 'debug', teleport: [x, y] });
  return waitFor(page, ({ x, y }) => Math.hypot(window.game.player.x - x, window.game.player.y - y) < 4, { x, y }, 5000, 'the teleport');
}

export async function run(t) {
  const { A, B, waitFor } = t;
  // where they stand now, and A's money: put back after, as the checks after a restart expect them
  const home = await Promise.all([A, B].map((p) => p.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y }))));
  const money = await A.evaluate(() => window.game.save.money);
  try {
    await shops(t);
  } finally {
    await A.evaluate(() => window.game.player.vehicle && window.game.host.requestExit());
    await teleport(A, home[0].x, home[0].y, waitFor);
    await teleport(B, home[1].x, home[1].y, waitFor);
    await send(A, { t: 'debug', money });
    await t.sleep(800);
  }
}

async function shops({ A, B, check, log, sleep, waitFor }) {
  check(await waitFor(A, () => !!window.game.host.live.catalog?.pistol, null, 5000, 'a catalog'), 'the server sent its price list');
  const [aId] = await Promise.all([A, B].map((p) => p.evaluate(() => window.game.host.me.id)));
  await send(A, { t: 'debug', money: 20000, wanted: 0 });

  // ---- the Butik: a jacket and a hat, bought through the panel, seen by B
  const butik = await place(A, 'clothes-kamenne');
  await teleport(B, butik.x + 4, butik.y + 2, waitFor);
  await teleport(A, butik.x, butik.y, waitFor);
  const opened = await waitFor(A, () => !!document.querySelector('.kit-shop-card'), null, 5000, 'the Butik panel');
  check(opened, 'walking into the Butik opens its panel (online)');
  if (opened) {
    const look = await A.evaluate(() => (window.game.player.look + 4) % 10);
    await A.click(`button[data-k="jacket:${look}"]`);
    await A.click('button[data-k="hat:1"]');
    const shirt = await A.evaluate((l) => ['#4a3220', '#1565c0', '#2e7d32', '#6a1b9a', '#c62828', '#00838f', '#ef6c00', '#37474f', '#ad1457', '#9e9d24'][l], look);
    check(
      await waitFor(A, (l) => window.game.save.gear?.look === l && window.game.player.hat === 1, look, 3000, "A's new clothes"),
      'A wears the jacket and the hat bought (the server said so)',
    );
    check(
      await waitFor(B, ({ id, shirt }) => { const p = window.game.host.peds.find((q) => q.playerId === id); return p?.shirt === shirt && p.hairStyle === 'cap'; }, { id: aId, shirt }, 4000, "B's view of A"),
      "B sees A's new jacket and cap",
    );
    await A.keyboard.press('Escape');
  }

  // ---- the garage: buy it on foot, drive a car in, park it, take it out
  const garage = await place(A, 'garage-hviezdoslavovo-namestie');
  await teleport(A, garage.x + 1.5, garage.y + 1.5, waitFor);
  if (await waitFor(A, () => !!document.querySelector('.kit-shop-card'), null, 5000, 'the garage panel')) {
    await A.click('button[data-k="garage"]');
    check(await waitFor(A, (id) => window.game.save.gear?.garages?.includes(id), garage.id, 3000, 'the garage bought'), 'A bought the garage');
    await A.keyboard.press('Escape');
  } else check(false, 'the garage panel opens');
  // a car to park there: one the test server puts beside A (debug), which A gets into by the door
  await send(A, { t: 'debug', car: 'classic' });
  const car = await waitFor(A, ({ x, y }) => window.game.host.vehicles.some((v) => v.kind === 'classic' && v.parked && Math.hypot(v.x - x, v.y - y) < 8), garage, 4000, 'the car')
    .then(() => A.evaluate(({ x, y }) => {
      const v = window.game.host.vehicles.find((q) => q.kind === 'classic' && q.parked && Math.hypot(q.x - x, q.y - y) < 8);
      return v && { id: v.id, x: v.x, y: v.y, a: v.angle, color: v.color, kind: v.kind };
    }, garage));
  if (!car) return check(false, 'the test server parks a car beside A');
  await A.bringToFront();
  await A.keyboard.press('KeyF');
  if (!(await waitFor(A, (id) => window.game.player.vehicle?.id === id, car.id, 4000, 'A in the car'))) return check(false, 'A gets into the car by the garage');
  // getting in isn't pulling up (no panel then): roll it a little, and stopping there is
  check(!(await A.$('.kit-shop-card')), 'getting into a car at the garage door opens no panel');
  await A.evaluate(() => {
    const v = window.game.player.vehicle;
    v.vx = Math.cos(v.angle) * 1.5;
    v.vy = Math.sin(v.angle) * 1.5;
  });
  const parked = await waitFor(A, () => !!document.querySelector('.kit-shop-card button[data-k="store"]'), null, 5000, 'the garage panel, in the car');
  if (!parked)
    log(
      'at the door:',
      JSON.stringify(
        await A.evaluate(({ x, y }) => {
          const g = window.game, v = g.player.vehicle, ui = g.features.find((f) => f.id === 'shops');
          return {
            inCar: !!v, d: v ? Math.hypot(v.x - x, v.y - y) : null, speed: v?.speed, kind: v?.kind,
            title: document.querySelector('.kit-modal h2')?.textContent, keys: [...document.querySelectorAll('.kit-modal [data-k]')].map((e) => e.dataset.k),
            visited: [...ui.visited], visitedAt: ui.visitedAt, paused: g.paused, state: g.state,
          };
        }, garage),
      ),
    );
  check(parked, 'stopping a car at the garage door opens its panel');
  if (!parked) return;
  await A.click('button[data-k="store"]');
  check(
    await waitFor(A, (id) => !window.game.player.vehicle && !window.game.host.vehicles.some((v) => v.id === id) && window.game.save.gear?.cars?.length === 1, car.id, 4000, 'the car stored'),
    'parking in the garage: A stands at the door and the car is gone from the street',
  );
  // the car is gone for B too
  check(await waitFor(B, (id) => !window.game.host.vehicles.some((v) => v.id === id), car.id, 4000, "the car gone for B"), 'B no longer sees the stored car');
  // (traffic passing the door holds it up: "Pred garážou niečo stojí", try again in a moment)
  for (let i = 0; i < 6; i++) {
    await sleep(i ? 1000 : 300);
    const asked = await A.evaluate(() => window.game.host.live.shop?.at ?? 0);
    await A.click('button[data-k="car:0"]');
    await waitFor(A, (at) => (window.game.host.live.shop?.at ?? 0) > at, asked, 3000, 'the answer');
    const ans = await A.evaluate(() => window.game.host.live.shop);
    if (ans?.ok) break;
    log('taking it out:', ans?.text);
    if (!(await A.$('button[data-k="car:0"]'))) break;
  }
  const back = await waitFor(
    A,
    ({ x, y, color }) => window.game.host.vehicles.some((v) => v.color === color && Math.hypot(v.x - x, v.y - y) < 1.5),
    { x: garage.x, y: garage.y, color: car.color },
    4000,
    'the car back at the door',
  );
  check(back && !(await A.$('.kit-shop-card')), 'taking it out puts it at the door, and the panel makes way');
  const out = await A.evaluate(({ x, y, color }) => window.game.host.vehicles.find((v) => v.color === color && Math.hypot(v.x - x, v.y - y) < 1.5)?.id, { ...garage, color: car.color });
  // stand beside it and get in
  const side = await A.evaluate((id) => { const v = window.game.host.vehicleById(id); return { x: v.x - Math.sin(v.angle) * 2.4, y: v.y + Math.cos(v.angle) * 2.4 }; }, out);
  for (let i = 0; i < 60 && !(await near(A, side.x, side.y, 0.3)); i++) {
    await A.evaluate(({ x, y }) => {
      const p = window.game.player;
      const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy), s = Math.min(d, 0.3);
      if (d > 0.01) (p.x += (dx / d) * s), (p.y += (dy / d) * s);
    }, side);
    await sleep(40);
  }
  await A.keyboard.press('KeyF');
  check(await waitFor(A, (id) => window.game.player.vehicle?.id === id, out, 4000, 'A back in the car'), 'A gets back into the car taken out of the garage');
}

export async function afterRestart({ A, check, waitFor }) {
  check(await waitFor(A, () => !!window.game.host.live.catalog, null, 5000, 'a catalog after the restart'), 'the price list comes again after a reconnect');
  check(
    await waitFor(A, () => window.game.save.gear?.hat === 1 && window.game.save.gear?.garages?.length === 1 && window.game.player.hat === 1, null, 5000, 'the gear after the restart'),
    "A's gear (clothes, garage) survived the server restart",
  );
}
