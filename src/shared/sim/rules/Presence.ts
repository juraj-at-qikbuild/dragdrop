// Away and the shield (docs/plans/pause-resume.md). A player in the pause menu, with the page hidden,
// or disconnected but still in the city is `away`: the city doesn't stop for them, but once they've
// been away a moment and aren't in trouble, nothing can hurt, arrest or carjack them. Server only
// (rules/index.ts): offline the pause menu freezes the whole world instead.
//
// The server's Presence feature (server/src/features/Presence.ts) says who is away; this rule decides
// who is `shielded`, and the Sim's own guards read that (hurtPlayer, damageVehicle, bust,
// enterVehicle, Crowd.provoke).
import type { Sim } from '../Sim';
import type { SimPlayer } from '../SimPlayer';
import type { SimRule } from './SimRule';

/** seconds away before the shield arms: a quick look at the menu mid-fight isn't cover */
export const SHIELD_ARM_S = 3;
/** no shield within this long of hurting, or being hurt by, another player */
export const PVP_COOLDOWN_S = 15;

/** wanted, or in a fight with another player lately: no shield, and leaving takes a while (Room) */
export function inTrouble(sim: Sim, p: SimPlayer, pvpS = PVP_COOLDOWN_S): boolean {
  return p.stars > 0 || sim.time - p.lastPvpAt < pvpS;
}

export class Presence implements SimRule {
  readonly id = 'presence';
  /** tunables (the server's RemoteConfig can override them) */
  config = { enabled: true, armS: SHIELD_ARM_S, pvpS: PVP_COOLDOWN_S };

  constructor(private sim: Sim) {}

  /** the pause menu opened or closed, the page hid, the connection dropped or came back */
  setAway(p: SimPlayer, on: boolean) {
    if (on === p.away) return;
    p.away = on;
    if (on) p.awaySince = this.sim.time;
    else this.shield(p, false); // back in control: no cover left over
  }

  /** could `p` be shielded right now, the arming delay aside? */
  safe(p: SimPlayer): boolean {
    if (p.state !== 'play' || p.drown > 0 || inTrouble(this.sim, p, this.config.pvpS)) return false;
    // a burning or sinking car kills its driver without going through hurtPlayer (Sim.wreck)
    const v = p.ped.vehicle;
    if (v && (v.fire > -1 || v.sinking > 0 || v.wrecked)) return false;
    return this.sim.rules.every((r) => r === this || r.allowShield?.(p) !== false);
  }

  step() {
    const sim = this.sim;
    for (const p of sim.players.values()) this.shield(p, this.config.enabled && p.away && sim.time - p.awaySince >= this.config.armS && this.safe(p));
  }

  private shield(p: SimPlayer, on: boolean) {
    if (p.shielded === on) return;
    p.shielded = on;
    this.sim.events.toPlayer(p.id, { k: 'shield', on });
  }
}
