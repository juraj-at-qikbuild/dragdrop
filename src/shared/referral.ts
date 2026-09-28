// Referral links (docs/referrals.md): every player, guest or account, has a link of their own. A new
// player who comes in through it (or through a party invite: the inviter counts as the referrer)
// earns their referrer credits once they have an account and have actually played long enough.
// Shared by the client (the link, the rules text) and the server (the code, the payouts); DOM-free.

/** what a referrer has been paid in total once their friend has played this many active minutes
 *  (cumulative: 50 min pays €1 000, the hour pays the rest up to €3 000) */
export const REFERRAL_TIERS: readonly { min: number; total: number }[] = [
  { min: 50, total: 1000 },
  { min: 60, total: 3000 },
];
/** the most one friend can earn their referrer */
export const REFERRAL_MAX = REFERRAL_TIERS[REFERRAL_TIERS.length - 1].total;
/** active minutes after which a friend's time no longer matters */
export const REFERRAL_DONE_MIN = REFERRAL_TIERS[REFERRAL_TIERS.length - 1].min;

/** 50 bits: plenty for every player there will ever be, and it fits links.ts's [a-z0-9]{4,12} */
export const REFERRAL_CODE_LEN = 10;
/** what the server accepts as a code in `hello.ref` */
export const REFERRAL_CODE_RE = /^[a-z0-9]{4,12}$/;

/** the string whose SHA-256 is a player's code: the player key (hashToken(token) for a guest,
 *  'acct:'+userId for an account), so the client can show its link before it ever connects */
export const referralSeed = (playerKey: string) => 'ref:' + playerKey;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** the code from the SHA-256 digest of referralSeed(playerKey): its first 50 bits in base32 */
export function referralCode(digest: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of digest) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < REFERRAL_CODE_LEN) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= REFERRAL_CODE_LEN) break;
  }
  return out;
}

/** what a friend's active time has earned their referrer so far; nothing until they have an account
 *  (docs/referrals.md: "signs up and plays") */
export function referralEarned(activeMs: number, account: boolean): number {
  if (!account) return 0;
  let total = 0;
  for (const t of REFERRAL_TIERS) if (activeMs >= t.min * 60_000) total = t.total;
  return total;
}

/** nick → a link's decoration: lowercase, no diacritics, spaces to '-', alnum/dash only, ≤12 */
export function linkSlug(nick: string): string {
  const s = nick
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // decomposed diacritics (NFD): drop the combining marks
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 12);
  return s || 'hrac';
}

/** `base`: the game's address (origin + path) */
export const referralLink = (base: string, nick: string, code: string) => `${base}#ref=${linkSlug(nick)}-${code}`;
