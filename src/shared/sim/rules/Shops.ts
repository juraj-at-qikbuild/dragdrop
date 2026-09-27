// What money buys, and where (docs/plans/gameplay.md, Phase 2). Every purchase, parking a car in a
// garage and taking one out goes through `act`, which checks where the player is (shops/places.ts),
// what they have and what it costs (the price list: shops/catalog.ts, overridden online by game_config),
// then does it. Offline the client calls it straight; online the server does, for a `shop` request.
// Also: the collection (every kind of vehicle driven), and a player's clothes when they arrive.
import { Vehicle, SPECS, type VehicleKind } from '../../entities/Vehicle';
import { PLAYER_SHIRTS, setPlayerHat, setPlayerLook, type WeaponId } from '../../entities/Ped';
import { LIVERY_NONE } from '../../entities/Vehicle';
import { dist } from '../../util/math';
import type { Sim } from '../Sim';
import type { SimPlayer } from '../SimPlayer';
import type { SimRule } from './SimRule';
import { POINTS } from './points';
import {
  AMMO_BOX, COLLECTION, COLLECTION_REWARD, HATS, MOD_MAX, NEONS, PAINTS, PRICES, SLOTS_MAX, SLOTS_START, mergePrices,
  type Gear, type Mods, type PriceId, type Prices, type StoredCar,
} from '../shops/catalog';
import { shopAt, type ShopPlace } from '../shops/places';

/** what a player asks a shop for */
export type ShopReq = { op: 'buy'; item: string } | { op: 'store' } | { op: 'take'; slot: number };

/** how it went, as the player is told */
export interface ShopResult {
  ok: boolean;
  text: string;
}

/** a car stopped in a workshop or at a garage door: slower than this (m/s) */
const STOPPED = 3;
/** reports lag a little behind the player: the server takes a door this much wider (m) */
const SLACK = 3;
const TUNE_KEYS = ['engine', 'plating', 'tyres', 'nitro'] as const;
/** a car taken out of the garage waits this long for its owner, nobody else can take it (s) */
const HOLD_S = 90;

/** a car the workshop may tune and a garage keep: not a police car, nor an event's or a mission's */
export function ownable(v: Vehicle): boolean {
  return v.kind !== 'police' && v.livery === LIVERY_NONE && !v.mission && !v.locked && !v.wrecked && v.fire <= -1 && !v.sinking;
}

export class Shops implements SimRule {
  readonly id = 'shops';
  prices: Prices = { ...PRICES };

  constructor(private sim: Sim) {}

  /** game_config's `shops` (the server): any item with a sane price */
  setPrices(v: unknown) {
    this.prices = mergePrices({ ...PRICES }, v);
  }

  /** the player's gear, created on first use */
  gear(p: SimPlayer): Gear {
    return (p.profile.gear ??= {});
  }

  /** where `p` is shopping, if anywhere: on foot, or stopped in a car */
  placeOf(p: SimPlayer, slack = SLACK): ShopPlace | null {
    const v = p.ped.vehicle;
    if (v && v.speed > STOPPED) return null;
    const f = p.focus();
    return shopAt(this.sim.world, f.x, f.y, !!v, slack);
  }

  // ------------------------------------------------------------------------------------------ act
  /** Do what `p` asked of the shop they're in. Tells them how it went (a `shop` event) and returns it. */
  act(p: SimPlayer, req: ShopReq): ShopResult {
    const r = this.run(p, req);
    this.sim.events.toPlayer(p.id, { k: 'shop', ok: r.ok, text: r.text });
    return r;
  }

  private run(p: SimPlayer, req: ShopReq): ShopResult {
    if (p.state !== 'play') return no('Teraz nie.');
    const place = this.placeOf(p);
    if (!place) return no('Tu nie je žiadny obchod.');
    if (req.op === 'store') return place.kind === 'garage' ? this.store(p, place) : no('Tu sa auto nedá odstaviť.');
    if (req.op === 'take') return place.kind === 'garage' ? this.take(p, place, req.slot) : no('Tu nie je tvoja garáž.');
    const [item, arg] = String(req.item ?? '').split(':');
    const n = arg === undefined ? -1 : Number(arg);
    switch (place.kind) {
      case 'guns':
        if (item === 'vest') return this.vest(p);
        if (item === 'pistol' || item === 'uzi' || item === 'shotgun') return this.gun(p, item);
        break;
      case 'clothes':
        if (item === 'jacket') return this.jacket(p, n);
        if (item === 'hat') return this.hat(p, n);
        break;
      case 'lawyer':
        if (item === 'lawyer') return this.lawyer(p);
        break;
      case 'tuning': {
        const v = p.ped.vehicle;
        if (!v) return no('Do dielne sa chodí autom.');
        if (!ownable(v)) return no('Toto auto sa tu upraviť nedá.');
        if (item === 'respray') return this.respray(p, v, n);
        if (item === 'glow') return this.glow(p, v, n);
        if ((TUNE_KEYS as readonly string[]).includes(item)) return this.upgrade(p, v, item as (typeof TUNE_KEYS)[number]);
        break;
      }
      case 'garage':
        if (item === 'garage') return this.buyGarage(p, place);
        if (item === 'slots') return this.buySlots(p);
        break;
    }
    return no('To sa tu nepredáva.');
  }

