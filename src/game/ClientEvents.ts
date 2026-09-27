// Turns simulation events into what the local player sees and hears: particles, sounds, camera shake,
// HUD flashes and messages. Offline the Sim calls this directly; online NetSimHost replays the server's
// events here once the entities they refer to have been interpolated to the same moment.
import type { Game } from './Game';
import type { GlobalEvent, DazeCause, PrivateEvent, ShotFx, SimEvents } from '../shared/sim/events';
import { WEAPONS, type Mess } from '../shared/sim/Combat';
import type { WeaponId } from '../shared/entities/Ped';
import { LANDMARK_INFO, RADIO } from '../data/brands';
import { clamp, dist, formatMoney } from '../shared/util/math';

/** sounds from further away than this are skipped (online, the world is big) */
const HEAR_R = 90;
/** how long someone looks wet, soapy or covered in confetti after a hit (s) */
const MESS_S = 25;
/** what a fan says after a high five (client only: docs/plans/non-violent.md) */
const CHEERS = ['Plácni si!', 'Jééé!', 'To bolo super!', 'Ešte raz!', 'High five!', 'Poďme, Slovensko!'];

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
    // (the helicopter, the one shooter with no ped, tips its water bucket: docs/plans/non-violent.md)
    const heli = e.by === 0;
    this.g.fx.shot(e.x, e.y, e.a, e.ends, e.sparks, e.w, heli);
    this.g.pigeons.scare(e.x, e.y, 18);
    const d = this.distTo(e.x, e.y);
    if (d < 130) heli ? this.g.audio.splash(d) : this.g.audio.shot(e.w, d);
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

  /** someone got wet, soapy, covered in confetti, tickled or bonked: what flies off them, and how
   *  they look for a while after (drawPed) */
  pedHit(id: number, x: number, y: number, size: number, mess: Mess = 'water') {
    this.g.fx.soak(x, y, size, mess);
    const p = this.g.host.pedById(id);
    if (p) {
      p.hitFlash = 0.14;
      if (mess !== 'tickle' && mess !== 'bonk') (p.mess = mess), (p.messT = MESS_S);
      // the knock-down's own hit (size 1, Sim.knockDown): what it was drives how they go down
      // (a bubble floating them off, a car's bump) on a mirror too, which the sim's field isn't sent to
      if (size >= 1) p.downMess = mess;
    }
  }

  spark(x: number, y: number, kind: 0 | 1 | 2) {
    if (kind === 0) this.g.fx.spark(x, y);
    else if (kind === 1) this.g.fx.metalSpark(x, y);
    else this.g.fx.glass(x, y);
  }

  explode(x: number, y: number, vehicleId: number, color: string | null) {
    const g = this.g;
    const d = this.distTo(x, y);
    if (d < 45) g.rumble(1 - d / 45, (1 - d / 45) * 0.8, 380);
    g.audio.explosion(d);
    g.juice.explosionNearPlayer(x, y);
    g.fx.explosion(x, y, color, vehicleId ? g.host.vehicleById(vehicleId) : null);
    g.pigeons.scare(x, y, 40);
  }

  crash(vehicleId: number, x: number, y: number, sev: number, nx: number, ny: number, kick: number) {
    const g = this.g;
    const v = g.host.vehicleById(vehicleId);
    const mine = !!v && v === g.player.vehicle;
    if (mine || this.distTo(x, y) < 40) g.audio.crash(sev);
    if (mine) g.rumble(Math.min(1, sev / 22), Math.min(1, sev / 14), 110 + Math.min(300, sev * 12));
    if (kick > 0 && v) g.juice.crashImpact(v, kick, nx, ny, mine);
  }

  /** someone knocked down (docs/plans/non-violent.md): a car's or a tram's bump goes BOING, a toy's
   *  last squirt a squeal, a tickle a giggle (a car giving up has its own PUF) */
  pedDazed(_id: number, x: number, y: number, _byPid: number, cause: DazeCause) {
    const d = this.distTo(x, y);
    if (d > HEAR_R) return;
    if (cause === 'road' || cause === 'tram') this.g.audio.boing(d);
    else if (cause === 'melee') this.g.audio.punch();
    else if (cause === 'shot') this.g.audio.scream();
  }

  scream(x: number, y: number) {
    if (this.distTo(x, y) < HEAR_R) this.g.audio.scream();
  }

  bell(x: number, y: number) {
    if (this.distTo(x, y) < 60) this.g.audio.bell();
  }

  horn(vehicleId: number, x: number, y: number) {
    this.g.pigeons.scare(x, y, 14);
    const v = this.g.host.vehicleById(vehicleId);
    if (v && v === this.g.player.vehicle) return; // played on the key press
    // a scooter's or a bike's is a bell
    if (this.distTo(x, y) < 60) v?.spec.twoWheeler ? this.g.audio.ring() : this.g.audio.horn();
  }

  /** thrown off our scooter or bike (docs/plans/gameplay.md, Phase 3): offline the Sim says so (an
   *  `eject` with `fall`), online our own simulation of the ride decides (NetSimHost) */
  fell() {
    const g = this.g;
    g.audio.thud(0.8);
    g.rumble(0.6, 0.9, 260);
    g.message('', 'Spadol si!', 2, '#ff8a80');
  }

  say(pedId: number, x: number, y: number, line: number) {
    if (this.distTo(x, y) < 50) this.g.bubbles.add(pedId, x, y, line);
  }

  /** a player's car splashed someone from a puddle (docs/plans/non-violent.md: ŠPLECH!) */
  splash(pedId: number, x: number, y: number, a: number, s: number) {
    const d = this.distTo(x, y);
    if (d > 70) return;
    this.g.fx.wave(x, y, a, s);
    this.g.audio.splash(d);
    this.g.pigeons.scare(x, y, 12);
    const p = this.g.host.pedById(pedId);
    if (p) (p.mess = 'water'), (p.messT = MESS_S), (p.hitFlash = 0.14);
  }

  /** a fan high-fived a player's car going past (PLÁCNI SI!): a clap, stars, and they cheer */
  highFive(pedId: number, x: number, y: number) {
    const d = this.distTo(x, y);
    if (d > 70) return;
    this.g.fx.stars(x, y, 5);
    this.g.fx.pop(x, y);
    if (d < 50) this.g.audio.clap();
    const p = this.g.host.pedById(pedId);
    if (p) {
      p.cheerT = 1.2;
      this.g.bubbles.addText(pedId, p.x, p.y, CHEERS[(p.seed + Math.floor(this.g.time)) % CHEERS.length]);
    }
  }

  /** city-wide news: the features (radio, HUD, map) take it from here */
  global(e: GlobalEvent) {
    for (const f of this.g.features) f.onGlobal?.(e);
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
        g.rumble(Math.min(1, 0.25 + e.dmg / 50), 0.3, 150);
        g.hud.hurt = 0.5;
        g.hud.hitFrom(Math.atan2(e.fy - p.y, e.fx - p.x));
        // a splash of water on the lens (docs/plans/non-violent.md: getting hit is getting wet)
        g.postFx?.pulse({ aberration: clamp(e.dmg / 55, 0, 1), flash: [0.25, 0.6, 1, clamp(e.dmg / 60, 0, 0.5)] });
        break;
      }
      case 'stars':
        g.hud.flashStars = 1.5;
        break;
      case 'jingle':
        g.audio.jingle(e.good);
        break;
      case 'style':
        g.juice.event(e.label, e.cash, e.x, e.y, e.mult);
        // the combo tops up the driver's nitro (online the client simulates the car)
        if (e.nitro) g.player.vehicle?.addNitro(e.nitro);
        break;
      case 'cash':
        g.juice.cashText(e.x, e.y, e.amount);
        break;
      case 'pickup':
        if (e.kind === 'cash') g.audio.cash();
        else {
          g.audio.pickup();
          if (e.kind === 'health') g.message('', 'Uterák – zase si suchý', 1.5, '#69f0ae');
          else if (e.kind === 'armor') g.message('', 'Pršiplášť', 1.5, '#ffd600');
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
        g.rumble(1, 1, 650);
        // missions are offline only, where nobody is ever just downed. An arrest fails one only at
        // the station (the respawn below): until then it can still be bought off (Úplatok)
        if (e.state === 'wasted') g.missions.onPlayerDown('wasted');
        g.audio.jingle(false);
        break;
      case 'respawn':
        if (e.busted) g.missions.onPlayerDown('busted');
        // (soaked through: dried off at the hospital, with a blanket and a cup of tea)
        g.message(e.busted ? 'Policajná stanica' : 'Nemocnica', e.busted ? `${e.poi}  −${formatMoney(e.fee)}` : `${e.poi}: vysušili ťa a dali ti čaj  −${formatMoney(e.fee)}`, 4, '#ffffff');
        g.cam.x = e.x;
        g.cam.y = e.y;
        g.audio.setStation(null);
        g.audio.engine(0, 0, false);
        break;
      case 'enter': {
        const v = g.host.vehicleById(e.vehicle);
        if (!e.ok || !v) break;
        // (no radio on a scooter or a bike)
        if (v.spec.twoWheeler) break;
        g.audio.setStation(v.kind === 'police' || g.radio >= RADIO.length ? null : RADIO[g.radio]);
        g.showRadio();
        break;
      }
      // trams (docs/plans/gameplay.md, Phase 3): on one, or in its cab
      case 'tram':
        if (e.id && e.cab) g.message('Ukradol si električku!', 'W plyn · S brzda · A/D výhybka · H zvonček', 4, '#ffd740');
        else if (e.id) g.message('', 'Cestuješ električkou. Vystúpiš, keď zastaví (F).', 3, '#e0e0e0');
        break;
      case 'eject':
        g.audio.setStation(null);
        g.audio.engine(0, 0, false);
        if (e.fall) this.fell();
        else g.message('', g.host.vehicleById(e.vehicle)?.spec.twoWheeler ? 'Zhodili ťa!' : 'Vyhodili ťa z auta!', 2, '#ff8a80');
        break;
      case 'spray':
        g.audio.cash();
        break;
      case 'tyres':
        g.audio.snap();
        break;
      // the shops (docs/plans/gameplay.md, Phase 2): a purchase rings the till; a car parked in the
      // garage takes its engine and radio with it
      case 'payout':
        if (e.reason === 'style') g.juice.comboPaid(e.amount);
        break;
      case 'shop':
        if (e.ok) g.audio.cash();
        break;
      case 'stored':
        g.audio.setStation(null);
        g.audio.engine(0, 0, false);
        break;
    }
    for (const f of g.features) f.onPrivate?.(e);
  }
}
