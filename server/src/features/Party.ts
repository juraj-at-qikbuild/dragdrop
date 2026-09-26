// Parties + invite links (docs/plans/social-events.md "Partia + invite link"). Up to 4 members, a
// leader (the nametag tag is their nick), a round-robin colour, and PvP/payout rules registered into
// the Sim. Invite codes are per-inviter (any member can mint one), stored in SQLite with a 24h TTL.
import { randomBytes } from 'node:crypto';
import type { HelloMsg } from '../../../src/shared/net/protocol';
import type { PartyMember, PartyState } from '../../../src/shared/sim/rules/types';
import type { PayoutReason, SimRule } from '../../../src/shared/sim/rules/SimRule';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { dist } from '../../../src/shared/util/math';
import type { Room, Session } from '../Room';
import { Bucket } from '../validate';
import type { FeatureHandlers, RoomFeature } from './RoomFeature';

const MAX_MEMBERS = 4;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/** round-robin, read well on the dark map and nametags */
const PARTY_COLORS = ['#ff5252', '#4fc3f7', '#ffca28', '#66bb6a', '#ba68c8', '#ff8a65', '#4dd0e1', '#f06292'];
/** reasons a party splits (docs/plans/social-events.md); everything else pays only the earner */
const SPLIT_REASONS = new Set<PayoutReason>(['kofolka', 'bounty', 'cumil', 'armored', 'derby', 'courier', 'taxi', 'tip']);
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** a 6-char lowercase base32 code from 4 random bytes (32 bits, enough for 6 * 5 = 30) */
function mintCode(): string {
  const buf = randomBytes(4);
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 6) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** the leader's nick, first 4 letters, uppercased */
const tagFor = (nick: string) => nick.slice(0, 4).toUpperCase();

interface PartyRec {
  id: number;
  leaderKey: string;
  tag: string;
  color: string;
  /** session keys */
  members: Set<string>;
}

export class Party implements RoomFeature {
  readonly id = 'party';
  private parties = new Map<number, PartyRec>();
  private nextId = 1;
  /** partyInvite rate limit, per session (a Session survives reconnects within the grace period) */
  private inviteBucket = new WeakMap<Session, Bucket>();

  constructor(private room: Room) {
    // same nonzero party: no damage, no car-jacking (Sim.hurtPlayer / Sim.enterVehicle already consult this)
    room.sim.rules.push({ id: 'party', allowPvp: (a, v) => !(a.partyId !== 0 && a.partyId === v.partyId) } satisfies SimRule);
    room.sim.payoutPolicy = (p, amount, reason) => this.split(p, amount, reason);
  }

  readonly messages: FeatureHandlers = {
    partyInvite: (s) => this.onInvite(s),
    partyLeave: (s) => this.onPartyLeave(s),
    partyKick: (s, m) => this.onKick(s, m.id),
  };

  onHello(s: Session, _isNew: boolean, msg: HelloMsg) {
    try {
      const joined = typeof msg.join === 'string' && msg.join ? this.onJoin(s, msg.join) : false;
      if (joined) return; // onJoin already pushed the fresh state
      // a reconnecting (or second-tab) member needs their party's current state re-sent: private
      // events don't survive a disconnect, and this session's own `pushState` calls at join/leave
      // time have long since been delivered (or dropped) for whoever was connected back then
      const pid = s.player.partyId;
      if (!pid) return;
      const party = this.parties.get(pid);
      if (party && party.members.has(s.key)) this.pushState(party);
      else s.player.partyId = 0; // stale: the party dissolved while this session was away
    } catch (e) {
      console.error('party onHello failed', e);
    }
  }

  onDrop(s: Session) {
    const party = this.partyOf(s);
    if (party) this.removeMember(party, s.key);
  }

  /** for Room's roster building (kept out of Room.ts itself: it just calls this if present) */
  partyTags(): [number, string, string][] {
    return [...this.parties.values()].map((p) => [p.id, p.tag, p.color]);
  }

  stats() {
    return { parties: this.parties.size };
  }

