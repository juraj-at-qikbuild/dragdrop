// Referral links (docs/referrals.md). Every player key has a code (derived from the key, so a client
// can show its link before it connects); every hello registers it. A brand-new player who arrives with
// `hello.ref`, or through a party invite (`hello.join`: the inviter is the referrer), is remembered as
// that code's friend. Their *active* time (connected, not away or AFK, gameplay input within the last
// minute) is counted here, and once they have an account the referrer is paid by REFERRAL_TIERS: into
// the live profile when they're in the city, else straight into the saved one (and told next time).
import type { HelloMsg } from '../../../src/shared/net/protocol';
import { REFERRAL_CODE_RE, REFERRAL_DONE_MIN, referralEarned } from '../../../src/shared/referral';
import { formatMoney } from '../../../src/shared/util/math';
import { hashToken } from '../db';
import type { DropReason, Room, Session } from '../Room';
import { referralCodeOf, type ReferralRow } from '../referral/ReferralStore';
import { INPUT_IDLE_MS } from './Analytics';
import type { FeatureHandlers, RoomFeature } from './RoomFeature';

/** how often counted time is saved (a crash loses at most this much of a friend's time) */
const CHECKPOINT_MS = 15_000;
/** friends listed in the `referral` message */
const LIST_MAX = 20;
const DONE_MS = REFERRAL_DONE_MIN * 60_000;

/** a friend being timed: their active ms so far, and what's saved */
interface Timing {
  ms: number;
  saved: number;
  nick: string;
}

export class Referral implements RoomFeature {
  readonly id = 'referral';
  /** referee key → their time, while they're in the city and still short of REFERRAL_DONE_MIN */
  private timing = new Map<string, Timing>();
  private last: number;
  private checkpointIn = CHECKPOINT_MS;

  constructor(private room: Room) {
    this.last = room.monotonicNow();
  }

  private get store() {
    return this.room.store?.referrals;
  }

  readonly messages: FeatureHandlers = {
    referral: (s) => this.sendState(s),
  };

  onHello(s: Session, isNew: boolean, msg: HelloMsg) {
    const store = this.store;
    if (!store) return;
    try {
      store.register(referralCodeOf(s.key), s.key, this.room.wallNow());
      // only a player the city has never seen: no saved profile yet (a claimed guest's has just moved in)
      if (isNew && !this.room.store!.hasPlayer(s.key)) this.attribute(s, msg);
      const row = store.get(s.key);
      if (row) {
        if (row.active_ms < DONE_MS && !this.timing.has(s.key)) this.timing.set(s.key, { ms: row.active_ms, saved: row.active_ms, nick: s.player.nick });
        this.settle(row); // e.g. a guest who has just claimed into an account
      }
      // friends who earned this referrer something while they were away
      for (const r of store.of(s.key)) if (r.paid < this.earned(r)) this.settle(r);
      const unseen = store.of(s.key).reduce((sum, r) => sum + r.paid - r.seen, 0);
      if (unseen > 0) {
        store.markSeen(s.key);
        this.msg(s, `Kamaráti, ktorých si pozval, ti zarobili ${formatMoney(unseen)}!`, true);
      }
      this.sendState(s);
    } catch (e) {
      console.error('referral onHello failed', e instanceof Error ? e.message : e);
    }
  }

  onLeave(s: Session) {
    this.save(s.key);
  }

  onDrop(s: Session, why: DropReason) {
    if (why === 'deleted') {
      this.timing.delete(s.key);
      this.store?.forget(s.key);
      return;
    }
    this.save(s.key);
    this.timing.delete(s.key);
  }

  onClaim(from: string, to: string) {
    this.store?.claim(from, to);
  }

  tick() {
    const now = this.room.monotonicNow();
    const dt = Math.max(0, now - this.last);
    this.last = now;
    if (!this.timing.size) return;
    for (const [key, t] of this.timing) {
      const s = this.room.sessions.get(key);
      if (!s || !this.active(s, now)) continue;
      const before = t.ms;
      t.ms += dt;
      t.nick = s.player.nick;
      // a tier just reached: saved and paid at once
      if (referralEarned(before, true) !== referralEarned(t.ms, true)) this.save(key);
    }
    this.checkpointIn -= dt;
    if (this.checkpointIn <= 0) {
      this.checkpointIn = CHECKPOINT_MS;
      for (const key of [...this.timing.keys()]) this.save(key);
    }
  }

