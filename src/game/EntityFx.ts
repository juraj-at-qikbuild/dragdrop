// Per-frame cosmetic effects of vehicles: tyre smoke and skid marks, exhaust puffs, offroad dust, damage
// smoke, steam, sparks from burst tyres and splashes. Runs on the client for every vehicle it draws,
// simulated or mirrored, from state the simulation/snapshots already carry.
import type { Vehicle } from '../shared/entities/Vehicle';
import type { World } from '../shared/world/World';
import { dist, rand } from '../shared/util/math';
import type { Fx } from './Fx';

export class EntityFx {
  private wasSinking = new WeakSet<Vehicle>();

  update(dt: number, vehicles: readonly Vehicle[], fx: Fx, world: World, focus: { x: number; y: number }, wet = 0) {
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
      // (a scooter or a bike has no engine to smoke or exhaust to puff)
      if (!v.wrecked && !s.twoWheeler && v.health < (v.maxHealth || s.health) * 0.35 && Math.random() < dt * 8) fx.smoke(v.x + c * s.length * 0.35, v.y + sn * s.length * 0.35);
      if (!v.wrecked && v.speed > 3 && dist(v.x, v.y, focus.x, focus.y) < 45) {
        // a boat throws spray off its bow instead (docs/plans/gameplay.md, Phase 3)
        if (s.boat) {
          if (v.speed > 6 && Math.random() < dt * v.speed * 0.25) fx.splash(v.x + c * s.length * 0.4, v.y + sn * s.length * 0.4);
        } else {
          if (world.surfaceAt(v.x, v.y) === 'offroad' && Math.random() < dt * v.speed * 0.2) fx.dust(v.x - c * s.length * 0.4, v.y - sn * s.length * 0.4);
          // spray off the wheels on a wet road, or through a pothole that never dries (docs/plans/non-violent.md)
          if (v.speed > 6 && !s.twoWheeler && Math.random() < dt * v.speed * 0.5) {
            const side = Math.random() < 0.5 ? 1 : -1;
            const wx = v.x - c * s.length * 0.32 - sn * side * s.width * 0.5, wy = v.y - sn * s.length * 0.32 + c * side * s.width * 0.5;
            if (wet > 0.35 || world.puddles.at(wx, wy, 0.2, true) >= 0) fx.drops(wx, wy, 2, 2);
          }
          if (v.ctrl.throttle > 0.5 && !s.twoWheeler && Math.random() < dt * 3) fx.exhaustPuff(v.x - c * s.length * 0.5, v.y - sn * s.length * 0.5, v.angle);
        }
      }
      if (v.sinking > 0 && v.sinking < 2.5 && Math.random() < dt * 6) fx.splash(v.x + rand(-1, 1), v.y + rand(-1, 1));
      // a car about to give up hisses steam from its radiator (docs/plans/non-violent.md: no fire)
      if (v.fire > 0 && !v.wrecked && Math.random() < dt * 14) fx.steam(v.x + c * s.length * 0.35, v.y + sn * s.length * 0.35);
    }
  }
}
