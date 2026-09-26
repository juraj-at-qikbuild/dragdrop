// Turns simulation events into what the local player sees and hears: particles, sounds, camera shake,
// HUD flashes and messages. Offline the Sim calls this directly; online NetSimHost replays the server's
// events here once the entities they refer to have been interpolated to the same moment.
import type { Game } from './Game';
import type { KillCause, PrivateEvent, ShotFx, SimEvents } from '../shared/sim/events';
import { WEAPONS } from '../shared/sim/Combat';
import type { WeaponId } from '../shared/entities/Ped';
import { LANDMARK_INFO, RADIO } from '../data/brands';
import { clamp, dist, formatMoney } from '../shared/util/math';

/** sounds from further away than this are skipped (online, the world is big) */
const HEAR_R = 90;

export class ClientEvents implements SimEvents {
  /** online: the local player's own shots were already shown when fired */
  skipOwnShots = false;

  constructor(private g: Game) {}

  private get meId() {
    return this.g.host.me.id;
  }

  private distTo(x: number, y: number) {
    const f = this.g.focus();
    return dist(x, y, f.x, f.y);
  }

  shot(e: ShotFx) {
    if (this.skipOwnShots && e.pid === this.meId) return;
    this.g.fx.shot(e.x, e.y, e.a, e.ends, e.sparks);
    const d = this.distTo(e.x, e.y);
    if (d < 130) this.g.audio.shot(e.w, d);
    // a mirrored shooter turns to face where they fired
    const shooter = e.by ? this.g.host.pedById(e.by) : null;
    if (shooter && shooter.kinematic) {
      shooter.angle = e.a;
      shooter.weapon = e.w;
    }
  }

  melee(x: number, y: number, hit: boolean) {
    if (this.distTo(x, y) > 40) return;
    if (hit) this.g.audio.punch();
    else this.g.audio.whoosh();
  }

  pedHit(id: number, x: number, y: number, size: number) {
    this.g.fx.blood(x, y, size);
    const p = this.g.host.pedById(id);
    if (p) p.hitFlash = 0.14;
  }

  spark(x: number, y: number, kind: 0 | 1 | 2) {
    if (kind === 0) this.g.fx.spark(x, y);
    else if (kind === 1) this.g.fx.metalSpark(x, y);
    else this.g.fx.glass(x, y);
  }

  explode(x: number, y: number, vehicleId: number, color: string | null) {
    const g = this.g;
    g.audio.explosion(this.distTo(x, y));
    g.juice.explosionNearPlayer(x, y);
    g.fx.explosion(x, y, color, vehicleId ? g.host.vehicleById(vehicleId) : null);
  }

  crash(vehicleId: number, x: number, y: number, sev: number, nx: number, ny: number, kick: number) {
    const g = this.g;
    const v = g.host.vehicleById(vehicleId);
    const mine = !!v && v === g.player.vehicle;
    if (mine || this.distTo(x, y) < 40) g.audio.crash(sev);
    if (kick > 0 && v) g.juice.crashImpact(v, kick, nx, ny, mine);
  }

  pedKilled(_id: number, x: number, y: number, _byPid: number, cause: KillCause) {
    if (this.distTo(x, y) > HEAR_R) return;
    if (cause === 'road') this.g.audio.punch();
    else if (cause === 'shot' || cause === 'melee') this.g.audio.scream();
  }

  scream(x: number, y: number) {
    if (this.distTo(x, y) < HEAR_R) this.g.audio.scream();
  }

  bell(x: number, y: number) {
    if (this.distTo(x, y) < 60) this.g.audio.bell();
  }

  horn(vehicleId: number, x: number, y: number) {
    const v = this.g.host.vehicleById(vehicleId);
    if (v && v === this.g.player.vehicle) return; // played on the key press
    if (this.distTo(x, y) < 60) this.g.audio.horn();
  }

  say(pedId: number, x: number, y: number, line: number) {
    if (this.distTo(x, y) < 50) this.g.bubbles.add(pedId, x, y, line);
  }

  toPlayer(pid: number, e: PrivateEvent) {
    if (pid !== this.meId) return;
    const g = this.g;
    g.host.onPrivate(e);
    switch (e.k) {
      case 'msg':
        g.message(e.title, e.text, e.time, e.color);
        break;
      case 'hurt': {
        const p = g.player;
        g.hud.hurt = 0.5;
        g.hud.hitFrom(Math.atan2(e.fy - p.y, e.fx - p.x));
        g.postFx?.pulse({ aberration: clamp(e.dmg / 55, 0, 1), flash: [0.9, 0.05, 0.05, clamp(e.dmg / 60, 0, 0.5)] });
        break;
      }
      case 'stars':
        g.hud.flashStars = 1.5;
        break;
      case 'jingle':
        g.audio.jingle(e.good);
        break;
      case 'style':
        g.juice.event(e.label, e.cash, e.x, e.y);
        break;
      case 'cash':
        g.juice.cashText(e.x, e.y, e.amount);
        break;
      case 'pickup':
        if (e.kind === 'cash') g.audio.cash();
        else {
          g.audio.pickup();
          if (e.kind === 'health') g.message('', 'Zdravie doplnené', 1.5, '#69f0ae');
          else if (e.kind === 'armor') g.message('', 'Nepriestrelná vesta', 1.5, '#90caf9');
          else if (e.kind in WEAPONS) g.message('', `${WEAPONS[e.kind as WeaponId].name} +${e.amount}`, 1.5, '#ffffff');
        }
        break;
      case 'found': {
        const l = g.world.landmarks.get(e.id);
        g.message(`Objavené: ${l?.name ?? e.id}`, `${LANDMARK_INFO[e.id] ?? ''}  +${formatMoney(e.reward)}`, 4, '#80d8ff');
        break;
      }
      case 'cumil':
        g.audio.jingle(true);
        g.message('ČUMIL NÁJDENÝ!', `${e.count}/10  +${formatMoney(e.reward)}`, 3.5, '#ffd740');
        break;
      case 'down':
        g.missions.onPlayerDown(e.state);
        g.audio.jingle(false);
        break;
      case 'respawn':
        g.message(e.busted ? 'Policajná stanica' : 'Nemocnica', `${e.poi}  −${formatMoney(e.fee)}`, 4, '#ffffff');
        g.cam.x = e.x;
        g.cam.y = e.y;
        g.audio.setStation(null);
        g.audio.engine(0, 0, false);
        break;
      case 'enter': {
        const v = g.host.vehicleById(e.vehicle);
        if (!e.ok || !v) break;
        g.audio.setStation(v.kind === 'police' || g.radio >= RADIO.length ? null : RADIO[g.radio]);
        g.showRadio();
        break;
      }
      case 'eject':
        g.audio.setStation(null);
        g.audio.engine(0, 0, false);
        g.message('', 'Vyhodili ťa z auta!', 2, '#ff8a80');
        break;
      case 'spray':
        g.audio.cash();
        break;
    }
  }
}
