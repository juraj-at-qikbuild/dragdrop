// Where new players start (src/shared/world/spawns.ts): every spawn place is open ground at street
// level on the real map that a player can walk away from, and a game that asks for random spawns
// (the offline game and the server) puts each new player at one of them.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Ped } from '../../src/shared/entities/Ped';
import { Rng } from '../../src/shared/util/Rng';
import { dist } from '../../src/shared/util/math';
import { SPAWNS, SPAWN_SPREAD, spawnAt } from '../../src/shared/world/spawns';
import { underAnyRoof } from '../../src/shared/world/spots';
import { SERVER_CAPS } from '../../src/shared/sim/density';
import { loadWorld } from './helpers';

const profile = () => ({ money: 0, done: [], found: [], cumils: [] });
/** no NPCs: just the players */
const EMPTY = { ...SERVER_CAPS, traffic: 0, parked: 0, peds: 0, trams: 0, police: 0 };

describe('spawn places', () => {
  it('are about ten, spread over the city', () => {
    expect(SPAWNS.length).toBeGreaterThanOrEqual(8);
    for (const a of SPAWNS) for (const b of SPAWNS) if (a !== b) expect(dist(a.x, a.y, b.x, b.y), `${a.name} / ${b.name}`).toBeGreaterThan(150);
  });

  it('are open ground at street level: no building, roof, water or bridge deck anywhere a player is put', () => {
    const w = loadWorld();
    for (const s of SPAWNS) {
      // the place itself and the ring a second arrival steps aside to
      for (let k = 0; k <= 16; k++) {
        const r = k ? SPAWN_SPREAD : 0, a = (k / 16) * Math.PI * 2;
        const x = s.x + Math.cos(a) * r, y = s.y + Math.sin(a) * r;
        expect(w.insideBuilding(x, y), s.name).toBe(false);
        expect(underAnyRoof(w, x, y), s.name).toBe(false);
        expect(w.inWater(x, y, 0), s.name).toBe(false);
        expect(w.onBridge(x, y), s.name).toBe(false);
        expect(w.spawnLevel(x, y, 0.4), s.name).toBe(0);
        expect(w.collideCircle(x, y, 0.5, 0, false), s.name).toBe(null);
      }
      // on the footpaths, and a road a short walk away (the Old Town's squares are pedestrian)
      expect(w.ped.nearest(s.x, s.y, 10), s.name).toBeGreaterThanOrEqual(0);
      expect(w.car.nearest(s.x, s.y, 160), s.name).toBeGreaterThanOrEqual(0);
    }
  });

  it('let a player walk off in every direction, and never into a building', () => {
    const w = loadWorld();
    for (const s of SPAWNS) {
      let free = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const p = new Ped('player', s.x, s.y, 1);
        p.levelInit = true;
        // 1.5 s of running (7.2 m/s) that way, sliding along whatever is in the way
        for (let t = 0; t < 1.5; t += 1 / 60) {
          p.move(1 / 60, w, Math.cos(a) * 7.2, Math.sin(a) * 7.2);
          w.updateLevel(p, p.vx, p.vy, p.r);
        }
        expect(w.insideBuilding(p.x, p.y), `${s.name} going ${k * 45}°`).toBe(false);
        expect(p.level, `${s.name} going ${k * 45}°`).toBe(0);
        if (dist(p.x, p.y, s.x, s.y) > 8) free++;
      }
      expect(free, s.name).toBeGreaterThanOrEqual(6);
    }
  });
});

describe('random spawns', () => {
  it('start new games at different spawn places', () => {
    const w = loadWorld();
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const sim = new Sim(w, { rng: new Rng(seed), caps: EMPTY, randomSpawn: true });
      const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
      const at = spawnAt(p.ped.x, p.ped.y);
      expect(at, `seed ${seed}`).not.toBe(null);
      seen.add(at!.name);
    }
    expect(seen.size).toBeGreaterThanOrEqual(7);
  });

  it('puts every new player at a spawn place, a step aside from anyone already standing there', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(3), caps: EMPTY, randomSpawn: true });
    const players = Array.from({ length: 30 }, (_, i) => sim.addPlayer({ nick: 'P' + i, profile: profile(), kinematic: true }));
    for (const p of players) expect(spawnAt(p.ped.x, p.ped.y), p.nick).not.toBe(null);
    for (const a of players) for (const b of players) if (a !== b) expect(dist(a.ped.x, a.ped.y, b.ped.x, b.ped.y), `${a.nick} / ${b.nick}`).toBeGreaterThan(1);
  });

  it('keeps a given position (a player coming back), and the square without randomSpawn', () => {
    const w = loadWorld();
    const sim = new Sim(w, { rng: new Rng(4), caps: EMPTY, randomSpawn: true });
    const back = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true, x: 12, y: 34 });
    expect([back.ped.x, back.ped.y]).toEqual([12, 34]);
    const main = w.landmark('main');
    const plain = new Sim(w, { rng: new Rng(4), caps: EMPTY }).addPlayer({ nick: 'C', profile: profile(), kinematic: false });
    expect(dist(plain.ped.x, plain.ped.y, main.x, main.y)).toBeLessThan(30);
  });
});
