// What money buys (docs/plans/gameplay.md, Phase 2): the items each kind of shop sells and their
// default prices (online, game_config's `shops` key overrides any of them), the paints and hats on
// offer, the tuning tiers, and what a player owns: their gear. Shared by the simulation (rules/
// Shops.ts, which sells), the server (which persists gear) and the client (which shows it).
import type { VehicleKind } from '../../entities/Vehicle';
import type { WeaponId } from '../../entities/Ped';

export type ShopKind = 'guns' | 'clothes' | 'lawyer' | 'tuning' | 'garage';

/** tuning, per car (Vehicle.mods): tiers 0 = stock */
export interface Mods {
  /** 0..2: acceleration and top speed */
  engine: number;
  /** 0..2: damage taken */
  plating: number;
  /** 0..1: run-flat tyres (spikes and shots can't burst them) */
  tyres: number;
  /** 0..2: a bigger nitro tank */
  nitro: number;
  /** 0..7: neon underglow, an index into NEONS (0 = none) */
  glow: number;
}

export const NO_MODS: Readonly<Mods> = Object.freeze({ engine: 0, plating: 0, tyres: 0, nitro: 0, glow: 0 });

/** each tier's effect: acceleration and top speed (engine), damage taken (plating), how long the
 *  nitro lasts (tank) */
export const ENGINE = [
  { accel: 1, top: 1 },
  { accel: 1.15, top: 1.06 },
  { accel: 1.3, top: 1.12 },
] as const;
export const PLATING = [1, 0.75, 0.55] as const;
export const TANK = [1, 1.5, 2] as const;
export const MOD_MAX: Record<Exclude<keyof Mods, 'glow'>, number> = { engine: 2, plating: 2, tyres: 1, nitro: 2 };

/** neon underglow colours (index 1..7; 0 = none) */
export const NEONS = ['', '#ff1744', '#ff9100', '#ffea00', '#00e676', '#00e5ff', '#2979ff', '#d500f9'] as const;

/** the workshop's paints (a respray picks one) */
export const PAINTS = [
  '#c62828', '#d50000', '#ff6f00', '#f9a825', '#2e7d32', '#00bfa5', '#1565c0', '#1a237e', '#8e24aa', '#6d4c41', '#eeeeee', '#b0bec5', '#455a64', '#212121',
] as const;

/** a player figure's headwear (Ped.hairStyle), index 0 = none */
export const HATS = ['short', 'cap', 'hat', 'helmet', 'scarf'] as const;

/** a car kept in a garage */
export interface StoredCar {
  kind: VehicleKind;
  color: string;
  mods: Mods;
  /** health, and located damage [front, rear, left, right] 0..1 */
  hp: number;
  dmg: [number, number, number, number];
}

/** What a player owns and wears (Profile.gear), saved with their profile. */
export interface Gear {
  /** the jacket (an index into PLAYER_SHIRTS) and the hat (HATS) bought at a Butik; unset: as dealt */
  look?: number;
  hat?: number;
  /** the garages bought (their place ids), how many cars they hold between them, and those cars */
  garages?: string[];
  slots?: number;
  cars?: StoredCar[];
  /** every kind of vehicle the player has driven (the collection), and whether its reward was paid */
  seen?: VehicleKind[];
  seenAll?: boolean;
  /** a lawyer on retainer: the next arrest keeps the guns and halves the fee */
  lawyer?: boolean;
}

/** garage places: 2 to start with, +2 per upgrade */
export const SLOTS_START = 2;
export const SLOTS_MAX = 6;

/** Default prices (€). Online, game_config's `shops` overrides any of them (Shops.setPrices). */
export const PRICES = {
  // Poľovnícke potreby
  pistol: 250,
  uzi: 700,
  shotgun: 900,
  vest: 300,
  // Butik
  jacket: 150,
  hat: 120,
  // Advokát
  lawyer: 500,
  // Dielňa
  respray: 250,
  engine1: 900,
  engine2: 1800,
  plating1: 800,
  plating2: 1600,
  tyres1: 600,
  nitro1: 500,
  nitro2: 1000,
  glow: 400,
  // Garáž
  garage: 2500,
  slots4: 1500,
  slots6: 2500,
};
export type Prices = typeof PRICES;
export type PriceId = keyof Prices;

/** what a box of ammo holds, per gun (as the pickups do) */
export const AMMO_BOX: Record<Exclude<WeaponId, 'fist'>, number> = { pistol: 36, uzi: 120, shotgun: 16 };

/** the collection: every kind there is (the kinds Phase 3 adds included) */
export const COLLECTION: readonly VehicleKind[] = ['hatch', 'sedan', 'taxi', 'van', 'bus', 'sport', 'classic', 'police', 'ambulance', 'scooter', 'bike', 'boat', 'policeboat'];
/** ...and its one-off reward */
export const COLLECTION_REWARD = 1000;

/** a death's fee drops where they died, all but this much of it (docs/plans/gameplay.md, Phase 2) */
export const DROP_KEEP = 100;
/** ...and the cash lies there this long (s) */
export const DROP_LIFE = 120;

/** Take a price list from game_config: every known item with a sane whole number; anything else is
 *  left as it was. */
export function mergePrices(into: Prices, v: unknown): Prices {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return into;
  const out = { ...into };
  for (const k of Object.keys(PRICES) as PriceId[]) {
    const n = (v as Record<string, unknown>)[k];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e6) out[k] = Math.round(n);
  }
  return out;
}

/** a car's mods, sanitised (from a save, the wire) */
export function cleanMods(v: unknown): Mods {
  const m = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof Mods, unknown>>;
  const tier = (x: unknown, max: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(max, Math.round(x))) : 0);
  return {
    engine: tier(m.engine, MOD_MAX.engine),
    plating: tier(m.plating, MOD_MAX.plating),
    tyres: tier(m.tyres, MOD_MAX.tyres),
    nitro: tier(m.nitro, MOD_MAX.nitro),
    glow: tier(m.glow, NEONS.length - 1),
  };
}

/** any mod at all */
export const tuned = (m: Mods) => m.engine + m.plating + m.tyres + m.nitro + m.glow > 0;
