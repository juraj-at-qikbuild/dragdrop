// Per-frame cosmetic effects of vehicles: tyre smoke and skid marks, exhaust puffs, offroad dust, damage
// smoke, flames, sparks from burst tyres and splashes. Runs on the client for every vehicle it draws,
// simulated or mirrored, from state the simulation/snapshots already carry.
import type { Vehicle } from '../shared/entities/Vehicle';
import type { World } from '../shared/world/World';
import { dist, rand } from '../shared/util/math';
import type { Fx } from './Fx';

export class EntityFx {
  private wasSinking = new WeakSet<Vehicle>();

  update(dt: number, vehicles: readonly Vehicle[], fx: Fx, world: World, focus: { x: number; y: number }) {
    for (const v of vehicles) {
      const s = v.spec;
      const c = Math.cos(v.angle), sn = Math.sin(v.angle);
      if (v.skid > 0.4 && Math.random() < dt * 5) fx.tireSmoke(v.x - c * s.length * 0.4, v.y - sn * s.length * 0.4);
      if (v.tyresBurst && v.speed > 2 && Math.random() < dt * 4) fx.metalSpark(v.x, v.y);
      if (v.sinking > 0 && !this.wasSinking.has(v)) {
        this.wasSinking.add(v);
        fx.splash(v.x, v.y);
      }
      if (v.skid && v.speed > 4 && !v.sinking) fx.skid(v);
      else fx.noSkid(v);
      if (!v.wrecked && v.health < s.health * 0.35 && Math.random() < dt * 8) fx.smoke(v.x + c * s.length * 0.35, v.y + sn * s.length * 0.35);
      if (!v.wrecked && v.speed > 3 && dist(v.x, v.y, focus.x, focus.y) < 45) {
        if (world.surfaceAt(v.x, v.y) === 'offroad' && Math.random() < dt * v.speed * 0.2) fx.dust(v.x - c * s.length * 0.4, v.y - sn * s.length * 0.4);
        if (v.ctrl.throttle > 0.5 && Math.random() < dt * 3) fx.exhaustPuff(v.x - c * s.length * 0.5, v.y - sn * s.length * 0.5, v.angle);
      }
      if (v.sinking > 0 && v.sinking < 2.5 && Math.random() < dt * 6) fx.splash(v.x + rand(-1, 1), v.y + rand(-1, 1));
      if (v.fire > 0 && !v.wrecked) fx.flame(v.x + c * s.length * 0.3, v.y + sn * s.length * 0.3);
    }
  }
}
