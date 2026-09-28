// server/src/features/Shops.ts (docs/plans/gameplay.md, Phase 2): the shops over the wire. The rules
// themselves are tested in test/shared/shops.test.ts; this checks the messages, the price list (and
// game_config's say in it), what's logged, and that what a player owns outlives a restart: their gear,
// their clothes, and the tuning of the car they drove off in.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Room } from '../src/Room';
import { MIGRATIONS, Store, hashToken } from '../src/db';
import { Supa } from '../src/supa';
import { parseShop } from '../src/features/Shops';
import { PROTOCOL_VERSION, type ClientMsg } from '../../src/shared/net/protocol';
import { Ent } from '../../src/shared/net/codec';
import { AMMO_BOX, PRICES } from '../../src/shared/sim/shops/catalog';
import { shopById, shopPlaces, teleports } from '../../src/shared/sim/shops/places';
import { PLAYER_SHIRTS } from '../../src/shared/entities/Ped';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import type { PrivateEvent } from '../../src/shared/sim/events';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, disabledSupa, loadWorld, stateMsg } from './helpers';

const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

function withDb(fn: (file: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'blava-shops-'));
  try {
    fn(path.join(dir, 'test.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setup(o: { store?: Store; supa?: Supa } = {}) {
  const clock = new FakeClock();
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 5, debug: true, caps: NO_NPCS, store: o.store, supa: o.supa ?? disabledSupa() });
  const join = (token = TOKEN_A, nick = 'Anna') => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick, presence: true }));
    const w = link.last('welcome');
    const p = room.sim.players.get(w.id)!;
    // every landmark already found: no discovery reward lands on a money assertion
    p.profile.found = [...room.sim.world.landmarks.keys()];
    const send = (m: ClientMsg) => room.onMessage(conn, JSON.stringify(m));
    /** stand at a shop (the client moves its player: here, straight to it) */
    const goTo = (id: string) => {
      const s = shopById(room.sim.world, id)!;
      p.ped.x = s.x;
      p.ped.y = s.y;
      return s;
    };
    return { link, conn, w, p, send, goTo };
  };
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  return { clock, room, join, tick };
}

const privs = (link: FakeLink): PrivateEvent[] => link.json('ev').flatMap((m) => m.p);
const answers = (link: FakeLink) => privs(link).filter((e): e is Extract<PrivateEvent, { k: 'shop' }> => e.k === 'shop');

