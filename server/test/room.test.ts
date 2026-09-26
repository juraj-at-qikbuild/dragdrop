import { describe, expect, it } from 'vitest';
import { Room, GRACE_MS, type RoomOptions } from '../src/Room';
import { PROTOCOL_VERSION, ROSTER_ACCOUNT } from '../../src/shared/net/protocol';
import { Ent } from '../../src/shared/net/codec';
import { HitKind } from '../../src/shared/sim/Combat';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, TOKEN_C, flush, loadWorld, stateMsg } from './helpers';
import type { Ped } from '../../src/shared/entities/Ped';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import type { AuthVerifier } from '../src/auth-types';
import { TimedEvent, type WorldEventDef } from '../../src/shared/sim/rules/WorldEvents';
import type { EventEntry } from '../../src/shared/sim/rules/types';

function setup(extra: Partial<RoomOptions> = {}) {
  const clock = new FakeClock();
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 42, debug: true, ...extra });
  const join = (token: string, nick: string, resume?: { x: number; y: number }) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick, resume: resume && { ...resume, lvl: 0, car: 0 } }));
    const w = link.last('welcome');
    return { link, conn, id: w?.id, ped: w?.ped, x: w?.x, y: w?.y };
  };
  /** an account hello: resolves once the (async) AuthVerifier has settled and the welcome arrived */
  const joinAuth = async (token: string, nick: string, authToken: string) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick, auth: authToken }));
    await flush();
    return { link, conn, w: link.last('welcome') };
  };
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  return { clock, room, join, joinAuth, tick };
}

/** a fake AuthVerifier (server/src/auth.ts's real one arrives later): 'tok-a' is u1, anything else fails */
const fakeAuth: AuthVerifier = { verify: (token) => Promise.resolve(token === 'tok-a' ? { userId: 'u1' } : null) };

const idsOf = (link: FakeLink, type: Ent) => {
  const seen = new Set<number>();
  for (const s of link.snapshots()) {
    for (const e of s.ents) if (e.type === type) seen.add(e.id);
    for (const g of s.gone) seen.delete(g);
  }
  return seen;
};

