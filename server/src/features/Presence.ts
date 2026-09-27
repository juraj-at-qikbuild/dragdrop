// Away and the idle timeout on the server (docs/plans/pause-resume.md). The client says when its pause
// menu opens or closes, or its page hides (`away`); a dropped socket counts too. Whoever has been away
// too long is moved out of the city, saved, and the client offers to come back. The shield itself is a
// shared rule (src/shared/sim/rules/Presence.ts): this feature feeds it, and owns the tunables for both
// (game_config's 'presence' key, through RemoteConfig).
import type { ClientMsg } from '../../../src/shared/net/protocol';
import type { Room, Session } from '../Room';
import type { Party } from './Party';
import type { FeatureHandlers, RoomFeature } from './RoomFeature';

/** away this long (the pause menu, a hidden page) and a player is moved out of the city, saved */
export const IDLE_MS = 15 * 60_000;
/** how often the idle timeout is checked */
const CHECK_MS = 1000;

/** game_config's 'presence' key (and E2E's `debug.presence`): an absent or out-of-range field keeps
 *  the current value */
export interface PresenceTuning {
  /** the shield at all */
  shield?: boolean;
  /** seconds away before the shield arms */
  arm_s?: number;
  /** seconds after PvP damage with no shield, and before leaving is instant */
  pvp_s?: number;
  /** seconds a dropped player's figure stays in the city */
  grace_s?: number;
  /** seconds the figure stays after leaving while wanted or in a fight */
  leave_s?: number;
  /** minutes away before the idle timeout */
  idle_min?: number;
  /** minutes a party holds a seat for someone who left */
  seat_min?: number;
  /** minutes a returning player's car is theirs alone */
  car_min?: number;
}

export class Presence implements RoomFeature {
  readonly id = 'presence';
  idleMs = IDLE_MS;
  private checkIn = CHECK_MS;

  constructor(private room: Room) {}

  readonly messages: FeatureHandlers = {
    away: (s, m) => this.room.presence?.setAway(s.player, m.on === true),
  };

  onHello(s: Session) {
    // a new connection starts out playing; a client still in its pause menu says so again at once
    this.room.presence?.setAway(s.player, false);
  }

  onLeave(s: Session) {
    this.room.presence?.setAway(s.player, true);
  }

  onDebug(_s: Session, m: Extract<ClientMsg, { t: 'debug' }>) {
    if (m.presence && typeof m.presence === 'object') this.apply(m.presence as PresenceTuning);
  }

  tick(dtMs: number) {
    this.checkIn -= dtMs;
    if (this.checkIn > 0) return;
    this.checkIn = CHECK_MS;
    const now = this.room.sim.time;
    for (const s of [...this.room.sessions.values()]) {
      const p = s.player;
      // only a client that knows what `bye: 'idle'` means: an older one would just reconnect
      if (s.conn && s.presence && p.away && (now - p.awaySince) * 1000 >= this.idleMs) this.room.dropIdle(s);
    }
  }

  /** copy the validated tunables over, field by field */
  apply(t: PresenceTuning) {
    const rule = this.room.presence;
    const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
    if (rule && typeof t.shield === 'boolean') rule.config.enabled = t.shield;
    const arm = num(t.arm_s, 0, 60);
    if (rule && arm !== undefined) rule.config.armS = arm;
    const pvp = num(t.pvp_s, 0, 600);
    if (rule && pvp !== undefined) rule.config.pvpS = pvp;
    const grace = num(t.grace_s, 5, 3600);
    if (grace !== undefined) this.room.graceMs = grace * 1000;
    const leave = num(t.leave_s, 0, 120);
    if (leave !== undefined) this.room.leaveUnsafeMs = leave * 1000;
    const idle = num(t.idle_min, 0.05, 24 * 60);
    if (idle !== undefined) this.idleMs = idle * 60_000;
    const seat = num(t.seat_min, 0, 24 * 60);
    const party = this.room.feature<Party>('party');
    if (party && seat !== undefined) party.seatMs = seat * 60_000;
    const car = num(t.car_min, 0, 24 * 60);
    if (car !== undefined) this.room.carHoldS = car * 60;
  }

  stats() {
    let away = 0, shielded = 0;
    for (const s of this.room.sessions.values()) {
      if (s.player.away) away++;
      if (s.player.shielded) shielded++;
    }
    return { away, shielded };
  }
}
