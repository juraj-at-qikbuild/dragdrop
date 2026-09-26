// What people say when something happens to them: shown in a speech bubble over their head. The
// simulation picks a line (a category and an index, `SimEvents.say`), clients look the text up
// here. Tourists answer in English.

/** bumped into by a player */
export const SAY_BUMP = 0;
/** a gun pointed at them */
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

const LINES: string[][] = [
  ['Hej!', 'Pozor!', 'Dávaj pozor!', 'Kam sa ženieš?', 'Čo strkáš?', 'Aspoň sa ospravedlň!', 'Au!', 'No dovoľ!'],
  ['Nestrieľajte!', 'Pokoj, pokoj!', 'Neubližujte mi!', 'Zober si, čo chceš!', 'Prosím, nie!', 'Mám deti!'],
  ['Čo trúbiš?!', 'Veď už idem!', 'Pomaly!', 'Kam sa ponáhľaš?', 'Nervák!', 'Máš zelenú, či čo?'],
  ['Haló, polícia?', 'Prosím, rýchlo!', 'Tu sa strieľa!', 'Ukradol auto!', 'Pošlite hliadku!'],
  ['Poď sem!', 'To si prehnal!', 'No počkaj!', 'Čo si myslíš?', 'Poď, ak si chlap!', 'Ešte raz a...'],
  ['Blázon!', 'Vieš vôbec šoférovať?', 'Ty trubiroh!', 'Skoro ma zrazil!', 'Magor!'],
  ['Idem na električku.', 'Pekný deň, však?', 'Už to ide.', 'Kde je tá štvorka?', 'Zase mešká.'],
];

const TOURIST: string[][] = [
  ['Hey!', 'Watch it!', 'Excuse me?!', 'Ouch!', 'Rude!'],
  ["Don't shoot!", 'Take it, take it!', 'Please, no!', "I'm just a tourist!"],
  ['Easy!', "I'm going!", 'Relax!'],
  ['Police? Hello?', 'Somebody help!', 'Send someone, quick!'],
  ['Come on then!', 'You want some?'],
  ['Maniac!', 'Are you crazy?!', 'Learn to drive!'],
  ['Which way to the castle?', 'Lovely city!', 'Is this the right tram?'],
];

/** a line number (category × 16 + index) for `cat`, picked with `r` in [0, 1) */
export function pickLine(cat: number, tourist: boolean, r: number): number {
  const lines = (tourist ? TOURIST : LINES)[cat];
  return (tourist ? 128 : 0) + cat * 16 + Math.min(lines.length - 1, Math.floor(r * lines.length));
}

/** the text of a line number from `pickLine` */
export function lineText(line: number): string {
  const tourist = line >= 128, l = line & 127;
  return (tourist ? TOURIST : LINES)[l >> 4]?.[l & 15] ?? '';
}
