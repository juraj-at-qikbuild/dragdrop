// The words of the introduction a newcomer gets on their first start (OnboardingUi): who counts as
// new, and what its four cards say (the basics, the world events, everything else there is to do,
// what money buys) for the way they play (keyboard and mouse, a gamepad or a touch screen), online or off. Pure (no
// DOM), so test/client/onboarding.test.ts can read it.
import type { EventEntry, EventKind } from '../../../shared/sim/rules/types';
import type { Profile } from '../../../shared/sim/SimPlayer';
import type { PriceId, Prices, ShopKind } from '../../../shared/sim/shops/catalog';
import { formatMoney } from '../../../shared/util/math';
import type { Forecast } from '../activities/forecast';
import { EVENT_ABOUT, EVENT_LABEL, EVENT_ORDER, candidatesLine, either, nextLine, soon } from '../activities/text';

/** how the player plays: the keyboard and mouse, a gamepad, a touch screen */
export type InputKind = 'key' | 'pad' | 'touch';

/** A player with nothing to show yet: no money, missions, landmarks, Čumils or purchases (online the
 *  server's profile, which knows an account's progress from its other devices too). */
export function looksNew(p: Profile): boolean {
  return !p.money && !p.done.length && !p.found.length && !p.cumils.length && !Object.keys(p.gear ?? {}).length;
}

/** `?intro=1`: a newcomer always gets the introduction, `?intro=0`: never by itself */
export function introParam(search: string): 'on' | 'off' | null {
  const v = new URLSearchParams(search).get('intro');
  return v === '1' ? 'on' : v === '0' ? 'off' : null;
}

/** Whether a newcomer's start opens the introduction by itself: once per device (`seen`), for a
 *  player with nothing to show yet (`fresh`), and not in an automated browser (the smoke and
 *  end-to-end scripts drive a new player every time), unless the URL says otherwise. */
export function autoIntro(o: { param: 'on' | 'off' | null; automated: boolean; seen: boolean; fresh: boolean }): boolean {
  if (o.param) return o.param === 'on';
  return !o.automated && !o.seen && o.fresh;
}

// ---------------------------------------------------------------------------------- the basics
/** a control and what it does: `cap` is a key or pad button, or an emoji on a touch screen */
export interface Row {
  cap: string;
  text: string;
}

export function welcomeTitle(online: boolean) {
  return online ? 'Vitaj v spoločnom meste' : 'Vitaj v Bratislave';
}

export function welcomeLead(online: boolean) {
  return online
    ? 'Všetci hráči sú v jednej Bratislave, na jej skutočných uliciach. Kradni autá, zarábaj a unikaj polícii.'
    : 'Skutočné ulice Bratislavy sú celé tvoje. Kradni autá, plň misie, zarábaj a unikaj polícii.';
}

/** the four things to know first (the pad's buttons are named as the HUD's legend names them) */
export function basics(input: InputKind): Row[] {
  switch (input) {
    case 'key':
      return [
        { cap: 'WASD', text: 'chôdza a jazda · Shift: beh, v aute nitro' },
        { cap: 'F', text: 'nastúpiť do auta – aj do cudzieho' },
        { cap: 'Myš', text: 'mierenie · ľavé tlačidlo: striekanie' },
        { cap: 'M', text: 'mapa mesta · klikni na cieľ a navigácia ťa dovedie' },
      ];
    case 'pad':
      return [
        { cap: 'LS', text: 'chôdza a jazda · A: beh, v aute nitro' },
        { cap: 'Y', text: 'nastúpiť do auta – aj do cudzieho' },
        { cap: 'RT', text: 'striekanie (v aute plyn) · pravou páčkou mieriš' },
        { cap: '⧉', text: 'mapa mesta · vyber cieľ a navigácia ťa dovedie' },
      ];
    case 'touch':
      return [
        { cap: '🕹️', text: 'ľavý palec kdekoľvek vľavo: chôdza a jazda' },
        { cap: '🟡', text: 'žlté tlačidlo: nastúpiť do auta – aj do cudzieho' },
        { cap: '💦', text: 'podrž: striekaš na najbližšieho' },
        { cap: '🗺️', text: 'ťukni na minimapu: mapa mesta a navigácia' },
      ];
  }
}

export const POLICE_NOTE = '★ Za zločiny ťa naháňa polícia. Keď ťa stratí z očí, hviezdy postupne zhasnú.';

// ---------------------------------------------------------------------------- the world events
export const EVENTS_TITLE = 'Udalosti v meste';

export function eventsLead(online: boolean) {
  return online
    ? 'Každých pár minút sa v meste niečo deje. Ohlási to banner hore a Rádio Kecy a na mape uvidíš, kde. Kto sa zapojí, môže vyhrať peniaze aj body do rebríčka.'
    : 'Aj keď hráš sám, v meste sa z času na čas niečo deje. Ohlási to banner hore a Rádio Kecy a na mape uvidíš, kde.';
}

