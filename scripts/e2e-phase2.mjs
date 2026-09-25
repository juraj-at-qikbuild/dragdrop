// Phase 2 checks: one shared, server-simulated city. Both players see the same NPCs in the same places,
// and an NPC one of them shoots is dead for the other too.
export async function run({ A, B, check, log, sleep }) {
  await sleep(1500);
  // same NPC ids, same places (give or take interpolation)
  const view = (page) =>
    page.evaluate(() => {
      const h = window.game.host;
      const peds = {};
      for (const p of h.peds) if (!p.playerId) peds[p.id] = [p.x, p.y, p.dead];
      const cars = {};
      for (const v of h.vehicles) cars[v.id] = [v.x, v.y];
      return { peds, cars };
    });
  const [va, vb] = await Promise.all([view(A), view(B)]);
  const shared = Object.keys(va.peds).filter((id) => id in vb.peds);
  const sharedCars = Object.keys(va.cars).filter((id) => id in vb.cars);
  let maxOff = 0;
  for (const id of shared) {
    const [ax, ay] = va.peds[id], [bx, by] = vb.peds[id];
    maxOff = Math.max(maxOff, Math.hypot(ax - bx, ay - by));
  }
  log(`shared peds ${shared.length}, shared cars ${sharedCars.length}, max offset ${maxOff.toFixed(2)} m`);
  check(shared.length > 30 && sharedCars.length > 10, `both players see the same NPCs (${shared.length} peds, ${sharedCars.length} cars)`);
  check(maxOff < 3, `...in the same places (max ${maxOff.toFixed(2)} m apart)`);

  // A shoots a civilian that B can see; B sees it die
  await A.evaluate(() => window.game.host.conn.send({ t: 'debug', give: 'pistol' }));
  await sleep(400);
  let victim = null;
  const tried = [];
  for (let attempt = 0; attempt < 3 && !victim; attempt++) {
    const id = await shootSomeone(A, tried, sleep);
    if (!id) break;
    tried.push(id);
    if (await A.evaluate((id) => window.game.host.pedById(id)?.dead === true, id)) victim = id;
    else log(`attempt ${attempt + 1}: civilian ${id} survived, trying another`);
  }
  try {
    const st = await (await fetch('http://localhost:8787/stats')).json();
    log(`server: shots ${st.shots}, rejected ${st.rejected}, teleports ${st.teleports}`);
  } catch {
    /* stats unavailable */
  }
  check(!!victim, 'A shot a civilian dead');
  await sleep(500);
  const deadForB = victim ? await B.evaluate((id) => window.game.host.pedById(id)?.dead ?? null, victim) : null;
  check(deadForB === true, `B sees that civilian dead too (${deadForB})`);
  const wanted = await A.evaluate(() => window.game.wanted);
  check(wanted >= 1, `A is wanted for it (${wanted})`);
}

/** walk A to 4 m from a live civilian with a clear line of fire and shoot at it; returns its id */
async function shootSomeone(A, skip, sleep) {
  const target = await A.evaluate((skip) => {
    const g = window.game, h = g.host, p = g.player;
    const cands = h.peds.filter((q) => q.kind === 'civ' && !q.dead && !q.vehicle && q.level === p.level && !skip.includes(q.id));
    cands.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
    for (const q of cands.slice(0, 40)) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const x = q.x + Math.cos(a) * 4, y = q.y + Math.sin(a) * 4;
        if (g.world.collideCircle(x, y, 0.5) || g.world.raycast(x, y, q.x, q.y) < 1 || g.world.inWater(x, y, 0)) continue;
        if (Math.hypot(x - p.x, y - p.y) > 35) continue;
        return { id: q.id, x, y };
      }
    }
    return null;
  }, skip);
  if (!target) return null;
  // walk there in steps the server accepts
  for (let i = 0; i < 120; i++) {
    const d = await A.evaluate(({ x, y }) => {
      const p = window.game.player;
      const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy);
      const s = Math.min(d, 0.35);
      if (d > 0.01) (p.x += (dx / d) * s), (p.y += (dy / d) * s);
      return d;
    }, target);
    if (d < 0.05) break;
    await sleep(50);
  }
  await sleep(300);
  for (let i = 0; i < 8; i++) {
    const pos = await A.evaluate((id) => {
      const g = window.game;
      const t = g.host.pedById(id);
      if (!t || t.dead) return null;
      g.player.weapon = 'pistol';
      return g.worldToScreen(t.x, t.y);
    }, target.id);
    if (!pos) break;
    await A.mouse.move(pos.x, pos.y);
    await A.mouse.down();
    await sleep(60);
    await A.mouse.up();
    await sleep(450);
  }
  await sleep(800);
  return target.id;
}