describe('the shops over the wire', () => {
  it('a price list follows every welcome, and a `shop` request buys through the rule', () => {
    const { join, tick } = setup();
    const a = join();
    expect(a.link.last('catalog')?.prices).toEqual(PRICES);
    // the catalog comes after the profile, which carries the gear
    const order = a.link.json().map((m) => m.t);
    expect(order.indexOf('catalog')).toBeGreaterThan(order.indexOf('profile'));
    expect(a.link.last('profile')?.gear).toEqual({});
    a.p.profile.money = 1000;
    a.goTo('guns-michael');
    a.send({ t: 'shop', op: 'buy', item: 'pistol' });
    expect(a.p.ammo.pistol).toBe(AMMO_BOX.pistol);
    expect(a.p.profile.money).toBe(1000 - PRICES.pistol);
    tick();
    expect(answers(a.link).at(-1)).toMatchObject({ ok: true });
    // nothing there to buy away from the shop
    a.p.ped.x += 30;
    a.send({ t: 'shop', op: 'buy', item: 'pistol' });
    tick();
    expect(answers(a.link).at(-1)).toMatchObject({ ok: false, text: 'Tu nie je žiadny obchod.' });
    expect(a.p.ammo.pistol).toBe(AMMO_BOX.pistol);
  });

  it('malformed requests are dropped without a strike', () => {
    const { join, tick } = setup();
    const a = join();
    a.p.profile.money = 1000;
    a.goTo('guns-michael');
    for (const m of [{ op: 'buy' }, { op: 'buy', item: 5 }, { op: 'buy', item: 'x'.repeat(40) }, { op: 'take', slot: -1 }, { op: 'take', slot: 1.5 }, { op: 'take' }, { op: 'sell', item: 'pistol' }])
      a.send({ t: 'shop', ...m } as ClientMsg);
    tick();
    expect(answers(a.link)).toEqual([]);
    expect(a.p.profile.money).toBe(1000);
    expect(a.conn.strikes).toBe(0);
    expect(parseShop({ t: 'shop', op: 'take', slot: 2 })).toEqual({ op: 'take', slot: 2 });
    expect(parseShop({ t: 'shop', op: 'store', item: 'junk' })).toEqual({ op: 'store' });
  });

  it('what was spent goes to the activity log, beside what was earned (amount 0: it isn\'t earnings)', () => {
    const { room, join } = setup();
    const a = join();
    const log = vi.spyOn(room.activity!, 'log');
    a.p.profile.money = 1000;
    a.goTo('guns-michael');
    a.send({ t: 'shop', op: 'buy', item: 'vest' });
    expect(log).toHaveBeenCalledWith('shop', expect.objectContaining({ key: hashToken(TOKEN_A) }), 0, { spent: PRICES.vest, item: 'vest' });
  });

  it('a new jacket and hat reach everyone: the snapshot re-sends the figure', () => {
    const { join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    a.p.profile.money = 1000;
    const s = a.goTo('clothes-kamenne');
    b.p.ped.x = s.x + 4;
    b.p.ped.y = s.y;
    tick(2);
    const look = (a.p.ped.look + 5) % PLAYER_SHIRTS.length;
    a.send({ t: 'shop', op: 'buy', item: `jacket:${look}` });
    a.send({ t: 'shop', op: 'buy', item: 'hat:2' });
    b.link.clear();
    tick(2);
    const rec = b.link.snapshots().flatMap((sn) => sn.ents).find((e) => e.id === a.p.ped.id && e.full);
    expect(rec?.type === Ent.Ped ? rec.v : null).toMatchObject({ look, hat: 2 });
    // …and the buyer hears what they now own
    expect(privs(a.link).filter((e) => e.k === 'gear').at(-1)).toMatchObject({ g: { look, hat: 2 } });
  });

  it('parking in the garage tells the driver\'s client where they now stand', () => {
    const { room, join, tick } = setup();
    const a = join();
    a.p.profile.money = 5000;
    const g = a.goTo(shopPlaces(room.sim.world).find((s) => s.kind === 'garage')!.id);
    a.send({ t: 'shop', op: 'buy', item: 'garage' });
    const v = room.sim.addVehicle(new Vehicle('sedan', g.x, g.y, g.a, '#123456'));
    a.send({ t: 'enter', vid: v.id });
    expect(a.p.ped.vehicle).toBe(v);
    a.send({ t: 'shop', op: 'store' });
    expect(room.sim.vehicles.includes(v)).toBe(false);
    tick();
    const stored = privs(a.link).find((e) => e.k === 'stored');
    expect(stored).toMatchObject({ vehicle: v.id, x: a.p.ped.x, y: a.p.ped.y });
    expect(a.p.profile.gear?.cars).toHaveLength(1);
  });

  it('a teleport with the car: the server moves it, the driver\'s client hears where, and its reports from there count', () => {
    const { room, join, tick } = setup();
    const a = join();
    a.p.profile.money = 1000;
    const tps = teleports(room.sim.world);
    const t = a.goTo(tps[0].id);
    const v = room.sim.addVehicle(new Vehicle('sedan', t.x, t.y, t.a, '#123456'));
    a.send({ t: 'enter', vid: v.id });
    expect(a.p.ped.vehicle).toBe(v);
    a.send({ t: 'shop', op: 'buy', item: 'teleport:8' });
    expect(a.p.profile.money).toBe(1000 - PRICES.teleport);
    expect(Math.hypot(v.x - tps[8].x, v.y - tps[8].y)).toBeLessThanOrEqual(12.01);
    tick();
    const tp = privs(a.link).find((e): e is Extract<PrivateEvent, { k: 'teleport' }> => e.k === 'teleport');
    expect(tp).toMatchObject({ car: v.id, x: v.x, y: v.y, epoch: a.p.epoch });
    // the client drives on from there, in the new epoch: accepted, not corrected back
    const veh = { vid: v.id, av: 0, steer: 0, throttle: 0.5, handbrake: false, boost: false, siren: false, horn: false, boosting: false, wrecked: false, tyres: false, health: v.health, dmg: [0, 0, 0, 0] as [number, number, number, number], fire: -1, sinking: 0, nitro: 1, skid: 0 };
    a.link.clear();
    const x0 = v.x;
    room.onMessage(a.conn, stateMsg(x0 + 1, v.y, { epoch: a.p.epoch, veh }));
    expect(v.x).toBeCloseTo(x0 + 1, 1);
    tick();
    expect(a.link.last('correct')).toBeUndefined();
    // (a report from before the ride, in the old epoch, doesn't pull it back)
    room.onMessage(a.conn, stateMsg(t.x, t.y, { epoch: (a.p.epoch + 255) & 0xff, veh }));
    expect(v.x).toBeCloseTo(x0 + 1, 1);
  });

  it('game_config\'s prices reach the rule and everyone online', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ key: 'shops', value: { pistol: 10, uzi: -1 } }]), { status: 200 }));
    const supa = new Supa('https://x.example', 'k', { fetch: fetch as unknown as typeof globalThis.fetch });
    const { room, join } = setup({ supa });
    const a = join();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.link.last('catalog')?.prices).toEqual({ ...PRICES, pistol: 10 });
    a.p.profile.money = 100;
    a.goTo('guns-michael');
    a.send({ t: 'shop', op: 'buy', item: 'pistol' });
    expect(a.p.profile.money).toBe(90);
    // a later welcome gets the same list
    expect(join(TOKEN_B, 'Boris').link.last('catalog')?.prices.pistol).toBe(10);
    room.shutdown();
  });
});

