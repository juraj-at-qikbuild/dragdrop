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

const LINES: string[][] = [
  ['Hej!', 'Pozor!', 'Dávaj pozor!', 'Kam sa ženieš?', 'Čo strkáš?', 'Aspoň sa ospravedlň!', 'Au!', 'No dovoľ!'],
  ['Len nie na vlasy!', 'Pokoj, pokoj!', 'Mám v tom mobil!', 'To je nový oblek!', 'Prosím, nie!', 'Práve idem od kaderníčky!'],
  ['Čo trúbiš?!', 'Veď už idem!', 'Pomaly!', 'Kam sa ponáhľaš?', 'Nervák!', 'Máš zelenú, či čo?'],
  ['Haló, polícia?', 'Prosím, rýchlo!', 'Tu sa strieka!', 'Ukradol auto!', 'Pošlite hliadku!', 'Oblieva ľudí!'],
  ['Poď sem!', 'To si prehnal!', 'No počkaj!', 'Čo si myslíš?', 'Aj ja mám striekačku!', 'Ešte raz a...'],
  ['Blázon!', 'Vieš vôbec šoférovať?', 'Ty trubiroh!', 'Skoro ma zrazil!', 'Magor!'],
  ['Idem na električku.', 'Pekný deň, však?', 'Už to ide.', 'Kde je tá štvorka?', 'Zase mešká.'],
  // SAY_UP, in UP_LINES' groups: wet, soapy, confetti, tickled, bumped
  [
    'Moje nové topánky!', 'Mokro až do ponožiek!', 'Idem sa prezliecť!', 'Práve idem od kaderníčky!',
    'Mám penu aj v ušiach!', 'Fuj, mydlo!', 'Aspoň voniam.',
    'Toto budem vyberať do Vianoc!', 'Konfety aj v topánkach!', 'Veď nie je Silvester!',
    'To nebolo fér!', 'Ešte ma to šteklí!', 'Chi-chi… nabudúce!',
    'Kde to som?', 'Vidím hviezdičky!', 'Vieš vôbec šoférovať?!',
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
    'Not fair!', 'Still tickles!', 'Hee-hee… stop!',
    'Where am I?', 'I see stars!', 'Learn to drive!',
  ],
];

/** SAY_UP's lines by what knocked them down: [first, how many] (the same for tourists) */
const UP_LINES: Record<Mess, [number, number]> = {
  water: [0, 4],
  bubbles: [4, 3],
  foam: [4, 3],
  confetti: [7, 3],
  tickle: [10, 3],
  bonk: [13, 3],
};

/** a line number (category × 16 + index) for `cat`, picked with `r` in [0, 1) */
export function pickLine(cat: number, tourist: boolean, r: number): number {
  const lines = (tourist ? TOURIST : LINES)[cat];
  return (tourist ? 128 : 0) + cat * 16 + Math.min(lines.length - 1, Math.floor(r * lines.length));
}

/** a SAY_UP line for someone getting up after `mess` knocked them down, picked with `r` in [0, 1) */
export function pickUpLine(mess: Mess, tourist: boolean, r: number): number {
  const [first, n] = UP_LINES[mess];
  return (tourist ? 128 : 0) + SAY_UP * 16 + first + Math.min(n - 1, Math.floor(r * n));
}

/** the text of a line number from `pickLine` */
export function lineText(line: number): string {
  const tourist = line >= 128, l = line & 127;
  return (tourist ? TOURIST : LINES)[l >> 4]?.[l & 15] ?? '';
}
