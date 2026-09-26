// A position turned into a short Slovak phrase in the locative case, for radio lines and event
// markers ("na Moste SNP", "pri Eurovei", "na ulici Obchodná"). Tries, in order: a hand-written
// landmark table, a named square, a street, a quarter, then the district.
// Plan: docs/plans/social-events.md
import type { World } from '../../world/World';
import { dist } from '../../util/math';

/** Locative phrases for all 52 landmarks in the real map (see World.landmarks / public/data/
 *  bratislava.json), with the preposition a local would actually use: "pri" near a building or
 *  statue, "na" on a bridge or square, "v" inside a park/gallery/museum. Every point that isn't near
 *  one of these falls through to the square/street/quarter/district chain below. */
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
  reduta: 'v Redute',
  blue: 'pri Modrom kostolíku',
  snd: 'pri Slovenskom národnom divadle',
  kamenne: 'na Kamennom námestí',
  radnica: 'pri Starej radnici',
  jesuit: 'pri Jezuitskom kostole',
  franciscan: 'pri Františkánskom kostole',
  klarisky: 'pri Kostole Klarisiek',
  mirbach: 'pri Mirbachovom paláci',
  palffy: 'pri Pálffyho paláci',
  ganymede: 'pri Ganymedovej fontáne',
  vodnaveza: 'pri Vodnej veži',
  mikulas: 'pri Kostole sv. Mikuláša',
  chatam: 'pri Mauzóleu Chatama Sofera',
  snm: 'v Slovenskom národnom múzeu',
  uk: 'na Univerzite Komenského',
  snpsquare: 'na Námestí SNP',
  manderlak: 'pri Manderláku',
  kyjev: 'pri Hoteli Kyjev',
  synagogue: 'pri Synagóge',
  trinity: 'pri Trinitárskom kostole',
  capuchin: 'pri Kapucínskom kostole',
  lutheran: 'pri Veľkom evanjelickom kostole',
  hodzovo: 'na Hodžovom námestí',
  medicka: 'v Medickej záhrade',
  blumental: 'pri Blumentálskom kostole',
  nbs: 'pri Národnej banke Slovenska',
  newsnd: 'pri Novom SND',
  euroveatower: 'pri Eurovea Tower',
  panorama: 'pri Panorama City',
  skypark: 'pri Sky Parku',
  nivytower: 'pri Nivy Tower',
  incheba: 'pri Inchebe',
};

/** a landmark only counts within this range; farther away, the square/street chain takes over */
const LANDMARK_RANGE = 120;

/** Nominative-singular-neuter adjective -> locative singular, the two shapes that actually occur in
 *  Bratislava's square names: a possessive adjective from a surname ("Hurbanovo" -> "Hurbanovom",
 *  "Šafárikovo" -> "Šafárikovom") and a quality adjective ("Hlavné" -> "Hlavnom", "Rybné" ->
 *  "Rybnom", short-e forms from rhythmic shortening included: "Františkánske" -> "Františkánskom").
 *  A fixed genitive attribute from a surname ("Komenského", already genitive) never declines further
 *  and is returned unchanged. Falls back to the input for anything else — better an indeclinable name
 *  than a confidently wrong ending. */
function locativeNeuterAdj(word: string): string {
  if (word.endsWith('ého')) return word; // "Komenského námestie" -> "na Komenského námestí"
  if (word.endsWith('ovo')) return word + 'm'; // "Hurbanovo" -> "Hurbanovom"
  if (word.endsWith('é') || word.endsWith('e')) return word.slice(0, -1) + 'om'; // "Hlavné" -> "Hlavnom"
  return word;
}

/** The plan's locative rule for named squares: "X námestie" -> "na X-locative námestí" (declining
 *  the leading adjective, see above), and the "Námestie X" shape (X a name that doesn't decline: a
 *  person's name in the genitive, or an abbreviation) -> "na Námestí X". Not full Slovak declension,
 *  but grammatically correct for every square on the real map (see placeName.test.ts). */
// exported so tests can check every named square's grammar directly, without needing to find a
// point that lands inside each one's polygon
export function squarePhrase(name: string): string {
  if (name.startsWith('Námestie ')) return 'na Námestí ' + name.slice('Námestie '.length);
  if (/námestie$/i.test(name)) {
    const adj = name.slice(0, -'námestie'.length).trim();
    return 'na ' + locativeNeuterAdj(adj) + ' námestí';
  }
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
