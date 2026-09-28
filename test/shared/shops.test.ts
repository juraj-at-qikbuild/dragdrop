// What money buys (src/shared/sim/rules/Shops.ts; docs/plans/gameplay.md, Phase 2), against the real
// map: where the shops are, what each sells and when it refuses, the garage keeping a car as it was,
// the collection, the cash a death leaves behind, the lawyer, clothes in the police's description,
// and gear read back from a save.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Vehicle, SPECS, LIVERY_KOFOLKA, type VehicleKind } from '../../src/shared/entities/Vehicle';
import { PLAYER_SHIRTS } from '../../src/shared/entities/Ped';
import { nullEvents, type PrivateEvent } from '../../src/shared/sim/events';
import type { Caps } from '../../src/shared/sim/density';
import { START_AMMO, type SimPlayer } from '../../src/shared/sim/SimPlayer';
import { Shops, carFrom, ownable } from '../../src/shared/sim/rules/Shops';
import type { Jobs } from '../../src/shared/sim/rules/jobs/Jobs';
import { FOOT_R, shopAt, shopById, shopPlaces, teleports, type ShopPlace } from '../../src/shared/sim/shops/places';
import { SPAWNS, SPAWN_SPREAD } from '../../src/shared/world/spawns';
import {
  AMMO_BOX, COLLECTION, COLLECTION_REWARD, DROP_KEEP, DROP_LIFE, NEONS, NO_MODS, PAINTS, PRICES, SLOTS_MAX, SLOTS_START, cleanMods, mergePrices, tuned,
} from '../../src/shared/sim/shops/catalog';
import { cleanGear, cleanStoredCar } from '../../src/shared/sim/shops/gear';
import { dist } from '../../src/shared/util/math';
import { loadWorld } from './helpers';

const NO_NPCS: Caps = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };
/** every landmark pre-found, so no discovery reward lands on a money assertion */
const allFound = () => [...loadWorld().landmarks.keys()];

function setup() {
  const priv: [number, PrivateEvent][] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(11), caps: NO_NPCS, driveClock: false, rules: 'offline',
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]) },
  });
  sim.clock.setTime(12);
  const shops = sim.rule<Shops>('shops')!;
  /** the private events of `k` sent so far */
  const sent = <K extends PrivateEvent['k']>(k: K) => priv.map(([, e]) => e).filter((e): e is Extract<PrivateEvent, { k: K }> => e.k === k);
  return { sim, priv, shops, sent };
}

/** a player (their client moves them, as online) standing at `at` */
function player(sim: Sim, at: { x: number; y: number }, money = 10_000): SimPlayer {
  const p = sim.addPlayer({ nick: 'A', profile: { money, done: [], found: allFound(), cumils: [] }, kinematic: true, x: at.x, y: at.y });
  p.ped.x = at.x;
  p.ped.y = at.y;
  return p;
}

const place = (id: string): ShopPlace => shopById(loadWorld(), id)!;
const first = (kind: ShopPlace['kind']) => shopPlaces(loadWorld()).find((s) => s.kind === kind)!;

/** put `p` at the wheel of a new car stopped at `at` */
function drive(sim: Sim, p: SimPlayer, at: { x: number; y: number }, kind: VehicleKind = 'sedan', color = '#1565c0') {
  const v = sim.addVehicle(new Vehicle(kind, at.x, at.y, 0, color));
  p.ped.x = at.x;
  p.ped.y = at.y;
  expect(sim.enterVehicle(p, v, 5)).toBe(true);
  return v;
}

const run = (sim: Sim, seconds: number, dt = 0.25) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) sim.step(dt);
};

