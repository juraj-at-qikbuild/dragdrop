// The shops' words (docs/plans/gameplay.md, Phase 2): what each kind of shop is, its items, the
// colours and hats on offer, a car's tuning and a stored car in one line. Pure (no DOM), so
// test/client/shops.test.ts can check it.
import { SPECS, type VehicleKind } from '../../../shared/entities/Vehicle';
import { PLAYER_SHIRTS, type WeaponId } from '../../../shared/entities/Ped';
import { AMMO_BOX, COLLECTION, MOD_MAX, type Mods, type ShopKind, type StoredCar } from '../../../shared/sim/shops/catalog';
import { colorWord } from '../police/text';

/** each kind of shop, generically, and what it's for (the panel's first line) */
export const SHOP_KIND: Record<ShopKind, { name: string; about: string }> = {
  guns: { name: 'Poľovnícke potreby', about: 'Zbraň s krabicou nábojov, nepriestrelná vesta.' },
  clothes: { name: 'Butik', about: 'Polícia hľadá oblečenie, v ktorom ťa naposledy videla. Prezleč sa, kým sa nepozerá.' },
  lawyer: { name: 'Advokát', about: 'Pri ďalšom zatknutí ťa JUDr. Paragraf zastúpi: zbrane ti ostanú a pokutu zaplatíš polovičnú.' },
  tuning: { name: 'Dielňa', about: 'Lak s opravou, výkon, pancier, pneumatiky, nitro a neón. Úpravy patria autu: aby ti ostali, nechaj ho v garáži.' },
  garage: { name: 'Garáž', about: 'Auto, ktoré tu necháš, vyberieš v ktorejkoľvek svojej garáži, s lakom, úpravami aj škrabancami.' },
};

/** the guns, as the shop names them */
export const GUN_NAME: Record<Exclude<WeaponId, 'fist'>, string> = { pistol: 'Pištoľ', uzi: 'Samopal', shotgun: 'Brokovnica' };

/** "Pištoľ + 36 nábojov" */
export function gunLine(w: Exclude<WeaponId, 'fist'>): string {
  return `${GUN_NAME[w]} + ${AMMO_BOX[w]} ${rounds(AMMO_BOX[w])}`;
}

/** "36 nábojov", "2 náboje", "1 náboj" */
function rounds(n: number): string {
  return n === 1 ? 'náboj' : n >= 2 && n <= 4 ? 'náboje' : 'nábojov';
}

const capital = (w: string) => `${w[0].toUpperCase()}${w.slice(1)}`;

/** a paint as the workshop names it: "Červený lak" */
export function paintName(hex: string): string {
  return `${capital(colorWord(hex))} lak`;
}

/** the jackets, in PLAYER_SHIRTS order, named as the police will describe them ("Modrá": "Hľadajú
 *  modrú bundu") */
export const JACKET_NAMES = PLAYER_SHIRTS.map((c) => capital(colorWord(c, 'f')));
/** the hats, in HATS order (0: none) */
export const HAT_NAMES = ['Bez pokrývky', 'Šiltovka', 'Klobúk', 'Prilba', 'Šatka'];
/** the neons, in NEONS order (0: none) */
export const NEON_NAMES = ['Bez neónu', 'Červený', 'Oranžový', 'Žltý', 'Zelený', 'Tyrkysový', 'Modrý', 'Fialový'];

export type ModKey = Exclude<keyof Mods, 'glow'>;
export const MOD_KEYS: readonly ModKey[] = ['engine', 'plating', 'tyres', 'nitro'];

/** each upgrade: its name and what it does */
export const MOD_INFO: Record<ModKey, { name: string; about: string }> = {
  engine: { name: 'Motor', about: 'Rýchlejší rozjazd a vyššia maximálka.' },
  plating: { name: 'Pancier', about: 'Auto znesie viac nárazov a striel.' },
  tyres: { name: 'Dojazdové pneumatiky', about: 'Klince ani strely ich neprepichnú.' },
  nitro: { name: 'Nádrž na nitro', about: 'Nitro vydrží dlhšie.' },
};

const ROMAN = ['', 'I', 'II', 'III'];

/** a tier as shown: "Motor II", "Dojazdové pneumatiky" */
export function modName(key: ModKey, tier: number): string {
  if (key === 'tyres' || MOD_MAX[key] === 1) return MOD_INFO[key].name;
  return `${MOD_INFO[key].name} ${ROMAN[tier] ?? tier}`;
}

/** a car's tuning in one line: "Motor II · Pancier I · Neón", or "Sériové" */
export function modsLine(m: Mods): string {
  const out: string[] = [];
  for (const k of MOD_KEYS) if (m[k] > 0) out.push(k === 'tyres' ? 'Dojazdové pneu' : k === 'nitro' ? `Nitro ${ROMAN[m[k]]}` : modName(k, m[k]));
  if (m.glow > 0) out.push('Neón');
  return out.length ? out.join(' · ') : 'Sériové';
}

/** how much of a car is left, in % of its full health */
export function condition(kind: VehicleKind, hp: number): number {
  const full = SPECS[kind]?.health ?? 100;
  return Math.max(1, Math.min(100, Math.round((hp / full) * 100)));
}

/** a car in the garage in one line: "Škodovka Felícia · 85 % · Motor I" */
export function storedCarLine(c: StoredCar): string {
  const m = modsLine(c.mods);
  return `${SPECS[c.kind]?.name ?? c.kind} · ${condition(c.kind, c.hp)} %${m === 'Sériové' ? '' : ` · ${m}`}`;
}

/** the collection so far: "Zbierka 5/8" */
export function collectionLine(seen: readonly string[] | undefined): string {
  const n = (seen ?? []).filter((k) => (COLLECTION as readonly string[]).includes(k)).length;
  return `Zbierka ${n}/${COLLECTION.length}`;
}

/** garage places as said: "2 miesta", "6 miest" */
export function placesWord(n: number): string {
  return `${n} ${n === 1 ? 'miesto' : n >= 2 && n <= 4 ? 'miesta' : 'miest'}`;
}
