class Player extends Phaser.Physics.Arcade.Sprite {
  constructor(scene, x, y) {
    super(scene, x, y, 'player');
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setDepth(10);
    this.body.setCollideWorldBounds(true);
    this.body.setSize(18, 18);
    this.body.setOffset(3, 3);

    // State
    this.health = 100;
    this.maxHealth = 100;
    this.armor = 0;
    this.maxArmor = 100;
    this.money = 0;
    this.isAlive = true;

    // Weapons: slot 0 = fists (always)
    this.weapons = [
      { id: 'fists', ammo: Infinity, maxAmmo: Infinity },
    ];
    this.currentWeaponIndex = 0;

    this.inVehicle = false;
    this.currentVehicle = null;

    this.speed = 160;
    this.aimAngle = 0;
    this.lastFiredAt = 0;
    this.lastMeleeAt = 0;
    this._pointerWasDown = false;  // tracks previous frame pointer state for semi-auto

    // Input
    this.cursors = scene.input.keyboard.createCursorKeys();
    this.wasd = scene.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
    this.fKey = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F);

    // Weapon slot keys 1–9
    scene.input.keyboard.on('keydown', (event) => {
      const idx = event.keyCode - 49; // '1' → slot 0
      if (idx >= 0 && idx < 9 && idx < this.weapons.length) {
        this._switchWeapon(idx);
      }
    });

    // Mouse wheel scrolls through weapons
    scene.input.on('wheel', (pointer, objs, dx, dy) => {
      const dir = dy > 0 ? 1 : -1;
      const next = Phaser.Math.Wrap(this.currentWeaponIndex + dir, 0, this.weapons.length);
      this._switchWeapon(next);
    });

    // Camera follow
    scene.cameras.main.startFollow(this, true, 0.12, 0.12);
    scene.cameras.main.setBounds(0, 0, MAP_WORLD_WIDTH, MAP_WORLD_HEIGHT);

    this._fWasDown = false;

    // Damage flash overlay
    this._damageFlash = 0;

