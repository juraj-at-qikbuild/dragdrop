// What people say when something happens to them: shown in a speech bubble over their head. The
// simulation picks a line (a category and an index, `SimEvents.say`), clients look the text up
// here. Tourists answer in English. Nobody gets hurt (docs/plans/non-violent.md): they get wet,
// soapy or covered in confetti, and they grumble about it.
import type { Mess } from '../entities/Ped';

/** bumped into by a player */
export const SAY_BUMP = 0;
/** a toy pointed at them */
export const SAY_GUN = 1;
/** honked at */
export const SAY_HORN = 2;
/** phoning the police about a player */
export const SAY_PHONE = 3;
/** squaring up to a player */
export const SAY_FIGHT = 4;
/** jumped out of the way of a car */
export const SAY_DODGE = 5;
/** getting up off a bench, off to catch a tram... small talk */
export const SAY_CHAT = 6;
/** getting up again after being knocked down: lines by what did it (`pickUpLine`) */
export const SAY_UP = 7;
/** ...more of them: what the Hračkárstvo's second shelf leaves (sticky, perfumed, a pea on the
 *  neck...), also said on a hit that doesn't sit them down (a cough, a pea) */
export const SAY_UP2 = 8;
/** a tourist's line: this bit set (English); the category is the next four bits up from the index */
const TOURIST_BIT = 256;

const LINES: string[][] = [
  ['Hej!', 'Pozor!', 'Dávaj pozor!', 'Kam sa ženieš?', 'Čo strkáš?', 'Aspoň sa ospravedlň!', 'Au!', 'No dovoľ!'],
  ['Len nie na vlasy!', 'Pokoj, pokoj!', 'Mám v tom mobil!', 'To je nový oblek!', 'Prosím, nie!', 'Práve idem od kaderníčky!'],
  ['Čo trúbiš?!', 'Veď už idem!', 'Pomaly!', 'Kam sa ponáhľaš?', 'Nervák!', 'Máš zelenú, či čo?'],
  ['Haló, polícia?', 'Prosím, rýchlo!', 'Tu sa strieka!', 'Ukradol auto!', 'Pošlite hliadku!', 'Oblieva ľudí!'],
  ['Poď sem!', 'To si prehnal!', 'No počkaj!', 'Čo si myslíš?', 'Aj ja mám striekačku!', 'Ešte raz a...'],
  ['Blázon!', 'Vieš vôbec šoférovať?', 'Ty trubiroh!', 'Skoro ma zrazil!', 'Magor!'],
  ['Idem na električku.', 'Pekný deň, však?', 'Už to ide.', 'Kde je tá štvorka?', 'Zase mešká.'],
  // SAY_UP, in UP_LINES' groups: wet, soapy, confetti, tickled, then bumped and sooty (sharing two)
  [
    'Moje nové topánky!', 'Mokro až do ponožiek!', 'Idem sa prezliecť!', 'Práve idem od kaderníčky!',
    'Mám penu aj v ušiach!', 'Fuj, mydlo!', 'Aspoň voniam.',
    'Toto budem vyberať do Vianoc!', 'Konfety aj v topánkach!', 'Veď nie je Silvester!',
    'Ešte ma to šteklí!', 'Chi-chi… nabudúce!',
    'Vieš vôbec šoférovať?!', 'Vidím hviezdičky!', 'Kde to som?', 'Khe-khe… vyzerám ako kominár!',
  ],
  // SAY_UP2, in UP_LINES' groups: Kofola, perfume, a pea, leaves, foam, an egg, a pigeon
  [
    'Celý sa lepím!', 'Kofola aj v topánkach!', 'Veď ja pijem len vodu!',
    'Khe-khe! Čo je to?!', 'Voniam ako babka!', 'Fuj, to je Tosca?!',
    'Au! Čo to bolo?', 'Niekto po mne pľuje hrach!',
    'Mám lístie všade!', 'Ako na jeseň!',
    'Veď nehorím!', 'Som ako snehuliak!',
    'Vajce?! Veď ešte nie je Veľká noc!', 'Mám praženicu vo vlasoch!',
    'Vraj to prináša šťastie…', 'Holuby! Zasa!',
  ],
];

const TOURIST: string[][] = [
  ['Hey!', 'Watch it!', 'Excuse me?!', 'Ouch!', 'Rude!'],
  ['Not my camera!', 'Not the hair!', 'My phone!', "I'm just a tourist!"],
  ['Easy!', "I'm going!", 'Relax!'],
  ['Police? Hello?', 'Somebody help!', 'Send someone, quick!'],
  ["Oh, it's on!", "You'll pay for this!"],
  ['Maniac!', 'Are you crazy?!', 'Learn to drive!'],
  ['Which way to the castle?', 'Lovely city!', 'Is this the right tram?'],
  [
    'My shoes!', "I'm soaked!", 'Not the hair!', 'So wet!',
    'Soap in my ears!', 'Ugh, bubbles!', 'At least I smell nice.',
    'Confetti everywhere!', 'Is it a wedding?', 'Not New Year yet!',
    'Still tickles!', 'Hee-hee… stop!',
    'Learn to drive!', 'I see stars!', 'Where am I?', 'Cough… I look like a chimney sweep!',
  ],
  [
    'So sticky!', 'Kofola? What is Kofola?!', 'My shoes are glued!',
    'Cough! What is that smell?', 'I smell like grandma!', 'Too much perfume!',
    'Ow! A pea?', 'Who spits peas?!',
    'Leaves everywhere!', 'Is it autumn already?',
    "I'm not on fire!", "I'm a snowman!",
    'An egg?! Really?', 'Scrambled hair!',
    "They say it's lucky…", 'Pigeons! Again!',
  ],
];

/** the getting-up lines by what knocked them down: [category, first, how many] (the same for tourists) */
const UP_LINES: Record<Mess, [number, number, number]> = {
  water: [SAY_UP, 0, 4],
  bubbles: [SAY_UP, 4, 3],
  confetti: [SAY_UP, 7, 3],
  tickle: [SAY_UP, 10, 2],
  bonk: [SAY_UP, 12, 3],
  soot: [SAY_UP, 13, 3],
  kofola: [SAY_UP2, 0, 3],
  perfume: [SAY_UP2, 3, 3],
  pea: [SAY_UP2, 6, 2],
  leaves: [SAY_UP2, 8, 2],
  foam: [SAY_UP2, 10, 2],
  egg: [SAY_UP2, 12, 2],
  pigeon: [SAY_UP2, 14, 2],
};

/** a line number (category × 16 + index, TOURIST_BIT for English) for `cat`, picked with `r` in [0, 1) */
export function pickLine(cat: number, tourist: boolean, r: number): number {
  const lines = (tourist ? TOURIST : LINES)[cat];
  return (tourist ? TOURIST_BIT : 0) + cat * 16 + Math.min(lines.length - 1, Math.floor(r * lines.length));
}

/** a getting-up line for someone after `mess` knocked them down, picked with `r` in [0, 1) */
export function pickUpLine(mess: Mess, tourist: boolean, r: number): number {
  const [cat, first, n] = UP_LINES[mess];
  return (tourist ? TOURIST_BIT : 0) + cat * 16 + first + Math.min(n - 1, Math.floor(r * n));
}

/** the category of a line number */
export const lineCat = (line: number) => (line & (TOURIST_BIT - 1)) >> 4;

/** the text of a line number from `pickLine` */
export function lineText(line: number): string {
  const tourist = line >= TOURIST_BIT, l = line & (TOURIST_BIT - 1);
  return (tourist ? TOURIST : LINES)[l >> 4]?.[l & 15] ?? '';
}
