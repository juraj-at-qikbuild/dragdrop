import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { SERVER_CAPS } from '../../src/shared/sim/density';
import { Ped } from '../../src/shared/entities/Ped';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { Tram } from '../../src/shared/entities/Tram';
import { Reader, Writer, decodeSnapshot, encodeSnapshotHeader, entityHead, pedDynamic, pedStatic, Ent } from '../../src/shared/net/codec';
import { lineText, pickLine, SAY_GUN } from '../../src/shared/sim/phrases';
import type { SimEvents } from '../../src/shared/sim/events';
import { nullEvents } from '../../src/shared/sim/events';
import { loadWorld } from './helpers';

const profile = () => ({ money: 0, done: [], found: [], cumils: [] });
const EMPTY = { ...SERVER_CAPS, traffic: 0, parked: 0, peds: 0, trams: 0, police: 0 };

/** an empty world with one player standing in an open square (Hlavné námestie), and what was said */
function scene(seed = 1) {
  const said: number[] = [];
  const msgs: string[] = [];
  const events: SimEvents = {
    ...nullEvents,
    say: (_id, _x, _y, line) => said.push(line),
    toPlayer: (_pid, e) => {
      if (e.k === 'msg') msgs.push(e.text);
    },
  };
  const sim = new Sim(loadWorld(), { rng: new Rng(seed), caps: EMPTY, events });
  const w = sim.world;
  const m = w.landmark('main');
  const s = w.clearSpot(m.x + 6, m.y + 6, 1.5);
  const pl = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: s.x, y: s.y });
  Object.assign(pl.observer, { fx: s.x, fy: s.y, cx: s.x, cy: s.y, hw: 30, hh: 18 });
  return { sim, pl, said, msgs, x: s.x, y: s.y };
}

function run(sim: Sim, seconds: number, dt = 0.05) {
  for (let t = 0; t < seconds; t += dt) sim.step(dt);
}

/** a civilian (a fighter, or someone who isn't) standing at (x, y) */
function civ(sim: Sim, x: number, y: number, fighter: boolean | null = null) {
  for (let seed = 1; ; seed++) {
    const p = new Ped('civ', x, y, seed * 7919);
    if (fighter === null || p.fighter === fighter) {
      p.state = 'idle';
      p.timer = 60;
      return sim.addPed(p);
    }
  }
}

