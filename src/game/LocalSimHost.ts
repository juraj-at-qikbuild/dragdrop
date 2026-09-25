// Offline play: the whole simulation runs in the page, with the local player as its only player.
import type { World } from '../shared/world/World';
import type { Vehicle } from '../shared/entities/Vehicle';
import type { Clock } from '../shared/sim/Clock';
import type { ShotReport } from '../shared/sim/Combat';
import type { SimEvents } from '../shared/sim/events';
import type { Observer, Profile, SimPlayer } from '../shared/sim/SimPlayer';
import { Sim } from '../shared/sim/Sim';
import { dist } from '../shared/util/math';
import type { SimHost } from './SimHost';

export class LocalSimHost implements SimHost {
  readonly mode = 'local';
  readonly sim: Sim;
  readonly me: SimPlayer;
  readonly net = null;
  readonly allowsPause = true;
  readonly allowsTimeScale = true;
  readonly missionsEnabled = true;

  constructor(world: World, events: SimEvents, profile: Profile, clock: Clock, private save: () => void) {
    this.sim = new Sim(world, { events, clock, driveClock: false });
    this.me = this.sim.addPlayer({ nick: 'Ty', profile, kinematic: false });
    this.sim.onProfileChange = () => this.save();
  }

  get vehicles() {
    return this.sim.vehicles;
  }
  get peds() {
    return this.sim.peds;
  }
  get trams() {
    return this.sim.trams;
  }
  get props() {
    return this.sim.props;
  }
  get helis() {
    return this.sim.police.helis();
  }
  get pickups() {
    const found = this.me.profile.cumils;
    return this.sim.pickups.filter((p) => p.hidden === 0 && !(p.cumil >= 0 && found.includes(p.cumil)));
  }

  vehicleById(id: number) {
    return this.sim.vehicleById(id);
  }
  pedById(id: number) {
    return this.sim.pedById(id);
  }

  setObserver(o: Observer) {
    Object.assign(this.me.observer, o);
  }

  update(dt: number) {
    this.sim.step(dt);
  }

  fire(shot: ShotReport) {
    this.sim.applyShot(this.me, shot);
  }

  punch(targetId: number) {
    this.sim.applyMelee(this.me, targetId);
  }

  requestEnter(v: Vehicle) {
    this.sim.enterVehicle(this.me, v);
  }

  requestExit() {
    this.sim.exitVehicle(this.me);
  }

  /** honking scares pedestrians out of the way */
  horn() {
    const v = this.me.ped.vehicle;
    if (!v) return;
    for (const q of this.sim.pedsNear(v.x, v.y, 12)) if (q.kind === 'civ' && !q.vehicle && dist(q.x, q.y, v.x, v.y) < 12) this.sim.combat.scare(q, v.x, v.y);
  }

  styleCash(n: number) {
    this.sim.addMoney(this.me, n);
  }

  onPrivate() {}

  persist() {
    this.save();
  }

  dispose() {}
}
