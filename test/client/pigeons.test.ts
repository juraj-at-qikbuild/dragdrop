// The pigeons (src/world/Pigeons.ts; docs/plans/non-violent.md): flocks on open ground at the squares,
// off when a car comes through or a player runs at them (not when someone just walks by), back later.
import { describe, expect, it } from 'vitest';
import { Pigeons } from '../../src/world/Pigeons';
import { loadWorld } from '../shared/helpers';

const w = loadWorld();
const car = (x: number, y: number, vx: number, vy: number) => ({ x, y, vx, vy, level: 0 });
const walker = (x: number, y: number, speed: number, playerId = 1) => ({ x, y, vx: speed, vy: 0, playerId, state: 'walk', vehicle: null, level: 0 });

describe('the pigeons', () => {
  it('a flock at most of the squares, every bird on open ground', () => {
    const pg = new Pigeons(w);
    expect(pg.flocks.length).toBeGreaterThanOrEqual(6);
    for (const f of pg.flocks) {
      expect(f.birds.length).toBeGreaterThanOrEqual(5);
      for (const b of f.birds) {
        expect(w.collideCircle(b.x, b.y, 0.2, 0)).toBeNull();
        expect(w.inWater(b.x, b.y, 0)).toBe(false);
      }
    }
  });

  it('a car coming through sends them off, feathers and all; they come back after a while', () => {
    const pg = new Pigeons(w);
    const f = pg.flocks[0];
    const scared: number[] = [];
    pg.onScare = (_x, _y, n) => scared.push(n);
    pg.update(0.1, f, [car(f.x + 5, f.y, -10, 0)], []);
    expect(scared).toHaveLength(1);
    expect(scared[0]).toBe(f.birds.length);
    for (let t = 0; t < 3; t += 0.1) pg.update(0.1, f, [], []);
    expect(f.birds.every((b) => b.h > 0.05 || b.state === 2)).toBe(true);
    for (let t = 0; t < 50; t += 0.1) pg.update(0.1, f, [], []);
    expect(f.birds.every((b) => b.state === 0 && b.h === 0)).toBe(true);
  });

  it('a player walking by leaves them be; running at them, they take off', () => {
    const pg = new Pigeons(w);
    const f = pg.flocks[1];
    let scared = 0;
    pg.onScare = () => scared++;
    pg.update(0.1, f, [], [walker(f.x + 2, f.y, 1.4)]);
    expect(scared).toBe(0);
    pg.update(0.1, f, [], [walker(f.x + 2, f.y, 5)]);
    expect(scared).toBe(1);
  });
});
