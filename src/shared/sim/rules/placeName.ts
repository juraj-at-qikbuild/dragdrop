// A position turned into a short Slovak phrase in the locative case, for radio lines and event
// markers ("na Moste SNP", "pri Eurovei", "na ulici Obchodná"). Tries, in order: a hand-written
// landmark table, a named square, a street, a quarter, then the district.
// Plan: docs/plans/social-events.md
import type { World } from '../../world/World';
import { dist } from '../../util/math';

/** Locative phrases for the landmarks most likely to come up in radio lines and event locations.
 *  Seeded with the ones a first pass could be confident about; every other landmark (and every point
 *  that isn't near one) falls through to the square/street/quarter/district chain below.
 *  Extend freely: `id -> "<preposition> <locative phrase>"`. */
export const LANDMARK_LOCATIVE: Record<string, string> = {
  snp: 'na Moste SNP',
  eurovea: 'pri Eurovei',
  aupark: 'pri Auparku',
  castle: 'pri Bratislavskom hrade',
  main: 'na Hlavnom námestí',
  michael: 'pri Michalskej bráne',
  cathedral: 'pri Dóme sv. Martina',
  oldbridge: 'pri Starom moste',
  apollo: 'na Moste Apollo',
  cumil: 'pri Čumilovi',
  parliament: 'pri Národnej rade SR',
  primate: 'pri Primaciálnom paláci',
  president: 'pri Prezidentskom paláci',
  market: 'pri Starej tržnici',
  sad: 'v Sade Janka Kráľa',
  hviezdoslav: 'na Hviezdoslavovom námestí',
  slavin: 'na Slavíne',
  radio: 'pri Slovenskom rozhlase',
  sng: 'v Slovenskej národnej galérii',
};

/** a landmark only counts within this range; farther away, the square/street chain takes over */
const LANDMARK_RANGE = 120;

/** The plan's small locative rule for named squares: "X námestie" -> "na X námestí", and the
 *  "Námestie X" shape (X a name that doesn't decline: a person's name in the genitive, or an
 *  abbreviation) -> "na Námestí X". Not full Slovak declension (the leading adjective in the first
 *  form keeps its nominative ending), but close enough for a HUD label or a radio aside. */
function squarePhrase(name: string): string {
  if (name.startsWith('Námestie ')) return 'na Námestí ' + name.slice('Námestie '.length);
  if (/námestie$/i.test(name)) return 'na ' + name.slice(0, -'námestie'.length) + 'námestí';
  return 'na ' + name;
}

/** Turn a position into a Slovak locative phrase, for radio lines ("Naháňačka na Moste SNP…") and
 *  the HUD. Tries the landmark table, then a named square, a street, a quarter and the district. */
export function placeName(world: World, x: number, y: number): string {
  let nearestId: string | null = null, nearestD = LANDMARK_RANGE;
  for (const id of Object.keys(LANDMARK_LOCATIVE)) {
    const l = world.landmarks.get(id);
    if (!l) continue;
    const d = dist(x, y, l.x, l.y);
    if (d < nearestD) (nearestD = d), (nearestId = id);
  }
  if (nearestId) return LANDMARK_LOCATIVE[nearestId];
  const sq = world.squareAt(x, y);
  if (sq) return squarePhrase(sq);
  const st = world.streetName(x, y);
  if (st) return 'na ulici ' + st;
  const q = world.quarter(x, y);
  if (q) return 'v štvrti ' + q;
  const d = world.district(x, y);
  if (d) return 'v časti ' + d;
  return 'v meste';
}