  // --------------------------------------------------------------------------------------- invite
  private onInvite(s: Session) {
    const now = this.room.wallNow();
    let bucket = this.inviteBucket.get(s);
    if (!bucket) this.inviteBucket.set(s, (bucket = new Bucket(0.1, 1, now))); // 1 per 10 s
    if (!bucket.take(now)) return;
    const party = this.getOrCreateParty(s);
    this.room.store?.deleteInvitesOf(s.key);
    const code = mintCode();
    this.room.store?.createInvite(code, s.key, now, INVITE_TTL_MS);
    this.room.sim.events.toPlayer(s.player.id, { k: 'invite', code });
    this.pushState(party, { key: s.key, code });
  }

  /** hello.join: place the joiner next to the inviter. Returns whether it actually changed anything
   *  (so onHello can skip its own generic state push). Never throws (onHello wraps it too, belt and
   *  braces): a bad invite must never fail the hello itself. */
  private onJoin(s: Session, code: string): boolean {
    const now = this.room.wallNow();
    const inv = this.room.store?.getInvite(code, now);
    if (!inv) {
      this.msg(s.player.id, 'Pozvánka už neplatí.', false);
      return false;
    }
    const inviter = this.room.sessions.get(inv.inviterKey);
    if (!inviter?.conn) {
      const stored = this.room.store?.loadProfile(inv.inviterKey);
      this.msg(s.player.id, stored ? `${stored.nick} nie je online.` : 'Hráč, ktorý ťa pozval, nie je online.', false);
      return false;
    }
    if (inviter.key === s.key) return false; // your own link: nothing to do
    const party = this.getOrCreateParty(inviter);
    if (party.members.has(s.key)) return false; // already there
    if (party.members.size >= MAX_MEMBERS) {
      this.msg(s.player.id, 'Partia je plná.', false);
      return false;
    }
    const old = s.player.partyId ? this.parties.get(s.player.partyId) : undefined;
    if (old && old !== party) this.removeMember(old, s.key);
    this.addMember(party, s);
    // a clear spot 2-4 m from the inviter, on their level (on foot, even mid-drive): sim.teleport
    // itself resolves the exact clear spot and bumps the epoch
    const f = inviter.player.focus(), lvl = inviter.player.focusLevel();
    const a = this.room.sim.rng.range(0, Math.PI * 2), r = this.room.sim.rng.range(2, 4);
    this.room.sim.teleport(s.player, f.x + Math.cos(a) * r, f.y + Math.sin(a) * r, lvl);
    this.msg(inviter.player.id, `${s.player.nick} sa pridal do partie`, true);
    this.msg(s.player.id, `Si v partii ${party.tag}!`, true);
    this.pushState(party);
    return true;
  }

  // ----------------------------------------------------------------------------- leave / kick / drop
  private onPartyLeave(s: Session) {
    const party = this.partyOf(s);
    if (party) this.removeMember(party, s.key);
    else s.player.partyId = 0;
  }

  private onKick(s: Session, targetId: number) {
    const party = this.partyOf(s);
    if (!party || party.leaderKey !== s.key) return; // leader only
    const target = this.room.sessionById(targetId);
    if (!target || target.key === s.key || !party.members.has(target.key)) return;
    this.removeMember(party, target.key, true);
  }

  /** remove `key` from `party`: passes leadership on, dissolves it if nobody's left connected, and
   *  tells the leaver (their party state clears; kicked also gets a toast). */
  private removeMember(party: PartyRec, key: string, kicked = false) {
    if (!party.members.has(key)) return;
    const leaving = this.room.sessions.get(key);
    if (leaving) {
      leaving.player.partyId = 0;
      this.room.sim.events.toPlayer(leaving.player.id, { k: 'party', s: null });
      if (kicked) this.msg(leaving.player.id, `Vyhodili ťa z partie ${party.tag}.`, false);
    }
    if (party.members.size === 1) {
      // `key` was the last one: dissolve here (rather than falling into the general dissolve()
      // below, which reads party.members) so the just-removed member's own code is still cleaned up
      this.parties.delete(party.id);
      this.room.store?.deleteInvitesOf(key);
      return;
    }
    party.members.delete(key);
    if (party.leaderKey === key) {
      let next: string | undefined;
      for (const k of party.members) if (this.room.sessions.get(k)?.conn) { next = k; break; }
      party.leaderKey = next ?? party.members.values().next().value!;
    }
    if (![...party.members].some((k) => this.room.sessions.get(k)?.conn)) return this.dissolve(party);
    this.pushState(party);
  }

