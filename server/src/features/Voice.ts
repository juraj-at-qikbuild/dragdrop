// Proximity voice chat (accounts only): opt-in/out, spatial pairing (WebRTC mesh, at most 8 peers
// each), signalling relay between linked pairs, ICE credentials, and reports.
// docs/plans/social-events.md ("Proximity voice", Decision 5, the "Implementation notes" section).
//
// The mesh itself (RTCPeerConnection, audio) is entirely peer-to-peer and client-side (src/game/
// features/voice/); this feature only ever decides *who* may signal *whom*, and relays their signals.
import { dist } from '../../../src/shared/util/math';
import type { ClientMsg, IceServer, VoiceSignal } from '../../../src/shared/net/protocol';
import type { Room, Session } from '../Room';
import { config } from '../config';
import { mintIceServers, type TurnCacheEntry } from '../turn';
import type { Activity } from './Activity';
import type { RemoteConfig } from './RemoteConfig';
import type { FeatureHandlers, RoomFeature } from './RoomFeature';
import { Bucket } from '../validate';

/** below this, a pair links; a linked pair stays linked until they're this far apart (hysteresis, so
 *  two players hovering right at the edge don't flap the WebRTC connection open/closed) */
export const VOICE_LINK_M = 45;
export const VOICE_UNLINK_M = 60;
/** each player keeps at most this many simultaneous voice peers */
export const VOICE_MAX_LINKS = 8;
/** once per second (a tick accumulator): plenty responsive for walking speed, cheap at 150 players */
const PAIR_INTERVAL_MS = 1000;
/** voiceSig relay: generous burst for a flurry of ICE candidates, refilling fast */
const SIG_RATE = 60;
const SIG_BURST = 60;
/** report: rate-limited so a report storm can't be used to spam Activity or grief a target */
const REPORT_PER_MIN = 5;
/** voice{on:true}: a small burst (a toggle, a reconnect) but capped hard, so a flood of them can't
 *  each mint their own Cloudflare TURN credentials (they'd also be de-duped by voiceOn/inFlight below,
 *  this only bounds how often that check itself even runs) */
const VOICE_RATE = 0.5; // 1 token every 2s
const VOICE_BURST = 4;

const MSG_DISABLED = 'Hlasový chat je teraz vypnutý.';
const MSG_GUEST = 'Hlasový chat je len pre prihlásených hráčov.';
const MSG_BLOCKED = 'Hlasový chat máš zablokovaný.';
const MSG_REPORTED = 'Ďakujeme, nahlásenie sme prijali.';

export interface VoicePairOpts {
  linkDist?: number;
  unlinkDist?: number;
  maxLinks?: number;
}

/** canonical key for an unordered pair of player ids */
export function linkKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Pure pairing step: given who currently qualifies (connected, not AFK, voice on — the caller filters
 * that) and the previously-linked pairs, returns the new set of links (`"minId:maxId"` keys).
 * Greedy over every eligible pair sorted by distance: nearest pairs win first, so the max-links cap
 * naturally keeps each player's *nearest* peers, and the result is inherently symmetric (a link either
 * exists for both ends or neither). Exported so it's unit-testable against plain fixtures.
 */
export function pairVoice(players: { id: number; x: number; y: number; underground: boolean }[], prev: ReadonlySet<string>, opts: VoicePairOpts = {}): Set<string> {
  const linkDist = opts.linkDist ?? VOICE_LINK_M;
  const unlinkDist = opts.unlinkDist ?? VOICE_UNLINK_M;
  const maxLinks = opts.maxLinks ?? VOICE_MAX_LINKS;
  const cands: { a: number; b: number; d: number }[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const pa = players[i], pb = players[j];
      if (pa.underground !== pb.underground) continue; // a tunnel and the surface never link
      const d = dist(pa.x, pa.y, pb.x, pb.y);
      const wasLinked = prev.has(linkKey(pa.id, pb.id));
      if (wasLinked ? d <= unlinkDist : d < linkDist) cands.push({ a: i, b: j, d });
    }
  }
  cands.sort((x, y) => x.d - y.d);
  const degree = new Map<number, number>();
  const out = new Set<string>();
  for (const c of cands) {
    const ida = players[c.a].id, idb = players[c.b].id;
    const da = degree.get(ida) ?? 0, db = degree.get(idb) ?? 0;
    if (da >= maxLinks || db >= maxLinks) continue;
    out.add(linkKey(ida, idb));
    degree.set(ida, da + 1);
    degree.set(idb, db + 1);
  }
  return out;
}

function pushMap<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