describe('Room', () => {
  it('welcomes a valid hello with a player and a figure', () => {
    const { join } = setup();
    const a = join(TOKEN_A, 'Jožo');
    const w = a.link.last('welcome');
    expect(w.v).toBe(PROTOCOL_VERSION);
    expect(w.id).toBeGreaterThan(0);
    expect(w.ped).toBeGreaterThan(0);
    expect(w.nick).toBe('Jožo');
    expect(a.link.last('profile').money).toBe(0);
  });

  it('rejects a protocol version mismatch and bad hellos', () => {
    const { room } = setup();
    const link = new FakeLink();
    room.onMessage(room.onJoin(link), JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION + 99, token: TOKEN_A, nick: 'Jožo' }));
    expect(link.last('error').code).toBe('version');
    for (const [token, nick] of [['nope', 'Jožo'], [TOKEN_A, 'x'], [TOKEN_A, '<script>']]) {
      const l = new FakeLink();
      room.onMessage(room.onJoin(l), JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick }));
      expect(l.last('error').code).toBe('bad-hello');
    }
  });

  it('two nearby players see each other and share the same NPCs', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    room.onMessage(b.conn, stateMsg(b.x!, b.y!));
    tick(40);
    const aPeds = idsOf(a.link, Ent.Ped), bPeds = idsOf(b.link, Ent.Ped);
    expect(aPeds.has(b.ped!)).toBe(true);
    expect(bPeds.has(a.ped!)).toBe(true);
    expect(aPeds.has(a.ped!)).toBe(false);
    // the city around them is the same city
    const shared = [...aPeds].filter((id) => bPeds.has(id));
    expect(shared.length).toBeGreaterThan(40);
    const aCars = idsOf(a.link, Ent.Vehicle), bCars = idsOf(b.link, Ent.Vehicle);
    expect([...aCars].filter((id) => bCars.has(id)).length).toBeGreaterThan(20);
  });

  it('far apart players do not see each other', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const c = join(TOKEN_C, 'Cyril', { x: 900, y: 600 });
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    room.onMessage(c.conn, stateMsg(c.x!, c.y!));
    tick(5);
    expect(idsOf(a.link, Ent.Ped).has(c.ped!)).toBe(false);
  });

  it('a shot NPC dies for everyone', () => {
    const { room, join, tick, clock } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    room.onMessage(b.conn, stateMsg(b.x!, b.y!));
    tick(20);
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', give: 'pistol' }));
    const shot = clearShot(room, (p) => idsOf(b.link, Ent.Ped).has(p.id))!;
    expect(shot).toBeTruthy();
    const { victim } = shot;
    for (let i = 0; i < 3 && !victim.dead; i++) {
      const f = aimAt(room, a.id!, victim);
      room.onMessage(a.conn, JSON.stringify({ t: 'fire', w: 'pistol', ...f, lvl: 0, rt: clock.t, pellets: [{ a: f.a, kind: HitKind.Ped, hit: victim.id, hx: f.hx, hy: f.hy }] }));
      tick(4);
    }
    expect(victim.dead).toBe(true);
    // B's latest record for that ped says dead
    let state = '';
    for (const s of b.link.snapshots()) for (const e of s.ents) if (e.id === victim.id && e.type === Ent.Ped) state = e.v.state;
    expect(state).toBe('dead');
    expect(room.sim.players.get(a.id!)!.wanted).toBeGreaterThanOrEqual(1);
  });

  it('rejects hit claims on targets that were not there', () => {
    const { room, join, tick, clock } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    tick(20);
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', give: 'pistol' }));
    const { victim } = clearShot(room, () => true)!;
    const f = aimAt(room, a.id!, victim);
    // claim a hit 5 m past where the ped actually is
    const hx = f.hx + Math.cos(f.a) * 5, hy = f.hy + Math.sin(f.a) * 5;
    room.onMessage(a.conn, JSON.stringify({ t: 'fire', w: 'pistol', ...f, lvl: 0, rt: clock.t, pellets: [{ a: f.a, kind: HitKind.Ped, hit: victim.id, hx, hy }] }));
    // and a hit on someone far away, through the city
    const far = room.sim.peds.find((p) => p.kind === 'civ' && !p.dead && Math.hypot(p.x - victim.x, p.y - victim.y) > 100)!;
    room.onMessage(a.conn, JSON.stringify({ t: 'fire', w: 'pistol', ...f, lvl: 0, rt: clock.t, pellets: [{ a: f.a, kind: HitKind.Ped, hit: far.id, hx: far.x, hy: far.y }] }));
    tick(2);
    expect(victim.health).toBe(100);
    expect(far.dead).toBe(false);
    expect(room.stats().badHits).toBeGreaterThanOrEqual(1);
  });

  it('PvP: a player shooting another is hurt server-side and becomes wanted', () => {
    const { room, join, tick, clock } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    room.onMessage(b.conn, stateMsg(b.x!, b.y!));
    tick(4);
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', give: 'pistol' }));
    const pa = room.sim.players.get(a.id!)!, pb = room.sim.players.get(b.id!)!;
    // stand them 3 m apart in the open
    const spot = clearShot(room, () => true)!;
    pb.ped.x = spot.victim.x;
    pb.ped.y = spot.victim.y;
    tick(2);
    const f = aimAt(room, a.id!, pb.ped);
    room.onMessage(a.conn, JSON.stringify({ t: 'fire', w: 'pistol', ...f, lvl: 0, rt: clock.t, pellets: [{ a: f.a, kind: HitKind.Ped, hit: pb.ped.id, hx: f.hx, hy: f.hy }] }));
    tick(2);
    expect(pb.ped.health).toBeLessThan(100);
    expect(pa.wanted).toBeGreaterThanOrEqual(1);
    const hurt = b.link.json('ev').flatMap((m) => m.p).find((e) => e.k === 'hurt');
    expect(hurt).toBeTruthy();
  });

  it('keeps a disconnected player for the grace period and resumes them on reconnect', () => {
    const { room, join, tick, clock } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    room.onMessage(b.conn, stateMsg(b.x!, b.y!));
    tick(3);
    room.onLeave(b.conn);
    tick(3);
    expect(idsOf(a.link, Ent.Ped).has(b.ped!)).toBe(true);
    clock.advance(GRACE_MS / 2);
    const b2 = join(TOKEN_B, 'Boris');
    expect(b2.id).toBe(b.id);
    expect(b2.ped).toBe(b.ped);
    room.onLeave(b2.conn);
    clock.advance(GRACE_MS + 1000);
    tick(2);
    expect(idsOf(a.link, Ent.Ped).has(b.ped!)).toBe(false);
    expect(room.sim.players.has(b.id!)).toBe(false);
  });

  it('a second connection with the same token takes over', () => {
    const { join } = setup();
    const a1 = join(TOKEN_A, 'Anna');
    const a2 = join(TOKEN_A, 'Anna');
    expect(a1.link.last('bye').reason).toBe('replaced');
    expect(a1.link.closed).not.toBeNull();
    expect(a2.id).toBe(a1.id);
  });

  it('rejects teleports with a correction', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    tick();
    room.onMessage(a.conn, stateMsg(a.x! + 300, a.y!));
    const c = a.link.last('correct');
    expect(c.x).toBeCloseTo(a.x!, 1);
    expect(c.y).toBeCloseTo(a.y!, 1);
  });

  it('lets a player take a parked car and drive it', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    tick(10);
    const car = room.sim.vehicles.find((v) => v.parked && !v.driver)!;
    const p = room.sim.players.get(a.id!)!;
    const x = car.x + Math.sin(car.angle) * 2, y = car.y - Math.cos(car.angle) * 2;
    p.ped.x = x;
    p.ped.y = y;
    room.onMessage(a.conn, JSON.stringify({ t: 'enter', vid: car.id }));
    tick();
    expect(a.link.json('ev').flatMap((m) => m.p).some((e) => e.k === 'enter' && e.ok && e.vehicle === car.id)).toBe(true);
    expect(car.owner).toBe(a.id);
    expect(car.kinematic).toBe(true);
    room.onMessage(a.conn, JSON.stringify({ t: 'exit', x, y, veh: { x: car.x, y: car.y, a: car.angle, vx: 0, vy: 0, av: 0, hp: car.health, dmg: [0, 0, 0, 0], fire: -1, tyres: 0, nitro: 1, lvl: 0 } }));
    expect(car.owner).toBe(0);
    expect(car.kinematic).toBe(false);
  });

  it('plays in the Suché mýto tunnel: resumes there, shots at level -1 count, a car left there stays underground', () => {
    const { room, tick, clock } = setup();
    const [x, y, ang] = [-403.5, -740, -0.66];
    const link = new FakeLink();
    const conn = room.onJoin(link);
    // a client that was in the tunnel when the server restarted
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TOKEN_A, nick: 'Anna', resume: { x, y, lvl: -1, car: 0 } }));
    const w = link.last('welcome');
    expect(w.lvl).toBe(-1);
    expect(Math.hypot(w.x - x, w.y - y)).toBeLessThan(0.5);
    const p = room.sim.players.get(w.id)!;
    room.onMessage(conn, stateMsg(x, y, { lvl: -1 }));
    const car = room.sim.addVehicle(new Vehicle('sedan', x + Math.cos(ang) * 5, y + Math.sin(ang) * 5, ang, '#fff'));
    car.parked = true;
    car.level = -1;
    car.levelInit = true;
    tick(10);
    room.onMessage(conn, JSON.stringify({ t: 'debug', give: 'pistol' }));
    const hx = car.x - Math.cos(ang) * 2, hy = car.y - Math.sin(ang) * 2;
    const hp = car.health;
    room.onMessage(conn, JSON.stringify({ t: 'fire', w: 'pistol', ox: x + Math.cos(ang) * 0.5, oy: y + Math.sin(ang) * 0.5, a: ang, lvl: -1, rt: clock.t, pellets: [{ a: ang, kind: HitKind.Car, hit: car.id, hx, hy }] }));
    tick(2);
    expect(car.health).toBeLessThan(hp);
    room.onMessage(conn, JSON.stringify({ t: 'enter', vid: car.id }));
    tick();
    expect(car.owner).toBe(w.id);
    room.onMessage(conn, JSON.stringify({ t: 'exit', x: car.x, y: car.y, veh: { x: car.x, y: car.y, a: car.angle, vx: 0, vy: 0, av: 0, hp: car.health, dmg: [0, 0, 0, 0], fire: -1, tyres: 0, nitro: 1, lvl: -1 } }));
    tick(4);
    expect(car.owner).toBe(0);
    expect(car.level).toBe(-1);
    expect(p.ped.level).toBe(-1);
  });

  it('rate-limits state spam and closes abusive connections', () => {
    const { room, join } = setup();
    const a = join(TOKEN_A, 'Anna');
    // a short burst is just dropped…
    for (let i = 0; i < 100; i++) room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    expect(a.link.closed).toBeNull();
    // …a flood gets the connection closed
    for (let i = 0; i < 1000; i++) room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    expect(a.link.closed?.code).toBe(1008);
  });

  it('forgives occasional bad messages over a long session', () => {
    const { room, join, clock } = setup();
    const a = join(TOKEN_A, 'Anna');
    for (let i = 0; i < 200; i++) {
      room.onMessage(a.conn, '{not json');
      clock.advance(3000);
    }
    expect(a.link.closed).toBeNull();
    // …but a burst of them still closes the connection
    for (let i = 0; i < 60; i++) room.onMessage(a.conn, '{not json');
    expect(a.link.closed?.code).toBe(1008);
  });
});

