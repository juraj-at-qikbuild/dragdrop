class NPC extends Phaser.Physics.Arcade.Sprite {
  constructor(scene, x, y, texture, config = {}) {
    super(scene, x, y, texture);
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setDepth(9);
    this.body.setCollideWorldBounds(true);
    this.body.setSize(12, 12);
    this.body.setOffset(2, 2);

    this.npcType = config.type || 'pedestrian';
    this.health = config.health || 50;
    this.maxHealth = this.health;
    this.isAlive = true;
    this.gangId = config.gangId || null;
    this.speed = config.speed || 70;

    // AI state machine
    this.aiState = 'wander';
    this.stateTimer = Math.random() * 2000;
    this.targetPosition = null;
    this.alertedBy = null;

    // Staggered updates for performance
    this.updateInterval = 100 + Math.random() * 100;
    this.lastUpdateTime = Math.random() * this.updateInterval;

    // Weapon for NPCs that shoot
    this.weaponId = config.weaponId || null;
    this.lastFiredAt = 0;
    this.fireRange = config.fireRange || 180;
  }

  update(time, delta) {
    if (!this.isAlive) return;

    if (time - this.lastUpdateTime >= this.updateInterval) {
      this.lastUpdateTime = time;
      this._runAI(time);
    }
  }

  _runAI(time) {
    // Overridden by subclasses
  }

  _moveToward(targetX, targetY, speed) {
    const angle = Phaser.Math.Angle.Between(this.x, this.y, targetX, targetY);
    this.scene.physics.velocityFromRotation(angle, speed, this.body.velocity);
    this.setRotation(angle + Math.PI / 2);
  }

  _stopMoving() {
    this.setVelocity(0, 0);
  }

  _pickRandomNearbyTile() {
    const tx = Math.floor(this.x / MAP_TILE_SIZE);
    const ty = Math.floor(this.y / MAP_TILE_SIZE);
    const range = 4;
    let attempts = 0;
    while (attempts < 10) {
      const nx = tx + Math.floor((Math.random() * 2 - 1) * range);
      const ny = ty + Math.floor((Math.random() * 2 - 1) * range);
      if (nx >= 0 && ny >= 0 && nx < MAP_WIDTH && ny < MAP_HEIGHT) {
        const id = MAP_DATA[ny] && MAP_DATA[ny][nx];
        if (id !== TILE.BUILDING) {
          return {
            x: nx * MAP_TILE_SIZE + MAP_TILE_SIZE / 2,
            y: ny * MAP_TILE_SIZE + MAP_TILE_SIZE / 2,
          };
        }
      }
      attempts++;
    }
    return { x: this.x, y: this.y };
  }

  takeDamage(amount, attacker) {
    if (!this.isAlive) return;
    this.health -= amount;

    // Flash red
    this.setTint(0xff4444);
    this.scene.time.delayedCall(150, () => {
      if (this.active) this.clearTint();
    });

    if (this.health <= 0) {
      this._die(attacker);
    }
  }

  _die(attacker) {
    this.isAlive = false;
    this.setVelocity(0, 0);
    this.setTint(0x880000);
    this.setAlpha(0.7);

    this.scene.events.emit('npc_died', { npc: this, attacker });

    // Drop money
    if (Math.random() < 0.3) {
      const amount = Phaser.Math.Between(10, 50);
      this.scene.events.emit('money_dropped', { x: this.x, y: this.y, amount });
    }

    // Fade out and destroy after delay
    this.scene.tweens.add({
      targets: this,
      alpha: 0,
      duration: 3000,
      delay: 2000,
      onComplete: () => { if (this.active) this.destroy(); },
    });

    this.body.enable = false;
  }

  _tryShootAt(target, time) {
    if (!this.weaponId) return;
    const def = WEAPON_DEFS[this.weaponId];
    if (!def) return;
    if (time - this.lastFiredAt < def.fireRate * 1.5) return;

    const dist = Phaser.Math.Distance.Between(this.x, this.y, target.x, target.y);
    if (dist > this.fireRange) return;

    this.lastFiredAt = time;
    const angle = Phaser.Math.Angle.Between(this.x, this.y, target.x, target.y);
    const spread = (Math.random() - 0.5) * 0.25;

    this.scene.events.emit('npc_fire', {
      x: this.x + Math.cos(angle) * 14,
      y: this.y + Math.sin(angle) * 14,
      angle: angle + spread,
      damage: def.damage * 0.8,
      speed: def.bulletSpeed,
      range: def.range,
      owner: 'npc',
    });
  }
}
