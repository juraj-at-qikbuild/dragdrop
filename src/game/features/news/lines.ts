// Turns a GlobalEvent into a short Slovak radio-DJ line for Rádio Kecy's breaking news, or null when
// it isn't worth interrupting the show. Pure and side-effect-free: the variant is picked from a hash
// of the event's own contents (never Math.random), so the same event always reads back the same way
// and NewsQueue/News.ts stay easy to test.
// Plan: docs/plans/social-events.md ("Rádio Kecy breaking news")
import type { GlobalEvent } from '../../../shared/sim/events';
import type { EventKind } from '../../../shared/sim/rules/types';
import { formatMoney, rng } from '../../../shared/util/math';

export interface NewsLine {
  text: string;
  priority: number;
}

/** turns a spot into a spoken Slovak phrase ("pri Eurovei"); News.ts passes `placeName` bound to the world */
export type PlaceFn = (x: number, y: number) => string;

type EndHow = Extract<GlobalEvent, { k: 'eventEnd' }>['how'];
type MostWantedHow = Extract<GlobalEvent, { k: 'mostWantedEnd' }>['how'];

const EVENT_NAME: Record<EventKind, string> = {
  kofolka: 'Horúca Kofolka',
  wanted: 'Najhľadanejší',
  cumil: 'Hon na Čumila',
  armored: 'Obrnené auto',
  derby: 'Derby na parkovisku',
};

/** small stable string hash (FNV-1a) turned into a seed for `rng`, so the same event contents always
 *  pick the same variant (no Math.random: the radio has to read the same story the same way for
 *  everyone, and tests need a fixed answer). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick(variants: readonly string[], seed: string): string {
  const i = Math.floor(rng(hash(seed))() * variants.length);
  return variants[Math.min(variants.length - 1, i)];
}

const cashOr = (amount: number | undefined, fallback: string) => (amount === undefined ? fallback : formatMoney(amount));
const winnerOr = (nick: string | undefined, fallback: string) => nick ?? fallback;

// ------------------------------------------------------------------------------- eventAnnounce
function announceLines(kind: EventKind, at: string, secs: number): string[] {
  switch (kind) {
    case 'kofolka':
      return [
        `Pozor, pozor! O ${secs} s vyráža Horúca Kofolka ${at} – dodávka plná peňazí!`,
        `Rádio Kecy hlási: Horúca Kofolka sa chystá ${at}. Kto ju ukoristí, zbohatne!`,
        `Guráž, Blavania – o chvíľu štartuje Horúca Kofolka ${at}!`,
      ];
    case 'wanted':
      return [
        `Pozor, chystá sa naháňačka storočia – niekto sa čoskoro stane Najhľadanejším ${at}!`,
        `Rádio Kecy varuje: o ${secs} s vypukne poplach Najhľadanejší ${at}.`,
        `Polícia bystrí zmysly – akcia Najhľadanejší sa blíži ${at}.`,
      ];
    case 'cumil':
      return [
        `Pripravte sa, Zlatý Čumil sa o ${secs} s schová ${at}!`,
        `Rádio Kecy avizuje Hon na Čumila – čoskoro ${at}.`,
        `Zlatý Čumil sa už chystá vykuknúť z kanála ${at}.`,
      ];
    case 'armored':
      return [
        `Obrnené auto s hotovosťou o chvíľu vyráža ${at}. Polícia bude v strehu!`,
        `Rádio Kecy hlási prevoz peňazí – o ${secs} s ${at}.`,
        `Chystá sa prepad storočia? Obrnené auto sa čoskoro objaví ${at}.`,
      ];
    default: // 'derby'
      return [
        `Motory vrčia, Derby na parkovisku sa o ${secs} s spúšťa ${at}!`,
        `Rádio Kecy hlási: aréna na Derby je pripravená ${at}.`,
        `Kto má nervy z ocele? Derby na parkovisku štartuje ${at}.`,
      ];
  }
}

// ----------------------------------------------------------------------------------- eventStart
function startLines(kind: EventKind, at: string): string[] {
  switch (kind) {
    case 'kofolka':
      return [
        `${at} sa objavila Horúca Kofolka – dodávka plná peňazí!`,
        `Horúca Kofolka práve vyrazila ${at}. Kto ju ukoristí, zbohatne!`,
        `Štartuje sa! Dodávka s Kofolkou je ${at}, plná drobných aj nedrobných.`,
      ];
    case 'wanted':
      return [
        `Akcia Najhľadanejší práve začala ${at}!`,
        `Polícia aj hráči majú nový cieľ – naháňačka je ${at}.`,
        `A je to tu! Najhľadanejší uteká ${at}.`,
      ];
    case 'cumil':
      return [
        `Zlatý Čumil vykukol z kanála ${at}!`,
        `Hon na Čumila sa začal! Zlatý úlovok je ${at}.`,
        `Kto ho nájde prvý? Zlatý Čumil sa ukrýva ${at}.`,
      ];
    case 'armored':
      return [
        `Obrnené auto práve vyrazilo na trasu bánk, prvá zastávka ${at}.`,
        `Vidno ho ${at}: obrnené auto plné peňazí sa dalo do pohybu!`,
        `Akcia Obrnené auto štartuje ${at} – zadné dvere sú cieľ.`,
      ];
    default: // 'derby'
      return [
        `Plech na plech! Derby na parkovisku sa práve rozbehlo ${at}.`,
        `Motory naštartované, Derby je v plnom prúde ${at}!`,
        `A je to tu: Derby na parkovisku ${at} práve odštartovalo.`,
      ];
  }
}

// ------------------------------------------------------------------------------------- eventEnd
/** the endings every kind can share (a timeout, a cancellation, or a generic "someone won" when a
 *  kind-specific line below doesn't cover the `how` it actually got) */
