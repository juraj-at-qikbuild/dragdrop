// What the police are looking for, in Slovak (docs/plans/gameplay.md, Phases 1 and 2): a car's colour
// and model, or the clothes of someone on foot, declined the way a sentence needs them ("Hľadajú
// červenú Felíciu", "…biely autobus", "…modrú bundu so šiltovkou"), and the police radio's lines. Pure (no DOM), so test/client/police.test.ts can check the grammar.
import type { VehicleKind } from '../../../shared/entities/Vehicle';

type Gender = 'f' | 'm' | 'n';

/** each car kind as the police would name it: accusative (whom they're looking for), and nominative */
const MODEL: Record<VehicleKind, { acc: string; nom: string; g: Gender }> = {
  hatch: { acc: 'Felíciu', nom: 'Felícia', g: 'f' },
  sedan: { acc: 'Octávku', nom: 'Octávka', g: 'f' },
  taxi: { acc: 'taxík', nom: 'taxík', g: 'm' },
  police: { acc: 'policajnú Octávku', nom: 'policajná Octávka', g: 'f' },
  van: { acc: 'dodávku', nom: 'dodávka', g: 'f' },
  bus: { acc: 'autobus', nom: 'autobus', g: 'm' },
  sport: { acc: 'Porše', nom: 'Porše', g: 'n' },
  classic: { acc: 'Tatrovku', nom: 'Tatrovka', g: 'f' },
  ambulance: { acc: 'sanitku', nom: 'sanitka', g: 'f' },
  scooter: { acc: 'kolobežku', nom: 'kolobežka', g: 'f' },
  bike: { acc: 'bicykel', nom: 'bicykel', g: 'm' },
  boat: { acc: 'čln', nom: 'čln', g: 'm' },
  policeboat: { acc: 'policajný čln', nom: 'policajný čln', g: 'm' },
};

/** colour adjectives by stem: the endings follow the noun (masculine -ý, neuter -é, feminine -á, and
 *  -ú in the accusative). `short`: the stem's syllable is long (biel-, čier-), so by the rhythmic
 *  law every one of those endings shortens: biely, biele, biela, bielu. */
const COLORS: { stem: string; short?: boolean }[] = [
  { stem: 'čiern', short: true }, // 0 black
  { stem: 'siv' }, // 1 grey
  { stem: 'biel', short: true }, // 2 white
  { stem: 'červen' }, // 3 red
  { stem: 'oranžov' }, // 4 orange
  { stem: 'žlt' }, // 5 yellow
  { stem: 'zelen' }, // 6 green
  { stem: 'tyrkysov' }, // 7 teal
  { stem: 'modr' }, // 8 blue
  { stem: 'fialov' }, // 9 purple
  { stem: 'ružov' }, // 10 pink
  { stem: 'hned' }, // 11 brown
];

/** which of COLORS a car colour (#rrggbb) reads as */
export function colorIndex(hex: string): number {
  const c = parseInt(hex.replace('#', ''), 16);
  if (!isFinite(c)) return 1;
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  // blue-greys (the Octávka's slate, the Felícia's gunmetal) read as grey
  if (s < 0.22 || max - min < 0.08) return l < 0.22 ? 0 : l > 0.78 ? 2 : 1;
  let h = 0;
  if (max === r) h = ((g - b) / (max - min) + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / (max - min) + 2) * 60;
  else h = ((r - g) / (max - min) + 4) * 60;
  if (l < 0.2) return 0;
  // dark oranges read as brown, and so do the dullest dark reds (a maroon stays red)
  if ((h >= 12 && h < 45 && l < 0.42) || (h < 12 && l < 0.33 && s < 0.5)) return 11;
  if (h < 12 || h >= 345) return 3;
  if (h < 35) return 4;
  if (h < 70) return 5;
  if (h < 165) return 6;
  if (h < 195) return 7;
  if (h < 255) return 8;
  if (h < 300) return 9;
  return 10;
}

function adjective(color: string, g: Gender, acc: boolean) {
  const { stem, short } = COLORS[colorIndex(color)];
  const end = g === 'm' ? 'ý' : g === 'n' ? 'é' : acc ? 'ú' : 'á';
  return stem + (short ? ({ ý: 'y', é: 'e', ú: 'u', á: 'a' } as Record<string, string>)[end] : end);
}

/** a colour as an adjective, masculine or feminine: "červený", "biela" (the workshop's paints, "červený
 *  lak", and the Butik's jackets, "biela": the same words the police will use for them) */
export function colorWord(hex: string, g: 'm' | 'f' = 'm'): string {
  return adjective(hex, g, false);
}

/** "červenú Felíciu", "biely autobus", "oranžové Porše": whom the police look for (accusative).
 *  The police car keeps its own name (its livery says it all). */
export function describeCar(kind: VehicleKind, color: string): string {
  const m = MODEL[kind] ?? MODEL.sedan;
  if (kind === 'police' || kind === 'policeboat') return m.acc;
  return `${adjective(color, m.g, true)} ${m.acc}`;
}

/** "červená Felícia": the same, in the nominative */
export function nameCar(kind: VehicleKind, color: string): string {
  const m = MODEL[kind] ?? MODEL.sedan;
  if (kind === 'police' || kind === 'policeboat') return m.nom;
  return `${adjective(color, m.g, false)} ${m.nom}`;
}

/** a hat (HATS, docs/plans/gameplay.md Phase 2) as the police would add it: "so šiltovkou" */
const HAT_WITH = ['', 'so šiltovkou', 's klobúkom', 's prilbou', 'so šatkou'];

/** "modrú bundu so šiltovkou": whom the police look for on foot, by the clothes they last saw
 *  (accusative) */
export function describeClothes(color: string, hat = 0): string {
  const with_ = HAT_WITH[hat] ?? '';
  return `${adjective(color, 'f', true)} bundu${with_ ? ` ${with_}` : ''}`;
}

/** "pešieho podozrivého v modrej bunde so šiltovkou": the same for the police radio */
export function describeWalker(color: string, hat = 0): string {
  if (!color) return 'pešieho podozrivého';
  const with_ = HAT_WITH[hat] ?? '';
  return `pešieho podozrivého v ${COLORS[colorIndex(color)].stem}ej bunde${with_ ? ` ${with_}` : ''}`;
}

/** the chip's first line: what the police are looking for (car 0: the player on foot, by their
 *  clothes when the server says which) */
export function wantedLine(car: number, kind: string, color: string, hat = 0): string {
  if (car === 0 || !(kind in MODEL)) return color ? `Hľadajú ${describeClothes(color, hat)}` : 'Hľadajú ťa pešo';
  return `Hľadajú ${describeCar(kind as VehicleKind, color)}`;
}

/** the police radio (Vysielačka): `place` is a locative phrase ("na Moste SNP", see placeName) */
export const DISPATCH = {
  start: (what: string, place: string) => `Všetky hliadky: hľadáme ${what}, naposledy ${place}.`,
  lost: (place: string) => `Stratili sme ho ${place}. Prehľadajte okolie.`,
  switched: (what: string) => `Pozor, podozrivý prestúpil! Hľadáme ${what}.`,
  onFoot: () => 'Podozrivý vystúpil, pokračuje pešo.',
  changed: (what: string) => `Pozor, podozrivý sa prezliekol! Hľadáme ${what}.`,
  found: (place: string) => `Máme ho ${place}! Všetky hliadky tam.`,
  off: () => 'Pátranie odvolané. Späť na hliadky.',
} as const;
