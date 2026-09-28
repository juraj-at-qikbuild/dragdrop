// Mini-games online (docs/plans/minigames.md), with two real clients: A starts a round of Súrna potreba
// next to B, B sees it to join in the city-wide state and joins, A starts it at once, and both play
// the same round (each with their own bladder and marks); then B leaves and A ends it. The rule
// itself: test/shared/minigames/; the server's side: server/test/minigames.test.ts.

const send = (page, msg) => page.evaluate((m) => window.game.host.conn.send(m), msg);

async function teleport(page, x, y, waitFor) {
  await send(page, { t: 'debug', teleport: [x, y] });
  return waitFor(page, ({ x, y }) => Math.hypot(window.game.player.x - x, window.game.player.y - y) < 6, { x, y }, 5000, 'the teleport');
}

export async function run(t) {
  const { A, B, waitFor, sleep } = t;
  const home = await Promise.all([A, B].map((p) => p.evaluate(() => ({ x: window.game.player.x, y: window.game.player.y }))));
  try {
    await minigames(t);
  } finally {
    for (const p of [A, B]) await p.evaluate(() => window.game.host.live.mini && window.game.host.mini({ op: 'leave' }));
    await sleep(300);
    await teleport(A, home[0].x, home[0].y, waitFor);
    await teleport(B, home[1].x, home[1].y, waitFor);
    await sleep(500);
  }
}

async function minigames({ A, B, check, sleep, waitFor }) {
  check(await A.evaluate(() => window.game.host.takesMini), 'the server takes mini-games (its welcome lists them)');
  // nobody plays with the police after them (the earlier phases leave A wanted)
  for (const p of [A, B]) await send(p, { t: 'debug', wanted: 0 });
  await waitFor(A, () => window.game.wanted === 0, null, 5000, 'A no longer wanted');
  // both of them on Hlavné námestie, a few metres apart
  const at = await A.evaluate(() => {
    const l = window.game.world.landmark('main');
    return window.game.world.walkableNear(l.x, l.y);
  });
  await teleport(A, at.x, at.y, waitFor);
  await teleport(B, at.x + 8, at.y + 4, waitFor);
  await sleep(600);
  const aNick = await A.evaluate(() => window.game.host.net.nick);
  await A.evaluate(() => window.game.host.mini({ op: 'start', kind: 'toilet' }));
  check(await waitFor(A, () => window.game.host.live.mini?.phase === 'lobby', null, 5000, "A's lobby"), 'A opens a round of Súrna potreba: a lobby, since B could join');
  // B sees it in the city-wide state, joinable, and joins
  const open = await waitFor(B, (nick) => window.game.host.live.miniOpen.some((o) => o.kind === 'toilet' && o.nick === nick), aNick, 5000, "A's round in B's wev");
  check(open, "B sees A's round to join (wev.mg)");
  const id = await B.evaluate((nick) => window.game.host.live.miniOpen.find((o) => o.nick === nick)?.id, aNick);
  await B.evaluate((id) => window.game.host.mini({ op: 'join', id }), id);
  check(await waitFor(A, () => window.game.host.live.mini?.n === 2, null, 5000, 'two players in the round'), "B joins A's round");
  // A doesn't wait out the lobby
  await A.evaluate(() => window.game.host.mini({ op: 'act' }));
  const live = (p) => waitFor(p, () => window.game.host.live.mini?.phase === 'live', null, 8000, 'the round live');
  check((await live(A)) && (await live(B)), 'the round goes live for both after A starts it');
  const st = await Promise.all([A, B].map((p) => p.evaluate(() => window.game.host.live.mini)));
  check(st.every((s) => s?.bar?.label === 'Mechúr' && (s.marks?.length ?? 0) >= 2), 'each player has a bladder and the toilets on their map');
  check(st[0]?.id === st[1]?.id, 'the same round for both');
  // B walks off; A carries on alone
  await B.evaluate(() => window.game.host.mini({ op: 'leave' }));
  check(await waitFor(B, () => window.game.host.live.mini === null, null, 5000, "B's round gone"), 'B leaves the round');
  check(await waitFor(A, () => window.game.host.live.mini?.n === 1, null, 5000, 'A alone'), 'A carries on alone');
  await A.evaluate(() => window.game.host.mini({ op: 'leave' }));
  check(await waitFor(A, () => window.game.host.live.mini === null, null, 5000, "A's round gone"), 'A leaves: the round is over');
}
