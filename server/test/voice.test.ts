// Proximity voice: the pure pairing algorithm against plain fixtures, then the Voice RoomFeature
// wired into a real Room (fake Supa/AuthVerifier, no network — server/test/helpers.ts).
import { describe, expect, it, vi } from 'vitest';
import { Room, type RoomOptions } from '../src/Room';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import type { PrivateEvent } from '../../src/shared/sim/events';
import type { AuthVerifier } from '../src/auth-types';
import { Supa } from '../src/supa';
import { linkKey, pairVoice } from '../src/features/Voice';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, TOKEN_C, disabledSupa, flush, loadWorld } from './helpers';

// ============================================================================================
// pairVoice: pure geometry, no Room involved
// ============================================================================================
describe('pairVoice', () => {
  /** two players d metres apart on the x axis, both at the same (surface/tunnel) level */
  const two = (d: number, underground = false): { id: number; x: number; y: number; underground: boolean }[] => [
    { id: 1, x: 0, y: 0, underground },
    { id: 2, x: d, y: 0, underground },
  ];

  it('links a new pair once they are under 45 m, not yet at or above it', () => {
    expect(pairVoice(two(44), new Set())).toEqual(new Set([linkKey(1, 2)]));
    expect(pairVoice(two(45), new Set())).toEqual(new Set()); // "below 45": the boundary itself doesn't (yet) count
    expect(pairVoice(two(46), new Set())).toEqual(new Set());
  });

  it('keeps an already-linked pair until they pass 60 m, then drops it (hysteresis)', () => {
    const linked = new Set([linkKey(1, 2)]);
    expect(pairVoice(two(50), linked)).toEqual(linked); // between 45 and 60: hysteresis keeps it
    expect(pairVoice(two(60), linked)).toEqual(linked); // exactly at the unlink boundary: still linked
    expect(pairVoice(two(61), linked)).toEqual(new Set()); // past it: dropped
  });

  it('never links across a tunnel/surface boundary, however close', () => {
    const players = [{ id: 1, x: 0, y: 0, underground: true }, { id: 2, x: 1, y: 0, underground: false }];
    expect(pairVoice(players, new Set())).toEqual(new Set());
    // even an already-linked pair breaks the moment one of them goes underground
    expect(pairVoice(players, new Set([linkKey(1, 2)]))).toEqual(new Set());
  });

  it('links normally when both are underground together', () => {
    expect(pairVoice(two(10, true), new Set())).toEqual(new Set([linkKey(1, 2)]));
  });

  it('only ever pairs players actually present in the list — callers filter voiceOn/connected/afk first', () => {
    // a third id that would obviously be in range simply never appears in the input, and can't leak in
    const out = pairVoice(two(10), new Set());
    expect(out).toEqual(new Set([linkKey(1, 2)]));
    for (const key of out) for (const id of key.split(':').map(Number)) expect([1, 2]).toContain(id);
  });

  it('caps each player at 8 links, keeps the nearest, and is symmetric/order-independent', () => {
    // a hub with 8 close-by satellites (a 90° wedge at ~18 m) plus one outlier at 44 m, isolated by
    // angle (~200°) so it is far from the whole wedge — every hub↔satellite edge (18 m) sorts well
    // before the hub↔outlier edge (44 m), so the hub is provably full (8/8) by the time that one is
    // considered, regardless of whatever links the satellites also form among themselves.
    const hub = { id: 100, x: 0, y: 0, underground: false };
    const cluster = Array.from({ length: 8 }, (_, i) => {
      const a = (i / 7) * (Math.PI / 2); // spread across a 90° wedge
      return { id: i + 1, x: Math.cos(a) * 18, y: Math.sin(a) * 18, underground: false };
    });
    const outlier = { id: 9, x: Math.cos((200 * Math.PI) / 180) * 44, y: Math.sin((200 * Math.PI) / 180) * 44, underground: false };
    const players = [hub, ...cluster, outlier];
    const out = pairVoice(players, new Set());
    const hubLinks = [...out].filter((k) => k.split(':').map(Number).includes(hub.id));
    expect(hubLinks).toHaveLength(8);
    for (const s of cluster) expect(out.has(linkKey(hub.id, s.id))).toBe(true);
    expect(out.has(linkKey(hub.id, outlier.id))).toBe(false); // bumped: the hub was already full
    const shuffled = [outlier, ...[...cluster].reverse(), hub];
    expect(pairVoice(shuffled, new Set())).toEqual(out); // same result whatever order players come in
  });
});