function genericEnd(name: string, at: string, how: EndHow, winner: string | undefined, cash: string): string[] {
  switch (how) {
    case 'won': {
      // "hráča" already governs the genitive here: a nick stays as-is (indeclinable), but the
      // fallback needs its own genitive form ("záhadného hráča"), not the nominative "záhadný hráč"
      // winnerOr() elsewhere always supplies (there it's the sentence's subject, so nominative is right)
      const who = winner ? `hráča ${winner}` : 'záhadného hráča';
      return [`Akcia ${name} sa skončila víťazstvom ${who} (${cash}) ${at}.`, `${winnerOr(winner, 'Niekto šikovný')} vyhral akciu ${name} ${at} a berie ${cash}!`];
    }
    case 'expired':
      return [`Akcia ${name} ${at} doznela, čas vypršal.`, `Nikto to nestihol – akcia ${name} ${at} sa skončila časom.`];
    case 'cancelled':
      return [`Akcia ${name} sa ${at} nekonala, málo záujemcov.`, `${name} sa dnes ${at} zrušilo.`];
    case 'wrecked':
      return [`${name} skončilo na kolenách ${at} – vrak namiesto koristi.`, `Niekto to prehnal: ${name} je ${at} na šrot.`];
    case 'robbed':
      return [`${name} bolo vylúpené ${at}!`, `${at} niekto práve vyplienil akciu ${name}.`];
    default: // 'delivered'
      return [`${name} došlo do cieľa ${at} v poriadku – tentokrát bez lúpeže.`, `${name} bezpečne dorazilo ${at}.`];
  }
}

function endLines(kind: EventKind, at: string, how: EndHow, winner: string | undefined, amount: number | undefined): string[] {
  const cash = cashOr(amount, 'balík peňazí');
  const name = EVENT_NAME[kind];
  if (kind === 'kofolka' && how === 'won')
    return [
      `Horúca Kofolka je prázdna! ${winnerOr(winner, 'Šťastlivec')} si odviezol ${cash} ${at}.`,
      `Posledné centy z Kofolky zhrabol ${winnerOr(winner, 'niekto šikovný')} – spolu ${cash} ${at}.`,
      `Dodávka je vyplienená do posledného eura! Gratulujeme, ${winnerOr(winner, 'víťaz')} (${cash}) ${at}.`,
    ];
  if (kind === 'cumil' && how === 'won')
    return [
      `Zlatého Čumila našiel ${winnerOr(winner, 'šikovný hráč')} ${at} a berie ${cash}!`,
      `Hon na Čumila má víťaza: ${winnerOr(winner, 'niekto rýchly')}, odmena ${cash}, ${at}.`,
      `Zlatý Čumil je nájdený! Gratulujeme, ${winnerOr(winner, 'víťaz')} (${cash}) ${at}.`,
    ];
  if (kind === 'armored') {
    if (how === 'robbed')
      return [`Zadné dvere obrneného auta povolili ${at} – peniaze sú vonku!`, `Vylúpili obrnené auto ${at}, hotovosť sa rozsypala po ulici!`, `Prepad sa podaril ${at}: obrnené auto je bez nákladu.`];
    if (how === 'delivered') return [`Obrnené auto doviezlo peniaze do poslednej banky ${at} – bez úhony.`, `Trasa bez incidentu: obrnené auto skončilo v poriadku ${at}.`];
    if (how === 'wrecked') return [`Obrnené auto skončilo rozbité ${at}, zvyšok nákladu je v prachu.`, `Niekto to s obrneným autom prehnal ${at} – je na kolenách.`];
  }
  if (kind === 'derby' && how === 'cancelled') return [`Derby na parkovisku ${at} sa nekonalo, prišlo málo áut.`, `Aréna ${at} dnes zíva prázdnotou – Derby je zrušené.`];
  return genericEnd(name, at, how, winner, cash);
}