describe('crowd', () => {
  it('people make room for each other and for the player instead of walking through them', () => {
    const { sim, pl, x, y } = scene();
    const a = civ(sim, x + 3, y), b = civ(sim, x + 3.05, y + 0.02);
    const c = civ(sim, x + 0.1, y);
    run(sim, 0.5);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r - 0.02);
    expect(Math.hypot(c.x - pl.ped.x, c.y - pl.ped.y)).toBeGreaterThan(c.r + pl.ped.r - 0.02);
    // the player's figure didn't budge
    expect(Math.hypot(pl.ped.x - x, pl.ped.y - y)).toBeLessThan(1e-9);
  });

  it('a gun pointed at someone gets their hands up (or sends them running), and a line said', () => {
    let up = 0, ran = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { sim, pl, said, x, y } = scene(seed);
      const q = civ(sim, x + 5, y, false);
      pl.ped.weapon = 'pistol';
      pl.ped.angle = Math.atan2(q.y - pl.ped.y, q.x - pl.ped.x);
      run(sim, 0.5);
      if (q.handsUp) {
        up++;
        expect(said.some((l) => l >> 4 === SAY_GUN || (l & 127) >> 4 === SAY_GUN)).toBe(true);
      } else if (q.state === 'flee') ran++;
    }
    expect(up + ran).toBe(12);
    expect(up).toBeGreaterThan(ran);
  });

  it('people sit on benches and café chairs, and get up again after a while', () => {
    const { sim, x, y } = scene(3);
    let n = 0;
    for (let i = 0; i < 40 && !n; i++) n = sim.crowd.spawnSeated(x, y, 20 + i * 5, 60 + i * 5);
    expect(n).toBeGreaterThan(0);
    const seated = sim.peds.filter((p) => p.state === 'sit');
    expect(seated.length).toBe(n);
    const p = seated[0], x0 = p.x, y0 = p.y;
    run(sim, 5);
    expect(p.state).toBe('sit');
    expect(Math.hypot(p.x - x0, p.y - y0)).toBeLessThan(1e-6);
    p.timer = 0.01;
    run(sim, 1);
    expect(p.state).not.toBe('sit');
  });

  it('people wait at tram stops and get on the tram when it stops there', () => {
    const { sim, x, y } = scene(4);
    const w = sim.world;
    let n = 0;
    for (let i = 0; i < 40 && !n; i++) n = sim.crowd.spawnWaiting(x, y, i * 30, 60 + i * 30);
    expect(n).toBeGreaterThan(0);
    const waiting = sim.peds.filter((p) => p.waitStop >= 0);
    expect(waiting.length).toBe(n);
    const stop = waiting[0].waitStop;
    // a tram standing at that stop with its doors open
    const S = w.tramStops;
    const t = new Tram(null, null);
    t.x = S[stop];
    t.y = S[stop + 1];
    t.dwell = 15;
    const a = Math.atan2(waiting[0].y - S[stop + 1], waiting[0].x - S[stop]) + Math.PI / 2;
    t.sections = [0, 1, 2].map((k) => ({ x: S[stop] - Math.cos(a) * (4.6 + k * 9.8), y: S[stop + 1] - Math.sin(a) * (4.6 + k * 9.8), a }));
    sim.addTram(t);
    Object.assign(sim.players.values().next().value!.observer, { fx: t.x, fy: t.y, cx: t.x, cy: t.y });
    // (the tram is a mirror-style one: not driven, just standing there)
    t.update = () => {};
    run(sim, 12);
    for (const p of waiting) expect(sim.peds.includes(p)).toBe(false);
  });

  it('the odd one hits back when punched', () => {
    const { sim, pl, x, y } = scene(5);
    const q = civ(sim, x + 1, y, true);
    pl.ped.angle = 0;
    sim.applyMelee(pl, q.id);
    expect(q.state).toBe('fight');
    const h0 = sim.players.get(pl.id)!.ped.health;
    run(sim, 4);
    expect(pl.ped.health).toBeLessThan(h0);
    // and most just run
    const { sim: sim2, pl: pl2, x: x2, y: y2 } = scene(6);
    const r = civ(sim2, x2 + 1, y2, false);
    pl2.ped.angle = 0;
    sim2.applyMelee(pl2, r.id);
    expect(r.state).toBe('flee');
  });

  it('a witness phones the police about a shooting with no police around, unless stopped', () => {
    const { sim, pl, msgs, x, y } = scene(7);
    for (let k = 0; k < 6; k++) civ(sim, x + 10 + k * 2, y + 8);
    sim.crime(pl, 'shoot');
    expect(pl.wanted).toBe(0);
    const w = sim.peds.find((p) => p.callPid === pl.id);
    expect(w).toBeTruthy();
    expect(msgs.length).toBe(1);
    run(sim, 14);
    expect(pl.wanted).toBeGreaterThanOrEqual(1);

    // pointing a gun at the witness while they dial stops the call
    const s2 = scene(8);
    for (let k = 0; k < 6; k++) civ(s2.sim, s2.x + 10 + k * 2, s2.y + 8);
    s2.sim.crime(s2.pl, 'shoot');
    const w2 = s2.sim.peds.find((p) => p.callPid === s2.pl.id)!;
    run(s2.sim, 4);
    expect(w2.state).toBe('phone');
    s2.pl.ped.x = w2.x - 4;
    s2.pl.ped.y = w2.y;
    s2.pl.ped.weapon = 'pistol';
    s2.pl.ped.angle = 0;
    run(s2.sim, 12);
    expect(w2.callPid).toBe(0);
    expect(s2.pl.wanted).toBe(0);
    expect(s2.msgs).toContain('Svedok nedovolal.');
  });

  it('a honk sends whoever stands in front of the car off its line', () => {
    const { sim, x, y } = scene(9);
    const v = new Vehicle('sedan', x + 20, y, 0, '#888888');
    v.parked = true;
    sim.addVehicle(v);
    const q = civ(sim, x + 25, y + 0.3);
    run(sim, 0.1);
    const lat0 = Math.abs(q.y - v.y);
    sim.honk(v);
    run(sim, 1.2);
    expect(Math.abs(q.y - v.y)).toBeGreaterThan(Math.max(lat0, v.spec.width / 2 + 0.6));
  });

  it('sends the new states and lines over the network', () => {
    for (const state of ['sit', 'phone', 'fight'] as const) {
      const w = new Writer(16);
      encodeSnapshotHeader(w, 1, 1, 1, { health: 100, armor: 0, wanted: 0, state: 'play', stateTimer: 0, searching: false, shotCops: false, money: 0, ammo: [0, 0, 0], epoch: 0, zone: null });
      w.u16(1);
      const p = new Ped('civ', 3, 4, 99);
      p.id = 5;
      p.state = state;
      entityHead(w, p.id, Ent.Ped, true, 0);
      pedStatic(w, p);
      pedDynamic(w, p, 0);
      w.u16(0);
      const snap = decodeSnapshot(new Reader(w.finish()));
      expect((snap.ents[0].v as { state: string }).state).toBe(state);
    }
    for (const tourist of [false, true]) for (let cat = 0; cat < 7; cat++) expect(lineText(pickLine(cat, tourist, 0.99))).not.toBe('');
  });
});
