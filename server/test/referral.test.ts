// server/src/features/Referral.ts (docs/referrals.md): who counts as a friend, what counts as playing,
// and paying the referrer live, offline and after a guest claims into an account.
import { afterEach, describe, expect, it } from 'vitest';
import { Room } from '../src/Room';
import { Store, hashToken } from '../src/db';
import type { Referral } from '../src/features/Referral';
import { referralCodeOf } from '../src/referral/ReferralStore';
import type { AuthVerifier } from '../src/auth-types';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, TOKEN_C, disabledSupa, flush, loadWorld } from './helpers';

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

/** 'tok-<name>' verifies as the account u-<name> */
const fakeAuth: AuthVerifier = { verify: (t) => Promise.resolve(t.startsWith('tok-') ? { userId: 'u-' + t.slice(4) } : null) };

function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  const clock = new FakeClock();
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 3, store, auth: fakeAuth, supa: disabledSupa() });
  const referral = room.feature<Referral>('referral')!;
  /** one room tick: private events (the toasts) go out with it */
  const tick = () => {
    clock.advance(50);
    room.tick(50);
  };
  const join = async (token: string, nick: string, extra: Record<string, unknown> = {}) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick, presence: true, analytics: true, ...extra }));
    await flush();
    tick();
    const w = link.last('welcome');
    const money = () => room.sessionById(w.id)!.player.profile.money;
    const start = money();
    /** what they've gained since they came in (a tick can bring a starting bonus: not ours) */
    return { link, conn, session: room.sessionById(w.id)!, money, gained: () => money() - start };
  };
  /** `minutes` of real play: an input pulse every 30 s */
  const play = (who: { conn: ReturnType<Room['onJoin']> }, minutes: number) => {
    for (let i = 0; i < minutes * 2; i++) {
      room.onMessage(who.conn, JSON.stringify({ t: 'activity' }));
      clock.advance(30_000);
      referral.tick();
    }
  };
  const idle = (minutes: number) => {
    for (let i = 0; i < minutes * 2; i++) {
      clock.advance(30_000);
      referral.tick();
    }
  };
  return { store, clock, room, referral, join, play, idle, tick };
}

const msgs = (link: FakeLink) => link.json('ev').flatMap((m) => m.p).flatMap((e) => (e.k === 'msg' ? [e.text] : []));