/** a live civilian with a spot 3 m away that has a clear line of fire; moves no one */
function clearShot(room: Room, ok: (p: Ped) => boolean) {
  const w = room.sim.world;
  for (const victim of room.sim.peds) {
    if (victim.kind !== 'civ' || victim.dead || victim.vehicle || victim.level !== 0 || !ok(victim)) continue;
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const x = victim.x + Math.cos(ang) * 3, y = victim.y + Math.sin(ang) * 3;
      if (w.collideCircle(x, y, 0.5) || w.inWater(x, y, 0) || w.raycast(x, y, victim.x, victim.y) < 1) continue;
      return { victim, x, y };
    }
  }
  return null;
}

/** put player `pid` 3 m from `t` with a clear line, and return the muzzle/aim/end of a shot at it */
function aimAt(room: Room, pid: number, t: { x: number; y: number }) {
  const w = room.sim.world;
  const p = room.sim.players.get(pid)!;
  for (let k = 0; k < 8; k++) {
    const ang = (k / 8) * Math.PI * 2;
    const x = t.x + Math.cos(ang) * 3, y = t.y + Math.sin(ang) * 3;
    if (w.collideCircle(x, y, 0.5) || w.inWater(x, y, 0) || w.raycast(x, y, t.x, t.y) < 1) continue;
    p.ped.x = x;
    p.ped.y = y;
    break;
  }
  const a = Math.atan2(t.y - p.ped.y, t.x - p.ped.x);
  return { ox: p.ped.x + Math.cos(a) * 0.5, oy: p.ped.y + Math.sin(a) * 0.5, a, hx: t.x - Math.cos(a) * 0.3, hy: t.y - Math.sin(a) * 0.3 };
}