/** each world event in a line: shorter than the Aktivity panel's EVENT_ABOUT, which has the prizes */
export const EVENT_HOOK: Record<EventKind, string> = {
  kofolka: 'Dodávka plná peňazí: kto ju šoféruje, zarába.',
  cumil: 'Nájdi zlatého Čumila v kruhu na mape.',
  armored: 'Oblievaj mu zámok, kým nezhrdzavie, a ber peniaze.',
  derby: 'Narážaj do ostatných, kým to ich autá nevzdajú, a vydrž do konca.',
  wanted: 'Hráč s 5★ má na hlave odmenu. Premoč ho do nitky.',
};

export const eventEmoji = (kind: EventKind) => EVENT_ABOUT[kind].emoji;

/** The kinds this game runs, in the panel's order, and the ones that come only online (offline the
 *  plan marks them `never`). Without a plan (a server from before it), every kind. */
export function eventKinds(f: Forecast | null): { here: EventKind[]; onlineOnly: EventKind[] } {
  if (!f) return { here: [...EVENT_ORDER], onlineOnly: [] };
  const status = new Map(f.kinds.map((k) => [k.kind, k.status.s]));
  return {
    here: EVENT_ORDER.filter((k) => status.has(k) && status.get(k) !== 'never'),
    onlineOnly: EVENT_ORDER.filter((k) => status.get(k) === 'never'),
  };
}

/** offline: what online play adds ('' when nothing) */
export function onlineOnlyLine(kinds: EventKind[]): string {
  if (!kinds.length) return '';
  return `Online ${kinds.length === 1 ? 'pribudne' : 'pribudnú'} aj ${either(kinds.map((k) => EVENT_LABEL[k]), true)}.`;
}

/** a world event on right now: "🥤 Horúca Kofolka práve beží pri Eurovei" (`left`: seconds left in
 *  its phase, for one that's only been announced; roughly, since the card doesn't count down) */
export function onNowLine(e: EventEntry, left: number): string {
  const when = e.phase === 'announce' ? `začne ${soon(left)}` : 'práve beží';
  return `${eventEmoji(e.kind)} ${EVENT_LABEL[e.kind]} ${when}${e.place ? ` ${e.place}` : ''}`;
}

/** with none on: when the next one may come, and what it could be */
export function comingLine(f: Forecast): string {
  return [nextLine(f), candidatesLine(f)].filter(Boolean).join(' ');
}

// ------------------------------------------------------------------------ everything else to do
export const THINGS_TITLE = 'Čo môžeš robiť';
export const THINGS_LEAD = 'Aj medzi udalosťami je v meste stále čo robiť.';

/** something to do: its key for the player's input (null: none, or a touch screen) */
export interface Thing {
  icon: string;
  key: string | null;
  title: string;
  about: string;
}

/** the mini-games and the rest, as the Aktivity panel lists them (`board`: the server keeps a
 *  leaderboard); the shops have a card of their own */
export function things(o: { online: boolean; input: InputKind; board: boolean }): Thing[] {
  const { input } = o;
  const key = (k: string, pad: string | null = null) => (input === 'key' ? k : input === 'pad' ? pad : null);
  const jobs: Thing = { icon: '💼', key: key('J', '←'), title: 'Práca', about: 'Vlk kuriér alebo Hopík taxi: rozvážaj jedlo a voz ľudí za peniaze.' };
  if (!o.online) {
    return [
      { icon: '☎', key: null, title: 'Misie', about: 'Šesť príbehov po meste. Začínajú pri žltých telefónnych búdkach.' },
      jobs,
      { icon: '🗿', key: null, title: 'Objavuj', about: 'Pamiatky a 10 skrytých Čumilov – za každý nález sú peniaze.' },
    ];
  }
  const out: Thing[] = [
    jobs,
    { icon: '🏁', key: key('H', 'X'), title: 'Závod?', about: 'Zastav pri aute iného hráča a podrž klaksón. Pretekáte o stávku.' },
    { icon: '👥', key: key('N'), title: 'Partia', about: 'Pozvi kamaráta odkazom – objaví sa hneď pri tebe.' },
    { icon: '📷', key: key('K'), title: 'Kde to je?', about: `Denná fotka miesta v meste. Kto tam príde prvý, berie ${formatMoney(1000)}.` },
  ];
  if (o.board) out.push({ icon: '🏆', key: key('L'), title: 'Rebríček', about: 'Body za udalosti, prácu, závody aj útek pred políciou.' });
  return out;
}

/** offline: what online play adds besides the world events */
export const OFFLINE_MORE = 'Online navyše: závody, partia s kamarátmi, denná fotka Kde to je? a rebríček.';

