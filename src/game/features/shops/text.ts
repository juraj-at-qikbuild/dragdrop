// The shops' words (docs/plans/gameplay.md, Phase 2): what each kind of shop is, its items, the
// colours and hats on offer, a car's tuning and a stored car in one line. Pure (no DOM), so
// test/client/shops.test.ts can check it.
import { SPECS, type VehicleKind } from '../../../shared/entities/Vehicle';
import { PLAYER_SHIRTS, type WeaponId } from '../../../shared/entities/Ped';
import { TOY_IDS, WEAPONS } from '../../../shared/sim/Combat';
import { AMMO_BOX, COLLECTION, MOD_MAX, type Mods, type ShopKind, type StoredCar } from '../../../shared/sim/shops/catalog';
import { colorWord } from '../police/text';

/** each kind of shop, generically, and what it's for (the panel's first line) */
export const SHOP_KIND: Record<ShopKind, { name: string; about: string }> = {
  guns: { name: 'Hračkárstvo', about: 'Striekačky, bublifuky, konfety, kladivko, Kofola aj holub. Všetko s náplňou. A pršiplášť, nech nezmokneš.' },
  clothes: { name: 'Butik', about: 'Polícia hľadá oblečenie, v ktorom ťa naposledy videla. Prezleč sa, kým sa nepozerá.' },
  lawyer: { name: 'Advokát', about: 'Pri ďalšom zatknutí ťa JUDr. Paragraf zastúpi: hračky ti ostanú a pokutu zaplatíš polovičnú.' },
  tuning: { name: 'Dielňa', about: 'Lak s opravou, výkon, pancier, pneumatiky, nitro a neón. Úpravy patria autu: aby ti ostali, nechaj ho v garáži.' },
  garage: { name: 'Garáž', about: 'Auto, ktoré tu necháš, vyberieš v ktorejkoľvek svojej garáži, s lakom, úpravami aj škrabancami.' },
  teleport: { name: 'Teleport', about: 'Metro Bratislava nemá, tak má teleport. Vyber si, kam chceš, a si tam: pešo, aj s autom, v ktorom sedíš.' },
};

/** how far a place is, as the teleport's list says it: "350 m", "2,4 km" */
export function distanceLine(m: number): string {
  return m < 975 ? `${Math.round(m / 50) * 50} m` : `${(Math.round(m / 100) / 10).toFixed(1).replace('.', ',')} km`;
}

/** the toys, as the shop names them (docs/plans/non-violent.md) */
export const GUN_NAME = Object.fromEntries(TOY_IDS.map((w) => [w, WEAPONS[w].name])) as Record<Exclude<WeaponId, 'fist'>, string>;

/** what each toy does, as the shop's shelf says it */
export const TOY_ABOUT: Record<Exclude<WeaponId, 'fist'>, string> = {
  pistol: 'Klasika. Premočí na diaľku.',
  uzi: 'Bubliny rýchlo za sebou.',
  shotgun: 'Konfety zblízka, do šírky.',
  hammer: 'Píísk! Zblízka posadí hocikoho.',
  kofola: 'Zatrepaná fľaša. Koho oblejete, lepí sa a chodí pomaly.',
  perfume: 'Babkina voňavka. Kto je blízko, kašle a uteká.',
  pea: 'Tichý hrášok na veľkú diaľku. Nikto nevie, odkiaľ letel.',
  blower: 'Zhodí ľudí a odfúkne kolobežky aj bicykle.',
  foam: 'Uhasí horiace auto. Aj tvoje.',
  soap: 'Hodíš a vznikne šmykľavka: autá sa šmýkajú, ľudia padajú.',
  egg: 'Na čelné sklo: vodič zastaví a utiera. Alebo rovno na hlavu.',
  clamp: 'Parkovacia papuča na koleso. Auto 10 sekúnd nepohne ani policajt.',
  bucket: 'Veľkonočná oblievačka. Premočí všetkých naokolo.',
  pigeon: 'Holub z Hlavného. Letí k najbližšiemu a nechá mu darček.',
};

/** "Vodná pištoľ + 36 striekancov" */
export function gunLine(w: Exclude<WeaponId, 'fist'>): string {
  return `${GUN_NAME[w]} + ${ammoLine(w, AMMO_BOX[w])}`;
}

/** what a toy's refill holds, counted: "36 striekancov", "2 bublinky", "1 dávka konfiet" */
export function ammoLine(w: Exclude<WeaponId, 'fist'>, n: number): string {
  const [one, few, many] = AMMO_WORDS[w];
  return `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
}

const AMMO_WORDS: Record<Exclude<WeaponId, 'fist'>, [string, string, string]> = {
  pistol: ['striekanec', 'striekance', 'striekancov'],
  uzi: ['bublinka', 'bublinky', 'bubliniek'],
  shotgun: ['dávka konfiet', 'dávky konfiet', 'dávok konfiet'],
  hammer: ['písknutie', 'písknutia', 'písknutí'],
  kofola: ['strek', 'streky', 'strekov'],
  perfume: ['fŕŕk', 'fŕŕky', 'fŕŕkov'],
  pea: ['hrášok', 'hrášky', 'hráškov'],
  blower: ['fúknutie', 'fúknutia', 'fúknutí'],
  foam: ['dávka peny', 'dávky peny', 'dávok peny'],
  soap: ['bomba', 'bomby', 'bômb'],
  egg: ['vajíčko', 'vajíčka', 'vajíčok'],
  clamp: ['papuča', 'papuče', 'papúč'],
  bucket: ['vedro', 'vedrá', 'vedier'],
  pigeon: ['holub', 'holuby', 'holubov'],
};

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
  plating: { name: 'Pancier', about: 'Auto znesie viac nárazov aj poriadnu oblievačku.' },
  tyres: { name: 'Dojazdové pneumatiky', about: 'Neprepichnú ich klince ani konfety.' },
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