  shutdown() {
    for (const key of [...this.timing.keys()]) this.save(key);
  }

  stats() {
    return { referralsTimed: this.timing.size };
  }

  // ------------------------------------------------------------------------------------------ inner
  /** playing for real: in the city, not paused, not AFK, and touching the controls */
  private active(s: Session, now: number) {
    return !!s.conn && !s.player.away && !s.player.afk && now - s.inputAt < INPUT_IDLE_MS;
  }

  /** a new player's referrer: a party invite's inviter first (that's the link they just used), else
   *  the `#ref=` code their client kept */
  private attribute(s: Session, msg: HelloMsg) {
    const store = this.store!;
    const now = this.room.wallNow();
    let code: string | null = null;
    if (typeof msg.join === 'string' && msg.join) {
      const inv = this.room.store!.getInvite(msg.join, now);
      if (inv) code = referralCodeOf(inv.inviterKey);
    }
    if (!code && typeof msg.ref === 'string' && REFERRAL_CODE_RE.test(msg.ref)) code = msg.ref.toLowerCase();
    if (!code) return;
    // not your own link: not this key's, nor (for an account) this device's guest identity's
    const guest = hashToken(s.token);
    const owner = store.owner(code);
    if (owner === s.key || owner === guest || code === referralCodeOf(guest)) return;
    if (!store.add(s.key, code, s.player.nick, now)) return;
    const by = owner ? this.room.sessions.get(owner) : undefined;
    const byNick = by?.player.nick ?? (owner ? this.room.store!.loadProfile(owner)?.nick : undefined);
    if (byNick) this.msg(s, `Pozval ťa ${byNick}. Keď si založíš účet a zahráš si, ${byNick} dostane odmenu.`, true);
    if (by) {
      this.msg(by, `${s.player.nick} prišiel na tvoju pozvánku!`, true);
      this.sendState(by);
    }
  }

  private earned(r: ReferralRow) {
    return referralEarned(this.timing.get(r.referee_key)?.ms ?? r.active_ms, r.referee_key.startsWith('acct:'));
  }

  /** a timed friend's time into SQLite, then whatever it has earned paid out */
  private save(key: string) {
    const store = this.store;
    const t = this.timing.get(key);
    if (!store || !t) return;
    if (t.ms !== t.saved) {
      store.setActive(key, t.ms, t.nick);
      t.saved = t.ms;
    }
    const row = store.get(key);
    if (row) this.settle(row);
    if (t.ms >= DONE_MS) this.timing.delete(key);
  }

  /** pay the referrer what `r` has earned them beyond what they've had: into their live profile, else
   *  their saved one. Their code's owner unknown (never been online), or no saved profile: it waits. */
  private settle(r: ReferralRow) {
    const store = this.store!;
    const earned = this.earned(r);
    const owed = earned - r.paid;
    if (owed <= 0) return;
    const ownerKey = store.owner(r.code);
    if (!ownerKey) return;
    const owner = this.room.sessions.get(ownerKey);
    if (owner) {
      if (!store.pay(r.referee_key, earned, !!owner.conn)) return;
      const p = owner.player;
      const f = p.focus();
      this.room.sim.addMoney(p, owed, f.x, f.y);
      this.room.sim.onProfileChange?.(p);
      this.msg(owner, `${r.nick} hrá už ${Math.floor((this.timing.get(r.referee_key)?.ms ?? r.active_ms) / 60_000)} min: odmena za pozvanie +${formatMoney(owed)}`, true);
      this.sendState(owner);
    } else store.pay(r.referee_key, earned, false, { key: ownerKey, amount: owed });
  }

  private sendState(s: Session) {
    const store = this.store;
    if (!store || !s.conn) return;
    const rows = store.of(s.key);
    this.room.sendTo(s, {
      t: 'referral',
      code: referralCodeOf(s.key),
      friends: rows.slice(0, LIST_MAX).map((r) => [
        r.nick, Math.floor((this.timing.get(r.referee_key)?.ms ?? r.active_ms) / 60_000), r.paid, r.referee_key.startsWith('acct:') ? 1 : 0,
      ]),
      n: rows.length,
      paid: rows.reduce((sum, r) => sum + r.paid, 0),
    });
  }

  private msg(s: Session, text: string, ok: boolean) {
    this.room.sim.events.toPlayer(s.player.id, { k: 'msg', title: '', text, time: 4, color: ok ? '#69f0ae' : '#ff8a80' });
  }
}