  private dissolve(party: PartyRec) {
    this.parties.delete(party.id);
    for (const key of party.members) {
      this.room.store?.deleteInvitesOf(key); // whoever minted a code out of this party, it's dead now
      const s = this.room.sessions.get(key);
      if (!s) continue;
      s.player.partyId = 0;
      this.room.sim.events.toPlayer(s.player.id, { k: 'party', s: null });
    }
  }

  // --------------------------------------------------------------------------------------- helpers
  private partyOf(s: Session): PartyRec | undefined {
    return s.player.partyId ? this.parties.get(s.player.partyId) : undefined;
  }

  /** the session's current party, creating a fresh one (them as leader) if they have none */
  private getOrCreateParty(s: Session): PartyRec {
    const existing = this.partyOf(s);
    if (existing) return existing;
    const id = this.nextId++;
    const party: PartyRec = { id, leaderKey: s.key, tag: tagFor(s.player.nick), color: PARTY_COLORS[(id - 1) % PARTY_COLORS.length], members: new Set([s.key]) };
    this.parties.set(id, party);
    s.player.partyId = id;
    return party;
  }

  private addMember(party: PartyRec, s: Session) {
    party.members.add(s.key);
    s.player.partyId = party.id;
  }

  private msg(pid: number, text: string, ok: boolean) {
    this.room.sim.events.toPlayer(pid, { k: 'msg', title: '', text, time: 3, color: ok ? '#90caf9' : '#ff8a80' });
  }

  /** send every member their view of the party (each only ever sees their own fresh invite code) */
  private pushState(party: PartyRec, inviteFor?: { key: string; code: string }) {
    const members: PartyMember[] = [];
    for (const key of party.members) {
      const s = this.room.sessions.get(key);
      if (s) members.push({ id: s.player.id, nick: s.player.nick, leader: key === party.leaderKey, online: !!s.conn });
    }
    for (const key of party.members) {
      const s = this.room.sessions.get(key);
      if (!s) continue;
      const state: PartyState = { id: party.id, tag: party.tag, color: party.color, members };
      if (inviteFor?.key === key) state.invite = inviteFor.code;
      this.room.sim.events.toPlayer(s.player.id, { k: 'party', s: state });
    }
  }

  /** kofolka/bounty/cumil/armored/derby/courier/taxi/tip split evenly among the earner and their
   *  connected, play-or-downed party members within 300 m; everything else pays only the earner. */
  private split(p: SimPlayer, amount: number, reason: PayoutReason): { p: SimPlayer; amount: number }[] {
    if (!SPLIT_REASONS.has(reason) || !p.partyId) return [{ p, amount }];
    const party = this.parties.get(p.partyId);
    if (!party) return [{ p, amount }];
    const f = p.focus();
    const recipients: SimPlayer[] = [p];
    for (const key of party.members) {
      const mp = this.room.sessions.get(key)?.player;
      if (!mp || mp === p || !mp.connected) continue;
      if (mp.state !== 'play' && mp.state !== 'downed') continue;
      if (dist(f.x, f.y, mp.focus().x, mp.focus().y) > 300) continue;
      recipients.push(mp);
    }
    if (recipients.length === 1) return [{ p, amount }];
    const share = Math.floor(amount / recipients.length);
    const extra = amount - share * recipients.length; // remainder to the earner
    return recipients.map((r) => ({ p: r, amount: r === p ? share + extra : share }));
  }
}
