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

    // Physics state
    this._forwardSpeed = 0;
    this._steerInput = 0;

    // Input keys (only active when player is driving)
    this._cursors = null;
    this._wasd = null;
  }

  setDriver(driver) {
    this.driver = driver;
    this.occupied = true;
    if (driver.constructor && driver.constructor.name === 'Player') {
      this._cursors = this.scene.input.keyboard.createCursorKeys();
      this._wasd = this.scene.input.keyboard.addKeys({
        up: Phaser.Input.Keyboard.KeyCodes.W,
        down: Phaser.Input.Keyboard.KeyCodes.S,
        left: Phaser.Input.Keyboard.KeyCodes.A,
        right: Phaser.Input.Keyboard.KeyCodes.D,
      });
    }
    // Report car theft
    this.scene.events.emit('crime_committed', { type: 'car_theft', x: this.x, y: this.y });
  }

  removeDriver() {
    this.driver = null;
    this.occupied = false;
    this._cursors = null;
    this._wasd = null;
  }

  update(time, delta) {
    if (!this.active) return;

    if (this.occupied && this.driver) {
      this._handlePlayerDriving(delta);
    } else {
      // No driver: apply drag to coast to a stop
      this._forwardSpeed *= this.def.forwardDrag;
      if (Math.abs(this._forwardSpeed) < 1) this._forwardSpeed = 0;
      this._applyVehiclePhysics(delta);
    }

    if (this.isBurning) {
      this.burnTimer -= delta;
      // Flash between orange and red
      this.setTint(time % 300 < 150 ? 0xff6600 : 0xff0000);
      if (this.burnTimer <= 0) {
        this._explode();
      }
    }
  }

  _handlePlayerDriving(delta) {
    const dt = delta / 1000;
    const up = this._cursors && (this._cursors.up.isDown || this._wasd.up.isDown);
    const down = this._cursors && (this._cursors.down.isDown || this._wasd.down.isDown);
    const left = this._cursors && (this._cursors.left.isDown || this._wasd.left.isDown);
    const right = this._cursors && (this._cursors.right.isDown || this._wasd.right.isDown);

    const def = this.def;
    const speedRatio = Math.abs(this._forwardSpeed) / def.maxSpeed;

    // Accelerate / brake
    if (up) {
      this._forwardSpeed = Math.min(this._forwardSpeed + def.acceleration * dt, def.maxSpeed);
    } else if (down) {
      if (this._forwardSpeed > 10) {
        // Braking
        this._forwardSpeed = Math.max(this._forwardSpeed - def.acceleration * 1.5 * dt, 0);
      } else {
        // Reverse
        this._forwardSpeed = Math.max(this._forwardSpeed - def.acceleration * dt, -def.maxSpeed * 0.5);
      }
    } else {
      // Natural drag
      this._forwardSpeed *= def.forwardDrag;
      if (Math.abs(this._forwardSpeed) < 1) this._forwardSpeed = 0;
    }

    // Steering (only effective with speed)
    this._steerInput = 0;
    if (left) this._steerInput = -1;
    if (right) this._steerInput = 1;

    if (Math.abs(this._forwardSpeed) > 5) {
      const steerAmount = this._steerInput * def.handling * speedRatio * dt;
      // Reverse direction flips steering feel
      const dir = this._forwardSpeed >= 0 ? 1 : -1;
      this.rotation += steerAmount * dir;
    }

    this._applyVehiclePhysics(delta);
  }

  _applyVehiclePhysics(delta) {
    const dt = delta / 1000;
    const angle = this.rotation - Math.PI / 2; // Phaser sprite 0 = up

    // Current velocity
    const vx = this.body.velocity.x;
    const vy = this.body.velocity.y;

    // Forward unit vector
    const fx = Math.cos(angle);
    const fy = Math.sin(angle);

    // Lateral unit vector
    const lx = -fy;
    const ly = fx;

    // Decompose current velocity
    const forwardComp = vx * fx + vy * fy;
    const lateralComp = vx * lx + vy * ly;

    // Desired forward velocity from forwardSpeed state
    const targetFwd = this._forwardSpeed;

    // Blend toward target (effectively sets the forward component)
    const newForward = targetFwd;
    const newLateral = lateralComp * this.def.lateralDrag; // heavy lateral damping

    // Recompose
    const newVx = newForward * fx + newLateral * lx;
    const newVy = newForward * fy + newLateral * ly;

    this.body.velocity.x = newVx;
    this.body.velocity.y = newVy;
  }

  takeDamage(amount) {
    this.health -= amount;
    if (this.health <= 40 && !this.isBurning) {
      this.isBurning = true;
      this.burnTimer = 5000; // explode after 5s
    }
    if (this.health <= 0) this._explode();
  }

  _explode() {
    this.scene.events.emit('explosion', { x: this.x, y: this.y });

    // Eject driver
    if (this.driver && this.driver.constructor.name === 'Player') {
      this.driver.takeDamage(50);
      this.driver.exitVehicle();
    }

    this.destroy();
  }

  /** Returns true if a character can enter this vehicle */
  canEnter() {
    return !this.occupied && this.active;
  }
}
