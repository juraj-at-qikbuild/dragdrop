// Phase 3 checks: server-validated PvP (shooting another player hurts them and makes you wanted) and
// persistence (money survives a server restart).

export async function run({ A, B, check, log, sleep }) {
  const ids = await Promise.all([A, B].map((p) => p.evaluate(() => window.game.host.me.id)));
  await A.evaluate(() => window.game.host.conn.send({ t: 'debug', give: 'pistol', wanted: 0 }));
  await B.evaluate(() => window.game.host.conn.send({ t: 'debug', hp: 100 }));
  await sleep(500);
  // bring A next to B with a clear line of fire (small steps the server accepts)
  const spot = await A.evaluate((bid) => {
    const g = window.game;
    const b = g.host.peds.find((p) => p.playerId === bid);
    if (!b) return null;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = b.x + Math.cos(a) * 4, y = b.y + Math.sin(a) * 4;
      if (g.world.collideCircle(x, y, 0.5) || g.world.raycast(x, y, b.x, b.y) < 1 || g.world.inWater(x, y, 0)) continue;
      return { x, y };
    }
    return null;
  }, ids[1]);
  if (!spot) return check(false, 'A found a spot to shoot B from');
  for (let i = 0; i < 200; i++) {
    const d = await A.evaluate(({ x, y }) => {
      const p = window.game.player;
      const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy);
      const s = Math.min(d, 0.35);
      if (d > 0.01) (p.x += (dx / d) * s), (p.y += (dy / d) * s);
      return d;
    }, spot);
    if (d < 0.05) break;
    await sleep(50);
  }
  await sleep(400);
  const hpBefore = await B.evaluate(() => window.game.player.health);
  for (let i = 0; i < 4; i++) {
    const pos = await A.evaluate((bid) => {
      const g = window.game;
      const b = g.host.peds.find((p) => p.playerId === bid);
      g.player.weapon = 'pistol';
      return b ? g.worldToScreen(b.x, b.y) : null;
    }, ids[1]);
    if (!pos) break;
    await A.mouse.move(pos.x, pos.y);
    await A.mouse.down();
    await sleep(60);
    await A.mouse.up();
    await sleep(450);
  }
  await sleep(800);
  const hpAfter = await B.evaluate(() => window.game.player.health);
  const aWanted = await A.evaluate(() => window.game.wanted);
  log(`B health ${hpBefore} -> ${hpAfter}, A wanted ${aWanted}`);
  check(hpAfter < hpBefore, 'shooting another player hurts them (server-side)');
  check(aWanted >= 1, `PvP makes the shooter wanted (${aWanted})`);

  // money to check after the restart
  await A.evaluate(() => window.game.host.conn.send({ t: 'debug', money: 7777 }));
  await sleep(600);
}

export async function afterRestart({ A, check, sleep }) {
  await sleep(1000);
  const money = await A.evaluate(() => window.game.save.money);
  check(money === 7777, `A's money survived the server restart (${money})`);
}
