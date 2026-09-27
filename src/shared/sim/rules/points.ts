// Points ("body") for the leaderboard (docs/plans/leaderboard.md): what each achievement is worth,
// which board it counts on, and the boards and periods themselves. Online only: the server sets
// Sim.onScore and keeps the totals (server/src/features/Leaderboard.ts); offline nothing scores.
// Every value here is a tunable; the pause menu's leaderboard lists them for players (LeaderboardUi).

/** What a player scored for. The ones that are also payout reasons keep that name, so a party
 *  splits exactly the points it splits the money for (server/src/features/Party.ts). */
export type ScoreSource =
  // world events
  | 'kofolka' | 'bounty' | 'cumil' | 'robbery' | 'loot' | 'derby'
  // on the run: the most wanted target, losing the police, police cars destroyed
  | 'wanted' | 'escape' | 'getaway' | 'takedown'
  // Vlk courier / Hopík taxi, and their near-miss tips
  | 'courier' | 'taxi' | 'tip'
  // Závod?
  | 'race'
  // the city: Kde to je?, landmarks, the ten hidden Čumil statues
  | 'daily' | 'landmark' | 'statue'
  // Dobrý samaritán
  | 'samaritan'
  // the garage's collection: every kind of vehicle driven (docs/plans/gameplay.md, Phase 2)
  | 'collection';

/** the boards: every point counts on 'all' and on its source's own board */
export const BOARDS = ['all', 'events', 'police', 'jobs', 'races', 'city', 'help'] as const;
export type BoardId = (typeof BOARDS)[number];
/** today and this week (Europe/Bratislava, weeks from Monday), and all time */
export const PERIODS = ['day', 'week', 'all'] as const;
export type ScorePeriod = (typeof PERIODS)[number];

export const SOURCE_BOARD: Record<ScoreSource, Exclude<BoardId, 'all'>> = {
  kofolka: 'events', bounty: 'events', cumil: 'events', robbery: 'events', loot: 'events', derby: 'events',
  wanted: 'police', escape: 'police', getaway: 'police', takedown: 'police',
  courier: 'jobs', taxi: 'jobs', tip: 'jobs',
  race: 'races',
  daily: 'city', landmark: 'city', statue: 'city', collection: 'city',
  samaritan: 'help',
};

export const POINTS = {
  /** Horúca Kofolka: each $100 of the pot paid to the van's driver (the whole pot is $1,500) */
  kofolka: 6,
  /** ...and whoever earned the most from it, when the pot runs dry */
  kofolkaTop: 20,
  /** Najhľadanejší, the takedown: this, plus the bounty × bountyPerDollar */
  bounty: 40,
  bountyPerDollar: 1 / 20,
  /** Hon na Čumila: the golden statue */
  cumil: 80,
  /** Obrnené auto: everyone who shot the rear doors out */
  robbery: 40,
  /** ...each bundle of its cash picked up (12 of them) */
  loot: 4,
  /** Derby na parkovisku: 1st, 2nd, 3rd... */
  derby: [100, 50, 30],
  /** ...and everyone else in the locked-in field */
  derbyField: 10,
  /** Najhľadanejší target: each minute at 5★ (the minutes the bounty grows) */
  wanted: 15,
  /** ...and getting away */
  escape: 60,
  /** losing the police, by the most stars the chase reached (index = stars) */
  getaway: [0, 5, 15, 40, 80, 150],
  /** a police car destroyed */
  takedown: 10,
  /** courier and taxi: the job's pay (distance, time bonus, the taxi's own bonus) × this */
  jobPerDollar: 1 / 5,
  /** a near miss while carrying */
  tip: 2,
  /** Závod?: winning a paid race at the finish line (not a forfeit or a false start) */
  race: 50,
  /** Kde to je?: the day's first finder */
  daily: 150,
  /** a landmark discovered, a hidden Čumil statue found (once each) */
  landmark: 15,
  statue: 40,
  /** reviving another player, when the Dobrý samaritán bonus pays */
  samaritan: 25,
  /** the collection complete: every kind of vehicle driven (once) */
  collection: 100,
};

/** a getaway only counts after a chase this long (seconds from the first star) */
export const GETAWAY_MIN_S = 30;
/** ...and at most one every this many seconds */
export const GETAWAY_COOLDOWN_S = 90;

/** at most this many awards per player per hour, for the sources a player could repeat at will
 *  (the server's Leaderboard enforces it; everything else is already limited by the game itself) */
export const HOURLY_CAP: Partial<Record<ScoreSource, number>> = {
  getaway: 6,
  takedown: 15,
  loot: 12,
  tip: 60,
  race: 8,
};

/** points for losing the police after a chase that reached `stars` */
export function getawayPoints(stars: number): number {
  return POINTS.getaway[Math.max(0, Math.min(5, Math.round(stars)))];
}

/** points for a delivery or a fare that paid `pay` */
export function jobPoints(pay: number): number {
  return Math.max(1, Math.round(pay * POINTS.jobPerDollar));
}

/** points for collecting a bounty of `bounty` */
export function bountyPoints(bounty: number): number {
  return POINTS.bounty + Math.round(bounty * POINTS.bountyPerDollar);
}

export const isBoard = (v: unknown): v is BoardId => typeof v === 'string' && (BOARDS as readonly string[]).includes(v);
export const isPeriod = (v: unknown): v is ScorePeriod => typeof v === 'string' && (PERIODS as readonly string[]).includes(v);
