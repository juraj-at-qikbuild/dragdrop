// Pausing, leaving and coming back on the server (docs/plans/pause-resume.md): the `away` message and
// the shield's roster flags, a dropped socket's grace period, leaving (at once, or a moment later when
// in trouble, and never mid-death), the idle timeout, how a welcome says the player came back, the
// tunables, and the car that leaves with its driver and waits for them.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GRACE_MS, LEAVE_UNSAFE_MS, Room, WANTED_RESUME_MS } from '../src/Room';
import { Store, hashToken } from '../src/db';
import { IDLE_MS, type Presence as PresenceFeature } from '../src/features/Presence';
import type { Party } from '../src/features/Party';
import { PROTOCOL_VERSION, ROSTER_AWAY, ROSTER_SHIELD, type ClientMsg } from '../../src/shared/net/protocol';
import { SPECS, Vehicle, type VehicleKind } from '../../src/shared/entities/Vehicle';
import { SHIELD_ARM_S, type Presence as PresenceRule } from '../../src/shared/sim/rules/Presence';
import type { PrivateEvent } from '../../src/shared/sim/events';
import { dist } from '../../src/shared/util/math';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, TOKEN_C, disabledSupa, loadWorld, stateMsg } from './helpers';

/** no NPCs: fast ticks, and nothing wanders in to change an outcome */
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

function withDb(fn: (store: Store) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'blava-presence-'));
  const store = new Store(path.join(dir, 'test.db'));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function setup(store?: Store) {
  const clock = new FakeClock();
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 11, debug: true, supa: disabledSupa(), caps: NO_NPCS, store });
  /** a client from after this change says hello with `presence`; `old: true` is one from before */
  const join = (token: string, nick: string, extra: { old?: boolean; resume?: { x: number; y: number; lvl: 0; car: number } } = {}) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick, presence: extra.old ? undefined : true, resume: extra.resume }));
    const w = link.last('welcome');
    return { link, conn, w, id: w.id, p: room.sim.players.get(w.id)! };
  };
  const send = (conn: ReturnType<typeof room.onJoin>, msg: ClientMsg) => room.onMessage(conn, JSON.stringify(msg));
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  const run = (seconds: number) => tick(Math.ceil((seconds * 1000) / 50));
  return { clock, room, join, send, tick, run };
}

/** every private event sent to this link so far */
const privs = (link: FakeLink): PrivateEvent[] => link.json('ev').flatMap((m) => m.p);
const texts = (link: FakeLink) => privs(link).flatMap((e) => (e.k === 'msg' ? [e.text] : []));
/** the flags of this player's row in the latest roster */
const rosterFlags = (link: FakeLink, id: number) => link.last('roster')?.ps.find((r) => r[0] === id)?.[8] ?? 0;

/** a car parked on open ground beside the player (clear of the square's fountains and benches), on
 *  their level, with the player 2 m from its side; `enter` then gets them in through the real message */
function carBeside(room: Room, p: ReturnType<Room['sim']['addPlayer']>, kind: VehicleKind = 'sedan', color = '#123456') {
  const spot = room.sim.world.clearSpot(p.ped.x + 3, p.ped.y, 3.2);
  const v = room.sim.addVehicle(new Vehicle(kind, spot.x, spot.y, 0, color));
  v.level = p.ped.level;
  v.levelInit = true;
  v.parked = true;
  p.ped.x = spot.x;
  p.ped.y = spot.y + 2;
  return v;
}

