// Závod?: pull up next to another player and hold the horn to challenge them (a worldRing fills over
// their car), the incoming-challenge panel (hold H to accept), the running race's 3-2-1-ŠTART
// countdown, throttle lock, GPS waypoint, timer/distance HUD, win/loss banners, and the map markers
// (the finish, the opponent highlighted). The mechanics are the shared Race rule
// (src/shared/sim/rules/Race.ts); this feature only shows what the server decides.
// Plan: docs/plans/social-events.md ("Závod?")
import type { Game } from '../Game';
import type { ClientFeature, ToScreen } from './ClientFeature';
import type { View } from '../../world/Renderer';
import type { GlobalEvent } from '../../shared/sim/events';
import type { ChallengeState, RaceState } from '../../shared/sim/rules/types';
import { dist, formatMoney } from '../../shared/util/math';
import { CHALLENGE_RANGE } from '../../shared/sim/rules/Race';
import { worldRing, drawHoldRing } from '../../ui/kit/HoldRing';
import { outlined } from '../../ui/Hud';
import { bandBottom } from '../../ui/kit/Banners';
import { roundRect } from '../../render/shapes';
import { mapMarker, pulsingCircle } from '../../ui/MapView';
import { KEYS } from '../Input';

const HEAD = `'Rajdhani', 'Arial Black', Impact, sans-serif`;
const BODY = `'Inter', system-ui, sans-serif`;

/** seconds of continuous horn hold to send a challenge */
const HOLD_TIME = 1.2;
/** seconds to wait locally before another challenge can be sent */
const SEND_COOLDOWN = 5;
/** driving faster than this (m/s), holding the horn is just honking, not challenging */
const MAX_SPEED = 3;
/** seconds of continuous horn hold to accept an incoming challenge */
const ACCEPT_TIME = 1;

export class RaceUi implements ClientFeature {
  readonly id = 'race';
  /** owner id of the car currently being held up for a challenge, and how long (world ring) */
  private holdTarget = 0;
  private holdT = 0;
  private cooldownUntil = 0;
  /** accepting an incoming challenge: whose, and how long held */
  private acceptFrom = 0;
  private acceptT = 0;
  /** the race id a GPS waypoint was last set for, so it's only (re)planned once per race */
  private waypointFor = 0;
  private prevStartsIn = 0;
  /** seconds left showing "ŠTART!" right as the countdown ends */
  private startFlashT = 0;

  constructor(private g: Game) {}

  update(dt: number) {
    const g = this.g;
    const race = g.host.live.race;
    g.lockThrottle = !!race && race.startsIn > 0;
    if (race) {
      if (race.id !== this.waypointFor) {
        this.waypointFor = race.id;
        g.gps.setWaypoint(race.x, race.y);
        this.prevStartsIn = race.startsIn;
      }
      if (this.prevStartsIn > 0 && race.startsIn <= 0) this.startFlashT = 1.1;
      this.prevStartsIn = race.startsIn;
    } else if (this.waypointFor) {
      this.waypointFor = 0;
      g.gps.clearWaypoint();
    }
    if (this.startFlashT > 0) this.startFlashT -= dt;
    if (g.paused || g.showMap) return;
    const challenge = g.host.live.challenge;
    if (challenge) return this.updateAccept(dt, challenge.from);
    this.acceptFrom = 0;
    this.acceptT = 0;
    if (!race) this.updateChallenging(dt);
  }

  /** holding H for ACCEPT_TIME sends challengeAnswer(from, true); letting go resets the hold */
  private updateAccept(dt: number, from: number) {
    const g = this.g;
    if (from !== this.acceptFrom) (this.acceptFrom = from), (this.acceptT = 0);
    if (this.acceptT < 0) return; // already sent for this challenge: wait for the server to clear it
    if (g.input.down(KEYS.horn)) {
      this.acceptT += dt;
      if (this.acceptT >= ACCEPT_TIME) {
        g.host.challengeAnswer(from, true);
        this.acceptT = -1;
      }
    } else this.acceptT = 0;
  }

  /** while driving slower than MAX_SPEED, holding H next to another player's car fills a ring over
   *  it; after HOLD_TIME, send one challenge and wait SEND_COOLDOWN before allowing another. */
  private updateChallenging(dt: number) {
    const g = this.g;
    const v = g.player.vehicle;
    const holding = !!v && v.speed < MAX_SPEED && g.input.down(KEYS.horn) && performance.now() >= this.cooldownUntil;
    const target = holding ? this.nearestTarget() : 0;
    if (target && target === this.holdTarget) this.holdT += dt;
    else (this.holdTarget = target), (this.holdT = target ? dt : 0);
    if (this.holdTarget && this.holdT >= HOLD_TIME) {
      g.host.challenge(this.holdTarget);
      this.cooldownUntil = performance.now() + SEND_COOLDOWN * 1000;
      this.holdTarget = 0;
      this.holdT = 0;
    }
  }

  /** the nearest other player's car within range (a mirror vehicle whose `owner` is a player id) */
  private nearestTarget(): number {
    const g = this.g;
    const f = g.focus();
    let best = 0, bd = CHALLENGE_RANGE;
    for (const v of g.host.vehicles) {
      if (!v.owner || v.owner === g.host.me.id) continue;
      const d = dist(v.x, v.y, f.x, f.y);
      if (d <= bd) (bd = d), (best = v.owner);
    }
    return best;
  }

  drawWorld(ctx: CanvasRenderingContext2D, v: View) {
    if (!this.holdTarget || this.holdT <= 0) return;
    const car = this.g.host.vehicles.find((c) => c.owner === this.holdTarget);
    if (!car) return;
    worldRing(ctx, car.x, car.y - 1.6, 1.4, this.holdT / HOLD_TIME, '#ffd740', v.scale);
  }