  /** take the money, if there is enough: false (and nothing taken) when there isn't */
  private pay(p: SimPlayer, id: PriceId, what: string): boolean {
    const price = this.prices[id];
    if (p.profile.money < price) return false;
    if (price > 0) {
      this.sim.addMoney(p, -price);
      this.sim.onSpend?.(p, price, what);
    }
    return true;
  }

  private broke(id: PriceId) {
    return no(`Na to nemáš (€${this.prices[id]}).`);
  }

  /** the gear changed: save it and tell the player */
  private changed(p: SimPlayer) {
    this.sim.onProfileChange?.(p);
    this.sim.events.toPlayer(p.id, { k: 'gear', g: this.gear(p) });
  }

  // ------------------------------------------------------------------ Poľovnícke potreby
  private gun(p: SimPlayer, w: Exclude<WeaponId, 'fist'>): ShopResult {
    if (p.ammo[w] >= 999) return no('Viac nábojov už neunesieš.');
    if (!this.pay(p, w, w)) return this.broke(w);
    p.ammo[w] = Math.min(999, p.ammo[w] + AMMO_BOX[w]);
    p.ped.weapon = w;
    this.sim.events.toPlayer(p.id, { k: 'pickup', kind: w, amount: AMMO_BOX[w] });
    return yes(`${w === 'pistol' ? 'Pištoľ' : w === 'uzi' ? 'Samopal' : 'Brokovnica'} +${AMMO_BOX[w]}`);
  }

  private vest(p: SimPlayer): ShopResult {
    if (p.ped.armor >= 100) return no('Vestu už máš.');
    if (!this.pay(p, 'vest', 'vest')) return this.broke('vest');
    p.ped.armor = 100;
    return yes('Nepriestrelná vesta');
  }

  // -------------------------------------------------------------------------------- Butik
  private jacket(p: SimPlayer, i: number): ShopResult {
    if (!Number.isInteger(i) || i < 0 || i >= PLAYER_SHIRTS.length) return no('Takú bundu nemáme.');
    if (p.ped.look === i) return no('Túto bundu už máš na sebe.');
    if (!this.pay(p, 'jacket', `jacket:${i}`)) return this.broke('jacket');
    this.gear(p).look = i;
    setPlayerLook(p.ped, i);
    this.changed(p);
    return yes('Nová bunda');
  }

  private hat(p: SimPlayer, i: number): ShopResult {
    if (!Number.isInteger(i) || i < 0 || i >= HATS.length) return no('Takú pokrývku nemáme.');
    if (p.ped.hat === i) return no('Tú už máš na hlave.');
    // taking one off is free
    if (i > 0 && !this.pay(p, 'hat', `hat:${i}`)) return this.broke('hat');
    this.gear(p).hat = i;
    setPlayerHat(p.ped, i);
    this.changed(p);
    return yes(i ? 'Nová pokrývka hlavy' : 'Bez pokrývky');
  }

  // ------------------------------------------------------------------------------ Advokát
  private lawyer(p: SimPlayer): ShopResult {
    const g = this.gear(p);
    if (g.lawyer) return no('Advokáta už máš.');
    if (!this.pay(p, 'lawyer', 'lawyer')) return this.broke('lawyer');
    g.lawyer = true;
    this.changed(p);
    return yes('JUDr. Paragraf ťa bude zastupovať pri ďalšom zatknutí.');
  }

