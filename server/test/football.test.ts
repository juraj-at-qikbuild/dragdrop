// Vydrž do 95. minúty online (src/shared/sim/rules/minigames/games/football.ts): the ball is the
// server's (a dynamic body its Sim simulates), every client gets it in its snapshots as a vehicle of
// kind 'ball', and a player's car, which their own client drives (a moving wall on the server), knocks
// it away.
import { describe, expect, it } from 'vitest';
import { Room } from '../src/Room';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import { Ent } from '../../src/shared/net/codec';
import type { Vehicle } from '../../src/shared/entities/Vehicle';
import { FakeClock, FakeLink, TOKEN_A, disabledSupa, loadWorld, stateMsg } from './helpers';

function setup() {
  const clock = new FakeClock();
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 42, debug: true, supa: disabledSupa() });
  const join = (token: string, nick: string) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick }));
    const w = link.last('welcome');
    return { link, conn, id: w.id, send: (m: object | Uint8Array) => room.onMessage(conn, m instanceof Uint8Array ? m : JSON.stringify(m)) };
  };
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  return { room, join, tick };
}

describe('car football through the Room', () => {
  it('simulates the ball on the server, sends it as a ball, and a player\'s car knocks it away', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Fero');
    const p = room.sim.players.get(a.id)!;
    const aupark = room.sim.world.walkableNear(room.sim.world.landmark('aupark').x, room.sim.world.landmark('aupark').y);
    a.send({ t: 'debug', teleport: [aupark.x, aupark.y] });
    a.send(stateMsg(p.ped.x, p.ped.y, { epoch: p.epoch }));
    tick(2);
    a.send({ t: 'debug', mini: 'football' });
    tick(80);
    // the car waiting for Fero: he steps up to it and gets in (his client has it from a snapshot)
    const car = room.sim.vehicles.find((v) => v.reservedFor === p.id)!;
    expect(car).toBeTruthy();
    a.send({ t: 'debug', teleport: [car.x + Math.cos(car.angle + Math.PI / 2) * 2.6, car.y + Math.sin(car.angle + Math.PI / 2) * 2.6] });
    a.send(stateMsg(p.ped.x, p.ped.y, { epoch: p.epoch }));
    tick(1);
    a.send({ t: 'enter', vid: car.id });
    tick(1);
    expect(p.ped.vehicle).toBe(car);
    expect(car.kinematic).toBe(true);
    tick(70);
    const ball = room.sim.vehicles.find((v) => v.spec.ball) as Vehicle;
    expect(ball.kinematic).toBe(false);
    // every client gets it as a ball
    const seen = a.link.snapshots().flatMap((s) => s.ents).find((e) => e.type === Ent.Vehicle && e.id === ball.id && e.full);
    expect(seen?.type === Ent.Vehicle && seen.v.kind).toBe('ball');
    // Fero drives straight at it (his car starts lined up on it, in his half)
    const ux = Math.cos(car.angle), uy = Math.sin(car.angle);
    let x = car.x, y = car.y;
    const veh = { vid: car.id, av: 0, steer: 0, throttle: 1, handbrake: false, boost: false, siren: false, horn: false, boosting: false, wrecked: false, tyres: false, health: car.spec.health, dmg: [0, 0, 0, 0] as [number, number, number, number], fire: -1, sinking: 0, nitro: 1, skid: 0 };
    let hit = 0;
    for (let i = 0; i < 60 && !hit; i++) {
      x += ux * 0.45;
      y += uy * 0.45;
      a.send(stateMsg(x, y, { epoch: p.epoch, a: car.angle, vx: ux * 9, vy: uy * 9, veh }));
      tick(1);
      if (ball.speed > 5) hit = i;
    }
    expect(hit).toBeGreaterThan(0);
    expect(a.link.json('correct').length).toBe(0);
    tick(4);
    // off it goes, faster than the car, the way the car was going
    expect(ball.speed).toBeGreaterThan(9);
    expect((ball.vx * ux + ball.vy * uy) / ball.speed).toBeGreaterThan(0.9);
    const last = a.link.snapshots().flatMap((s) => s.ents).filter((e) => e.type === Ent.Vehicle && e.id === ball.id).pop();
    expect(last?.type === Ent.Vehicle && Math.hypot(last.v.vx, last.v.vy)).toBeGreaterThan(5);
  });
});