/** a do-nothing world event that never times out on its own (test/shared/contracts.test.ts has the pattern) */
class DebugTestEvent extends TimedEvent {
  update(dt: number) {
    this.tick(dt);
    return true;
  }
  entry(): EventEntry {
    return { id: this.id, kind: this.kind, phase: this.phase, left: this.left };
  }
  stop() {}
}

describe('Room respawn', () => {
  it('accepts reports from the hospital after a respawn instead of snapping the player back', () => {
    const clock = new FakeClock();
    const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 9 });
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TOKEN_A, nick: 'Anna' }));
    const w = link.last('welcome');
    const tick = (n: number) => {
      for (let i = 0; i < n; i++) clock.advance(50), room.tick(50);
    };
    room.onMessage(conn, stateMsg(w.x, w.y));
    tick(2);
    const p = room.sim.players.get(w.id)!;
    room.sim.hurtPlayer(p, 1000, p.ped.x, p.ped.y);
    tick(100); // wasted, then respawned at a hospital
    expect(p.state).toBe('play');
    expect(p.epoch).toBe(1);
    const hx = p.ped.x, hy = p.ped.y;
    expect(Math.hypot(hx - w.x, hy - w.y)).toBeGreaterThan(40);
    link.clear();
    room.onMessage(conn, stateMsg(hx + 0.2, hy, { epoch: 1 }));
    tick(1);
    expect(link.json('correct')).toHaveLength(0);
    expect(p.ped.x).toBeCloseTo(hx + 0.2, 1);
  });
});

