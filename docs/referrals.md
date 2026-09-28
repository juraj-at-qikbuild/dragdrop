# Referral links (Pozvi kamaráta)

Every player has a link of their own, `https://gta-sk.fun/#ref=<nick>-<code>`, shown with a copy/share
button in the main menu and the pause menu (`src/ui/ReferralUi.ts`). A new player who comes in through it
is that player's friend, and once they've played for real the sender earns credits (in-game €):

| The friend has…                        | The sender has been paid |
| -------------------------------------- | ------------------------ |
| an account and 50 active minutes       | €1 000                   |
| an account and 60 active minutes       | €3 000 in all (+€2 000)  |

The tiers are `REFERRAL_TIERS` in `src/shared/referral.ts` (totals, so the hour pays the difference).
Guests and accounts alike have links. The *friend* needs an account ("signs up and plays"), but the time
they played as a guest before claiming into it counts.

## Who counts as a friend

- Only a player the server has never seen: no saved profile under that key at their first hello. Anyone
  who has played before, or a guest who has just claimed into an account, keeps whoever referred them (or
  nobody).
- The code comes from `hello.ref` (the client keeps a `#ref=` code in localStorage for 30 days and sends
  it until a hello is welcomed), or from `hello.join`: a **party invite counts as a referral**, with the
  inviter as the referrer. A party link wins over an older `#ref=` code.
- Never your own link: not your key's code, nor (for an account) the code of the guest identity on the
  same device.

## Codes

A code is the first 50 bits (10 base32 characters) of `SHA-256('ref:' + playerKey)`, where the player
key is `hashToken(guestToken)` for a guest and `acct:<userId>` for an account. The client derives it
itself (`src/net/referral.ts`, WebCrypto), so the main menu shows the link before connecting, even to a
device that is offline. Every hello registers `code → key` in SQLite (`referral_codes`; the first owner
keeps a code). A code nobody has registered yet still counts: the friend is stored with the code, and the
payment waits until its owner shows up. When a guest claims into an account, their code (and their own
referrer) move along. Old links keep working and pay the account.

## Active time and payment

`server/src/features/Referral.ts` times each friend who hasn't yet reached the last tier while they're in
the city. A minute counts only when the player is connected, not paused/away, not AFK, and has sent an
input `activity` pulse (real keyboard/mouse/touch/gamepad input, the same signal as the playtime
analytics) within the last 60 s. Time is saved every 15 s, on leaving, and at a tier.

A payment goes into the sender's live profile when they're in the city (a `+€` floaty, a toast and a
fresh `referral` message). Otherwise it goes straight into their saved profile in the same SQLite
transaction that records it, and they are told on their next hello ("Kamaráti, ktorých si pozval, ti
zarobili …"). `referrals.paid` makes every payment idempotent. A deleted account is dropped as a friend
and as a sender.

## Wire

Optional both ways, still protocol-compatible: `hello.ref`, `welcome.caps: 'referral'`, the client's
`{ t: 'referral' }` request (sent when the pause menu opens) and the server's `referral` message
(`code`, the 20 newest friends as `[nick, active minutes, paid, has account]`, the total count and the
total paid), after every welcome and on every change.