export class Voice implements RoomFeature {
  readonly id = 'voice';
  /** currently active links, "minId:maxId" */
  private links = new Set<string>();
  /** counts down to the next once-a-second pairing pass */
  private pairTimer = 0;
  private sigBuckets = new WeakMap<Session, Bucket>();
  private reportBuckets = new WeakMap<Session, Bucket>();
  private voiceBuckets = new WeakMap<Session, Bucket>();
  /** per-session cached TURN credentials (server/src/turn.ts); one Map per Room/Voice instance so
   *  tests (and separate Rooms) never share cached credentials */
  private turnCache = new Map<string, TurnCacheEntry>();
  /** a mint already in flight for a session key, so a burst of `voice{on:true}` (or an off/on flip
   *  while the first mint hasn't landed yet) never fires more than one concurrent Cloudflare request */
  private inFlight = new Map<string, Promise<IceServer[]>>();
  /** players whose voiceIce has gone out: only they get paired, so a client never builds a peer
   *  connection before it has its ICE servers (an empty list can't cross a NAT) */
  private iceSent = new Set<number>();
  private unsubConfig: () => void;

  messages: FeatureHandlers = {
    voice: (s, m) => this.onVoice(s, m),
    voiceSig: (s, m) => this.onVoiceSig(s, m),
    report: (s, m) => this.onReport(s, m),
  };

  constructor(
    private room: Room,
    private rc: RemoteConfig,
    private activity: Activity,
  ) {
    this.unsubConfig = rc.onChange((cfg) => {
      if (!cfg.voice_enabled) this.disableAll();
    });
  }

  /** every (re)connect starts with voice off: a reloaded page has no mic open and the old connection's
   *  WebRTC links are dead, so the client opts in again (VoiceFeature does, on a reconnect) */
  onHello(s: Session) {
    if (s.player.voiceOn) this.turnOff(s);
  }

  onLeave(s: Session) {
    this.turnOff(s);
  }

  onDrop(s: Session) {
    this.turnOff(s);
    this.turnCache.delete(s.key);
  }

  tick(dtMs: number) {
    this.pairTimer -= dtMs;
    if (this.pairTimer > 0) return;
    this.pairTimer = PAIR_INTERVAL_MS;
    this.repair();
  }

  shutdown() {
    this.unsubConfig();
  }

  stats() {
    return { voiceLinks: this.links.size };
  }

  // ------------------------------------------------------------------------------------- opt in/out
  private onVoice(s: Session, m: Extract<ClientMsg, { t: 'voice' }>) {
    if (!m.on) return this.turnOff(s);
    if (s.player.voiceOn) return; // already on: ICE was already sent, or its mint is already in flight
    const t = this.room.wallNow();
    const bucket = this.voiceBuckets.get(s) ?? this.voiceBuckets.set(s, new Bucket(VOICE_RATE, VOICE_BURST, t)).get(s)!;
    if (!bucket.take(t)) return;
    const reason = this.refusalReason(s);
    if (reason) {
      s.player.voiceOn = false;
      this.room.sim.events.toPlayer(s.player.id, { k: 'msg', title: '', text: reason, time: 3, color: '#ff8a80' });
      return;
    }
    s.player.voiceOn = true;
    this.mintAndSendIce(s).catch((e: Error) => console.error('voice: sending ICE servers failed:', e.message));
  }

  private refusalReason(s: Session): string | null {
    if (!this.rc.get('voice_enabled')) return MSG_DISABLED;
    if (this.rc.get('voice_requires_account') && !s.player.account) return MSG_GUEST;
    if (s.key.startsWith('acct:') && this.rc.get('voice_blocklist').includes(s.key.slice(5))) return MSG_BLOCKED;
    return null;
  }

  private turnOff(s: Session) {
    s.player.voiceOn = false;
    this.iceSent.delete(s.player.id);
    this.removeAllLinksFor(s.player.id);
  }

  /** every voice-on player turns off (the kill switch flipped off mid-game): wipe every link and clear
   *  everyone's flag in one diff, so ROSTER_VOICE and the next voicePeers/roster reflect it at once */
  private disableAll() {
    for (const p of this.room.sim.players.values()) if (p.voiceOn) p.voiceOn = false;
    this.iceSent.clear();
    this.applyDiff(new Set());
  }

  private async mintAndSendIce(s: Session) {
    let p = this.inFlight.get(s.key);
    if (!p) {
      p = mintIceServers(config.cfTurnKeyId, config.cfTurnApiToken, fetch, this.turnCache, s.key).finally(() => this.inFlight.delete(s.key));
      this.inFlight.set(s.key, p);
    }
    const ice = await p;
    if (!s.player.voiceOn) return; // turned off (or left) while the mint was in flight
    this.room.sendTo(s, { t: 'voiceIce', ice });
    this.iceSent.add(s.player.id); // pairable from the next repair() on
  }