// -------------------------------------------------------------------------------- mostWantedEnd
function mostWantedEndLines(nick: string, how: MostWantedHow, by: string | undefined, amount: number, at: string): string[] {
  const cash = formatMoney(amount);
  switch (how) {
    case 'taken':
      return [
        `${winnerOr(by, 'Niekto')} dostal Najhľadanejšieho ${nick} ${at} a inkasuje ${cash}!`,
        `Koniec naháňačky: ${winnerOr(by, 'neznámy hrdina')} zložil ${nick} ${at}, odmena ${cash} je jeho!`,
        `${nick} je dolapený! Zaslúžil sa o to ${winnerOr(by, 'iný hráč')} ${at}, odmena ${cash}.`,
      ];
    case 'busted':
      return [`Polícia zatkla Najhľadanejšieho ${nick} ${at}. Odmena prepadla mestu.`, `${nick} skončil v putách ${at} – polícia bola tentokrát rýchlejšia.`, `Koniec jazdy pre ${nick} ${at}: zatkli ho.`];
    case 'died':
      return [`Najhľadanejší ${nick} to nezvládol ${at}, naháňačka sa tak skončila.`, `${nick} skončil na dlažbe ${at}. Najhľadanejší je minulosťou.`];
    case 'escaped':
      return [`${nick} unikol polícii aj naháňačom ${at} a berie polovicu odmeny (${cash})!`, `Nedostali ho! ${nick} sa vytratil ${at} a berie ${cash} za trápenie.`];
    default: // 'left'
      return [`${nick} sa odpojil od hry a Najhľadanejší tak skončil bez víťaza.`, `Naháňačka na ${nick} sa skončila, keď zmizol zo servera.`, `${nick} nechal odmenu ${cash} bez majiteľa a odišiel z hry.`];
  }
}

/** `formatNews(e, place)` picks a Slovak DJ line for a city-wide event, or `null` when it isn't worth
 *  breaking in for. `place(x, y)` is `placeName` bound to the world (News.ts supplies it; kept as a
 *  parameter so this stays pure and DOM-free, and testable with a fake). */
