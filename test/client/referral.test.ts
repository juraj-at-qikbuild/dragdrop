// Referral links on the client (src/net/referral.ts, src/boot/links.ts; docs/referrals.md): the link
// the main menu shows must carry the very code the server pays out on, and a `#ref=` link must survive
// until an online hello carries it. The environment is node (see vitest.config.ts), so localStorage is
// a small in-memory stand-in here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBootLinks } from '../../src/boot/links';
import { clearPendingRef, myReferralCode, pendingRef, setPendingRef } from '../../src/net/referral';
import { REFERRAL_CODE_LEN, REFERRAL_CODE_RE, linkSlug, referralEarned, referralLink } from '../../src/shared/referral';
import { hashToken } from '../../server/src/db';
import { referralCodeOf } from '../../server/src/referral/ReferralStore';

const TOKEN = '11111111-1111-4111-8111-111111111111';
const MIN = 60_000;

describe('referral links', () => {
  const g = globalThis as { localStorage?: unknown };
  beforeEach(() => {
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  });
  afterEach(() => {
    delete g.localStorage;
  });

  it("derives the same code as the server, for this device's guest", async () => {
    expect(await myReferralCode()).toBeNull(); // no identity yet: no link
    (g.localStorage as Storage).setItem('blava-city-online-id', JSON.stringify({ token: TOKEN, nick: 'Ferko' }));
    const code = await myReferralCode();
    expect(code).toBe(referralCodeOf(hashToken(TOKEN)));
    expect(code).toHaveLength(REFERRAL_CODE_LEN);
    expect(REFERRAL_CODE_RE.test(code!)).toBe(true);
  });

  it('round-trips through the link parser', () => {
    const code = referralCodeOf('acct:u1');
    const url = referralLink('https://gta-sk.fun/', 'Jožko Mrkvička', code);
    expect(url).toBe(`https://gta-sk.fun/#ref=jozko-mrkvic-${code}`);
    expect(parseBootLinks(new URL(url).hash, '').ref).toBe(code);
    expect(parseBootLinks('#ref=ABCD1234', '').ref).toBe('abcd1234');
    expect(parseBootLinks('#ref=', '').ref).toBeNull();
    expect(parseBootLinks('#join=fero-k3x9q2', '').ref).toBeNull();
    expect(linkSlug('!!!')).toBe('hrac');
  });

  it('keeps a pending code for 30 days, until a hello is welcomed', () => {
    const now = Date.UTC(2026, 8, 28);
    setPendingRef('abcd1234', now);
    expect(pendingRef(now + 29 * 24 * 60 * MIN)).toBe('abcd1234');
    expect(pendingRef(now + 31 * 24 * 60 * MIN)).toBeUndefined();
    clearPendingRef();
    expect(pendingRef(now)).toBeUndefined();
  });
});

describe('referral rewards', () => {
  it('pays €1 000 at 50 active minutes, €3 000 in all at the hour, and only for an account', () => {
    expect(referralEarned(49 * MIN, true)).toBe(0);
    expect(referralEarned(50 * MIN, true)).toBe(1000);
    expect(referralEarned(59 * MIN, true)).toBe(1000);
    expect(referralEarned(60 * MIN, true)).toBe(3000);
    expect(referralEarned(600 * MIN, true)).toBe(3000);
    expect(referralEarned(600 * MIN, false)).toBe(0);
  });
});