// ============================================================================================
// Voice wired into a Room: opt-in gating, pairing, signalling relay, reports, lifecycle
// ============================================================================================
/** 'tok-a'/'tok-b'/'tok-c' verify as distinct accounts; anything else fails (server/src/auth.ts's
 *  real verifier arrives with I3 — this stands in exactly as server/test/room.test.ts's does) */
const fakeAuth: AuthVerifier = {
  verify: (token) =>
    Promise.resolve(token === 'tok-a' ? { userId: 'u1' } : token === 'tok-b' ? { userId: 'u2' } : token === 'tok-c' ? { userId: 'u3' } : null),
};

function setup(extra: Partial<RoomOptions> = {}) {
  const clock = new FakeClock();
  // debug:true (teleport) lets one test place a player far away by a known city landmark instead of a
  // made-up coordinate; it also relaxes RemoteConfig's voice_requires_account (the e2e override, see
  // RemoteConfig.ts), which the one test that cares about that override explicitly turns back off
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 7, debug: true, supa: disabledSupa(), auth: fakeAuth, ...extra });
  const join = (token: string, nick: string) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick }));
    return { link, conn, id: link.last('welcome')?.id as number };
  };
  const joinAuth = async (token: string, nick: string, authToken: string) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick, auth: authToken }));
    await flush();
    return { link, conn, id: link.last('welcome')?.id as number };
  };
  const voice = (conn: Parameters<Room['onMessage']>[0], on: boolean) => room.onMessage(conn, JSON.stringify({ t: 'voice', on }));
  const tick = (n = 1, ms = 50) => {
    for (let i = 0; i < n; i++) {
      clock.advance(ms);
      room.tick(ms);
    }
  };
  return { clock, room, join, joinAuth, voice, tick };
}

/** every `{k:'msg', text}` private event a link has received so far (via `ev.p`, drained on tick) */
function privMsgs(link: FakeLink): string[] {
  const out: string[] = [];
  for (const m of link.json('ev')) for (const e of m.p as PrivateEvent[]) if (e.k === 'msg') out.push(e.text);
  return out;
}

function fakeSupa(rows: { key: string; value: unknown }[]) {
  const fn = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }));
  return new Supa('https://x.example', 'k', { fetch: fn as unknown as typeof fetch });
}

