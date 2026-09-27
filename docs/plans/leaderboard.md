# Plan: points and the leaderboard (Blava City)

Status: implemented (27 September 2026). This page is both the plan and the as-built record.

## Context

Before this, nothing showed players who was leading. The server logged every payout to Supabase
`activity`, and `leaderboard_week()` summed a week of it by money, but no client ever called it. It
also had counting problems: every party share counted as a separate win or delivery, derby 2nd and
3rd places counted as wins, and the armoured van's cash (pickups, not payouts) never counted. The
per-player counters in `players.stats` reached the client in `profile`, which dropped them.

## Goals

1. Players get **points** for a lot of what the city offers: world events, the mini-games, jobs,
   races, running from the police, exploring, helping others.
2. **Boards for today, this week and all time**, overall and **per kind of thing**, visible in game
   in one key press, with the player's own place on each.
3. The points are **hard to farm**: every source keeps (at least) the guards its money has.
4. **Nothing waits on the network** in the tick, and a server without the feature (or a client
   without it) keeps working.

## What players get

| Where | What |
|---|---|
| While playing | Points float up in gold where they're scored ("+30 b"). Under the online badge, a pill shows today's points and rank ("🏆 240 b · 5. dnes", with the **L** key on a keyboard). |
| **L** (or "🏆 Rebríček" in the pause menu) | The boards: **Dnes / Týždeň / Celkovo** × **Spolu, Udalosti, Na úteku, Práca, Závody, Mesto, Pomoc**. The top 20, medals for the podium, ✓ for accounts, ● for who's in the city now, the player's own row highlighted (or "Ty: 37. z 57" under the list), yesterday's or last week's winner, when the day or week resets, and "Za čo sú body" with every value. Opening it from play pauses the game like the menu does (online: away, and shielded when safe). |
| Climbing | "🏆 Vedieš dnešný rebríček!", "Si 3. v dnešnom rebríčku!", "Si v top 10…" (on boards big enough for it to mean something). |
| The city | Rádio Kecy and a banner when someone takes the lead of the day (100+ points, at most every 10 min), and at midnight who won the day. |

## Decisions

1. **Points, not money.** Money is spent, lost at the hospital and moved between players by race
   stakes; points only go up and can't be transferred. Payouts keep going to Supabase `activity` as
   before (analytics), untouched.
2. **Online only, decided by the server.** Offline there's no one to compare with and a
   localStorage save can say anything, so offline nothing scores (`Sim.onScore` is unset).
3. **The totals live in the game server's SQLite, not Supabase.** They're hot data: every award
   updates them and every push reads them, synchronously and locally, the way money is kept. They're
   pre-added per period, board and player (`scores`), so any page of any board is one index scan.
   *Rejected:* Supabase `activity` + SQL: a network round trip for every page and every rank, a
   batching delay, and nothing to test against locally.
4. **Periods:** the day and the ISO week (from Monday) in Europe/Bratislava time, and all time. Days
   are kept 14 days, weeks 10 weeks; all-time forever.
5. **Boards follow the game's own structure:** Udalosti (the world events), Na úteku (the police and
   the most-wanted target), Práca (the jobs), Závody, Mesto (the daily puzzle, landmarks, Čumils),
   Pomoc (revives), and Spolu (everything).
6. **A party splits points the way it splits the money**: the same payout policy, for the same
   sources (Kofolka, the bounty, the golden Čumil, the derby, deliveries, fares and tips; not races,
   the van's robbery or cash, the most-wanted target's own points, getaways, the city or revives).
   A party of four earns no more per job than one player, and the away rules from pausing apply.
7. **Anti-farming.** Every source keeps its money's guards (revive pair and hourly caps, the bounty's
   pair cooldown and 60 s at 5★, the derby's grace period, the friendly-race prize cap). On top:
   - race points only for a paid win *at the line*: a forfeit (a false start, the other player
     leaving) is one click away for a second account;
   - a getaway scores only after a chase of 30 s or more, at most once per 90 s, and by the most
     stars the chase reached (1★ is worth little);
   - hourly caps per player on what can be repeated at will: getaways 6, police cars 15, van cash
     12, near-miss tips 60, races 8;
   - no points for PvP kills or for killing civilians.
8. **Players from before the leaderboard are seeded once, on the all-time boards only**, from their
   saved progress (landmarks, Čumils and the counters in `stats`), so veterans aren't erased. Today's
   and this week's boards start empty for everyone.
9. **No protocol bump.** Every new message and event is optional. A server with a leaderboard sends
   `score` right after every welcome; a client asks for a `board` only after it's seen one. Older
   clients ignore the new messages; an older server never sends `score`, so the panel says it has no
   leaderboard.

## The points

All in `src/shared/sim/rules/points.ts` (`POINTS`), which the panel's "Za čo sú body" also reads.

| Board | Source | Points |
|---|---|---|
| Udalosti | Horúca Kofolka | 6 per $100 of the pot paid to the driver (90 for the whole pot), +20 for the top earner when it runs dry |
| | Najhľadanejší, the hunter | 40 + 1 per $20 of the bounty |
| | Hon na Čumila | 80 |
| | Obrnené auto | 40 to everyone who shot the doors out (10 s window), 4 per bundle of cash |
| | Derby | 100 / 50 / 30 for the podium, 10 for the rest of the locked-in field |
| Na úteku | Najhľadanejší, the target | 15 per minute at 5★, 60 for getting away |
| | Losing the police | 5 / 15 / 40 / 80 / 150 by the chase's most stars |
| | A police car destroyed | 10 |
| Práca | Delivery or fare | its pay ÷ 5 (distance, time bonus and the taxi bonus included) |
| | Near miss while carrying | 2 |
| Závody | A race won at the line | 50 |
| Mesto | Kde to je? | 150 |
| | A landmark, a Čumil statue | 15, 40 (once each) |
| Pomoc | A revive that pays the samaritan bonus | 25 |

