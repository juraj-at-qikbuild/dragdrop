// A player's gear as read back from a save (the server's database, the offline localStorage save),
// checked field by field: whatever is missing or no longer makes sense is left out, never the rest.
import { PLAYER_SHIRTS } from '../../entities/Ped';
import { SPECS, type VehicleKind } from '../../entities/Vehicle';
import { COLLECTION, HATS, SLOTS_MAX, SLOTS_START, cleanMods, type Gear, type StoredCar } from './catalog';

/** no more garages than there are (places.ts has six); a save with more is not ours */
const GARAGES_MAX = 16;

const isInt = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;

export function cleanGear(v: unknown): Gear {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const g = v as Record<string, unknown>;
  const out: Gear = {};
  if (isInt(g.look, 0, PLAYER_SHIRTS.length - 1)) out.look = g.look;
  if (isInt(g.hat, 0, HATS.length - 1)) out.hat = g.hat;
  if (Array.isArray(g.garages)) {
    const ids = [...new Set(g.garages.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 64))].slice(0, GARAGES_MAX);
    if (ids.length) out.garages = ids;
  }
  // places come two at a time: 2, 4, 6
  if (out.garages) out.slots = isInt(g.slots, SLOTS_START, SLOTS_MAX) && (g.slots - SLOTS_START) % 2 === 0 ? g.slots : SLOTS_START;
  // (cars only ever go into a garage the player owns)
  if (out.garages && Array.isArray(g.cars)) {
    const cars = g.cars.map(cleanStoredCar).filter((c): c is StoredCar => !!c).slice(0, out.slots ?? SLOTS_START);
    if (cars.length) out.cars = cars;
  }
  if (Array.isArray(g.seen)) {
    const seen = [...new Set(g.seen.filter((k): k is VehicleKind => typeof k === 'string' && COLLECTION.includes(k as VehicleKind)))];
    if (seen.length) out.seen = seen;
  }
  if (g.seenAll === true) out.seenAll = true;
  if (g.lawyer === true) out.lawyer = true;
  return out;
}

/** a car kept in a garage, or null when it doesn't make sense (never a police car: garages don't
 *  take one; nor the car football's ball, which is no car) */
export function cleanStoredCar(v: unknown): StoredCar | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<Record<keyof StoredCar, unknown>>;
  if (typeof c.kind !== 'string' || !(c.kind in SPECS) || c.kind === 'police' || c.kind === 'ball') return null;
  const kind = c.kind as VehicleKind;
  if (typeof c.color !== 'string' || !c.color || c.color.length > 32) return null;
  if (typeof c.hp !== 'number' || !Number.isFinite(c.hp) || c.hp <= 0) return null;
  if (!Array.isArray(c.dmg) || c.dmg.length !== 4 || !c.dmg.every((d) => typeof d === 'number' && Number.isFinite(d))) return null;
  const dmg = c.dmg.map((d: number) => Math.max(0, Math.min(1, d))) as StoredCar['dmg'];
  return { kind, color: c.color, mods: cleanMods(c.mods), hp: Math.min(c.hp, SPECS[kind].health), dmg };
}