describe('Voice (wired into a Room)', () => {
  it('an account opting in gets voiceIce, and near another voice-on account gets voicePeers with complementary polite flags', async () => {
    const { joinAuth, voice, tick } = setup();
    // no explicit position: two players joining close together land a few metres apart (Sim.addPlayer's
    // spread-near-spawn), comfortably under the 45 m link range — see the pairVoice suite above for the
    // exact geometry of the pairing rule itself.
    const a = await joinAuth(TOKEN_A, 'Adam', 'tok-a');
    const b = await joinAuth(TOKEN_B, 'Beta', 'tok-b');
    voice(a.conn, true);
    voice(b.conn, true);
    await flush(); // let both voiceIce mints (fire-and-forget) land
    expect(a.link.last('voiceIce')?.ice.length).toBeGreaterThan(0);
    expect(b.link.last('voiceIce')?.ice.length).toBeGreaterThan(0);
    a.link.clear();
    b.link.clear();
    tick(); // one pairing pass
    const pa = a.link.last('voicePeers'), pb = b.link.last('voicePeers');
    expect(pa?.add).toEqual([{ id: b.id, polite: a.id > b.id }]);
    expect(pb?.add).toEqual([{ id: a.id, polite: b.id > a.id }]);
    expect(pa!.add[0].polite).not.toBe(pb!.add[0].polite); // exactly one side is polite
  });

  it('a guest is refused while voice_requires_account is on, and accepted once the override turns it off', () => {
    const { room, join, voice, tick } = setup({ debug: false }); // debug:false: no e2e override in play
    const g = join(TOKEN_A, 'Guest');
    voice(g.conn, true);
    tick();
    expect(privMsgs(g.link)).toContain('Hlasový chat je len pre prihlásených hráčov.');
    expect(room.sessionById(g.id)!.player.voiceOn).toBe(false);
    expect(g.link.json('voiceIce')).toHaveLength(0);
    g.link.clear();
    room.remoteConfig!.setVoiceRequiresAccountOverride(false);
    voice(g.conn, true);
    expect(room.sessionById(g.id)!.player.voiceOn).toBe(true);
  });

  it('a blocklisted account is refused', async () => {
    const { joinAuth, voice, tick } = setup({ supa: fakeSupa([{ key: 'voice_blocklist', value: ['u1'] }]) });
    await flush(); // RemoteConfig's boot load()
    const a = await joinAuth(TOKEN_A, 'Adam', 'tok-a');
    voice(a.conn, true);
    tick();
    expect(privMsgs(a.link)).toContain('Hlasový chat máš zablokovaný.');
  });

  it('voiceSig is relayed only between linked pairs', async () => {
    const { room, joinAuth, voice, tick } = setup();
    const a = await joinAuth(TOKEN_A, 'Aa', 'tok-a');
    const b = await joinAuth(TOKEN_B, 'Bb', 'tok-b'); // close: will link
    const c = await joinAuth(TOKEN_C, 'Cc', 'tok-c'); // moved far away below: never links
    const eurovea = room.sim.world.walkableNear(room.sim.world.landmark('eurovea').x, room.sim.world.landmark('eurovea').y);
    room.onMessage(c.conn, JSON.stringify({ t: 'debug', teleport: [eurovea.x, eurovea.y] }));
    voice(a.conn, true);
    voice(b.conn, true);
    voice(c.conn, true);
    await flush();
    tick();
    b.link.clear();
    c.link.clear();
    room.onMessage(a.conn, JSON.stringify({ t: 'voiceSig', to: b.id, data: { ice: { candidate: 'cand1' } } }));
    expect(b.link.json('voiceSig')).toHaveLength(1);
    expect(b.link.last('voiceSig')).toMatchObject({ from: a.id, data: { ice: { candidate: 'cand1' } } });
    room.onMessage(a.conn, JSON.stringify({ t: 'voiceSig', to: c.id, data: { ice: { candidate: 'cand2' } } }));
    expect(c.link.json('voiceSig')).toHaveLength(0); // not linked: silently dropped
  });

  it('leaving removes links and tells the peer', async () => {
    const { room, joinAuth, voice, tick } = setup();
    const a = await joinAuth(TOKEN_A, 'Aa', 'tok-a');
    const b = await joinAuth(TOKEN_B, 'Bb', 'tok-b');
    voice(a.conn, true);
    voice(b.conn, true);
    await flush();
    tick();
    expect(b.link.last('voicePeers')?.add).toEqual([{ id: a.id, polite: b.id > a.id }]);
    b.link.clear();
    room.onLeave(a.conn);
    expect(b.link.last('voicePeers')?.del).toEqual([a.id]);
  });

  it('a reconnect starts with voice off: the player opts in again and the peer is told the link dropped', async () => {
    const { room, joinAuth, voice, tick } = setup();
    const a = await joinAuth(TOKEN_A, 'Aa', 'tok-a');
    const b = await joinAuth(TOKEN_B, 'Bb', 'tok-b');
    voice(a.conn, true);
    voice(b.conn, true);
    await flush();
    tick();
    expect(b.link.last('voicePeers')?.add).toEqual([{ id: a.id, polite: b.id > a.id }]);
    b.link.clear();
    room.onLeave(a.conn);
    expect(room.sessionById(a.id)!.player.voiceOn).toBe(false);
    const again = await joinAuth(TOKEN_A, 'Aa', 'tok-a'); // same account, within the grace period
    expect(again.id).toBe(a.id);
    tick(25); // a few pairing passes: no link until the client opts in again
    expect(again.link.json('voicePeers')).toHaveLength(0);
    voice(again.conn, true);
    await flush();
    tick(25);
    expect(again.link.last('voicePeers')?.add).toEqual([{ id: b.id, polite: a.id > b.id }]);
  });

  it('a new connection taking over a live session also turns voice off', async () => {
    const { room, joinAuth, voice } = setup();
    const a = await joinAuth(TOKEN_A, 'Aa', 'tok-a');
    voice(a.conn, true);
    await flush();
    expect(room.sessionById(a.id)!.player.voiceOn).toBe(true);
    await joinAuth(TOKEN_A, 'Aa', 'tok-a'); // e.g. a reloaded tab, before the old socket closed
    expect(room.sessionById(a.id)!.player.voiceOn).toBe(false);
  });

  it('turning voice_enabled off through RemoteConfig drops everyone', async () => {
    const rows: { key: string; value: unknown }[] = [];
    const supa = fakeSupa(rows);
    const { room, joinAuth, voice, tick } = setup({ supa });
    await flush(); // boot load, still defaults (voice_enabled true)
    const a = await joinAuth(TOKEN_A, 'Aa', 'tok-a');
    const b = await joinAuth(TOKEN_B, 'Bb', 'tok-b');
    voice(a.conn, true);
    voice(b.conn, true);
    await flush();
    tick();
    expect(a.link.last('voicePeers')?.add).toHaveLength(1);
    a.link.clear();
    b.link.clear();
    rows.push({ key: 'voice_enabled', value: false });
    await (room.remoteConfig as unknown as { load(): Promise<void> }).load();
    expect(a.link.last('voicePeers')?.del).toEqual([b.id]);
    expect(b.link.last('voicePeers')?.del).toEqual([a.id]);
    expect(room.sessionById(a.id)!.player.voiceOn).toBe(false);
    expect(room.sessionById(b.id)!.player.voiceOn).toBe(false);
  });

  it('report reaches activity.report, replies with a confirmation, and is rate-limited to 5/min', async () => {
    const { room, joinAuth, tick } = setup();
    const a = await joinAuth(TOKEN_A, 'Aa', 'tok-a');
    const b = await joinAuth(TOKEN_B, 'Bb', 'tok-b');
    const spy = vi.spyOn(room.activity!, 'report');
    const send = (reason: string) => room.onMessage(a.conn, JSON.stringify({ t: 'report', target: b.id, reason }));
    send('r1');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(room.sessionById(a.id));
    expect(spy.mock.calls[0][1]).toBe(room.sessionById(b.id));
    expect(spy.mock.calls[0][2]).toBe('r1');
    tick();
    expect(privMsgs(a.link)).toContain('Ďakujeme, nahlásenie sme prijali.');
    for (let i = 0; i < 7; i++) send('spam' + i); // 1 already spent of the 5-burst; only 4 more should land
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('truncates an overlong report reason to 200 chars', async () => {
    const { room, joinAuth } = setup();
    const a = await joinAuth(TOKEN_A, 'Aa', 'tok-a');
    const b = await joinAuth(TOKEN_B, 'Bb', 'tok-b');
    const spy = vi.spyOn(room.activity!, 'report');
    room.onMessage(a.conn, JSON.stringify({ t: 'report', target: b.id, reason: 'x'.repeat(500) }));
    expect(spy.mock.calls[0][2]).toHaveLength(200);
  });
});