## Design (as built)

### Shared (`src/shared/sim`)
- `Sim.score(p, points, source, x?, y?)` splits through `payoutPolicy` (the same as `payout`), calls
  `onScore` for each share and, for whatever the host took, sends the private event
  `{ k: 'points', n, src, x, y }`. `onScore` returns how many points counted, so a capped award shows
  nothing.
- Every source calls it where its money is paid (or where it's decided, for the ones without money):
  `Jobs`, `Race.finish` (now told `'line'` or `'forfeit'`), `Derby.finishRound`, `CumilHunt`,
  `Kofolka`, `ArmoredVan` (robbery) and `VanLoot` (loot), `MostWanted`, `Revive.payBonus`, and in
  `Sim` itself landmarks (`discover`), Čumils (`takePickup`), police cars (`wreck`) and getaways
  (`updateWanted` → `getaway`, with `SimPlayer.chaseSince/chasePeak/lastGetawayAt`). The server's
  `Daily` scores the puzzle.
- New global events `leader` and `dayWinner`, for Rádio Kecy and the banners.

### Server (`server/src/features/Leaderboard.ts`, `server/src/db.ts`)
- **`scores`** (migration 4): `(period, board, key)` → `nick, points, updated_at`, with an index on
  `(period, board, points DESC, updated_at)` for pages and ranks and one on `key` for GDPR and claims.
  Periods are `d2026-09-27`, `w2026-W39` and `all`.
- **Awarding:** `onScore` checks the hourly caps, then adds the points to the day, week and all-time
  rows of the source's board and of `all`, in one transaction.
- **Pages:** `board { period, board }` is answered with the top 20 (ties share a rank; the earlier
  one is listed first), the asker's own rank and points, how many are on the board, the previous
  period's winner and the seconds until the period resets. A token bucket per session (6, then 3 a
  second) keeps a flood of requests away from the database.
- **Pushes:** a player's own `score` (today, week, all time, today's rank and board size) right
  after every welcome, within a second of any change, and at midnight; and every 10 s for everyone
  while anyone is scoring, since someone else's points move your rank. Identical pushes aren't
  resent, and at most 50 go out a second.
- **Climbing and news:** a player who takes the lead of the day alone, or climbs into the top 3 (on a
  board of 4+) or top 10 (11+), is told (at most once a minute). A new sole leader with 100+ points
  is news for the whole city (at most every 10 min). At midnight the day's winner is.
- **Seeding** (decision 8) happens in `onHello` for a new session whose key has never scored.
- **Leaving for good:** `Store.deletePlayer` (GDPR) deletes the player's scores too; `movePlayer`
  (claiming a guest into an account) moves them, added to anything the account had.
- **Without a store** (tests) the feature is off: `onScore` stays unset and nothing is pushed.
- `/stats` gains `lbAwards`, `lbCapped`, `lbQueries`, `lbErrors`.

### Client
- `src/game/features/LeaderboardUi.ts`: the panel (a kit modal), the pause menu's "🏆 Rebríček"
  (online only), floating points (`Juice.pointsText`; a near miss already has its own "TESNE!"), and
  the leader and day-winner banners. Its text (board names, the points list, the countdown) is in
  `leaderboard/text.ts`.
- `LiveState.score` (from the `score` push) feeds the HUD pill (`Hud.drawScore`) and the panel's
  header.
- `NetSimHost` forwards `board` replies to the features.
- Rádio Kecy lines for `leader` and `dayWinner` (`news/lines.ts`), with the right plural of "bod".

## Verification

- `test/shared/points.test.ts`: `Sim.score` (offline no-op, the split, capped awards) and every
  source through its own rule's real-map flow, including forfeits and short or repeated getaways that
  must not score.
- `server/test/leaderboard.test.ts`: totals per period and board, pages (ties, flags, the asker,
  resets), the hourly caps, the party split, leader news and rank messages, midnight, pruning,
  seeding, GDPR deletion and claims, and the store-less room.
- `test/client/board.test.ts` and `test/client/news.test.ts`: the panel's text and the news lines.
- `E2E_PHASE=board npm run e2e` (`scripts/e2e-board.mjs`): two browsers, one on a phone layout.
  Points arrive by discovering Hlavné námestie, the HUD gets them, the leader news reaches the other
  player, L opens and closes the panel (pausing and unpausing), the boards and periods switch, and
  the pause menu's button works over the menu.

## Out of scope, for later

- **The leaderboard outside the game**: in the main menu before joining, or on a web page. It needs
  a read-only HTTP endpoint on the game server (CORS for the allowed origins).
- **Rewards for the winners** (a title, a badge on the name tag, a weekly prize).
- **Tuning the points remotely** through `game_config`, the way the presence times are tuned.
- **Supabase `leaderboard_week()`** is left as it was, an analytics view over the payouts in
  `activity`, with the counting caveats above. Nothing in the game reads it; it could be dropped or
  rewritten in a new migration.
