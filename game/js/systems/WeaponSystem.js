class WeaponSystem {
  constructor() {
    this.bulletGroup = null;
    this.scene = null;
  }

  create(scene) {
    this.scene = scene;

    this.bulletGroup = scene.physics.add.group({
      classType: Bullet,
      maxSize: 300,
      runChildUpdate: true,
    });

    // Listen for fire events
    scene.events.on('player_fire', this._onPlayerFire, this);
    scene.events.on('npc_fire', this._onNpcFire, this);

    return this;
  }

  _onPlayerFire(data) {
    this._spawnBullet(data);
  }

  _onNpcFire(data) {
    this._spawnBullet({ ...data, owner: 'npc' });
  }

  _spawnBullet(data) {
    const bullet = this.bulletGroup.get(data.x, data.y);
    if (!bullet) return;
    bullet.fire(data.x, data.y, data.angle, data.speed, data.range, data.damage, data.owner || 'player');
  }

  /** Wire up collisions after player, NPCs, vehicles, map are ready */
  wireCollisions(scene, player, npcGroup, vehicleGroup, mapSystem) {
    // Bullets hit buildings
    scene.physics.add.collider(this.bulletGroup, mapSystem.groundLayer, (bullet) => {
      this._spawnHitEffect(bullet.x, bullet.y);
      bullet.deactivate();
    });

    // Player bullets hit NPCs
    scene.physics.add.overlap(this.bulletGroup, npcGroup, (bullet, npc) => {
      if (bullet.owner === 'player' && npc.active) {
        npc.takeDamage(bullet.damage, player);
        this._spawnHitEffect(bullet.x, bullet.y);
        bullet.deactivate();
      }
    });

    // NPC bullets hit player
    scene.physics.add.overlap(this.bulletGroup, player, (bullet, p) => {
      if (bullet.owner === 'npc' && p.isAlive) {
        p.takeDamage(bullet.damage);
        bullet.deactivate();
      }
    });

    // Bullets hit vehicles (damage them)
    scene.physics.add.overlap(this.bulletGroup, vehicleGroup, (bullet, vehicle) => {
      if (vehicle.active) {
        vehicle.takeDamage(bullet.damage);
        this._spawnHitEffect(bullet.x, bullet.y);
        bullet.deactivate();
      }
    });
  }

  _spawnHitEffect(x, y) {
    // Small flash particle using temporary image
    const flash = this.scene.add.image(x, y, 'explosion_0').setDepth(20).setScale(0.5);
    this.scene.tweens.add({
      targets: flash,
      alpha: 0,
      scale: 1.5,
      duration: 120,
      onComplete: () => flash.destroy(),
    });
  }

  spawnExplosion(x, y) {
    let frame = 0;
    const keys = ['explosion_0','explosion_1','explosion_2','explosion_3','explosion_4','explosion_5'];
    const img = this.scene.add.image(x, y, keys[0]).setDepth(25);
    const timer = this.scene.time.addEvent({
      delay: 60,
      repeat: keys.length - 1,
      callback: () => {
        frame++;
        if (frame < keys.length) {
          img.setTexture(keys[frame]);
        } else {
          img.destroy();
          timer.remove();
        }
      },
    });
  }
}
