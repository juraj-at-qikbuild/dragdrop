import { describe, expect, it } from 'vitest';
import {
  Ent, Reader, Writer, decodeSnapshot, decodeState, encodeSnapshotHeader, encodeState, entityHead, pedDynamic, pedStatic,
  tramDynamic, vehicleDynamic, vehicleStatic, type StateReport,
} from '../../src/shared/net/codec';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { Ped } from '../../src/shared/entities/Ped';
import { Tram } from '../../src/shared/entities/Tram';

describe('codec', () => {
  it('round-trips a STATE report within quantisation error', () => {
    const r: StateReport = {
      seq: 65535, epoch: 7, lvl: 1, x: -1234.567, y: 987.654, a: -2.5, vx: 12.34, vy: -5.67, weapon: 'uzi', camDx: 8, camDy: -12, hw: 32.5, hh: 18.2,
      veh: { vid: 4242, av: 0.321, steer: -0.5, throttle: 1, handbrake: true, boost: false, siren: true, horn: false, boosting: true, wrecked: false, tyres: true, health: 87.5, dmg: [0.4, 0, 1, 0.2], fire: 2.5, sinking: 0, nitro: 0.5, skid: 0.8 },
    };
    const w = new Writer(8);
    encodeState(w, r);
    const d = decodeState(new Reader(w.finish()));
    expect(d.seq).toBe(65535);
    expect(d.epoch).toBe(7);
    expect(d.lvl).toBe(1);
    expect(Math.abs(d.x - r.x)).toBeLessThanOrEqual(1 / 32);
    expect(Math.abs(d.y - r.y)).toBeLessThanOrEqual(1 / 32);
    expect(Math.abs(Math.atan2(Math.sin(d.a - r.a), Math.cos(d.a - r.a)))).toBeLessThan(1e-4);
    expect(d.vx).toBeCloseTo(12.34, 2);
    expect(d.weapon).toBe('uzi');
    expect(d.veh!.vid).toBe(4242);
    expect(d.veh!.siren).toBe(true);
    expect(d.veh!.tyres).toBe(true);
    expect(d.veh!.health).toBeCloseTo(87.5, 1);
    expect(d.veh!.dmg[2]).toBeCloseTo(1, 1);
    expect(d.veh!.fire).toBeCloseTo(2.5, 2);
  });

  it('round-trips a snapshot with vehicles, peds and trams', () => {
    const w = new Writer(16);
    encodeSnapshotHeader(w, 99, 1.7e12 + 123.5, 42, { health: 80, armor: 50, wanted: 2.5, state: 'play', stateTimer: 0, searching: true, shotCops: false, money: 12345, ammo: [10, 200, 3], epoch: 3, zone: { x: 10, y: -20, r: 60 } });
    const at = w.n;
    w.u16(3);
    const v = new Vehicle('police', 100.5, -50.25, 1.2, '#f5f5f5');
    v.id = 17;
    v.siren = true;
    v.vx = 20;
    v.dmg.front = 0.5;
    entityHead(w, v.id, Ent.Vehicle, true, 0);
    vehicleStatic(w, v, false);
    vehicleDynamic(w, v);
    const p = new Ped('player', 3, 4, 777);
    p.id = 18;
    p.playerId = 5;
    p.look = 2;
    p.state = 'dead';
    entityHead(w, p.id, Ent.Ped, true, 1);
    pedStatic(w, p);
    pedDynamic(w, p, 4);
    const t = new Tram(null, null);
    t.id = 19;
    t.sections = [{ x: 1, y: 2, a: 0.1 }, { x: 3, y: 4, a: 0.2 }, { x: 5, y: 6, a: 0.3 }];
    t.speed = 9.5;
    entityHead(w, t.id, Ent.Tram, false, 0);
    tramDynamic(w, t);
    w.patchU16(at, 3);
    w.u16(2);
    w.u16(5);
    w.u16(6);
    const s = decodeSnapshot(new Reader(w.finish()));
    expect(s.tick).toBe(99);
    expect(s.st).toBe(1.7e12 + 123.5);
    expect(s.me).toMatchObject({ health: 80, armor: 50, state: 'play', searching: true, money: 12345, ammo: [10, 200, 3], epoch: 3 });
    expect(s.me.wanted).toBeCloseTo(2.5, 1);
    expect(s.me.zone).toEqual({ x: 10, y: -20, r: 60 });
    const [ev, ep, et] = s.ents;
    expect(ev.type).toBe(Ent.Vehicle);
    if (ev.type === Ent.Vehicle) {
      expect(ev.v.kind).toBe('police');
      expect(ev.v.color).toBe('#f5f5f5');
      expect(ev.v.siren).toBe(true);
      expect(ev.v.x).toBeCloseTo(100.5, 1);
      expect(ev.v.vx).toBeCloseTo(20, 2);
      expect(ev.v.dmg[0]).toBeCloseTo(0.5, 1);
    }
    if (ep.type === Ent.Ped) {
      expect(ep.level).toBe(1);
      expect(ep.v.seed).toBe(777);
      expect(ep.v.playerId).toBe(5);
      expect(ep.v.state).toBe('dead');
      expect(ep.v.stars).toBe(4);
    }
    if (et.type === Ent.Tram) expect(et.v.sections[2].x).toBeCloseTo(5, 1);
    expect(s.gone).toEqual([5, 6]);
  });

  it('rejects truncated messages', () => {
    const w = new Writer();
    encodeState(w, { seq: 1, epoch: 0, lvl: 0, x: 0, y: 0, a: 0, vx: 0, vy: 0, weapon: 'fist', camDx: 0, camDy: 0, hw: 10, hh: 10, veh: null });
    const b = w.finish();
    expect(() => decodeState(new Reader(b.slice(0, b.length - 3)))).toThrow(RangeError);
  });

  it('clamps positions outside ±2 km instead of wrapping', () => {
    const w = new Writer();
    w.pos(5000);
    w.pos(-5000);
    const r = new Reader(w.finish());
    expect(r.pos()).toBeCloseTo(2047.9, 0);
    expect(r.pos()).toBeCloseTo(-2048, 0);
  });
});