describe('referrals', () => {
  it('pays the referrer €1 000 at 50 active minutes and €3 000 in all at the hour, once the friend has an account', async () => {
    const t = setup();
    const a = await t.join(TOKEN_A, 'Ferko');
    const code = referralCodeOf(hashToken(TOKEN_A));
    expect(a.link.last('referral')).toMatchObject({ code, n: 0, paid: 0 });
    const b = await t.join(TOKEN_B, 'Janka', { auth: 'tok-janka', ref: code });
    expect(msgs(b.link).some((m) => m.includes('Pozval ťa Ferko'))).toBe(true);
    expect(a.link.last('referral')).toMatchObject({ n: 1, friends: [['Janka', 0, 0, 1]] });
    t.play(b, 49);
    expect(a.gained()).toBe(0);
    t.play(b, 1);
    expect(a.gained()).toBe(1000);
    t.play(b, 10);
    expect(a.gained()).toBe(3000);
    t.play(b, 30);
    expect(a.gained()).toBe(3000);
    expect(a.link.last('referral')).toMatchObject({ n: 1, paid: 3000, friends: [['Janka', 60, 3000, 1]] });
  });

  it('counts only active time: not paused, not without input', async () => {
    const t = setup();
    const a = await t.join(TOKEN_A, 'Ferko');
    const b = await t.join(TOKEN_B, 'Janka', { auth: 'tok-janka', ref: referralCodeOf(hashToken(TOKEN_A)) });
    t.play(b, 1);
    t.idle(120); // no input: a minute's grace, then nothing
    t.room.onMessage(b.conn, JSON.stringify({ t: 'away', on: true }));
    t.play(b, 120); // paused: pulses don't count
    t.referral.shutdown();
    expect(t.store.referrals.get('acct:u-janka')!.active_ms).toBeLessThan(3 * 60_000);
    expect(a.gained()).toBe(0);
  });

  it("never refers an existing player, or anyone to their own link", async () => {
    const t = setup();
    const a = await t.join(TOKEN_A, 'Ferko');
    const code = referralCodeOf(hashToken(TOKEN_A));
    const b = await t.join(TOKEN_B, 'Janka');
    t.room.onMessage(b.conn, JSON.stringify({ t: 'leave' }));
    await t.join(TOKEN_B, 'Janka', { ref: code }); // back, with a saved profile
    expect(t.store.referrals.get(hashToken(TOKEN_B))).toBeNull();
    // the same device's new account, through its own guest link
    await t.join(TOKEN_A, 'Ferko2', { auth: 'tok-ferko', ref: code });
    expect(t.store.referrals.get('acct:u-ferko')).toBeNull();
    expect(a.link.last('referral')).toMatchObject({ n: 0 });
  });

  it('a party invite counts as a referral', async () => {
    const t = setup();
    const a = await t.join(TOKEN_A, 'Ferko');
    t.room.onMessage(a.conn, JSON.stringify({ t: 'partyInvite' }));
    t.tick();
    const invite = a.link.json('ev').flatMap((m) => m.p).find((e) => e.k === 'invite') as { code: string };
    const b = await t.join(TOKEN_B, 'Janka', { auth: 'tok-janka', join: invite.code });
    expect(t.store.referrals.get('acct:u-janka')).toMatchObject({ code: referralCodeOf(hashToken(TOKEN_A)) });
    t.play(b, 60);
    expect(a.gained()).toBe(3000);
  });

  it('pays an offline referrer into the saved profile, and tells them when they are back', async () => {
    const t = setup();
    const a = await t.join(TOKEN_A, 'Ferko');
    t.room.onMessage(a.conn, JSON.stringify({ t: 'leave' }));
    const saved = () => t.store.loadProfile(hashToken(TOKEN_A))!.profile.money;
    const before = saved();
    const b = await t.join(TOKEN_B, 'Janka', { auth: 'tok-janka', ref: referralCodeOf(hashToken(TOKEN_A)) });
    t.play(b, 50);
    expect(saved() - before).toBe(1000);
    const back = await t.join(TOKEN_A, 'Ferko');
    expect(back.money()).toBe(before + 1000);
    expect(msgs(back.link).some((m) => m.includes('ti zarobili €1 000'))).toBe(true);
    const again = await t.join(TOKEN_A, 'Ferko'); // told once
    expect(msgs(again.link).some((m) => m.includes('ti zarobili'))).toBe(false);
  });

  it("waits for a guest friend's account, then pays for the time they played as a guest too", async () => {
    const t = setup();
    const a = await t.join(TOKEN_A, 'Ferko');
    const b = await t.join(TOKEN_B, 'Janka', { ref: referralCodeOf(hashToken(TOKEN_A)) });
    t.play(b, 55);
    expect(a.gained()).toBe(0);
    await t.join(TOKEN_B, 'Janka', { auth: 'tok-janka', claim: true });
    expect(a.gained()).toBe(1000);
    expect(t.store.referrals.get(hashToken(TOKEN_B))).toBeNull();
    expect(t.store.referrals.get('acct:u-janka')).toMatchObject({ paid: 1000 });
  });

  it("a claimed guest's own link keeps working and pays the account", async () => {
    const t = setup();
    const guestCode = referralCodeOf(hashToken(TOKEN_A));
    const a = await t.join(TOKEN_A, 'Ferko');
    t.room.onMessage(a.conn, JSON.stringify({ t: 'leave' }));
    const acct = await t.join(TOKEN_A, 'Ferko', { auth: 'tok-ferko', claim: true });
    expect(acct.link.last('referral').code).toBe(referralCodeOf('acct:u-ferko'));
    const c = await t.join(TOKEN_C, 'Mišo', { auth: 'tok-miso', ref: guestCode });
    t.play(c, 50);
    expect(acct.gained()).toBe(1000);
  });
});