describe('accounts (hello.auth)', () => {
  it('a verified account gets a welcome with account: true and claimed: false', async () => {
    const { room, joinAuth } = setup({ auth: fakeAuth });
    const a = await joinAuth(TOKEN_A, 'Fero', 'tok-a');
    expect(a.w.account).toBe(true);
    expect(a.w.claimed).toBe(false);
    expect(room.sim.players.get(a.w.id)!.account).toBe(true);
  });

  it('a bad token gets error "auth" and the link is closed', async () => {
    const { room, joinAuth } = setup({ auth: fakeAuth });
    const a = await joinAuth(TOKEN_A, 'Fero', 'nope');
    expect(a.link.last('error').code).toBe('auth');
    expect(a.link.closed?.code).toBe(4005);
    expect(room.connectedCount()).toBe(0);
  });

  it('gets "auth-unavailable" when no verifier is configured', () => {
    const { room } = setup(); // no `auth` option
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TOKEN_A, nick: 'Fero', auth: 'tok-a' }));
    expect(link.last('error').code).toBe('auth-unavailable');
    expect(link.closed?.code).toBe(4004);
  });

  it('ignores binary and JSON messages (even a repeat hello) sent while the verify is pending, without striking them', async () => {
    const { room } = setup({ auth: fakeAuth });
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TOKEN_A, nick: 'Fero', auth: 'tok-a' }));
    room.onMessage(conn, stateMsg(0, 0));
    room.onMessage(conn, JSON.stringify({ t: 'nick', nick: 'Iny' }));
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TOKEN_A, nick: 'Znova', auth: 'tok-a' }));
    expect(link.closed).toBeNull();
    expect(room.counters.rejected).toBe(0);
    expect(link.json('welcome')).toHaveLength(0); // the verify hasn't settled yet
    await flush();
    expect(link.json('welcome')).toHaveLength(1); // exactly one: the repeated hello while pending was dropped too
    expect(link.last('welcome').nick).toBe('Fero'); // the `nick` sent while pending never applied
  });

  it('the same account from a second device takes over the session and keeps its money', async () => {
    const { room, joinAuth } = setup({ auth: fakeAuth });
    const a = await joinAuth(TOKEN_A, 'Fero', 'tok-a');
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', money: 777 }));
    const b = await joinAuth(TOKEN_B, 'Fero', 'tok-a'); // a different device: a different guest token
    expect(a.link.last('bye').reason).toBe('replaced');
    expect(a.link.closed).not.toBeNull();
    expect(b.w.id).toBe(a.w.id);
    expect(room.sim.players.get(b.w.id)!.profile.money).toBe(777);
    expect(room.sessions.size).toBe(1); // one session under the account key, not two
  });
});

describe('roster and wev', () => {
  it('roster rows carry 9 fields, with the account flag set only for the account player', async () => {
    const { join, joinAuth, tick } = setup({ auth: fakeAuth });
    const g = join(TOKEN_C, 'Guest');
    const a = await joinAuth(TOKEN_A, 'Fero', 'tok-a');
    tick(1);
    const rows = g.link.json('roster').flatMap((m) => m.ps);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.length === 9)).toBe(true);
    const acctRow = rows.find((r) => r[0] === a.w.id)!;
    const guestRow = rows.find((r) => r[0] === g.id)!;
    expect(acctRow[8] & ROSTER_ACCOUNT).toBeTruthy();
    expect(guestRow[8] & ROSTER_ACCOUNT).toBeFalsy();
  });

  it('sends a wev message right after the welcome', () => {
    const { join } = setup();
    const a = join(TOKEN_A, 'Anna');
    expect(a.link.last('welcome')).toBeTruthy();
    expect(a.link.json('wev')).toHaveLength(1);
  });

  it('a global event reaches every connected player through ev.g', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.sim.events.global({ k: 'dailyReveal', img: 'x.webp' });
    tick(1);
    for (const link of [a.link, b.link]) {
      const g = link.json('ev').flatMap((m) => m.g ?? []);
      expect(g.some((e) => e.k === 'dailyReveal')).toBe(true);
    }
  });
});

describe('features and debug', () => {
  it('addFeature wires up a message handler; unregistered types still strike', () => {
    const { room, join } = setup();
    const a = join(TOKEN_A, 'Anna');
    let got: string | null = null;
    room.addFeature({ id: 'test', messages: { partyLeave: (s) => { got = s.player.nick; } } });
    room.onMessage(a.conn, JSON.stringify({ t: 'partyLeave' }));
    expect(got).toBe('Anna');
    const before = room.counters.rejected;
    room.onMessage(a.conn, JSON.stringify({ t: 'partyKick', id: 999 })); // no feature handles this one
    expect(room.counters.rejected).toBe(before + 1);
  });

  it('debug.event starts a registered world event, and debug.teleport moves the player', () => {
    const { room, join } = setup();
    const a = join(TOKEN_A, 'Anna');
    const dir = room.director!;
    const def: WorldEventDef = {
      kind: 'cumil', minPlayers: 1, offline: true, scheduled: false, weight: 1, cooldown: 60,
      create: (sim, d, id) => new DebugTestEvent(sim, d, id, 'cumil', 0, 999),
    };
    dir.register(def);
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', event: 'cumil' }));
    expect(dir.active.length).toBe(1);
    expect(dir.entries()[0].kind).toBe('cumil');

    const p = room.sim.players.get(a.id!)!;
    const l = room.sim.world.landmark('eurovea');
    const to = room.sim.world.walkableNear(l.x, l.y - 40);
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', teleport: [to.x, to.y] }));
    expect(Math.hypot(p.ped.x - to.x, p.ped.y - to.y)).toBeLessThan(15);
  });
});