// ------------------------------------------------------------------------ what money buys
export const MONEY_TITLE = 'Na čo sú peniaze';

export function moneyLead(online: boolean) {
  return online
    ? 'Za prácu, udalosti a závody dostávaš peniaze. Minieš ich v obchodoch po meste.'
    : 'Za misie, prácu a nálezy dostávaš peniaze. Minieš ich v obchodoch po meste.';
}

/** a kind of shop: what it's for, and its cheapest price in the price list (`from`: there's more than
 *  one price) */
export interface Spend {
  kind: ShopKind;
  icon: string;
  title: string;
  about: string;
  price: string;
}

/** the shops, as the city has them: shorter than the shop panel's SHOP_KIND */
export function spending(p: Prices): Spend[] {
  const from = (ids: PriceId[]) => {
    const all = ids.map((id) => p[id]);
    const min = Math.min(...all);
    return `${all.some((v) => v !== min) ? 'od ' : ''}${formatMoney(min)}`;
  };
  return [
    { kind: 'guns', icon: '🧸', title: 'Hračkárstvo', about: 'Vodné pištole, bublifuky, konfety, vajíčka aj holub. A náplne do nich.', price: from(['pistol', 'uzi', 'shotgun', 'hammer', 'kofola', 'perfume', 'pea', 'blower', 'foam', 'soap', 'egg', 'clamp', 'bucket', 'pigeon']) },
    { kind: 'clothes', icon: '👕', title: 'Butik', about: 'Nová bunda či pokrývka hlavy. Polícia hľadá to, v čom ťa videla.', price: from(['jacket', 'hat']) },
    { kind: 'lawyer', icon: '⚖️', title: 'Advokát', about: 'Keď ťa zatknú, hračky ti ostanú a pokutu zaplatíš polovičnú.', price: from(['lawyer']) },
    { kind: 'tuning', icon: '🔧', title: 'Dielňa', about: 'Na benzínke, autom: lak s opravou, motor, pancier, pneumatiky, nitro, neón.', price: from(['respray', 'engine1', 'plating1', 'tyres1', 'nitro1', 'glow']) },
    { kind: 'garage', icon: '🅿️', title: 'Garáž', about: 'Tvoje auto tu počká aj s úpravami. Vyberieš ho v ktorejkoľvek svojej garáži.', price: from(['garage']) },
    { kind: 'teleport', icon: '🌀', title: 'Teleport', about: 'Z jedného teleportu na ktorýkoľvek iný – pešo aj s autom.', price: from(['teleport']) },
  ];
}

export const MONEY_NOTE = '💡 Úpravy patria autu. Aby ti ostali, nechaj ho v garáži.';

/** where the shops are: the city map, as the player opens it */
export function shopsHint(input: InputKind): Parts {
  const lead = 'Obchody nájdeš na mape – ';
  const tail = ' Do obchodu stačí vojsť.';
  if (input === 'touch') return [`${lead}ťukni na minimapu.${tail}`];
  return [`${lead}stlač `, { key: input === 'pad' ? '⧉' : 'M' }, `.${tail}`];
}

/** a sentence with a key cap in it: text, and `{ key }` where the cap goes */
export type Parts = (string | { key: string })[];

/** where all of it is listed from now on: the Aktivity panel, and its key as the player's input shows
 *  it (a touch screen names the chip instead) */
export function aktivityHint(input: InputKind): Parts {
  const lead = 'Všetko toto nájdeš v Aktivitách – ';
  if (input === 'touch') return [`${lead}ťukni na ☰ Aktivity.`];
  return input === 'pad' ? [`${lead}stlač `, { key: '↓' }, ' na krížiku.'] : [`${lead}stlač `, { key: 'U' }, '.'];
}

// ------------------------------------------------------------------------------------ the tip
/** the first time a world event is on (and the Aktivity panel was never opened): how to find out */
export function eventTip(input: InputKind): string {
  const how = input === 'key' ? 'Stlač U' : input === 'pad' ? 'Stlač ↓ na krížiku' : 'Ťukni na ☰ Aktivity';
  return `💡 V meste je udalosť! ${how} – zistíš, o čo ide, a nastavíš si k nej navigáciu.`;
}

/** the buttons */
export const NAV = {
  skip: 'Preskočiť',
  back: '‹ Späť',
  next: 'Ďalej ›',
  /** the last card, when it opened by itself at the start */
  play: 'Hrať!',
  /** the last card, opened again from the pause menu */
  done: 'Hotovo',
  aktivity: '📋 Otvoriť Aktivity',
  navigate: '📍 Navigovať',
  close: 'Zavrieť',
  /** the pause menu's button */
  again: '📖 Úvod do hry',
};