describe('where the shops are', () => {
  const w = loadWorld();
  const all = shopPlaces(w);

  it('every kind is there, each shop once, with a stable id', () => {
    const count = (k: ShopPlace['kind']) => all.filter((s) => s.kind === k).length;
    expect(count('guns')).toBe(10);
    expect(count('clothes')).toBe(3);
    expect(count('lawyer')).toBe(1);
    expect(count('garage')).toBe(6);
    expect(count('teleport')).toBe(SPAWNS.length);
    expect(count('tuning')).toBe(w.pois('fuel').length);
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
    // worked out the same way every time (the server checks a purchase against the client's idea of it)
    expect(shopPlaces(w)).toBe(all);
  });

  it('every shop stands clear of buildings and water, and a car can pull up to the garages', () => {
    for (const s of all) {
      expect(w.collideCircle(s.x, s.y, 0.4, 0, false), s.id).toBeFalsy();
      expect(w.inWater(s.x, s.y, 0), s.id).toBe(false);
      if (s.kind === 'garage' || s.kind === 'teleport') expect(w.car.nearest(s.x, s.y, 1), s.id).toBeGreaterThanOrEqual(0);
      if (s.kind === 'tuning') expect(w.car.nearest(s.x, s.y, 45), s.id).toBeGreaterThanOrEqual(0);
    }
  });

  it('standing at each shop is being in that shop (no two share a door)', () => {
    for (const s of all) expect(shopAt(w, s.x, s.y, !s.foot)?.id, s.id).toBe(s.id);
  });

  it('on foot or in a car, as the shop takes them', () => {
    const guns = first('guns'), tuning = first('tuning'), garage = first('garage');
    expect(shopAt(w, guns.x, guns.y, true)).toBeNull();
    expect(shopAt(w, tuning.x, tuning.y, false)).toBeNull();
    expect(shopAt(w, garage.x, garage.y, true)?.id).toBe(garage.id);
    expect(shopAt(w, garage.x, garage.y, false)?.id).toBe(garage.id);
    // a step outside the door is outside; the server's slack lets a lagging report in
    expect(shopAt(w, guns.x + guns.r + 1, guns.y, false)).toBeNull();
    expect(shopAt(w, guns.x + guns.r + 1, guns.y, false, 3)?.id).toBe(guns.id);
    // a car pulls up anywhere in front of a garage; someone on foot comes to its door
    expect(shopAt(w, garage.x + 6, garage.y, true)?.id).toBe(garage.id);
    expect(shopAt(w, garage.x + 6, garage.y, false)).toBeNull();
    expect(shopAt(w, garage.x + FOOT_R - 0.5, garage.y, false)?.id).toBe(garage.id);
  });

  it('nobody arrives in a shop: every spawn place is well clear of every door', () => {
    for (const sp of SPAWNS)
      for (const s of all) if (s.foot) expect(dist(sp.x, sp.y, s.x, s.y), `${sp.name} / ${s.id}`).toBeGreaterThan(SPAWN_SPREAD + FOOT_R + 2);
  });
});

