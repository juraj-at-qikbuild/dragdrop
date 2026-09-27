// Trams online (docs/plans/gameplay.md, Phase 3), with two real clients: A gets on a tram standing at
// a stop (and vanishes from B's view), gets off again (and is back), then takes the cab of a stopped
// tram, drives it and climbs out. The rule itself: test/shared/trams.test.ts; the server's side of it:
// server/test/room.test.ts.

const send = (page, msg) => page.evaluate((m) => window.game.host.conn.send(m), msg);

async function teleport(page, x, y, waitFor) {
  await send(page, { t: 'debug', teleport: [x, y] });
  return waitFor(page, ({ x, y }) => Math.hypot(window.game.player.x - x, window.game.player.y - y) < 6, { x, y }, 5000, 'the teleport');
}

/** walk the page's own figure to (x, y) in steps the server takes as walking */
async function walkTo(page, x, y, sleep) {
  for (let i = 0; i < 300; i++) {
    const d = await page.evaluate(({ x, y }) => {
      const p = window.game.player;
      const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy), s = Math.min(d, 0.3);
      if (d > 0.01) (p.x += (dx / d) * s), (p.y += (dy / d) * s);
      return d;
    }, { x, y });
    if (d < 0.05) return true;
    await sleep(50);
  }
  return false;
}

/** does B see A's figure? */
const bSeesA = (B, aId) => B.evaluate((id) => window.game.host.peds.some((p) => p.playerId === id), aId);

export async function run(t) {
  const { A, B, waitFor, sleep } = t;
  // where they stand now, and A's money (a pickup on the way to the tram adds to it): put back after,
  // as the checks after a restart expect them
  const home = await Promise.all([A, B].map((p) => p.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y }))));
  const money = await A.evaluate(() => window.game.save.money);
  try {
    await trams(t);
  } finally {
    await A.evaluate(() => window.game.host.live.tram && window.game.host.tram('off'));
    await sleep(300);
    await teleport(A, home[0].x, home[0].y, waitFor);
    await teleport(B, home[1].x, home[1].y, waitFor);
    await send(A, { t: 'debug', wanted: 0, money });
    await sleep(800);
  }
}

async function trams({ A, B, check, log, sleep, waitFor }) {
  check(await A.evaluate(() => window.game.host.takesTrams), 'the server takes trams (its welcome lists them)');
  const aId = await A.evaluate(() => window.game.host.me.id);
  // both of them by the tram stop nearest A, and trams on their way to it
  const stop = await A.evaluate(() => {
    const g = window.game, S = g.world.tramStops, p = g.player;
    let b = 0;
    for (let i = 0; i < S.length; i += 2) if (Math.hypot(S[i] - p.x, S[i + 1] - p.y) < Math.hypot(S[b] - p.x, S[b + 1] - p.y)) b = i;
    return { x: S[b], y: S[b + 1] };
  });
  await teleport(A, stop.x + 6, stop.y + 6, waitFor);
  await teleport(B, stop.x - 10, stop.y + 8, waitFor);
  await send(A, { t: 'debug', tram: true });
  // one standing at a stop with its doors open, as A's client sees it
  const standing = () =>
    A.evaluate(() => {
      const g = window.game, p = g.player;
      let best = null;
      for (const t of g.host.trams) if (t.dwell > 0 && Math.hypot(t.x - p.x, t.y - p.y) < 250 && (!best || Math.hypot(t.x - p.x, t.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y))) best = t;
      return best && { id: best.id, x: best.x, y: best.y, doors: best.doorSpots() };
    });
  if (!(await waitFor(A, () => window.game.host.trams.some((t) => t.dwell > 0 && Math.hypot(t.x - window.game.player.x, t.y - window.game.player.y) < 250), null, 60000, 'a tram at a stop')))
    return check(false, 'a tram pulls in at a stop near A');
  let tram = await standing();
  // B close by; A to its nearest door
  await teleport(B, tram.x + 12, tram.y + 12, waitFor);
  const door = await A.evaluate(({ doors }) => {
    const p = window.game.player, w = window.game.world;
    let b = -1;
    for (let i = 0; i < doors.length; i += 2) {
      if (w.collideCircle(doors[i], doors[i + 1], 0.4)) continue;
      if (b < 0 || Math.hypot(doors[i] - p.x, doors[i + 1] - p.y) < Math.hypot(doors[b] - p.x, doors[b + 1] - p.y)) b = i;
    }
    return b < 0 ? null : { x: doors[b], y: doors[b + 1] };
  }, tram);
  if (!door) return check(false, 'a door A can get to');
  await teleport(A, door.x, door.y, waitFor);
  await walkTo(A, door.x, door.y, sleep);
  await sleep(300);
  const boardText = await A.evaluate(() => window.game.prompt()?.text);
  await A.bringToFront();
  await A.keyboard.press('KeyF');
  const on = await waitFor(A, (id) => window.game.host.live.tram?.id === id, tram.id, 4000, 'A on the tram');
  check(on, `A gets on a tram at a stop with F ("${boardText}")`);
  if (!on) {
    log('at the door:', JSON.stringify(await A.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y, prompt: window.game.prompt() }))));
    return;
  }
  check(await waitFor(B, (id) => !window.game.host.peds.some((p) => p.playerId === id), aId, 3000, 'A gone from B'), 'B no longer sees A (aboard, out of sight)');
  // off again while it still stands there: back in B's view
  await A.keyboard.press('KeyF');
  check(await waitFor(A, () => !window.game.host.live.tram, null, 4000, 'A off the tram'), 'A gets off with F');
  check(await waitFor(B, (id) => window.game.host.peds.some((p) => p.playerId === id), aId, 4000, 'A back for B'), 'B sees A again');

  // the cab of a stopped tram: a crime, and A drives it
  tram = await standing();
  if (!tram) return check(false, 'a tram still standing there for the cab');
  const nose = await A.evaluate((id) => {
    const t = window.game.host.trams.find((q) => q.id === id);
    return { x: t.x + Math.cos(t.angle) * 1.2, y: t.y + Math.sin(t.angle) * 1.2 };
  }, tram.id);
  await walkTo(A, nose.x, nose.y, sleep);
  await sleep(300);
  const cabText = await A.evaluate(() => window.game.prompt()?.text);
  await A.keyboard.press('KeyF');
  const cab = await waitFor(A, (id) => window.game.host.live.tram?.id === id && window.game.host.live.tram.cab, tram.id, 4000, 'A in the cab');
  check(cab, `A takes the cab with F ("${cabText}")`);
  if (!cab) return;
  const t0 = await A.evaluate((id) => { const t = window.game.host.trams.find((q) => q.id === id); return { x: t.x, y: t.y }; }, tram.id);
  await A.keyboard.down('KeyW');
  await sleep(3000);
  await A.keyboard.up('KeyW');
  const drove = await A.evaluate(({ id, x, y }) => {
    const g = window.game, t = g.host.trams.find((q) => q.id === id);
    return { d: t ? Math.hypot(t.x - x, t.y - y) : 0, wanted: g.wanted, withIt: !!t && Math.hypot(g.player.x - t.x, g.player.y - t.y) < 4 };
  }, { id: tram.id, ...t0 });
  check(drove.d > 3 && drove.withIt && drove.wanted >= 2, `the tram drives from its cab, and it's a crime (${JSON.stringify(drove)})`);
  await A.keyboard.down('KeyS');
  await sleep(3500);
  await A.keyboard.up('KeyS');
  await A.keyboard.press('KeyF');
  check(await waitFor(A, () => !window.game.host.live.tram, null, 4000, 'A out of the cab'), 'A climbs out once it has stopped');
}