  drawHud(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    const W = g.viewW, H = g.viewH;
    const small = W < 700;
    const challenge = g.host.live.challenge;
    if (challenge) this.drawChallengePanel(ctx, challenge, W, small);
    const race = g.host.live.race;
    if (race) this.drawRaceHud(ctx, race, W, H, small);
  }

  private drawChallengePanel(ctx: CanvasRenderingContext2D, c: ChallengeState, W: number, small: boolean) {
    const w = Math.min(W - 32, small ? 300 : 380);
    const h = small ? 92 : 108;
    // below both the top-right HUD panel and the Banners slot (src/ui/kit/Banners.ts), so this
    // never overlaps either
    const x = W / 2 - w / 2, y = bandBottom(small);
    ctx.save();
    ctx.fillStyle = 'rgba(10,12,18,0.84)';
    roundRect(ctx, x, y, w, h, 14);
    ctx.fill();
    ctx.strokeStyle = '#ffd740';
    ctx.lineWidth = 2;
    roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 13);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const stakeText = c.stake > 0 ? formatMoney(c.stake) : 'zadarmo – mestská odmena';
    ctx.font = `700 ${small ? 14 : 17}px ${HEAD}`;
    outlined(ctx, `ZÁVOD? ${c.nick} ťa vyzýva`, W / 2, y + 8, '#ffd740', 3);
    outlined(ctx, `do cieľa ${c.dest} o ${stakeText}`, W / 2, y + 8 + (small ? 18 : 21), '#ffd740', 3);
    ctx.font = `600 ${small ? 11 : 13}px ${BODY}`;
    outlined(ctx, `Podrž [H] = prijať · ${Math.max(0, Math.ceil(c.left))} s`, W / 2, y + (small ? 48 : 56), '#e8eaed', 2.5);
    const frac = this.acceptFrom === c.from ? Math.max(0, this.acceptT) / ACCEPT_TIME : 0;
    drawHoldRing(ctx, W / 2, y + h - (small ? 16 : 19), small ? 12 : 15, frac, '#69f0ae');
    ctx.restore();
  }

  private drawRaceHud(ctx: CanvasRenderingContext2D, r: RaceState, W: number, H: number, small: boolean) {
    const g = this.g;
    if (r.startsIn > 0 || this.startFlashT > 0) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${small ? 70 : 108}px ${HEAD}`;
      const label = r.startsIn > 0 ? String(Math.ceil(r.startsIn)) : 'ŠTART!';
      outlined(ctx, label, W / 2, H * 0.38, r.startsIn > 0 ? '#ffd740' : '#69f0ae', 6);
      ctx.restore();
      return; // no timer/distance chatter while the light is still red
    }
    const f = g.focus();
    const myD = Math.round(dist(f.x, f.y, r.x, r.y));
    const oppRow = g.online?.roster.find((row) => row[0] === r.opponent);
    const oppD = oppRow ? Math.round(dist(oppRow[2], oppRow[3], r.x, r.y)) : null;
    const w = Math.min(W - 32, small ? 280 : 360);
    const h = small ? 46 : 56;
    // below both the top-right HUD panel and the Banners slot (src/ui/kit/Banners.ts), so this
    // never overlaps either
    const x = W / 2 - w / 2, y = bandBottom(small);
    ctx.save();
    ctx.fillStyle = 'rgba(10,12,18,0.7)';
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const mm = Math.floor(r.left / 60), ss = Math.floor(r.left % 60);
    ctx.font = `700 ${small ? 11 : 13}px ${BODY}`;
    outlined(ctx, `ZÁVOD · cieľ ${r.dest} · ${mm}:${String(ss).padStart(2, '0')}`, W / 2, y + h * 0.32, '#ffd740', 3);
    const oppText = oppD !== null ? `${r.opponentNick} ${oppD} m` : r.opponentNick;
    outlined(ctx, `Ty ${myD} m   ·   ${oppText}`, W / 2, y + h * 0.72, '#e8eaed', 2.5);
    ctx.restore();
  }

  drawMap(ctx: CanvasRenderingContext2D, toScreen: ToScreen, full: boolean, size: number) {
    const g = this.g;
    const race = g.host.live.race;
    if (!race) return;
    const [fx, fy] = toScreen(race.x, race.y);
    mapMarker(ctx, fx, fy, size * 1.2, 'race', { label: race.dest, full });
    const oppRow = g.online?.roster.find((r) => r[0] === race.opponent);
    if (oppRow) {
      const [ox, oy] = toScreen(oppRow[2], oppRow[3]);
      pulsingCircle(ctx, ox, oy, size * 1.9, '#29b6f6', g.time, false);
    }
  }

  onGlobal(e: GlobalEvent) {
    if (e.k !== 'raceResult') return;
    const nick = this.g.online?.nick;
    if (!nick) return;
    if (e.winner === nick) this.g.banners.push({ title: 'VYHRAL SI ZÁVOD!', text: `${formatMoney(e.amount)} · cieľ ${e.dest}`, icon: 'race', color: '#69f0ae', priority: 2 });
    else if (e.loser === nick) this.g.banners.push({ title: 'PREHRAL SI ZÁVOD', text: `${e.winner} dorazil prvý do cieľa ${e.dest}`, icon: 'race', color: '#ff5252', priority: 2 });
  }

  reset() {
    this.g.lockThrottle = false;
    this.holdTarget = 0;
    this.holdT = 0;
    this.acceptFrom = 0;
    this.acceptT = 0;
    this.waypointFor = 0;
  }
}
