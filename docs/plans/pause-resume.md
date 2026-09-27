# Plan: pausing, leaving and coming back online (Blava City)

Status: implemented, all three phases (27 September 2026). The decisions below were confirmed the
same day. Where the build differs from this plan, see [As built](#as-built) at the end; the most
notable change is that the protocol stayed at v7.

## Context

Online players come back often, step away for a minute (the door, a message, another tab) and
sometimes need to stop for the day. The shared city can't stop for one player, so pausing online
means a menu over a city that keeps running. What needs work is everything around that: what
happens to a player while the menu is open, when they leave, when their connection drops, and when
they come back.

How it works today:

- **Pausing** (Esc, P, the touch ❚❚, the pad's Start) opens the menu, but online nothing freezes
  (`NetSimHost.allowsPause` is false). `Game.idlePlayer()` stops the figure or handbrakes the car,
  and the client keeps sending its state 20 times a second, so the server can't tell a paused
  player from an active one. Nothing on screen says the city keeps going.
- **A paused player is a sitting duck.** Players and NPCs can hurt them, their stars don't wear off
  while they stand still, and while they're wanted, a cop who reaches them arrests them in under
  2 s. A death or an arrest costs 10% of their money, and an arrest also takes their guns
  (`Sim.respawn`).
- **A hidden tab isn't paused at all.** The browser stops the game loop and the server marks the
  player AFK after 60 s (`AFK_MS`), but their figure stays in the city, still vulnerable, with no
  time limit.
- **"Hlavné menu"** sends `leave`. The server saves and removes the player at once (`Room.drop`),
  and the page reloads into single-player. The player leaves their party, forfeits any race and
  ends any job, and their car stays in the street for anyone to take.
- **Leaving mid-death is a loophole.** `Store.savePlayers` writes full health and no stars for any
  state other than `play`. So a player who leaves while downed, wasted or busted comes back where
  they fell, at full health, with no stars and all their guns, and pays no fee.
- **A closed tab or a lost connection** sends nothing. The figure stays 30 s (`GRACE_MS`), frozen
  and vulnerable, then it's removed as if the player had left.
- **Coming back is slow.**
  - A returning guest clicks Online, gets the "Ako chceš hrať?" chooser when accounts are on, then
    waits for a reload and the connection.
  - A reload during play (F5, a restored tab, a phone that discarded the page) lands on the
    single-player menu, because the boot strips `#online` from the URL.
  - The server puts a player back where they were for 2 hours (`SESSION_TTL_MS`), but nothing on
    the menu says so.

## Goals

1. **Pausing is a menu over a running city, and says so.** Stepping away while not in trouble costs
   nothing.
2. **Leaving is a clear, deliberate action** that says what's kept and keeps as much as it can.
3. **Coming back takes one click**, or none after a reload, and returns the player to the same
   spot, party and car.
4. **Lost connections recover on their own**, and a dropped player isn't punished for it.
5. **None of this is a way out of trouble.** Pausing, leaving or dropping mustn't shake off the
   police, a fight, a bounty or a death.

Offline, the only changes are the auto-pause (a hidden page opens the menu) and the shared pause
code.

## What players get

The end state, once all three phases are in:

| When | What the player sees | What happens in the city |
|---|---|---|
| **Pause** (Esc, P, ❚❚, Start) | The menu over the running city: "Mesto beží ďalej", then either 🛡 "V menu si v bezpečí" or the reason not ("Polícia ťa hľadá", "Bojuješ s hráčom") | The figure stops and others see ⏸ on its name tag. After 3 s, if it's safe (decision 4), nobody can hurt, arrest or carjack it (🛡). |
| **Another tab or app** | The same menu, waiting when they come back | The same as pausing. After 15 min away, the player is moved out of the city and saved. |
| **Pokračovať** | Control back at once | ⏸ and 🛡 go at once. |
| **Odísť z mesta** (replaces "Hlavné menu" online) | A confirmation of what's kept and lost, then the main menu with "Pokračovať online" on top | The figure leaves at once, or after 10 s if wanted or in a fight. Spot, health, weapons, money and car are saved, and the party holds the seat for 15 min. |
| **Tab closed, connection lost, page discarded** | Nothing to do: the game reconnects on its own, or on the next visit | The figure stays 2 min, marked ⏸ (and 🛡 if safe), then leaves as above. |
| **Coming back** | After a reload or a restored tab, straight back in. On a new visit, one click on "Pokračovať online · Obchodná · pred 12 min" | Same spot within 24 h, same party within 15 min, and the car parked alongside. "Vitaj späť!" replaces the first-time welcome. |

## Decisions

1. **Leaving while wanted or in a fight takes 10 s.**
   - After `leave`, the server keeps the figure in the city for 10 s, still vulnerable.
   - Leaving while downed, wasted or busted first finishes that, with the hospital or police
     station and the usual fee.
   - *Today:* leaving is instant and escapes all of it.
2. **`#online` stays in the URL while playing.** A reload or a restored tab goes straight back
   online, and a new visit lands on the menu with "Pokračovať online".
   - *Rejected:* rejoining automatically on any visit soon after a drop. That's guesswork and can
     surprise.
3. **A player's spot is kept for 24 h** (was 2 h), **and their stars for 30 min.** After half an
   hour, the police have given up.
4. **A paused or dropped player is protected when it's safe.** The shield arms after 3 s away,
   and only if the player:
   - has no stars;
   - hasn't hurt, or been hurt by, a player in the last 15 s;
   - isn't downed or drowning, or in a burning or sinking car;
   - isn't racing, in the derby, the most-wanted target or holding the Kofolka van (those rules
     veto it).

   *Rejected:* never protecting, which keeps pausing cosmetic and punishes stepping away; and
   always protecting, which is a free exit from any fight.
5. **A dropped player's figure stays 2 min** (was 30 s). That's enough for a phone switching apps or
   a tram through a tunnel, and it's protected if safe.
6. **15 min away moves a player out of the city** (paused, hidden or AFK), saved. This frees slots
   and streets, and a forgotten tab no longer keeps its figure in the city indefinitely.
7. **A party holds a player's seat for 15 min** after they leave, drop or time out.
8. **The car leaves with its driver.** Only ordinary cars count, not police cars or event vehicles.
   When the driver comes back, it's parked beside them and reserved for them for 5 min.
   - *Today:* the car stays in the street for anyone to take.

From Phase 2 on, every one of these times is a tunable in `game_config` (`RemoteConfig`), with
these values as hardcoded defaults.

## Design

### Presence on the server

- **Active:** connected and playing.
- **Away:** paused, hidden, or dropped and within the grace period (`SimPlayer.away`,
  `awaySince`); shown as ⏸ (`ROSTER_AWAY`).
  - An away player doesn't count as taking part. A new `active` getter (`observing && !away`)
    leaves them out of `WorldEvents.playerCount()`, the most-wanted pick and a party's payout
    split.
  - While their client still sends its state, they stay an NPC observer, so the city keeps living
    around the menu.
- **Shielded:** away and safe (decision 4); shown as 🛡 (`ROSTER_SHIELD`).
- **Gone:** dropped (left, grace over or idle) and saved, with the party seat and car held
  (decisions 7 and 8).

### The shield (`src/shared/sim/rules/Presence.ts`, server only)

Each step, the rule sets `SimPlayer.shielded` from decision 4's conditions and tells the player when
it changes (private event `shield`). A new `SimRule` hook, `allowShield?(p): boolean`, lets a rule
veto the shield for its own participants: `Race`, `Derby`, `MostWanted` and `Kofolka`.

While a player is shielded:

- **They take no damage.** `Sim.hurtPlayer` returns early, and every shot, punch, blast, car and
  tram goes through it.
- **Their car takes no damage.** A car exploding under its driver kills them without going through
  `hurtPlayer` (`Sim.wreck`), so the car needs its own guards:
  - `Sim.damageVehicle` skips a shielded owner's car.
  - The owner's client simulates its own car, so it stops applying collision damage while shielded.
  - The server ignores a fire or wreck reported for that car.
- **They can't be arrested or carjacked.** `Sim.bust` and `Sim.enterVehicle` refuse. An arrest
  can't happen without stars anyway; the `bust` guard is a safety net.
- **Civilians won't start a fight with them** (`Crowd.provoke`).

The shield drops as soon as the player resumes, gets a star (for example, a witness's call goes
through) or a rule vetoes it. Because it only arms when the player has no stars, the police are
never chasing someone they can't catch.

### Protocol v8

*Superseded: the protocol stayed at v7, with the same messages negotiated as capabilities. See
[As built](#as-built).*

All wire changes are declared once, up front, as for v7:

- **`ClientMsg`:** `{ t: 'away'; on: boolean }`.
- **`ServerMsg`:** `bye.reason` gains `'idle'`. `WelcomeMsg` gains
  `resumed?: 'live' | 'saved' | 'fresh'`: still in the city, restored from the save, or a fresh
  start.
- **Roster flags:** `ROSTER_AWAY = 8`, `ROSTER_SHIELD = 16`.
- **Private event:** `{ k: 'shield'; on: boolean }`.

Older clients get "Nová verzia hry – obnov stránku", as with every protocol bump. The reload that
follows takes them straight back online (decision 2).

### Client

- **One pause path.** `Game.setPaused(on)` sets the flag, shows or hides the menu (`onPause`) and
  tells the host through `SimHost.setAway()`.
  - Offline, `setAway()` does nothing. Online, it sends `away`, and re-sends it after every welcome
    while the player is still paused.
  - Esc/P, ❚❚, "Pokračovať", the pause menu's touch shortcuts and the hidden-page handler all go
    through it. Today "Pokračovať" hides the menu without calling `onPause`.
- **Auto-pause** when `visibilitychange` reports the page hidden, online and offline. A window
  that just loses focus doesn't pause.
- **Pause-menu status and name tags** (`src/game/features/PresenceUi.ts`, a new `ClientFeature`):
  - the "Mesto beží ďalej" line, with the shield state or the reason there isn't one;
  - a ⏸/🛡 name-tag decorator;
  - away figures, and their cars, drawn dimmed.
- **Leaving.** Online, "Hlavné menu" reads "Odísť z mesta". It opens a confirmation built from the
  player's current party, race, job and stars, for example:
  - "Peniaze, zbrane, auto aj miesto sa uložia. Keď sa vrátiš, pokračuješ tu."
  - "Partia ti podrží miesto 15 minút."
  - "Rozbehnutý závod prehráš."
  - "Si hľadaný: tvoja postava zostane v meste ešte 10 sekúnd."

  Confirming sends `leave` and loads the plain URL.
- **The URL.**
  - Once `session.start()` succeeds, `history.replaceState` puts `#online` back.
  - Every way back to the menu loads the plain URL through one `goToMenu()`: leaving, signing out,
    the failed connection's "Späť do menu" and the idle dialog.
  - The boot still strips the hash, so a failed connection never loops.
- **Last-session memory** (`src/net/lastSession.ts`).
  - It keeps `{ mode, at, place }` in localStorage, where `place` is the street and district from
    the HUD. It's updated on welcome, every 30 s, on `pagehide` and on leaving.
  - When an identity exists, the main menu shows "Pokračovať online · Obchodná · pred 12 min". It's
    first and primary if online was the last mode played, and it goes straight online, skipping
    the chooser.
  - The chooser stays for new players and for switching to an account.
- **Reconnect sooner.** `Connection.retryNow()` runs when the page becomes visible or the browser
  fires `online`, instead of waiting out the backoff.
- **Idle.** `bye: 'idle'` is final, with no automatic retry. A dialog says "Bol si dlho preč, tak
  tvoja postava odišla z mesta.":
  - "Vrátiť sa do mesta" reloads, which rejoins at the saved spot.
  - "Hlavné menu" goes to the menu.
- **Welcome back.** The message comes from `welcome.resumed`:
  - `'live'`: "Znovu pripojený".
  - `'saved'`: "Vitaj späť! Pokračuješ tam, kde si skončil."
  - `'fresh'`: today's welcome on a first visit, otherwise "Vitaj späť v meste".

## Phases

### Phase 1: leaving and coming back (no protocol change)

Ships on its own. From this phase on, coming back is easy.

1. `Game.setPaused()` and auto-pause on a hidden page (`src/game/Game.ts`, `src/main.ts`).
2. The pause menu's online note, honest for now: "Mesto beží ďalej – tvoja postava stojí a dá sa
   zraniť.", with a warning while wanted (`index.html`, `src/main.ts`).
3. "Odísť z mesta" and its confirmation, worded for what this phase keeps: spot, weapons and money
   stay; party, race and job end.
4. `#online` in the URL while playing, and `goToMenu()` (`src/main.ts`, `src/ui/AccountUi.ts`).
5. Last-session memory and "Pokračovať online" (`src/net/lastSession.ts`, `index.html`,
   `src/main.ts`, `src/ui/AccountUi.ts`).
6. `Connection.retryNow()` when the page becomes visible or the browser comes back online
   (`src/net/Connection.ts`).
7. "Vitaj späť" for returning players, based on the last-session memory until Phase 2 adds
   `resumed`.
8. Server: leaving.
   - `Session.dropAt` replaces the fixed `disconnectedAt + GRACE_MS` check.
   - `leave` drops a player at once, or after 10 s when they're wanted or within 15 s of PvP
     (`SimPlayer.lastPvpAt`, set for both players in `hurtPlayer`).
   - `drop()` first finishes a pending death or arrest (`respawn`).
9. Server: `RESUME_MS` (24 h, a shared constant in `protocol.ts`) replaces `SESSION_TTL_MS`. Stars
   are restored only from a session saved less than 30 min ago.

### Phase 2: pausing without being a sitting duck (protocol v8)

1. Protocol v8 as above (`src/shared/net/protocol.ts`, `src/shared/sim/events.ts`).
2. `SimPlayer.away`, `awaySince`, `shielded` and the `active` getter. `WorldEvents`,
   `MostWantedWatch` and `Party.split` switch to `active`.
3. The `Presence` rule, the `allowShield` hook and its vetoes, and the guards in `Sim` and `Crowd`,
   plus the client's own-car guard in `NetSimHost`.
4. `server/src/features/Presence.ts`, a new `RoomFeature`, which:
   - handles `away`;
   - marks a player away when their socket drops (`onLeave`), with the grace raised to 2 min, and
     clears it on hello;
   - runs the idle timeout in `tick()`;
   - reads its tunables from `RemoteConfig`;
   - reports away and shielded counts in `/stats`.
5. `Room`: the roster flags and `welcome.resumed`.
6. Client: `SimHost.setAway()`, the shield-aware pause note, name tags and dimmed figures, the idle
   dialog and the `resumed` messages.

### Phase 3: keeping the party and the car

1. **Party seats** (`server/src/features/Party.ts`).
   - On a drop, the member's seat is held (`key → { nick, until }`) instead of removed, and the
     party panel lists them as offline.
   - A hello within the window restores `partyId` and pushes the party state. `tick()` expires
     seats.
   - A party with only held seats lasts until the last one expires. `partyLeave` and kicks stay
     immediate.
2. **The car leaves with its driver.**
   - A migration adds `sessions.car` (JSON: kind, colour, health, damage, angle).
   - On a drop, an ordinary car is saved and taken out of the city. "Ordinary" means not a police
     car, no livery and not locked.
   - On return, the car is parked at the saved spot, or the nearest clear kerb, with "Tvoje auto
     parkuje vedľa teba.". It's reserved for its owner for 5 min (`Vehicle.reservedFor` and
     `reservedUntil`, checked in `Sim.enterVehicle`).
   - A reload within the grace period sends a hello without `resume`, which steps the player out of
     their car. That car gets the same reservation; today anyone can take it.

## Verification

- **`test/shared/presence.test.ts`** runs the shield against a real `Sim` with two players:
  - it arms after 3 s;
  - it never arms with stars, within 15 s of PvP, while downed or in a burning car;
  - each veto;
  - each guard (`hurtPlayer`, `damageVehicle`, `bust`, `enterVehicle`, `provoke`);
  - it drops on resume and on a new star.
- **`server/test/room.test.ts`** (Phase 1):
  - a safe `leave` drops the player at once, and an unsafe one after 10 s (`dropAt`);
  - leaving while downed, wasted or busted pays the fee and saves at the hospital or police station;
  - stars come back only from a session saved less than 30 min ago.
- **`server/test/presence.test.ts`** (Phase 2):
  - `away` sets the roster flag and a hello clears it;
  - a socket drop counts as away, with the 2 min grace;
  - the idle timeout sends `bye: 'idle'` and saves;
  - `welcome.resumed` in each case, and tunables overriding the defaults.
- **`server/test/db.test.ts`:** a session resumes within 24 h (Phase 1); the migration and a car
  saved and restored (Phase 3).
- **`server/test/party.test.ts`** (Phase 3): a seat held, restored on hello and expired, and a party
  of held seats dissolving on time.
- **`test/client/`:** the last-session memory and the menu labels, and `setPaused` telling the host
  once per change.
- **End to end:** `E2E_PHASE=presence npm run e2e` runs a new `scripts/e2e-presence.mjs` (the
  dispatcher in `scripts/e2e-mp.mjs` gains `presence`), with short timers from the E2E config:
  - A pauses; B sees ⏸🛡 and B's shots do nothing; A resumes.
  - A leaves, and B sees A gone at once.
  - A's menu shows "Pokračovať online", and one click puts A back on the same spot.
  - A reloads and is back online without seeing the menu.
  - A's page is hidden: A is paused, then gets the idle dialog, and "Vrátiť sa do mesta" works.
- **`npm run smoke` and `npm run smoke:mobile`** still pass, with the auto-pause offline and on
  touch.

## Risks

- **The shield as an escape.** Covered by the arming delay, the stars and PvP conditions, the event
  vetoes and the burning-car rule, each with a test. `/stats` shows how many players are shielded.
- **Shots that do nothing.** 🛡 on the name tag explains it, and there's no blood or hit sound,
  because the server sends no hit.
- **A shielded car blocking a street.** NPC traffic goes round it as round a parked car, and the
  idle timeout clears it after 15 min.
- **Someone waiting beside a player for the moment they resume.** Accepted for now. If it becomes a
  problem, a second or two of protection on resume can come later.
- **`#online` looping on errors.** Prevented by `goToMenu()` and the boot's hash stripping, and
  covered end to end.
- **Auto-pause getting in the way on a desktop.** It only fires when the page is hidden (another
  tab, minimised, another app), never when the window just loses focus.
- **More figures standing in the city,** from the 2 min grace and players away. They're marked,
  usually protected and left out of events, and the tunables can shorten both.
- **The protocol bump at deploy.** Open tabs get the usual "Nová verzia hry" message, and the reload
  takes them straight back online.

## Out of scope

- Pausing the shared city, or slowing it down for anyone.
- Offline changes beyond the auto-pause.
- Moving a live session between devices. An account already takes over its session from another
  device.
- Notifications while the tab is closed.

## As built

The three phases shipped together. [docs/multiplayer.md](../multiplayer.md) ("Pausing, leaving and
coming back") describes the result; these are the places where it differs from the plan above.

- **No protocol bump.** Every addition is optional, so the protocol stayed at v7 and each side
  announces what it understands:
  - `hello.presence: true` means the client sends `away` and handles `bye: 'idle'`. Only these
    clients are ever moved out for being idle; an older client wouldn't know what `bye: 'idle'`
    means.
  - `welcome.resumed` means the server understands `away`. A client only sends `away` to a server
    that sets it. Against an older server, the pause note warns "Kým si v menu, dá sa zraniť."
  - Older clients ignore the two new roster bits and the `shield` event.

  So there's no "Nová verzia hry" at deploy, and the client (Cloudflare) and server (Fly) can
  deploy in either order.
- **Tests.** The Phase 1 server tests are in `server/test/presence.test.ts` with the rest, not in
  `room.test.ts`. The end-to-end run checks ⏸ and 🛡 as B sees them. That shots do nothing is
  covered by the `hurtPlayer` guard in `test/shared/presence.test.ts`, not end to end.
- **Short timers for end-to-end runs.** With `E2E=1`, `debug.presence` takes the same fields as the
  `presence` row in `game_config`. `scripts/e2e-presence.mjs` uses it to shorten the idle timeout.
- **Shield details.**
  - The Derby veto covers anyone inside the live arena as well as active participants, so a
    spectator can't stand shielded in the way.
  - The client's own-car guard restores the car's health, damage and fire after each physics
    step. Fire is included because `Vehicle.damage` lights a car at zero health.
- **Leaving.** `Room.drop()` takes a reason (`left`, `grace`, `idle`, `deleted`, `claimed`) and
  passes it to `RoomFeature.onDrop`. A party holds the seat for the first three; a deleted or
  claimed session leaves it at once.
- **Party seats** use negative ids in the party state, so the panel can list them and a leader can
  kick them.
- **The car.**
  - Someone else trying a reserved car gets "Toto auto čaká na iného hráča.".
  - A returning car is placed at the saved spot or up to 14 m along the saved heading, as long as
    it's clear of walls, water and other cars. Otherwise it isn't restored.
  - `Sim.removeVehicle` rebuilds the vehicle hash, so a car taken out of the city doesn't block
    the spot for the next one.
- **Last-session memory** stores `{ mode, online: { at, place } }` and is updated every 10 s rather
  than every 30 s.