describe('what a player owns outlives a restart', () => {
  it('gear is saved with the profile, and they come back dressed as they left', () => {
    withDb((file) => {
      let store = new Store(file);
      let s = setup({ store });
      let a = s.join();
      a.p.profile.money = 10_000;
      a.goTo('clothes-kamenne');
      a.send({ t: 'shop', op: 'buy', item: 'jacket:6' });
      a.send({ t: 'shop', op: 'buy', item: 'hat:4' });
      const g = a.goTo('garage-eurovea');
      a.send({ t: 'shop', op: 'buy', item: 'garage' });
      a.goTo('lawyer');
      a.send({ t: 'shop', op: 'buy', item: 'lawyer' });
      s.room.shutdown();
      store.close();

      store = new Store(file);
      expect(store.loadProfile(hashToken(TOKEN_A))!.profile.gear).toEqual({ look: 6, hat: 4, garages: [g.id], slots: 2, lawyer: true });
      s = setup({ store });
      a = s.join();
      expect(a.w.look).toBe(6);
      expect(a.p.ped.hat).toBe(4);
      expect(a.link.last('profile')?.gear).toMatchObject({ look: 6, hat: 4, garages: [g.id], lawyer: true });
      s.room.shutdown();
      store.close();
    });
  });

  it('the car a player drives off in keeps its tuning', () => {
    withDb((file) => {
      const store = new Store(file);
      const { room, join } = setup({ store });
      const a = join();
      const at = room.sim.world.clearSpot(a.p.ped.x + 3, a.p.ped.y, 3.2);
      const v = room.sim.addVehicle(new Vehicle('sport', at.x, at.y, 0, '#00bfa5'));
      v.level = a.p.ped.level;
      v.levelInit = true;
      a.p.ped.x = at.x;
      a.p.ped.y = at.y + 2;
      a.send({ t: 'enter', vid: v.id });
      expect(a.p.ped.vehicle).toBe(v);
      v.tune({ engine: 2, plating: 0, tyres: 1, nitro: 1, glow: 6 });
      a.send({ t: 'leave' });
      expect(store.loadSession(hashToken(TOKEN_A), room.wallNow())!.car?.mods).toEqual({ engine: 2, plating: 0, tyres: 1, nitro: 1, glow: 6 });
      const back = join();
      const again = room.sim.vehicles.find((q) => q.kind === 'sport' && q.color === '#00bfa5')!;
      expect(again.reservedFor).toBe(back.p.id);
      expect(again.mods).toEqual({ engine: 2, plating: 0, tyres: 1, nitro: 1, glow: 6 });
      // getting in hands the tuning to the driver's client, which simulates the car
      back.send({ t: 'enter', vid: again.id });
      expect(back.p.ped.vehicle).toBe(again);
      room.tick(50);
      expect(privs(back.link).find((e) => e.k === 'enter' && e.ok)).toMatchObject({ vehicle: again.id, mods: { engine: 2, tyres: 1, nitro: 1, glow: 6 } });
      room.shutdown();
      store.close();
    });
  });

  it('adds the players.gear column to an existing database: old players read back with no gear', () => {
    withDb((file) => {
      const raw = new Database(file);
      for (let i = 0; i < 4; i++) raw.exec(MIGRATIONS[i]);
      raw.pragma('user_version = 4');
      raw.prepare('INSERT INTO players (token_hash, nickname, money, found, cumils, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('abc', 'Old', 42, '[]', '[]', 0, 0);
      raw.close();
      const store = new Store(file); // runs the gear migration
      expect(store.loadProfile('abc')!.profile).toMatchObject({ money: 42, gear: {} });
      // a guest's gear follows them into an account
      const set = new Database(file);
      set.prepare('UPDATE players SET gear = ? WHERE token_hash = ?').run(JSON.stringify({ look: 2, lawyer: true, hat: 99 }), 'abc');
      set.close();
      expect(store.movePlayer('abc', 'acct:u1')).toBe(true);
      expect(store.loadProfile('acct:u1')!.profile.gear).toEqual({ look: 2, lawyer: true });
      store.close();
    });
  });
});