    this._syncRegistry();
  }

  update(time, delta) {
    if (!this.isAlive) return;

    if (this.inVehicle) {
      this._updateInVehicle(time, delta);
      return;
    }

    this._updateMovement();
    this._updateAim();
    this._updateShooting(time);
    this._updateEnterVehicle();
    this._updateDamageFlash(delta);
    this._syncRegistry();
  }

  _updateMovement() {
    const up    = this.cursors.up.isDown    || this.wasd.up.isDown;
    const down  = this.cursors.down.isDown  || this.wasd.down.isDown;
    const left  = this.cursors.left.isDown  || this.wasd.left.isDown;
    const right = this.cursors.right.isDown || this.wasd.right.isDown;

    let vx = 0, vy = 0;
    if (left)  vx -= 1;
    if (right) vx += 1;
    if (up)    vy -= 1;
    if (down)  vy += 1;

    // Normalize diagonal
    if (vx !== 0 && vy !== 0) {
      vx *= Math.SQRT1_2;
      vy *= Math.SQRT1_2;
    }

    this.setVelocity(vx * this.speed, vy * this.speed);
    // Always rotate toward mouse aim
    this.setRotation(this.aimAngle + Math.PI / 2);
  }

  _updateAim() {
    const cam = this.scene.cameras.main;
    const pointer = this.scene.input.activePointer;
    const worldPos = cam.getWorldPoint(pointer.x, pointer.y);
    this.aimAngle = Phaser.Math.Angle.Between(this.x, this.y, worldPos.x, worldPos.y);
  }

  _updateShooting(time) {
    const weapon = this.weapons[this.currentWeaponIndex];
    const isPointerDown = this.scene.input.activePointer.isDown;
    const justPressed = isPointerDown && !this._pointerWasDown;

    // Melee (fists)
    if (!weapon || weapon.id === 'fists') {
      if (justPressed && time - this.lastMeleeAt > WEAPON_DEFS.fists.fireRate) {
        this.lastMeleeAt = time;
        this.scene.events.emit('player_melee', this);
        this.scene.soundSystem && this.scene.soundSystem.play('punch');
      }
      this._pointerWasDown = isPointerDown;
      return;
    }

    const def = WEAPON_DEFS[weapon.id];
    if (!def || weapon.ammo <= 0) {
      this._pointerWasDown = isPointerDown;
      return;
    }

    const cooldownDone = time - this.lastFiredAt >= def.fireRate;

    if (def.isAutomatic) {
      // Auto: fires continuously while held
      if (isPointerDown && cooldownDone) {
        this._fire(time, weapon, def);
      }
    } else {
      // Semi-auto: fires once per click (fresh press only)
      if (justPressed && cooldownDone) {
        this._fire(time, weapon, def);
      }
    }

    this._pointerWasDown = isPointerDown;
  }

  _fire(time, weapon, def) {
    this.lastFiredAt = time;
    const pellets = def.pelletsPerShot || 1;
    for (let i = 0; i < pellets; i++) {
      const spread = (Math.random() - 0.5) * def.spreadAngle;
      this.scene.events.emit('player_fire', {
        x: this.x + Math.cos(this.aimAngle) * 14,
        y: this.y + Math.sin(this.aimAngle) * 14,
        angle: this.aimAngle + spread,
        damage: def.damage,
        speed: def.bulletSpeed,
        range: def.range,
        owner: 'player',
      });
    }

    // Muzzle flash
    this._spawnMuzzleFlash();

    // Sound
    this.scene.soundSystem && this.scene.soundSystem.playWeapon(weapon.id);

    // Alert nearby pedestrians
    this.scene.events.emit('gunshot_heard', { x: this.x, y: this.y, radius: 260 });

    if (weapon.ammo !== Infinity) {
      weapon.ammo = Math.max(0, weapon.ammo - 1);
      if (weapon.ammo === 0) this._switchToNextAvailableWeapon();
    }
  }

  _spawnMuzzleFlash() {
    const mx = this.x + Math.cos(this.aimAngle) * 18;
    const my = this.y + Math.sin(this.aimAngle) * 18;
    const flash = this.scene.add.circle(mx, my, 6, 0xffff88, 0.9).setDepth(15);
    this.scene.tweens.add({
      targets: flash, alpha: 0, scale: 2.5,
      duration: 80,
      onComplete: () => flash.destroy(),
    });
  }

  _updateEnterVehicle() {
    const fDown = this.fKey.isDown;
    if (fDown && !this._fWasDown) {
      this.scene.events.emit('player_try_enter_vehicle', this);
    }
    this._fWasDown = fDown;
  }

  _updateInVehicle(time, delta) {
    const fDown = this.fKey.isDown;
    if (fDown && !this._fWasDown) {
      this.scene.events.emit('player_exit_vehicle', this);
    }
    this._fWasDown = fDown;

    if (this.currentVehicle) {
      this.setPosition(this.currentVehicle.x, this.currentVehicle.y);
      this.setRotation(this.currentVehicle.rotation);
    }
  }

  _updateDamageFlash(delta) {
    if (this._damageFlash > 0) {
      this._damageFlash = Math.max(0, this._damageFlash - delta);
      const t = Math.min(1, this._damageFlash / 120);
      this.scene.cameras.main.setAlpha(1 - t * 0.4);
    } else {
      this.scene.cameras.main.setAlpha(1);
    }
  }

  enterVehicle(vehicle) {
    this.inVehicle = true;
    this.currentVehicle = vehicle;
    this.setVisible(false);
    this.body.enable = false;
    vehicle.setDriver(this);
    this.scene.cameras.main.startFollow(vehicle, true, 0.1, 0.1);
    this.scene.registry.set('inVehicle', true);
    this.scene.soundSystem && this.scene.soundSystem.play('car_start');
  }

  exitVehicle() {
    if (!this.currentVehicle) return;
    const vehicle = this.currentVehicle;

    // Try a few exit offsets to avoid spawning in a building
    const angles = [Math.PI / 2, -Math.PI / 2, Math.PI, 0];
    let placed = false;
    for (const offset of angles) {
      const exitAngle = vehicle.rotation + offset;
      const ex = vehicle.x + Math.cos(exitAngle) * 40;
      const ey = vehicle.y + Math.sin(exitAngle) * 40;
      const tx = Math.floor(ex / MAP_TILE_SIZE);
      const ty = Math.floor(ey / MAP_TILE_SIZE);
      if (tx >= 0 && ty >= 0 && tx < MAP_WIDTH && ty < MAP_HEIGHT &&
          MAP_DATA[ty][tx] !== TILE.BUILDING) {
        this.setPosition(ex, ey);
        placed = true;
        break;
      }
    }
    if (!placed) this.setPosition(vehicle.x, vehicle.y);

    this.inVehicle = false;
    this.currentVehicle = null;
    this.setVisible(true);
    this.body.enable = true;
    vehicle.removeDriver();
    this.scene.cameras.main.startFollow(this, true, 0.12, 0.12);
    this.scene.registry.set('inVehicle', false);
    this._pointerWasDown = false;
  }

  takeDamage(amount) {
    if (!this.isAlive || amount <= 0) return;

    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, amount);
      this.armor -= absorbed;
      amount -= absorbed;
    }
    this.health = Math.max(0, this.health - amount);

    // Camera damage flash
    this._damageFlash = 200;
    this.scene.cameras.main.shake(120, 0.008);

    if (this.health <= 0) this._die();
    this._syncRegistry();
  }

  addWeapon(weaponId, ammo) {
    const existing = this.weapons.find(w => w.id === weaponId);
    const def = WEAPON_DEFS[weaponId];
    if (!def) return;

    if (existing) {
      existing.ammo = Math.min(existing.ammo + ammo, def.maxAmmo);
    } else {
      this.weapons.push({ id: weaponId, ammo: Math.min(ammo, def.maxAmmo), maxAmmo: def.maxAmmo });
      this._switchWeapon(this.weapons.length - 1);
    }
    this.scene.soundSystem && this.scene.soundSystem.play('pickup');
    this._syncRegistry();
  }

  addMoney(amount) {
    this.money += amount;
    this._syncRegistry();
  }

  addArmor(amount) {
    this.armor = Math.min(this.maxArmor, this.armor + amount);
    this._syncRegistry();
  }

  _switchWeapon(index) {
    if (index >= 0 && index < this.weapons.length) {
      this.currentWeaponIndex = index;
      this._syncRegistry();
    }
  }

  _switchToNextAvailableWeapon() {
    for (let i = 0; i < this.weapons.length; i++) {
      const w = this.weapons[i];
      if (w.ammo === Infinity || w.ammo > 0) {
        this.currentWeaponIndex = i;
        this._syncRegistry();
        return;
      }
    }
    this.currentWeaponIndex = 0;
    this._syncRegistry();
  }

  _die() {
    this.isAlive = false;
    this.setVelocity(0, 0);
    this.setTint(0xff0000);
    this.scene.cameras.main.shake(400, 0.02);

    this.scene.time.delayedCall(1800, () => {
      if (this.scene) this.scene.scene.start('GameOverScene');
    });
  }

  _syncRegistry() {
    const reg = this.scene.registry;
    reg.set('playerHealth', this.health);
    reg.set('playerMaxHealth', this.maxHealth);
    reg.set('playerArmor', this.armor);
    reg.set('playerMaxArmor', this.maxArmor);
    reg.set('playerMoney', this.money);
    const weapon = this.weapons[this.currentWeaponIndex];
    reg.set('playerWeapon', weapon ? weapon.id : 'fists');
    reg.set('playerAmmo', weapon ? weapon.ammo : 0);
    reg.set('playerWeapons', this.weapons.map(w => w.id));
    reg.set('playerWeaponIndex', this.currentWeaponIndex);
  }
}
