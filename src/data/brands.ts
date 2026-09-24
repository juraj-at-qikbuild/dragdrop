// Parody brands. Every name and slogan below is an original spoof of real
// Slovak brands. No real logos or trademarks are used.

export const ROOF_ADS = [
  { title: 'KOFOLKA', slogan: 'Keď ju piješ, nie je čo riešiť', bg: '#c8102e', fg: '#fff', accent: '#2e7d32' },
  { title: 'STRIEBORNÝ BAŽANT', slogan: 'Pivo pre skutočných bažantov', bg: '#1b3d2f', fg: '#e0e0e0', accent: '#c0c0c0' },
  { title: 'SLOVNAFTA', slogan: 'Natankuj a uteč', bg: '#0d47a1', fg: '#fff', accent: '#e53935' },
  { title: 'DOLINKY', slogan: 'Oblátky z nížin', bg: '#f9a825', fg: '#3e2723', accent: '#6d4c41' },
  { title: 'TATRAČAJ 72%', slogan: 'Čaj len pre dospelých', bg: '#263238', fg: '#ffca28', accent: '#ffca28' },
  { title: 'BILLKA', slogan: 'Vždy lacno. Niekedy.', bg: '#ffeb3b', fg: '#d32f2f', accent: '#d32f2f' },
  { title: 'RÁDIO EXPRESO', slogan: '107,6 – hity, čo nudia', bg: '#e91e63', fg: '#fff', accent: '#fff' },
  { title: 'HALUŠKY U FERA', slogan: 'Bryndza, ktorá si ťa nájde', bg: '#f5f5f5', fg: '#2e7d32', accent: '#8d6e63' },
  { title: 'FIGARKO', slogan: 'Čokoláda pre drsných chlapov', bg: '#4e342e', fg: '#ffcc80', accent: '#ffcc80' },
  { title: 'VINEA BLAVA', slogan: 'Hrozno z Karpát, bolehlav z Blavy', bg: '#6a1b9a', fg: '#fff', accent: '#ce93d8' },
  { title: 'HOPÍK TAXI', slogan: 'Odvezieme ťa. Asi.', bg: '#212121', fg: '#ffd600', accent: '#ffd600' },
  { title: 'ZLATÉ PIESKY', slogan: 'Kúpalisko s charakterom', bg: '#0288d1', fg: '#fff59d', accent: '#fff59d' },
] as const;

export interface RadioStation {
  name: string;
  freq: string;
  style: 'pop' | 'dance' | 'folk' | 'talk';
  lines: string[];
}

export const RADIO: RadioStation[] = [
  {
    name: 'Rádio Expreso',
    freq: '107,6 FM',
    style: 'pop',
    lines: [
      'Dobré ráno, Blava! Na Moste SNP kolóna až po Aupark, ako vždy.',
      'Súťaž: kto prvý zavolá, vyhrá permanentku na električku číslo 4!',
      'Počasie: v Petržalke fúka, na Hrade fúka viac.',
      'Kofolka – keď ju piješ, nie je čo riešiť. Reklama.',
      'Polícia hlási zvýšený pohyb podozrivých áut v Starom Meste. Zaujímavé.',
    ],
  },
  {
    name: 'Fan Rádio',
    freq: '102,8 FM',
    style: 'dance',
    lines: [
      'FAN RÁDIO! Najväčšie party hity z Nového Mesta!',
      'Dnes večer párty pod UFOm, vstup len s Kofolkou!',
      'Pozdravujeme všetkých vodičov, čo práve kradnú auto. Jazdite opatrne!',
      'Strieborný Bažant – pivo pre skutočných bažantov.',
    ],
  },
  {
    name: 'Rádio Dévin Folk',
    freq: '88,8 FM',
    style: 'folk',
    lines: [
      'Tancuj, tancuj, vykrúcaj... a nezabudni pritom šoférovať.',
      'Ľudová hudba z Podunajska pre všetkých zatúlaných Blavákov.',
      'Dolinky – oblátky z nížin. Lebo hory sú preceňované.',
      'Na Hlavnom námestí dnes vianočné trhy. Áno, aj v septembri.',
    ],
  },
  {
    name: 'Rádio Kecy',
    freq: '95,3 FM',
    style: 'talk',
    lines: [
      'Téma dňa: Je Petržalka ešte Bratislava? Volajte, čakáme.',
      'Poslucháč Fero z Dúbravky: "Električky mali ostať zelené!"',
      'Mestská rada schválila štvrtý nový most. Stavať sa začne v roku 2087.',
      'Diskusia: Prečo sa Čumil stále pozerá spod kanála? Experti mlčia.',
      'Halušky u Fera – bryndza, ktorá si ťa nájde.',
    ],
  },
];

/** Short in-game descriptions for discovered landmarks. */
export const LANDMARK_INFO: Record<string, string> = {
  castle: 'Biely obdĺžnik so štyrmi vežami. Symbol mesta nad Dunajom.',
  michael: 'Jediná zachovaná brána stredovekého opevnenia.',
  snp: 'Most so známou reštauráciou UFO na pylóne.',
  cathedral: 'Tu korunovali uhorských kráľov a kráľovné.',
  primate: 'Ružový palác so Zrkadlovou sieňou.',
  blue: 'Secesný kostol svätej Alžbety, celý v modrom.',
  eurovea: 'Nákupné centrum a promenáda pri Dunaji.',
  market: 'Stará tržnica – sobotné trhy a street food.',
  snd: 'Historická budova Slovenského národného divadla.',
  cumil: 'Robotník vykúkajúci z kanála. Pozor na hlavu!',
  main: 'Hlavné námestie s Rolandovou fontánou.',
  president: 'Grasalkovičov palác, sídlo prezidenta.',
  apollo: 'Moderný oblúkový most z roku 2005.',
  sad: 'Najstarší verejný park v strednej Európe.',
  oldbridge: 'Najstarší most cez Dunaj v Bratislave, dnes s električkou.',
  hviezdoslav: 'Promenáda so sochou Pavla Országha Hviezdoslava.',
  reduta: 'Sídlo Slovenskej filharmónie.',
  sng: 'Slovenská národná galéria s moderným premostením.',
  kamenne: 'Kamenné námestie – križovatka električiek.',
  aupark: 'Nákupné centrum na petržalskej strane.',
  parliament: 'Budova Národnej rady pod hradom.',
};

/** Colours for POI signage by parody brand name. */
export const BRAND_COLORS: Record<string, [string, string]> = {
  Slovnafta: ['#0d47a1', '#fff'],
  OMW: ['#0b3d91', '#b7e0ff'],
  Shel: ['#ffd600', '#d50000'],
  MOLL: ['#2e7d32', '#fff'],
  Orlín: ['#d32f2f', '#fff'],
  Billka: ['#ffeb3b', '#d32f2f'],
  Lidel: ['#0050aa', '#fff200'],
  Tescó: ['#00539f', '#fff'],
  Kaufstrand: ['#e10915', '#fff'],
  McDonaldov: ['#da291c', '#ffc72c'],
  KFČ: ['#a3080c', '#fff'],
  Starbáks: ['#00704a', '#fff'],
  'Burger Kráľ': ['#d62300', '#f5ebdc'],
  dn: ['#fff', '#00569d'],
  Rossmanek: ['#c3002f', '#fff'],
};