export function formatNews(e: GlobalEvent, place: PlaceFn): NewsLine | null {
  // raceStart/raceResult `dest` is the landmark's display name, in the nominative ("Eurovea"): the
  // lines only use it in apposition ("do cieľa Eurovea"), never after a case-governing preposition
  switch (e.k) {
    case 'eventAnnounce': {
      const at = place(e.x, e.y);
      const secs = Math.max(1, Math.round(e.secs));
      return { text: pick(announceLines(e.kind, at, secs), `A:${e.kind}:${e.x}:${e.y}:${secs}`), priority: 2 };
    }
    case 'eventStart': {
      const at = place(e.x, e.y);
      return { text: pick(startLines(e.kind, at), `S:${e.kind}:${e.x}:${e.y}`), priority: 2 };
    }
    case 'eventEnd': {
      const at = place(e.x, e.y);
      const variants = endLines(e.kind, at, e.how, e.winner, e.amount);
      return { text: pick(variants, `E:${e.kind}:${e.how}:${e.x}:${e.y}:${e.winner ?? ''}:${e.amount ?? ''}`), priority: e.how === 'won' ? 3 : 2 };
    }
    case 'holder': {
      const at = place(e.x, e.y);
      const name = EVENT_NAME[e.kind];
      const variants = [
        `${e.nick} má teraz v rukách akciu ${name} ${at}!`,
        `Práve vedie ${e.nick} v akcii ${name} ${at}.`,
        `${e.nick} drží trumfy v akcii ${name} ${at} – kto ho zastaví?`,
      ];
      return { text: pick(variants, `H:${e.kind}:${e.nick}:${e.x}:${e.y}`), priority: 1 };
    }
    case 'mostWanted': {
      const at = place(e.x, e.y);
      const cash = formatMoney(e.bounty);
      const variants = [
        `${e.nick} má päť hviezd ${at} a polícia ho nevie chytiť!`,
        `Pozor, ${e.nick} je odteraz Najhľadanejší ${at} – odmena rastie každú minútu!`,
        `Rádio Kecy hlási poplach: ${e.nick} uteká polícii ${at}, odmena je už ${cash}!`,
        `Najhľadanejší je ${e.nick}, naposledy videný ${at}. Kto ho dostane, zarobí ${cash}!`,
      ];
      return { text: pick(variants, `MW:${e.nick}:${e.x}:${e.y}`), priority: 3 };
    }
    case 'mostWantedEnd': {
      const at = place(e.x, e.y);
      const variants = mostWantedEndLines(e.nick, e.how, e.by, e.amount, at);
      return { text: pick(variants, `MWE:${e.nick}:${e.how}:${e.by ?? ''}:${e.x}:${e.y}`), priority: e.how === 'taken' ? 3 : 2 };
    }
    case 'raceStart': {
      const stake = formatMoney(e.stake);
      const variants = [
        `${e.a} vyzval ${e.b} na Závod? Cieľ: ${e.dest}, v hre je ${stake}!`,
        `Rádio Kecy hlási novú stávku: ${e.a} proti ${e.b}, cieľ ${e.dest}, stávka ${stake}.`,
        `Na štarte sú ${e.a} a ${e.b} – ide sa do cieľa ${e.dest}, v hre ${stake}!`,
      ];
      return { text: pick(variants, `RS:${e.a}:${e.b}:${e.dest}:${e.stake}`), priority: 2 };
    }
    case 'raceResult': {
      const cash = formatMoney(e.amount);
      const variants = [
        `${e.winner} zdrhol hráčovi ${e.loser} v pretekoch do cieľa ${e.dest} a zhrabol ${cash}!`,
        `Výsledok súboja Závod?: ${e.winner} porazil hráča ${e.loser}, výhra ${cash}.`,
        `${e.winner} bol v cieli ${e.dest} prvý – ${e.loser} ostal v prachu a prišiel o ${cash}.`,
      ];
      return { text: pick(variants, `RR:${e.winner}:${e.loser}:${e.dest}:${e.amount}`), priority: 3 };
    }
    case 'derbyResult': {
      const winners = e.winners.length ? e.winners.join(', ') : 'nikto';
      const variants = [
        `Derby na parkovisku ${e.place} skončilo, víťazí ${winners}!`,
        `Plech na plechu ${e.place}: z Derby vyšiel víťazne ${winners}!`,
        `A je to! Derby ${e.place} rozhodlo v prospech: ${winners}.`,
      ];
      return { text: pick(variants, `DR:${winners}:${e.place}`), priority: 3 };
    }
    case 'dailyReveal': {
      const variants = [
        'Nová fotka v Kde to je? je online – poznáte to miesto?',
        'Rádio Kecy: dnešná hádanka Kde to je? je na table, poďte hádať!',
        'Kde to je? má nový obrázok. Prvý, kto uhádne miesto, berie tisícku!',
      ];
      return { text: pick(variants, `DREV:${e.img}`), priority: 2 };
    }
    case 'dailyHint': {
      const variants = [`Nápoveda ku Kde to je?: ${e.text}`, `Rádio Kecy pomáha: ${e.text}`, `Ešte to nemáte? Skúste toto: ${e.text}`];
      return { text: pick(variants, `DH:${e.level}:${e.text}`), priority: 1 };
    }
    case 'dailySolved': {
      const variants = [
        `${e.nick} uhádol dnešné Kde to je? a berie tisícku!`,
        `Máme víťaza! Kde to je? dnes vyriešil hráč ${e.nick}.`,
        `${e.nick} bol rýchlejší ako všetci ostatní – Kde to je? je vyriešené!`,
      ];
      return { text: pick(variants, `DS:${e.nick}`), priority: 3 };
    }
    case 'dailyAnswer': {
      const at = place(e.x, e.y);
      const variants = [`Včerajšie Kde to je? zostalo neuhádnuté – bolo to ${at}.`, `Nikto to netrafil: hľadané miesto bolo ${at}.`, `Rádio Kecy prezrádza: včerajšie miesto bolo ${at}.`];
      return { text: pick(variants, `DA:${e.x}:${e.y}`), priority: 2 };
    }
    case 'revived': {
      const at = place(e.x, e.y);
      const variants = [
        `${e.by} postavil na nohy hráča ${e.who} ${at}. Dobrý samaritán!`,
        `Kúsok ľudskosti ${at}: ${e.by} pozviechal hráča ${e.who}.`,
        `${e.who} je späť na nohách vďaka hráčovi ${e.by} ${at}.`,
      ];
      return { text: pick(variants, `RV:${e.by}:${e.who}:${e.x}:${e.y}`), priority: 1 };
    }
    default:
      // exhaustive: every GlobalEvent kind is handled above. Kept for a future kind added to the
      // union without a matching case here — better a silent skip than a build break at runtime.
      return null;
  }
}