  // -------------------------------------------------------------------------------- Dielňa
  private respray(p: SimPlayer, v: Vehicle, i: number): ShopResult {
    const color = PAINTS[i];
    if (!color) return no('Taký lak nemáme.');
    if (!this.pay(p, 'respray', 'respray')) return this.broke('respray');
    v.color = color;
    v.rev++;
    // a respray is a repair too
    if (!v.kinematic) {
      v.health = v.spec.health;
      v.fire = -1;
      v.dmg.front = v.dmg.rear = v.dmg.left = v.dmg.right = 0;
      v.tyresBurst = 0;
    }
    // (the driver's client simulates a player's car online: this tells it to paint and repair)
    this.sim.events.toPlayer(p.id, { k: 'spray', vehicle: v.id, color });
    // and the police, who look for the car's colour, are looking for another car now (Pursuit)
    return yes('Nový lak, auto ako nové.');
  }

  private upgrade(p: SimPlayer, v: Vehicle, key: (typeof TUNE_KEYS)[number]): ShopResult {
    const tier = v.mods[key] + 1;
    if (tier > MOD_MAX[key]) return no('Viac sa to vylepšiť nedá.');
    const id = `${key}${tier}` as PriceId;
    if (!(id in this.prices)) return no('To sa tu nepredáva.');
    if (!this.pay(p, id, id)) return this.broke(id);
    this.setMods(p, v, { ...v.mods, [key]: tier });
    const label = { engine: 'Motor', plating: 'Pancier', tyres: 'Dojazdové pneumatiky', nitro: 'Nádrž na nitro' }[key];
    return yes(key === 'tyres' ? label : `${label} ${tier === 1 ? 'I' : 'II'}`);
  }

  private glow(p: SimPlayer, v: Vehicle, i: number): ShopResult {
    if (!Number.isInteger(i) || i < 0 || i >= NEONS.length) return no('Taký neón nemáme.');
    if (v.mods.glow === i) return no(i ? 'Tento neón už máš.' : 'Neón nemáš.');
    // taking it off is free
    if (i > 0 && !this.pay(p, 'glow', `glow:${i}`)) return this.broke('glow');
    this.setMods(p, v, { ...v.mods, glow: i });
    return yes(i ? 'Neón pod autom' : 'Neón dole');
  }

  /** tune a car and tell its driver (whose client simulates it online) */
  private setMods(p: SimPlayer, v: Vehicle, m: Mods) {
    v.tune(m);
    v.rev++;
    this.sim.events.toPlayer(p.id, { k: 'mods', vehicle: v.id, mods: v.mods });
  }

  // --------------------------------------------------------------------------------- Garáž
  private owns(p: SimPlayer, place: ShopPlace) {
    return !!this.gear(p).garages?.includes(place.id);
  }

  private buyGarage(p: SimPlayer, place: ShopPlace): ShopResult {
    const g = this.gear(p);
    if (this.owns(p, place)) return no('Túto garáž už máš.');
    if (!this.pay(p, 'garage', place.id)) return this.broke('garage');
    (g.garages ??= []).push(place.id);
    g.slots ??= SLOTS_START;
    this.changed(p);
    return yes(`${place.name} je tvoja.`);
  }

  private buySlots(p: SimPlayer): ShopResult {
    const g = this.gear(p);
    if (!g.garages?.length) return no('Najprv si kúp garáž.');
    const slots = g.slots ?? SLOTS_START;
    if (slots >= SLOTS_MAX) return no('Viac miest už nebude.');
    const id: PriceId = slots < 4 ? 'slots4' : 'slots6';
    if (!this.pay(p, id, id)) return this.broke(id);
    g.slots = slots + 2;
    this.changed(p);
    return yes(`Tvoje garáže majú ${g.slots} miest.`);
  }

  /** park the car `p` drives in their garage: it leaves the street, they step out at the door */
  private store(p: SimPlayer, place: ShopPlace): ShopResult {
    const g = this.gear(p);
    const v = p.ped.vehicle;
    if (!this.owns(p, place)) return no('Táto garáž nie je tvoja.');
    if (!v) return no('Prídi autom, ktoré tu chceš nechať.');
    if (!ownable(v)) return no('Toto auto si v garáži nechať nemôžeš.');
    const cars = (g.cars ??= []);
    if (cars.length >= (g.slots ?? SLOTS_START)) return no('Garáž je plná.');
    cars.push({ kind: v.kind, color: v.color, mods: { ...v.mods }, hp: Math.max(1, Math.min(v.health, v.spec.health)), dmg: [v.dmg.front, v.dmg.rear, v.dmg.left, v.dmg.right] });
    // they step out at the door (where the garage is, on foot, too: its panel stays open)
    const door = this.sim.world.walkableNear(place.x, place.y);
    this.sim.exitVehicle(p, true, door);
    this.sim.removeVehicle(v);
    this.sim.events.toPlayer(p.id, { k: 'stored', vehicle: v.id, x: door.x, y: door.y });
    this.changed(p);
    return yes(`Auto je v garáži (${cars.length}/${g.slots ?? SLOTS_START}).`);
  }