describe('Poľovnícke potreby', () => {
  it('sells a gun with a box of ammo, and a vest', () => {
    const { sim, shops, sent } = setup();
    const p = player(sim, place('guns-michael'));
    expect(shops.act(p, { op: 'buy', item: 'uzi' }).ok).toBe(true);
    expect(p.ammo.uzi).toBe(AMMO_BOX.uzi);
    expect(p.ped.weapon).toBe('uzi');
    expect(p.profile.money).toBe(10_000 - PRICES.uzi);
    expect(sent('pickup').at(-1)).toMatchObject({ kind: 'uzi', amount: AMMO_BOX.uzi });
    expect(sent('shop').at(-1)?.ok).toBe(true);
    p.ped.armor = 20;
    expect(shops.act(p, { op: 'buy', item: 'vest' }).ok).toBe(true);
    expect(p.ped.armor).toBe(100);
    // a second vest over a whole one: no
    expect(shops.act(p, { op: 'buy', item: 'vest' }).ok).toBe(false);
    expect(p.profile.money).toBe(10_000 - PRICES.uzi - PRICES.vest);
  });

  it('refuses without the money, away from the shop, the wrong item, and while not playing', () => {
    const { sim, shops, sent } = setup();
    const p = player(sim, place('guns-michael'), PRICES.pistol - 1);
    const r = shops.act(p, { op: 'buy', item: 'pistol' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain(`€${PRICES.pistol}`);
    expect(sent('shop').at(-1)).toEqual({ k: 'shop', ok: false, text: r.text });
    p.profile.money = 10_000;
    expect(shops.act(p, { op: 'buy', item: 'lawyer' }).ok).toBe(false);
    expect(shops.act(p, { op: 'buy', item: 'engine' }).ok).toBe(false);
    expect(shops.act(p, { op: 'buy', item: 'rocket' }).ok).toBe(false);
    p.ped.x += 20;
    expect(shops.act(p, { op: 'buy', item: 'pistol' }).ok).toBe(false);
    p.ped.x -= 20;
    p.state = 'wasted';
    expect(shops.act(p, { op: 'buy', item: 'pistol' }).ok).toBe(false);
    expect(p.profile.money).toBe(10_000);
    expect(p.ammo.pistol).toBe(START_AMMO.pistol);
  });

  it('caps the ammo at 999', () => {
    const { sim, shops } = setup();
    const p = player(sim, place('guns-michael'));
    p.ammo.shotgun = 990;
    expect(shops.act(p, { op: 'buy', item: 'shotgun' }).ok).toBe(true);
    expect(p.ammo.shotgun).toBe(999);
    expect(shops.act(p, { op: 'buy', item: 'shotgun' }).ok).toBe(false);
  });
});

describe('the Butik', () => {
  it('a jacket and a hat: worn at once, kept in the gear, a hat taken off for free', () => {
    const { sim, shops, sent } = setup();
    const p = player(sim, place('clothes-kamenne'));
    const look = (p.ped.look + 3) % PLAYER_SHIRTS.length;
    expect(shops.act(p, { op: 'buy', item: `jacket:${look}` }).ok).toBe(true);
    expect(p.ped.shirt).toBe(PLAYER_SHIRTS[look]);
    expect(p.profile.gear?.look).toBe(look);
    expect(sent('gear').at(-1)?.g.look).toBe(look);
    // the same jacket again: no
    expect(shops.act(p, { op: 'buy', item: `jacket:${look}` }).ok).toBe(false);
    expect(shops.act(p, { op: 'buy', item: 'jacket:99' }).ok).toBe(false);
    expect(shops.act(p, { op: 'buy', item: 'hat:1' }).ok).toBe(true);
    expect(p.ped.hat).toBe(1);
    expect(p.ped.hairStyle).toBe('cap');
    const money = p.profile.money;
    expect(money).toBe(10_000 - PRICES.jacket - PRICES.hat);
    expect(shops.act(p, { op: 'buy', item: 'hat:0' }).ok).toBe(true);
    expect(p.ped.hat).toBe(0);
    expect(p.profile.money).toBe(money);
  });

  it('a player arrives in the clothes they bought', () => {
    const { sim } = setup();
    const p = sim.addPlayer({ nick: 'B', look: 0, profile: { money: 0, done: [], found: [], cumils: [], gear: { look: 4, hat: 2 } }, kinematic: true });
    expect(p.ped.shirt).toBe(PLAYER_SHIRTS[4]);
    expect(p.ped.hat).toBe(2);
    expect(p.ped.hairStyle).toBe('hat');
  });

  it('the police look for the clothes they saw, and new ones bought out of sight don\'t match', () => {
    const { sim, shops } = setup();
    const at = place('clothes-kamenne');
    const p = player(sim, at);
    sim.setWanted(p, 2);
    // the chase starts with what they wear now
    const seenIn = { color: p.ped.shirt, hat: p.ped.hat };
    sim.pursuit.know(p);
    expect(p.desc).toMatchObject({ car: 0, color: seenIn.color, hat: seenIn.hat });
    expect(sim.pursuit.matches(p)).toBe(true);
    expect(shops.act(p, { op: 'buy', item: 'hat:3' }).ok).toBe(true);
    expect(sim.pursuit.matches(p)).toBe(false);
    expect(shops.act(p, { op: 'buy', item: `jacket:${(p.ped.look + 1) % PLAYER_SHIRTS.length}` }).ok).toBe(true);
    expect(sim.pursuit.matches(p)).toBe(false);
  });
});

describe('the lawyer', () => {
  it('is hired once, and the next arrest keeps the guns and halves the fee', () => {
    const { sim, shops, sent } = setup();
    const p = player(sim, place('lawyer'), 2000);
    expect(shops.act(p, { op: 'buy', item: 'lawyer' }).ok).toBe(true);
    expect(shops.act(p, { op: 'buy', item: 'lawyer' }).ok).toBe(false);
    expect(p.profile.gear?.lawyer).toBe(true);
    expect(p.profile.money).toBe(1500);
    p.ammo.pistol = 40;
    sim.bust(p);
    p.bribeOffer = 0;
    sim.respawn(p, false);
    expect(p.ammo.pistol).toBe(40);
    expect(p.profile.money).toBe(1500 - 75);
    expect(p.profile.gear?.lawyer).toBe(false);
    expect(sent('gear').at(-1)?.g.lawyer).toBe(false);
    // the one after that is the usual one
    sim.bust(p);
    p.bribeOffer = 0;
    sim.respawn(p, false);
    expect(p.ammo.pistol).toBe(START_AMMO.pistol);
    expect(p.profile.money).toBe(1425 - Math.round(1425 * 0.1));
  });
});

describe('a death leaves its fee behind', () => {
  it('as cash where they died (less €100), for two minutes', () => {
    const { sim, sent } = setup();
    const at = place('guns-aupark');
    const p = player(sim, at, 5000);
    sim.wasted(p);
    sim.respawn(p, false);
    expect(p.profile.money).toBe(4500);
    const drop = sim.pickups.find((q) => q.tag === 'death')!;
    expect(drop).toBeTruthy();
    expect(drop.amount).toBe(500 - DROP_KEEP);
    expect(dist(drop.x, drop.y, at.x, at.y)).toBeLessThan(3);
    expect(sent('msg').some((m) => m.text.includes(`€${500 - DROP_KEEP}`))).toBe(true);
    run(sim, DROP_LIFE - 5, 1);
    expect(sim.pickups.includes(drop)).toBe(true);
    run(sim, 6, 1);
    expect(sim.pickups.includes(drop)).toBe(false);
  });

  it('anyone who gets there takes it', () => {
    const { sim } = setup();
    const at = place('guns-aupark');
    const p = player(sim, at, 5000);
    sim.wasted(p);
    sim.respawn(p, false);
    const drop = sim.pickups.find((q) => q.tag === 'death')!;
    const q = player(sim, { x: drop.x, y: drop.y }, 0);
    run(sim, 0.5);
    expect(q.profile.money).toBe(drop.amount);
  });

  it('a small fee and an arrest drop nothing', () => {
    const { sim } = setup();
    const p = player(sim, place('guns-aupark'), 900);
    sim.wasted(p);
    sim.respawn(p, false);
    expect(sim.pickups.some((q) => q.tag === 'death')).toBe(false);
    p.profile.money = 5000;
    sim.bust(p);
    p.bribeOffer = 0;
    sim.respawn(p, false);
    expect(sim.pickups.some((q) => q.tag === 'death')).toBe(false);
  });
});

describe('the Dielňa', () => {
  it('works on a car stopped in it, not one driving through, nor on foot', () => {
    const { sim, shops } = setup();
    const at = first('tuning');
    const p = player(sim, at);
    expect(shops.act(p, { op: 'buy', item: 'engine' }).ok).toBe(false);
    const v = drive(sim, p, at);
    v.vx = 10;
    expect(shops.act(p, { op: 'buy', item: 'engine' }).ok).toBe(false);
    v.vx = 0;
    expect(shops.act(p, { op: 'buy', item: 'engine' }).ok).toBe(true);
    expect(v.mods.engine).toBe(1);
  });

  it('each upgrade in turn, up to its best, and the tuning goes to the driver', () => {
    const { sim, shops, sent } = setup();
    const at = first('tuning');
    const p = player(sim, at);
    const v = drive(sim, p, at);
    let spent = 0;
    for (const [key, max] of [['engine', 2], ['plating', 2], ['tyres', 1], ['nitro', 2]] as const) {
      for (let t = 1; t <= max; t++) {
        expect(shops.act(p, { op: 'buy', item: key }).ok, `${key} ${t}`).toBe(true);
        spent += PRICES[`${key}${t}` as keyof typeof PRICES];
        expect(v.mods[key]).toBe(t);
      }
      expect(shops.act(p, { op: 'buy', item: key }).ok).toBe(false);
    }
    expect(p.profile.money).toBe(10_000 - spent);
    expect(sent('mods').at(-1)).toMatchObject({ vehicle: v.id, mods: { engine: 2, plating: 2, tyres: 1, nitro: 2, glow: 0 } });
  });

  it('paint of the player\'s choice with a repair, and a neon (off for free)', () => {
    const { sim, shops, sent } = setup();
    const at = first('tuning');
    const p = player(sim, at);
    const v = drive(sim, p, at);
    v.kinematic = false;
    v.health = 20;
    v.dmg.front = 0.8;
    v.tyresBurst = 1;
    expect(shops.act(p, { op: 'buy', item: 'respray:3' }).ok).toBe(true);
    expect(v.color).toBe(PAINTS[3]);
    expect(v.health).toBe(v.spec.health);
    expect(v.dmg.front).toBe(0);
    expect(v.tyresBurst).toBe(0);
    expect(sent('spray').at(-1)).toEqual({ k: 'spray', vehicle: v.id, color: PAINTS[3] });
    expect(shops.act(p, { op: 'buy', item: 'respray:99' }).ok).toBe(false);
    expect(shops.act(p, { op: 'buy', item: 'glow:5' }).ok).toBe(true);
    expect(v.mods.glow).toBe(5);
    expect(shops.act(p, { op: 'buy', item: 'glow:5' }).ok).toBe(false);
    const money = p.profile.money;
    expect(shops.act(p, { op: 'buy', item: 'glow:0' }).ok).toBe(true);
    expect(v.mods.glow).toBe(0);
    expect(p.profile.money).toBe(money);
    expect(shops.act(p, { op: 'buy', item: `glow:${NEONS.length}` }).ok).toBe(false);
  });

  it('won\'t touch a police car, an event\'s van or a mission car', () => {
    const { sim, shops } = setup();
    const at = first('tuning');
    for (const make of [
      () => new Vehicle('police', at.x, at.y, 0, '#f5f5f5'),
      () => Object.assign(new Vehicle('van', at.x, at.y, 0, '#b71c1c'), { livery: LIVERY_KOFOLKA }),
      () => Object.assign(new Vehicle('sedan', at.x, at.y, 0, '#263238'), { mission: true }),
    ]) {
      const p = player(sim, at);
      const v = sim.addVehicle(make());
      expect(ownable(v)).toBe(false);
      expect(sim.enterVehicle(p, v, 5)).toBe(true);
      expect(shops.act(p, { op: 'buy', item: 'engine' }).ok).toBe(false);
      expect(shops.act(p, { op: 'buy', item: 'respray:1' }).ok).toBe(false);
      expect(tuned(v.mods)).toBe(false);
      sim.exitVehicle(p);
      sim.removeVehicle(v);
      sim.removePlayer(p);
    }
  });

  it('on the run, stopping there still resprays at once and loses the police', () => {
    const { sim } = setup();
    const at = first('tuning');
    const p = player(sim, at);
    const v = drive(sim, p, at);
    sim.setWanted(p, 2);
    run(sim, 0.5);
    expect(p.wanted).toBe(0);
    expect(v.color).not.toBe('#1565c0');
  });

  it('not on the run, stopping there changes nothing by itself', () => {
    const { sim } = setup();
    const at = first('tuning');
    const p = player(sim, at);
    const v = drive(sim, p, at);
    run(sim, 0.5);
    expect(v.color).toBe('#1565c0');
    expect(p.profile.money).toBe(10_000);
  });
});

describe('the garage', () => {
  it('is bought once, and its places too, up to six', () => {
    const { sim, shops } = setup();
    const g = first('garage');
    const p = player(sim, g, 20_000);
    expect(shops.act(p, { op: 'buy', item: 'slots' }).ok).toBe(false);
    expect(shops.act(p, { op: 'buy', item: 'garage' }).ok).toBe(true);
    expect(shops.act(p, { op: 'buy', item: 'garage' }).ok).toBe(false);
    expect(p.profile.gear).toMatchObject({ garages: [g.id], slots: SLOTS_START });
    expect(shops.act(p, { op: 'buy', item: 'slots' }).ok).toBe(true);
    expect(shops.act(p, { op: 'buy', item: 'slots' }).ok).toBe(true);
    expect(shops.act(p, { op: 'buy', item: 'slots' }).ok).toBe(false);
    expect(p.profile.gear?.slots).toBe(SLOTS_MAX);
    expect(p.profile.money).toBe(20_000 - PRICES.garage - PRICES.slots4 - PRICES.slots6);
  });

  it('keeps a car as it was (colour, tuning, damage) and gives it back at any of the player\'s garages', () => {
    const { sim, shops, sent } = setup();
    const [g1, g2] = shopPlaces(loadWorld()).filter((s) => s.kind === 'garage');
    const p = player(sim, g1, 20_000);
    expect(shops.act(p, { op: 'buy', item: 'garage' }).ok).toBe(true);
    const v = drive(sim, p, g1, 'sport', '#00bfa5');
    v.tune({ engine: 2, plating: 1, tyres: 1, nitro: 0, glow: 3 });
    v.health = 60;
    v.dmg.left = 0.4;
    expect(shops.act(p, { op: 'store' }).ok).toBe(true);
    expect(sim.vehicles.includes(v)).toBe(false);
    expect(p.ped.vehicle).toBeNull();
    expect(sent('stored').at(-1)).toMatchObject({ vehicle: v.id });
    expect(p.profile.gear?.cars).toEqual([{ kind: 'sport', color: '#00bfa5', mods: { engine: 2, plating: 1, tyres: 1, nitro: 0, glow: 3 }, hp: 60, dmg: [0, 0, 0.4, 0] }]);
    // not at a garage they don't own
    Object.assign(p.ped, { x: g2.x, y: g2.y });
    expect(shops.act(p, { op: 'take', slot: 0 }).ok).toBe(false);
    expect(shops.act(p, { op: 'buy', item: 'garage' }).ok).toBe(true);
    expect(shops.act(p, { op: 'take', slot: 1 }).ok).toBe(false);
    expect(shops.act(p, { op: 'take', slot: 0 }).ok).toBe(true);
    expect(p.profile.gear?.cars).toEqual([]);
    const back = sim.vehicles.find((q) => q.kind === 'sport')!;
    expect(back).toBeTruthy();
    expect(dist(back.x, back.y, g2.x, g2.y)).toBeLessThan(0.5);
    expect(back.color).toBe('#00bfa5');
    expect(back.mods).toEqual({ engine: 2, plating: 1, tyres: 1, nitro: 0, glow: 3 });
    expect(back.health).toBe(60);
    expect(back.dmg.left).toBe(0.4);
    // it waits for them: nobody else gets in, they do
    const q = player(sim, { x: back.x + 2, y: back.y + 2 });
    expect(sim.enterVehicle(q, back, 5)).toBe(false);
    expect(sim.enterVehicle(p, back, 12)).toBe(true);
  });

  it('won\'t take a car that isn\'t theirs to keep, more cars than it has places, nor one out when driving', () => {
    const { sim, shops } = setup();
    const g = first('garage');
    const p = player(sim, g, 20_000);
    expect(shops.act(p, { op: 'buy', item: 'garage' }).ok).toBe(true);
    const cop = drive(sim, p, g, 'police', '#f5f5f5');
    expect(shops.act(p, { op: 'store' }).ok).toBe(false);
    sim.exitVehicle(p);
    sim.removeVehicle(cop);
    for (let i = 0; i < SLOTS_START; i++) {
      drive(sim, p, g, 'hatch');
      expect(shops.act(p, { op: 'store' }).ok).toBe(true);
    }
    const extra = drive(sim, p, g, 'hatch');
    expect(shops.act(p, { op: 'store' }).ok).toBe(false);
    expect(shops.act(p, { op: 'take', slot: 0 }).ok).toBe(false);
    expect(p.ped.vehicle).toBe(extra);
  });

  it('a car out of the garage needs a clear door', () => {
    const { sim, shops } = setup();
    const g = first('garage');
    const p = player(sim, g, 20_000);
    expect(shops.act(p, { op: 'buy', item: 'garage' }).ok).toBe(true);
    drive(sim, p, g, 'hatch');
    expect(shops.act(p, { op: 'store' }).ok).toBe(true);
    const blocker = sim.addVehicle(new Vehicle('van', g.x, g.y, g.a, '#eeeeee'));
    expect(shops.act(p, { op: 'take', slot: 0 }).ok).toBe(false);
    expect(p.profile.gear?.cars?.length).toBe(1);
    sim.removeVehicle(blocker);
    expect(shops.act(p, { op: 'take', slot: 0 }).ok).toBe(true);
  });
});

describe('the teleport', () => {
  const w = loadWorld();
  const tps = teleports(w);

  it('one by each spawn place, in the street at ground level, where a car can drive off, away from the other shops', () => {
    expect(tps.map((t) => t.id)).toEqual(SPAWNS.map((s) => `teleport-${s.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]+/g, '-')}`));
    tps.forEach((t, i) => {
      expect(dist(t.x, t.y, SPAWNS[i].x, SPAWNS[i].y), t.id).toBeLessThan(260);
      expect(w.onBridge(t.x, t.y) || w.tunnelDepth(t.x, t.y) >= 0, t.id).toBe(false);
      expect(w.car.depth?.[w.car.nearest(t.x, t.y, 1)], t.id).toBe(0);
      expect(t.car && t.foot, t.id).toBe(true);
      for (const s of shopPlaces(w)) if (s !== t) expect(dist(s.x, s.y, t.x, t.y), `${t.id} / ${s.id}`).toBeGreaterThanOrEqual(25);
    });
  });

  it('on foot: pays, and arrives at the other one', () => {
    const { sim, shops, sent } = setup();
    const p = player(sim, tps[0]);
    const epoch = p.epoch;
    const r = shops.act(p, { op: 'buy', item: 'teleport:4' });
    expect(r.ok).toBe(true);
    expect(p.profile.money).toBe(10_000 - PRICES.teleport);
    expect(dist(p.ped.x, p.ped.y, tps[4].x, tps[4].y)).toBeLessThan(3);
    expect(shopAt(w, p.ped.x, p.ped.y, false)?.id).toBe(tps[4].id);
    expect(p.epoch).not.toBe(epoch);
    expect(sent('teleport').at(-1)).toMatchObject({ x: p.ped.x, y: p.ped.y, lvl: 0, epoch: p.epoch });
    expect(sent('teleport').at(-1)?.car).toBeUndefined();
  });

  it('in a car: the car goes too, standing still in the bay, facing along the street', () => {
    const { sim, shops, sent } = setup();
    const p = player(sim, tps[2]);
    const v = drive(sim, p, tps[2]);
    expect(shops.act(p, { op: 'buy', item: 'teleport:7' }).ok).toBe(true);
    expect(p.ped.vehicle).toBe(v);
    expect(dist(v.x, v.y, tps[7].x, tps[7].y)).toBeLessThanOrEqual(12.01);
    expect(v.speed).toBe(0);
    expect(v.angle).toBeCloseTo(tps[7].a, 6);
    expect(sent('teleport').at(-1)).toMatchObject({ car: v.id, x: v.x, y: v.y, a: tps[7].a });
    // and it drives on from there
    run(sim, 1);
    expect(p.ped.vehicle).toBe(v);
    expect(dist(v.x, v.y, tps[7].x, tps[7].y)).toBeLessThan(13);
  });

  it('from anywhere (the city map): on foot, in a car on the move (it comes too), off a scooter on foot', () => {
    const { sim, shops } = setup();
    const at = first('garage');
    expect(shopAt(w, at.x + 40, at.y + 40, false)).toBeNull();
    const p = player(sim, { x: at.x + 40, y: at.y + 40 });
    expect(shops.act(p, { op: 'buy', item: 'teleport:5' }).ok).toBe(true);
    expect(dist(p.ped.x, p.ped.y, tps[5].x, tps[5].y)).toBeLessThan(3);
    expect(p.profile.money).toBe(10_000 - PRICES.teleport);
    // in a car, driving
    const v = drive(sim, p, first('guns'));
    v.vx = 12;
    expect(shops.act(p, { op: 'buy', item: 'teleport:2' }).ok).toBe(true);
    expect(p.ped.vehicle).toBe(v);
    expect(v.speed).toBe(0);
    expect(dist(v.x, v.y, tps[2].x, tps[2].y)).toBeLessThanOrEqual(12.01);
    // on a scooter: it stays, they go
    sim.exitVehicle(p, true);
    const s = drive(sim, p, first('clothes'), 'scooter');
    expect(shops.act(p, { op: 'buy', item: 'teleport:3' }).ok).toBe(true);
    expect(p.ped.vehicle).toBeNull();
    expect(dist(p.ped.x, p.ped.y, tps[3].x, tps[3].y)).toBeLessThan(3);
    expect(dist(s.x, s.y, first('clothes').x, first('clothes').y)).toBeLessThan(3);
    // already standing in that bay
    expect(shops.act(p, { op: 'buy', item: 'teleport:3' }).text).toBe('Tu už si.');
  });

  it('refuses (and charges nothing): the same place, one that isn\'t there, no money, on the run, a job under way, a burning car', () => {
    const { sim, shops } = setup();
    const p = player(sim, tps[1]);
    for (const item of ['teleport:1', 'teleport:99', 'teleport:x', 'teleport']) expect(shops.act(p, { op: 'buy', item }).ok, item).toBe(false);
    p.profile.money = PRICES.teleport - 1;
    expect(shops.act(p, { op: 'buy', item: 'teleport:0' }).text).toContain(`€${PRICES.teleport}`);
    p.profile.money = 10_000;
    sim.setWanted(p, 1);
    expect(shops.act(p, { op: 'buy', item: 'teleport:0' }).ok).toBe(false);
    sim.setWanted(p, 0);
    const jobs = sim.rule<Jobs>('jobs')!;
    jobs.start(p, 'courier');
    expect(jobs.busy(p)).toBe(true);
    expect(shops.act(p, { op: 'buy', item: 'teleport:0' }).text).toBe('Najprv dokonči zákazku.');
    jobs.stop(p);
    const v = drive(sim, p, tps[1]);
    v.fire = 3;
    expect(shops.act(p, { op: 'buy', item: 'teleport:0' }).ok).toBe(false);
    expect(p.profile.money).toBe(10_000);
    expect(dist(p.ped.x, p.ped.y, tps[1].x, tps[1].y)).toBeLessThan(13);
    v.fire = -1;
    expect(shops.act(p, { op: 'buy', item: 'teleport:0' }).ok).toBe(true);
  });

  it('a car needs room in the bay at the other end', () => {
    const { sim, shops } = setup();
    const p = player(sim, tps[3]);
    const v = drive(sim, p, tps[3]);
    const t = tps[6], ux = Math.cos(t.a), uy = Math.sin(t.a);
    const blockers = [0, 6, -6, 12, -12].map((d) => sim.addVehicle(new Vehicle('van', t.x + ux * d, t.y + uy * d, t.a, '#eeeeee')));
    expect(shops.act(p, { op: 'buy', item: 'teleport:6' }).ok).toBe(false);
    expect(p.profile.money).toBe(10_000);
    expect(dist(v.x, v.y, tps[3].x, tps[3].y)).toBeLessThan(13);
    sim.removeVehicle(blockers[0]);
    expect(shops.act(p, { op: 'buy', item: 'teleport:6' }).ok).toBe(true);
    expect(dist(v.x, v.y, t.x, t.y)).toBeLessThan(1);
  });
});

describe('the collection', () => {
  it('ticks off each kind of vehicle driven, and pays once for all eight', () => {
    const { sim, sent } = setup();
    const at = first('garage');
    const p = player(sim, at, 0);
    for (const kind of COLLECTION) {
      const v = drive(sim, p, at, kind);
      sim.exitVehicle(p);
      sim.removeVehicle(v);
    }
    expect(p.profile.gear?.seen?.length).toBe(COLLECTION.length);
    expect(p.profile.gear?.seenAll).toBe(true);
    expect(p.profile.money).toBe(COLLECTION_REWARD);
    expect(sent('msg').filter((m) => m.title === 'ZBIERKA KOMPLETNÁ')).toHaveLength(1);
    // driving them all again pays nothing more
    for (const kind of COLLECTION) {
      const v = drive(sim, p, at, kind);
      sim.exitVehicle(p);
      sim.removeVehicle(v);
    }
    expect(p.profile.money).toBe(COLLECTION_REWARD);
  });
});

describe('prices and saves', () => {
  it('game_config overrides any price it gets right, and the rule charges it', () => {
    const merged = mergePrices({ ...PRICES }, { pistol: 99, uzi: -5, shotgun: 'x', vest: 1e9, rocket: 5, lawyer: 12.4 });
    expect(merged).toEqual({ ...PRICES, pistol: 99, lawyer: 12 });
    expect(mergePrices({ ...PRICES }, [1, 2])).toEqual(PRICES);
    const { sim, shops } = setup();
    shops.setPrices({ pistol: 10 });
    const p = player(sim, place('guns-michael'), 100);
    expect(shops.act(p, { op: 'buy', item: 'pistol' }).ok).toBe(true);
    expect(p.profile.money).toBe(90);
  });

  it('gear from a save keeps what makes sense and drops the rest', () => {
    expect(cleanGear(null)).toEqual({});
    expect(cleanGear([1])).toEqual({});
    const g = cleanGear({
      look: 3, hat: 9, garages: ['garage-eurovea', 'garage-eurovea', 7, ''], slots: 5,
      cars: [
        { kind: 'sport', color: '#00bfa5', mods: { engine: 9, glow: 3 }, hp: 500, dmg: [0.2, 2, -1, 0] },
        { kind: 'police', color: '#fff', mods: {}, hp: 50, dmg: [0, 0, 0, 0] },
        { kind: 'tank', color: '#fff', mods: {}, hp: 50, dmg: [0, 0, 0, 0] },
        { kind: 'hatch', color: '#fff', hp: 0, dmg: [0, 0, 0, 0] },
      ],
      seen: ['hatch', 'hatch', 'ufo', 'bus'], seenAll: 'yes', lawyer: true,
    });
    expect(g).toEqual({
      look: 3, garages: ['garage-eurovea'], slots: SLOTS_START,
      cars: [{ kind: 'sport', color: '#00bfa5', mods: { engine: 2, plating: 0, tyres: 0, nitro: 0, glow: 3 }, hp: SPECS.sport.health, dmg: [0.2, 1, 0, 0] }],
      seen: ['hatch', 'bus'], lawyer: true,
    });
    // no garage, no cars (and no places either)
    expect(cleanGear({ cars: [{ kind: 'hatch', color: '#fff', mods: {}, hp: 50, dmg: [0, 0, 0, 0] }] })).toEqual({});
    expect(cleanStoredCar({ kind: 'hatch', color: '#fff', hp: 10, dmg: [0, 0, 0, 0] })?.mods).toEqual(NO_MODS);
    expect(cleanMods({ engine: 1.6, plating: '2', tyres: 3, nitro: NaN, glow: 7 })).toEqual({ engine: 2, plating: 0, tyres: 1, nitro: 0, glow: 7 });
  });

  it('a stored car comes back as a real car', () => {
    const v = carFrom({ kind: 'van', color: '#123456', mods: { engine: 1, plating: 0, tyres: 1, nitro: 2, glow: 0 }, hp: 70, dmg: [0.1, 0, 0, 0.3] }, 5, 6, 1);
    expect([v.kind, v.color, v.x, v.y, v.angle, v.health, v.dmg.front, v.dmg.right, v.parked]).toEqual(['van', '#123456', 5, 6, 1, 70, 0.1, 0.3, true]);
    expect(v.mods.nitro).toBe(2);
    expect(v.burstTyres()).toBe(false);
  });
});
