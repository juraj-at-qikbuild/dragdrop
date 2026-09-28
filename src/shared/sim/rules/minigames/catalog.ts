// What every mini-game is (docs/plans/minigames.md): its name, what it's about (the real Bratislava it
// makes fun of), how many can play and what it needs. The Aktivity panel lists these, Rádio Kecy names
// them, and the rule takes each one's player limit from here, so the words and the rules can't drift.
// DOM-free (tsconfig.shared.json).
import type { MiniKind } from './types';

export interface MiniInfo {
  /** its name in the game (Slovak) */
  title: string;
  emoji: string;
  /** the colour of its marks, its row, its news */
  color: string;
  /** what it is, in a sentence or two, for the panel */
  about: string;
  /** at most this many players in one round (the starter included) */
  max: number;
  /** what to bring, shown in the panel ('' for nothing) */
  needs: string;
  /** with others it's a team game (together against the city), not everyone for themselves */
  coop?: boolean;
}

export const MINI_INFO: Record<MiniKind, MiniInfo> = {
  parking: {
    title: 'Parkovací hon',
    emoji: '🅿️',
    color: '#42a5f5',
    about: 'Skenovacie auto PAAS obchádza zónu. Keď prejde okolo, musíš stáť v modrom boxe – a boxov je menej ako áut. Pokuta ťa vyradí.',
    max: 6,
    needs: 'auto',
  },
  revizor: {
    title: 'Revízor',
    emoji: '🎫',
    color: '#ab47bc',
    about: 'Električková naháňačka: čierny pasažier sa vezie k cieľu, revízori nastupujú na zastávkach. Hraj za ktorúkoľvek stranu.',
    max: 6,
    needs: '',
  },
  football: {
    title: 'Vydrž do 95. minúty',
    emoji: '⚽',
    color: '#66bb6a',
    about: 'Autofutbal na parkovisku. Vedieš 1:0 a do konca nadstaveného času zostáva chvíľa – súper má nožničky. Auto dostaneš.',
    max: 6,
    needs: '',
  },
  butter: {
    title: 'AKCIA! Maslo',
    emoji: '🧈',
    color: '#ffd54f',
    about: 'Maslo v akcii! Buď v obchode prvý, pretlač sa cez babky pri dverách, kúp čo najviac a predaj ho, kým sa v aute neroztopí.',
    max: 6,
    needs: '',
  },
  billboard: {
    title: 'Bilbordová vojna',
    emoji: '🪧',
    color: '#ef5350',
    about: 'Kampaň pred voľbami: lep plagáty svojho kandidáta na bilbordy a stĺpy, súperovým dokresli fúzy. Posledná minúta je moratórium.',
    max: 8,
    needs: '',
  },
  punch: {
    title: 'Punčová cesta',
    emoji: '🍷',
    color: '#e57373',
    about: 'Vianočné trhy na Hlavnom a Hviezdoslavovom námestí: obíď stánky zo zoznamu, zbieraj hrnčeky a vráť ich za zálohu. Každý punč ťa rozkýve viac.',
    max: 6,
    needs: '',
  },
  scooters: {
    title: 'Kolobežky všade',
    emoji: '🛴',
    color: '#34d186',
    about: 'Zdieľané kolobežky ležia po chodníkoch, v tráve aj pri Dunaji. Zvez ich na parkovacie miesta, kým mesto napíše pokutu – a nejazdi po chodníku.',
    max: 6,
    needs: '',
  },
  roadworks: {
    title: 'Rozkopávky',
    emoji: '🚧',
    color: '#ffa726',
    about: 'Leto v Blave: ulice sa zatvárajú jedna za druhou. Rozvážaj zásielky cez obchádzky – a kto chce, rozkopáva s partiou za stavbárov.',
    max: 6,
    needs: 'auto',
  },
  tram: {
    title: 'Električkár',
    emoji: '🚋',
    color: '#e53935',
    about: 'Jazdi električkou načas a zastav na každej zastávke. Na koľajniciach stoja zle zaparkované autá – zvoň, čakaj na odťahovku, alebo ich odtlač a zaplať.',
    max: 2,
    needs: '',
    coop: true,
  },
  flood: {
    title: 'Povodeň',
    emoji: '🌊',
    color: '#29b6f6',
    about: 'Dunaj stúpa ako v septembri 2024. Nos panely mobilnej protipovodňovej steny z depa do medzier na nábreží, kým príde ďalšia vlna.',
    max: 6,
    needs: '',
    coop: true,
  },
  heat: {
    title: 'Horúčava',
    emoji: '🥵',
    color: '#ff7043',
    about: '42 °C. Doruč zmrzlinu zo Starej tržnice, kým sa neroztopí – aj ty sa prehrievaš. Chladí tieň, fontány, rozprašovače, palác a električka, ak jej ide klíma.',
    max: 6,
    needs: '',
  },
  toilet: {
    title: 'Súrna potreba',
    emoji: '🚽',
    color: '#a1887f',
    about: 'Verejných WC je v Starom Meste ako šafranu: polovica je zamknutá, platené chcú drobné a kaviarne sú „len pre zákazníkov". Stihni to.',
    max: 6,
    needs: '',
  },
};

/** "sólo", "sólo · až 6 hráčov", "sólo · 2 spolu" */
export function playersLine(k: MiniKind): string {
  const i = MINI_INFO[k];
  if (i.max <= 1) return 'sólo';
  return `sólo · ${i.coop ? 'spolu' : 'proti sebe'} až ${i.max}`;
}
