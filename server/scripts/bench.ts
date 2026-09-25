// Simulation-only benchmark: N players spread over the city (or clustered), no networking.
// Prints the average/p95 step time and entity counts; run with `node --cpu-prof` via tsx to profile.
//
//   tsx scripts/bench.ts --players 30 --spread city --seconds 30
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { World } from '../../src/shared/world/World';
import type { MapJSON } from '../../src/shared/types';
import { Sim } from '../../src/shared/sim/Sim';
import { SERVER_CAPS } from '../../src/shared/sim/density';
import { Rng } from '../../src/shared/util/Rng';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const N = Number(args.get('players') ?? 30);
const SPREAD = args.get('spread') ?? 'city';
const SECONDS = Number(args.get('seconds') ?? 30);
const GOVERNOR = args.has('governor') ? Number(args.get('governor')) : 1;

const world = new World(JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../public/data/bratislava.json'), 'utf8')) as MapJSON);
const sim = new Sim(world, { rng: new Rng(1), caps: SERVER_CAPS, extrapolatePlayers: true });
sim.physics.step_ = 1 / 60;
sim.coarsePhysics = true;
sim.governor = GOVERNOR;
const g = world.ped;
const bots = [];
for (let i = 0; i < N; i++) {
  let s;
  if (SPREAD === 'cluster') {
    const m = world.landmark('main');
    s = world.walkableNear(m.x + ((i * 7) % 60) - 30, m.y + ((i * 13) % 60) - 30);
  } else {
    const b = world.bounds;
    s = world.walkableNear(b.x0 + 150 + ((i * 7919) % (b.x1 - b.x0 - 300)), b.y0 + 150 + ((i * 6271) % (b.y1 - b.y0 - 300)));
  }
  const p = sim.addPlayer({ nick: 'B' + i, profile: { money: 0, done: [], found: [], cumils: [] }, kinematic: true, x: s.x, y: s.y });
  bots.push({ p, node: g.nearest(s.x, s.y, 200), target: -1 });
}
const DT = 0.05;
const times: number[] = [];
for (let t = 0; t < SECONDS; t += DT) {
  for (const b of bots) {
    const ped = b.p.ped;
    if (b.target < 0 || Math.hypot(g.nx(b.target) - ped.x, g.ny(b.target) - ped.y) < 1) {
      if (b.target >= 0) b.node = b.target;
      const opts = g.out[b.node] ?? [];
      b.target = opts.length ? opts[Math.floor(Math.random() * opts.length)].to : b.node;
    }
    const tx = g.nx(b.target), ty = g.ny(b.target);
    const d = Math.hypot(tx - ped.x, ty - ped.y) || 1;
    ped.x += ((tx - ped.x) / d) * Math.min(d, 5 * DT);
    ped.y += ((ty - ped.y) / d) * Math.min(d, 5 * DT);
    Object.assign(b.p.observer, { fx: ped.x, fy: ped.y, cx: ped.x, cy: ped.y, hw: 30, hh: 18 });
  }
  const t0 = performance.now();
  sim.step(DT);
  times.push(performance.now() - t0);
}
const warm = times.slice(Math.floor(times.length / 3)).sort((a, b) => a - b);
const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
console.log(
  `${N} players (${SPREAD}), governor ${GOVERNOR}: step avg ${avg.toFixed(2)} ms, p95 ${warm[Math.floor(warm.length * 0.95)].toFixed(2)} ms; ` +
    `vehicles ${sim.vehicles.length} (parked ${sim.vehicles.filter((v) => v.parked).length}), peds ${sim.peds.length}, trams ${sim.trams.length}`,
);