  // ------------------------------------------------------------------------------------- signalling
  private onVoiceSig(s: Session, m: Extract<ClientMsg, { t: 'voiceSig' }>) {
    const t = this.room.wallNow();
    const bucket = this.sigBuckets.get(s) ?? this.sigBuckets.set(s, new Bucket(SIG_RATE, SIG_BURST, t)).get(s)!;
    if (!bucket.take(t)) return;
    if (typeof m.to !== 'number' || !validSignalShape(m.data)) return;
    if (!this.links.has(linkKey(s.player.id, m.to))) return; // only between currently linked pairs
    const target = this.room.sessionById(m.to);
    if (target) this.room.sendTo(target, { t: 'voiceSig', from: s.player.id, data: m.data });
  }

  // ------------------------------------------------------------------------------------------ report
  private onReport(s: Session, m: Extract<ClientMsg, { t: 'report' }>) {
    const t = this.room.wallNow();
    const bucket = this.reportBuckets.get(s) ?? this.reportBuckets.set(s, new Bucket(REPORT_PER_MIN / 60, REPORT_PER_MIN, t)).get(s)!;
    if (!bucket.take(t)) return;
    if (typeof m.target !== 'number') return;
    const target = this.room.sessionById(m.target);
    if (!target) return;
    const reason = typeof m.reason === 'string' ? m.reason.slice(0, 200) : '';
    const rp = s.player.focus(), tp = target.player.focus();
    this.activity.report(s, target, reason, { reporterX: rp.x, reporterY: rp.y, targetX: tp.x, targetY: tp.y, voiceOn: target.player.voiceOn, at: t });
    this.room.sim.events.toPlayer(s.player.id, { k: 'msg', title: '', text: MSG_REPORTED, time: 3, color: '#69f0ae' });
  }

  // ------------------------------------------------------------------------------------- pairing
  private repair() {
    const list: { id: number; x: number; y: number; underground: boolean }[] = [];
    for (const p of this.room.sim.players.values()) {
      if (!p.voiceOn || !this.iceSent.has(p.id) || !p.connected || p.afk) continue;
      const f = p.focus();
      list.push({ id: p.id, x: f.x, y: f.y, underground: p.focusLevel() === -1 });
    }
    this.applyDiff(pairVoice(list, this.links));
  }

  /** diffs `next` against the current links, tells every affected player (add with their `polite`
   *  flag, del by id), and adopts `next` as the current link set */
  private applyDiff(next: Set<string>) {
    const add = new Map<number, { id: number; polite: boolean }[]>();
    const del = new Map<number, number[]>();
    for (const key of next) if (!this.links.has(key)) this.noteAdd(add, key);
    for (const key of this.links) if (!next.has(key)) this.noteDel(del, key);
    this.links = next;
    if (!add.size && !del.size) return;
    const ids = new Set<number>([...add.keys(), ...del.keys()]);
    for (const id of ids) {
      const s = this.room.sessionById(id);
      if (s) this.room.sendTo(s, { t: 'voicePeers', add: add.get(id) ?? [], del: del.get(id) ?? [] });
    }
  }

  private noteAdd(add: Map<number, { id: number; polite: boolean }[]>, key: string) {
    const [a, b] = key.split(':').map(Number);
    pushMap(add, a, { id: b, polite: a > b });
    pushMap(add, b, { id: a, polite: b > a });
  }

  private noteDel(del: Map<number, number[]>, key: string) {
    const [a, b] = key.split(':').map(Number);
    pushMap(del, a, b);
    pushMap(del, b, a);
  }

  private removeAllLinksFor(id: number) {
    const next = new Set(this.links);
    for (const key of this.links) {
      const [a, b] = key.split(':').map(Number);
      if (a === id || b === id) next.delete(key);
    }
    this.applyDiff(next); // a no-op (no add/del) when `id` had no links: applyDiff early-returns
  }
}

/** the server never trusts a peer's WebRTC payload: reject anything that isn't roughly a VoiceSignal
 *  before relaying it (the relay is otherwise blind to its contents) */
function validSignalShape(d: unknown): d is VoiceSignal {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  if (o.sdp !== undefined) {
    if (!o.sdp || typeof o.sdp !== 'object') return false;
    const sdp = o.sdp as Record<string, unknown>;
    if (!['offer', 'answer', 'pranswer', 'rollback'].includes(sdp.type as string)) return false;
    if (sdp.sdp !== undefined && typeof sdp.sdp !== 'string') return false;
    if (typeof sdp.sdp === 'string' && sdp.sdp.length > 16_384) return false;
  }
  if (o.ice !== undefined && o.ice !== null) {
    if (typeof o.ice !== 'object') return false;
    const ice = o.ice as Record<string, unknown>;
    if (typeof ice.candidate !== 'string' || ice.candidate.length > 2048) return false;
  }
  if (o.sdp === undefined && o.ice === undefined) return false; // must carry at least one of them
  return true;
}