describe('away and the shield on the server', () => {
  it('`away` marks the player ⏸ in the roster, shields them once it arms, and a hello starts them out playing', () => {
    const { room, join, send, run } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    send(a.conn, { t: 'away', on: true });
    run(1.1);
    expect(rosterFlags(b.link, a.id) & ROSTER_AWAY).toBeTruthy();
    expect(rosterFlags(b.link, a.id) & ROSTER_SHIELD).toBeFalsy();
    run(SHIELD_ARM_S);
    expect(a.p.shielded).toBe(true);
    expect(rosterFlags(b.link, a.id) & ROSTER_SHIELD).toBeTruthy();
    expect(privs(a.link)).toContainEqual({ k: 'shield', on: true });

    room.sim.hurtPlayer(a.p, 60, a.p.ped.x, a.p.ped.y, b.id);
    expect(a.p.ped.health).toBe(100);

    join(TOKEN_A, 'Anna'); // a reconnect (a reload, another tab): playing again until it says otherwise
    expect(a.p.away).toBe(false);
    expect(a.p.shielded).toBe(false);
  });

  it('a dropped socket is away at once, and the figure stays the whole grace period (2 min) before leaving', () => {
    const { room, clock, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onLeave(a.conn);
    expect(a.p.away).toBe(true);
    expect(GRACE_MS).toBe(120_000);
    clock.advance(GRACE_MS - 1000);
    tick();
    expect(room.sim.players.has(a.id)).toBe(true);
    clock.advance(2000);
    tick();
    expect(room.sim.players.has(a.id)).toBe(false);
  });

  it("a shielded driver's reported damage, fire or sinking doesn't count", () => {
    const { room, join, send, run } = setup();
    const a = join(TOKEN_A, 'Anna');
    const car = carBeside(room, a.p);
    send(a.conn, { t: 'enter', vid: car.id });
    expect(a.p.ped.vehicle).toBe(car);
    send(a.conn, { t: 'away', on: true });
    run(SHIELD_ARM_S + 0.2);
    expect(a.p.shielded).toBe(true);
    room.onMessage(a.conn, stateMsg(car.x, car.y, {
      epoch: a.p.epoch,
      veh: { vid: car.id, av: 0, steer: 0, throttle: 0, handbrake: true, boost: false, siren: false, horn: false, boosting: false, wrecked: true, tyres: false, health: 0, dmg: [1, 1, 1, 1], fire: 0.2, sinking: 3, nitro: 1, skid: 0 },
    }));
    run(0.5);
    expect(car.health).toBe(SPECS.sedan.health);
    expect(car.fire).toBe(-1);
    expect(car.wrecked).toBe(false);
    expect(a.p.state).toBe('play');
  });
});

describe('leaving', () => {
  it('goes at once when safe; stays 10 s when wanted, or right after a fight with another player', () => {
    const { room, clock, join, send, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    const c = join(TOKEN_C, 'Cyril');
    send(b.conn, { t: 'debug', wanted: 2 });
    room.sim.hurtPlayer(c.p, 5, c.p.ped.x, c.p.ped.y, a.id); // Anna hits Cyril: Cyril's no crook, but he's in a fight
    room.sim.setWanted(a.p, 0); // (and Anna's in one too; she leaves first, below, only to show the safe case)
    a.p.lastPvpAt = -1e9;

    send(a.conn, { t: 'leave' });
    expect(room.sim.players.has(a.id)).toBe(false);
    expect(a.link.closed?.code).toBe(1000);

    send(b.conn, { t: 'leave' });
    send(c.conn, { t: 'leave' });
    for (const x of [b, c]) {
      expect(room.sim.players.has(x.id)).toBe(true); // still standing there, still in danger
      expect(x.p.connected).toBe(false);
      expect(x.link.closed?.code).toBe(1000);
    }
    expect(LEAVE_UNSAFE_MS).toBe(10_000);
    clock.advance(LEAVE_UNSAFE_MS + 100);
    tick();
    expect(room.sim.players.has(b.id)).toBe(false);
    expect(room.sim.players.has(c.id)).toBe(false);
  });

  it('never mid-death: a wasted, busted or downed player is sent to hospital or the station first, fee and all', () => {
    withDb((store) => {
      const { room, join, send } = setup(store);
      const a = join(TOKEN_A, 'Anna');
      const b = join(TOKEN_B, 'Boris');
      const c = join(TOKEN_C, 'Cyril');
      for (const x of [a, b, c]) send(x.conn, { t: 'debug', money: 1000 });
      send(b.conn, { t: 'debug', give: 'pistol' });
      room.sim.wasted(a.p);
      room.sim.bust(b.p);
      room.sim.down(c.p);
      for (const x of [a, b, c]) send(x.conn, { t: 'leave' });
      for (const x of [a, b, c]) expect(room.sim.players.has(x.id)).toBe(false);

      const pois = (kind: 'hospital' | 'police') => room.sim.world.pois(kind);
      const near = (x: number, y: number, kind: 'hospital' | 'police') => pois(kind).some((q) => dist(q.x, q.y, x, y) < 40);
      for (const [token, kind] of [[TOKEN_A, 'hospital'], [TOKEN_B, 'police'], [TOKEN_C, 'hospital']] as const) {
        const key = hashToken(token);
        expect(store.loadProfile(key)!.profile.money).toBe(900); // the usual 10%
        const row = store.loadSession(key, room.wallNow())!;
        expect(row.health).toBe(100);
        expect(near(row.x, row.y, kind)).toBe(true);
      }
      expect(store.loadSession(hashToken(TOKEN_B), room.wallNow())!.ammo.pistol).toBe(0); // an arrest takes the guns
    });
  });

  it('the stars come back only if they return within 30 minutes', () => {
    withDb((store) => {
      const { clock, join, send, tick } = setup(store);
      for (const [token, nick] of [[TOKEN_A, 'Anna'], [TOKEN_B, 'Boris']] as const) {
        const x = join(token, nick);
        send(x.conn, { t: 'debug', wanted: 3 });
        send(x.conn, { t: 'leave' });
      }
      clock.advance(LEAVE_UNSAFE_MS + 100);
      tick();
      clock.advance(10 * 60_000);
      expect(join(TOKEN_A, 'Anna').p.wanted).toBe(3);
      clock.advance(WANTED_RESUME_MS);
      const b = join(TOKEN_B, 'Boris');
      expect(b.p.wanted).toBe(0);
      expect(b.w.resumed).toBe('saved'); // the spot and the rest are still theirs, 24 h
    });
  });
});

describe('the idle timeout', () => {
  it('moves out, and saves, a player away too long; a client from before the change is never timed out', () => {
    withDb((store) => {
      const { room, join, send, run } = setup(store);
      expect(room.feature<PresenceFeature>('presence')!.idleMs).toBe(IDLE_MS);
      const a = join(TOKEN_A, 'Anna');
      const old = join(TOKEN_B, 'Boris', { old: true });
      send(a.conn, { t: 'debug', presence: { idle_min: 0.1 } }); // 6 s, for the test
      send(a.conn, { t: 'away', on: true });
      send(old.conn, { t: 'away', on: true }); // an old client never sends this, but it wouldn't matter
      run(5);
      expect(room.sim.players.has(a.id)).toBe(true);
      run(2.5);
      expect(a.link.last('bye')?.reason).toBe('idle');
      expect(a.link.closed?.code).toBe(4008);
      expect(room.sim.players.has(a.id)).toBe(false);
      expect(store.loadSession(hashToken(TOKEN_A), room.wallNow())).not.toBeNull();
      expect(room.sim.players.has(old.id)).toBe(true);
    });
  });
});

describe('welcome.resumed', () => {
  it("'fresh' for a first visit, 'live' while the figure is still in the city, 'saved' from the last session", () => {
    withDb((store) => {
      const { room, join, send } = setup(store);
      const a = join(TOKEN_A, 'Anna');
      expect(a.w.resumed).toBe('fresh');
      room.onLeave(a.conn);
      const again = join(TOKEN_A, 'Anna');
      expect(again.w.resumed).toBe('live');
      send(again.conn, { t: 'leave' });
      expect(join(TOKEN_A, 'Anna').w.resumed).toBe('saved');
    });
  });
});

describe('tunables', () => {
  it('debug.presence (and game_config, through the same apply) sets every one in range, and ignores the rest', () => {
    const { room, join, send } = setup();
    const a = join(TOKEN_A, 'Anna');
    const rule = room.sim.rule<PresenceRule>('presence')!;
    const feature = room.feature<PresenceFeature>('presence')!;
    const party = room.feature<Party>('party')!;
    send(a.conn, { t: 'debug', presence: { shield: false, arm_s: 1, pvp_s: 5, grace_s: 60, leave_s: 3, idle_min: 2, seat_min: 4, car_min: 1 } });
    expect(rule.config).toEqual({ enabled: false, armS: 1, pvpS: 5 });
    expect(room.graceMs).toBe(60_000);
    expect(room.leaveUnsafeMs).toBe(3000);
    expect(feature.idleMs).toBe(120_000);
    expect(party.seatMs).toBe(240_000);
    expect(room.carHoldS).toBe(60);
    send(a.conn, { t: 'debug', presence: { grace_s: -5, idle_min: 1e9, arm_s: Number.NaN, leave_s: 500 } });
    expect(room.graceMs).toBe(60_000);
    expect(feature.idleMs).toBe(120_000);
    expect(rule.config.armS).toBe(1);
    expect(room.leaveUnsafeMs).toBe(3000);
  });
});

describe('the car leaves with its driver', () => {
  it('is saved and taken out of the city, then waits parked beside them, theirs alone for a while', () => {
    withDb((store) => {
      const { room, join, send, tick } = setup(store);
      const a = join(TOKEN_A, 'Anna');
      const car = carBeside(room, a.p, 'sport', '#123456');
      send(a.conn, { t: 'enter', vid: car.id });
      expect(a.p.ped.vehicle).toBe(car);
      const spot = { x: car.x, y: car.y };
      send(a.conn, { t: 'leave' });
      expect(room.sim.vehicles.includes(car)).toBe(false);
      expect(store.loadSession(hashToken(TOKEN_A), room.wallNow())!.car).toMatchObject({ kind: 'sport', color: '#123456' });

      const back = join(TOKEN_A, 'Anna');
      const again = room.sim.vehicles.find((v) => v.kind === 'sport' && v.color === '#123456')!;
      expect(again).toBeTruthy();
      expect(dist(again.x, again.y, spot.x, spot.y)).toBeLessThan(1);
      expect(again.parked).toBe(true);
      expect(again.reservedFor).toBe(back.id);
      expect(back.p.ped.vehicle).toBeNull();
      expect(dist(back.p.ped.x, back.p.ped.y, again.x, again.y)).toBeLessThan(3); // standing right beside it
      tick();
      expect(texts(back.link)).toContain('Tvoje auto parkuje vedľa teba.');

      // somebody else can't take it yet, and is told why
      const b = join(TOKEN_B, 'Boris');
      b.p.ped.x = again.x;
      b.p.ped.y = again.y + 2.5;
      b.p.ped.level = again.level;
      send(b.conn, { t: 'enter', vid: again.id });
      tick();
      expect(b.p.ped.vehicle).toBeNull();
      expect(texts(b.link)).toContain('Toto auto čaká na iného hráča.');
      // its owner can
      send(back.conn, { t: 'enter', vid: again.id });
      expect(back.p.ped.vehicle).toBe(again);
    });
  });

  it("a police car doesn't come along: it stays in the street", () => {
    withDb((store) => {
      const { room, clock, join, send, tick } = setup(store);
      const a = join(TOKEN_A, 'Anna');
      join(TOKEN_B, 'Boris'); // someone stays around, or the emptied city would clear the street anyway
      const cop = carBeside(room, a.p, 'police');
      send(a.conn, { t: 'enter', vid: cop.id });
      expect(a.p.ped.vehicle).toBe(cop);
      send(a.conn, { t: 'leave' }); // stealing it made her wanted: she lingers the usual 10 s first
      clock.advance(LEAVE_UNSAFE_MS + 100);
      tick();
      expect(room.sim.players.has(a.id)).toBe(false);
      expect(room.sim.vehicles.includes(cop)).toBe(true);
      expect(store.loadSession(hashToken(TOKEN_A), room.wallNow())!.car).toBeNull();
    });
  });

  it('a reload within the grace period steps them out, and the car waits for them', () => {
    const { room, join, send } = setup();
    const a = join(TOKEN_A, 'Anna');
    const car = carBeside(room, a.p);
    send(a.conn, { t: 'enter', vid: car.id });
    room.onLeave(a.conn); // the tab reloads: the old socket goes…
    const again = join(TOKEN_A, 'Anna'); // …and a fresh page, which knows nothing of the car, says hello
    expect(again.id).toBe(a.id);
    expect(a.p.ped.vehicle).toBeNull();
    expect(room.sim.vehicles.includes(car)).toBe(true);
    expect(car.reservedFor).toBe(a.id);
  });
});
