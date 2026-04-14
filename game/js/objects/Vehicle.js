class Vehicle extends Phaser.Physics.Arcade.Sprite {
  constructor(scene, x, y, defId) {
    const def = VEHICLE_DEFS[defId] || VEHICLE_DEFS.sedan;
    super(scene, x, y, def.texture);
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setDepth(8);
    this.body.setSize(def.bodyWidth, def.bodyHeight);
    this.body.setCollideWorldBounds(true);

    this.def = def;
    this.defId = defId;
    this.health = def.health;
    this.maxHealth = def.health;
    this.driver = null;
    this.occupied = false;
    this.isBurning = false;
    this.burnTimer = 0;
    this._burnFlashTimer = 0;

    // Physics state (managed manually for GTA-feel drift)
    this._forwardSpeed = 0;

    // Tire marks
    this._lastTrailX = x;
    this._lastTrailY = y;
    this._trailTimer = 0;
  }

  setDriver(driver) {
    this.driver = driver;
    this.occupied = true;
    // Report car theft
    this.scene.events.emit('crime_committed', { type: 'car_theft', x: this.x, y: this.y });
  }

  removeDriver() {
    this.driver = null;
    this.occupied = false;
  }

  update(time, delta) {
    if (!this.active) return;

    if (this.occupied && this.driver) {
      this._handleDriving(delta);
    } else {
      // Coast to stop
      this._forwardSpeed *= Math.pow(this.def.forwardDrag, delta / 16.67);
      if (Math.abs(this._forwardSpeed) < 1) this._forwardSpeed = 0;
      this._applyVehiclePhysics(delta);
    }

    if (this.isBurning) {
      this.burnTimer -= delta;
      this._burnFlashTimer += delta;
      this.setTint(this._burnFlashTimer % 300 < 150 ? 0xff6600 : 0xff2200);
      if (this.burnTimer <= 0) this._explode();
    }

    this._updateTireMarks(delta);
  }

  _handleDriving(delta) {
    // Read input from the scene's shared input refs (stored by GameScene)
    const keys = this.scene.drivingKeys;
    if (!keys) return;

    const dt = delta / 1000;
    const def = this.def;
    const speedRatio = Math.abs(this._forwardSpeed) / def.maxSpeed;

    // Throttle / brake / reverse
    if (keys.up.isDown) {
      this._forwardSpeed = Math.min(this._forwardSpeed + def.acceleration * dt, def.maxSpeed);
    } else if (keys.down.isDown) {
      if (this._forwardSpeed > 10) {
        // Hard braking
        this._forwardSpeed = Math.max(this._forwardSpeed - def.acceleration * 2.0 * dt, 0);
      } else {
        // Reverse (50% of forward speed)
        this._forwardSpeed = Math.max(this._forwardSpeed - def.acceleration * dt, -def.maxSpeed * 0.45);
      }
    } else {
      // Engine drag (frame-rate independent)
      this._forwardSpeed *= Math.pow(def.forwardDrag, delta / 16.67);
      if (Math.abs(this._forwardSpeed) < 1) this._forwardSpeed = 0;
    }

    // Steering — scales with speed ratio so you can't spin on the spot
    const steer = (keys.left.isDown ? -1 : 0) + (keys.right.isDown ? 1 : 0);
    if (Math.abs(this._forwardSpeed) > 8 && steer !== 0) {
      const dir = this._forwardSpeed >= 0 ? 1 : -1;
      const steerRate = def.handling * speedRatio * Phaser.Math.Clamp(speedRatio + 0.15, 0, 1);
      this.rotation += steer * dir * steerRate * dt;
    }

    this._applyVehiclePhysics(delta);

    // Engine sound (pitch scales with speed)
    if (this.scene.soundSystem) {
      const pitch = 0.6 + speedRatio * 0.9;
      this.scene.soundSystem.setEngineFreq(pitch);
    }
  }

  _applyVehiclePhysics(delta) {
    // Sprite 0-rotation = facing UP in Phaser, physics forward = angle - 90°
    const angle = this.rotation - Math.PI / 2;

    const vx = this.body.velocity.x;
    const vy = this.body.velocity.y;

    // Forward unit vector
    const fx = Math.cos(angle);
    const fy = Math.sin(angle);
    // Lateral unit vector (perpendicular)
    const lx = -fy;
    const ly = fx;

    // Decompose current velocity into forward/lateral components
    const lateralComp = vx * lx + vy * ly;

    // Apply heavy lateral drag (prevents sideways sliding)
    const lateralDragFactor = Math.pow(this.def.lateralDrag, delta / 16.67);
    const newLateral = lateralComp * lateralDragFactor;

    // Forward component comes from our managed _forwardSpeed
    const newVx = this._forwardSpeed * fx + newLateral * lx;
    const newVy = this._forwardSpeed * fy + newLateral * ly;

    this.body.velocity.x = newVx;
    this.body.velocity.y = newVy;
  }

  _updateTireMarks(delta) {
    // Draw tire marks when cornering hard or braking
    const speed = Math.abs(this._forwardSpeed);
    const vx = this.body.velocity.x;
    const vy = this.body.velocity.y;
    const actualSpeed = Math.sqrt(vx * vx + vy * vy);
    const slip = Math.abs(actualSpeed - speed);

    this._trailTimer += delta;
    if (slip > 30 && speed > 40 && this._trailTimer > 80) {
      this._trailTimer = 0;
      const mark = this.scene.add.rectangle(this.x, this.y, 4, 4, 0x222222, 0.55).setDepth(1);
      this.scene.time.delayedCall(8000, () => { if (mark.active) mark.destroy(); });
    }
  }

  takeDamage(amount) {
    if (!this.active) return;
    this.health -= amount;

    // Spark effect
    const spark = this.scene.add.circle(this.x, this.y, 8, 0xffaa00, 0.7).setDepth(15);
    this.scene.tweens.add({ targets: spark, alpha: 0, scale: 2, duration: 150,
      onComplete: () => spark.destroy() });

    if (this.health <= 40 && !this.isBurning) {
      this.isBurning = true;
      this.burnTimer = 4500;
    }
    if (this.health <= 0) this._explode();
  }

  _explode() {
    if (!this.active) return;
    this.scene.events.emit('explosion', { x: this.x, y: this.y });
    this.scene.soundSystem && this.scene.soundSystem.play('explosion');

    // Eject player driver with knockback
    if (this.driver && this.driver.isAlive) {
      const knockAngle = Math.random() * Math.PI * 2;
      this.driver.takeDamage(45);
      if (this.driver.exitVehicle) this.driver.exitVehicle();
      if (this.driver.body) {
        this.driver.body.velocity.x += Math.cos(knockAngle) * 180;
        this.driver.body.velocity.y += Math.sin(knockAngle) * 180;
      }
    }

    this.destroy();
  }

  canEnter() {
    return !this.occupied && this.active;
  }
}