  /** Take a stored car out: it waits at the door, held for `p` a while (Sim.reservedFromOthers), if
   *  the door is clear. They get in as into any car: online their client drives it, and a snapshot
   *  never carries a player's own car, so it has to be one their client already sees. */
  private take(p: SimPlayer, place: ShopPlace, slot: number): ShopResult {
    const g = this.gear(p);
    const cars = g.cars ?? [];
    if (!this.owns(p, place)) return no('Táto garáž nie je tvoja.');
    if (p.ped.vehicle) return no('Najprv vystúp alebo zaparkuj.');
    const c = cars[slot];
    if (!Number.isInteger(slot) || !c) return no('Také auto v garáži nemáš.');
    const v = carFrom(c, place.x, place.y, place.a);
    if (!this.clear(v)) return no('Pred garážou niečo stojí.');
    v.level = 0;
    v.levelInit = true;
    v.reservedFor = p.id;
    v.reservedUntil = this.sim.time + HOLD_S;
    this.sim.addVehicle(v);
    cars.splice(slot, 1);
    this.changed(p);
    return yes(`${SPECS[v.kind].name} ťa čaká pred garážou.`);
  }

  /** nothing in the way of a car put down here: walls, water, other cars */
  private clear(v: Vehicle): boolean {
    const world = this.sim.world;
    const r = v.spec.width / 2;
    for (let i = 0; i < v.circles.length; i++) {
      const x = v.circleX(i), y = v.circleY(i);
      if (world.collideCircle(x, y, r - 0.25, 0, false) || world.inWater(x, y, 0)) return false;
    }
    for (const o of this.sim.vehiclesNear(v.x, v.y, 14))
      for (let i = 0; i < v.circles.length; i++)
        for (let j = 0; j < o.circles.length; j++) if (dist(v.circleX(i), v.circleY(i), o.circleX(j), o.circleY(j)) < r + o.spec.width / 2 - 0.1) return false;
    return true;
  }

  // ---------------------------------------------------------------------------------- hooks
  /** a player arrives: in the clothes they bought */
  onAdd(p: SimPlayer) {
    const g = p.profile.gear;
    if (g?.look !== undefined && g.look >= 0 && g.look < PLAYER_SHIRTS.length) setPlayerLook(p.ped, g.look);
    if (g?.hat !== undefined) setPlayerHat(p.ped, g.hat);
  }

  /** the collection: a kind of vehicle driven for the first time */
  onEnter(p: SimPlayer, v: Vehicle) {
    const g = this.gear(p);
    const seen = (g.seen ??= []);
    if (seen.includes(v.kind) || !COLLECTION.includes(v.kind)) return;
    seen.push(v.kind);
    const n = seen.filter((k) => COLLECTION.includes(k)).length;
    this.sim.events.toPlayer(p.id, { k: 'msg', title: '', text: `Zbierka: ${SPECS[v.kind].name} (${n}/${COLLECTION.length})`, time: 3, color: '#ffd740' });
    if (n >= COLLECTION.length && !g.seenAll) {
      g.seenAll = true;
      this.sim.addMoney(p, COLLECTION_REWARD);
      this.sim.events.toPlayer(p.id, { k: 'msg', title: 'ZBIERKA KOMPLETNÁ', text: `Jazdil si na všetkom, čo po meste jazdí.  +€${COLLECTION_REWARD}`, time: 4, color: '#ffd740' });
      const f = p.focus();
      this.sim.score(p, POINTS.collection, 'collection', f.x, f.y);
    }
    this.changed(p);
  }
}

/** a stored car, back on the street at (x, y) facing `a` */
export function carFrom(c: StoredCar, x: number, y: number, a: number): Vehicle {
  const v = new Vehicle(c.kind in SPECS ? (c.kind as VehicleKind) : 'sedan', x, y, a, c.color);
  v.tune(c.mods);
  v.health = Math.max(1, Math.min(c.hp, v.spec.health));
  [v.dmg.front, v.dmg.rear, v.dmg.left, v.dmg.right] = c.dmg;
  v.parked = true;
  return v;
}

const yes = (text: string): ShopResult => ({ ok: true, text });
const no = (text: string): ShopResult => ({ ok: false, text });
