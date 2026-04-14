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
    this.aimAngle = 0;   // radians, toward mouse
    this.lastFiredAt = 0;
    this.lastMeleeAt = 0;

    // Input
    this.cursors = scene.input.keyboard.createCursorKeys();
    this.wasd = scene.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
    this.fKey = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F);

    // Weapon slots 1-9
    scene.input.keyboard.on('keydown', (event) => {
      const idx = event.keyCode - 49; // '1' = 0
      if (idx >= 0 && idx < 9) this._switchWeapon(idx);
    });

    // Camera follow
    scene.cameras.main.startFollow(this, true, 0.12, 0.12);
    scene.cameras.main.setBounds(0, 0, MAP_WORLD_WIDTH, MAP_WORLD_HEIGHT);

    this._fWasDown = false;
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
    this._updateEnterVehicle(time);
    this._syncRegistry();
  }

  _updateMovement() {
    const up = this.cursors.up.isDown || this.wasd.up.isDown;
    const down = this.cursors.down.isDown || this.wasd.down.isDown;
    const left = this.cursors.left.isDown || this.wasd.left.isDown;
    const right = this.cursors.right.isDown || this.wasd.right.isDown;

    let vx = 0, vy = 0;
    if (left) vx -= 1;
    if (right) vx += 1;
    if (up) vy -= 1;
    if (down) vy += 1;

    // Normalize diagonal
    if (vx !== 0 && vy !== 0) {
      vx *= 0.7071;
      vy *= 0.7071;
    }

    this.setVelocity(vx * this.speed, vy * this.speed);

    // Rotate sprite toward aim angle (mouse)
    this.setRotation(this.aimAngle + Math.PI / 2);
  }

  _updateAim() {
    const pointer = this.scene.input.activePointer;
    const worldPos = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.aimAngle = Phaser.Math.Angle.Between(this.x, this.y, worldPos.x, worldPos.y);
  }

  _updateShooting(time) {
    const weapon = this.weapons[this.currentWeaponIndex];
    if (!weapon || weapon.id === 'fists') {
      // Melee
      if (this.scene.input.activePointer.isDown && time - this.lastMeleeAt > 500) {
        this.lastMeleeAt = time;
        this.scene.events.emit('player_melee', this);
      }
      return;
    }

    if (this.scene.input.activePointer.isDown) {
      const def = WEAPON_DEFS[weapon.id];
      if (!def) return;
      const isAuto = def.isAutomatic;
      const canFire = isAuto
        ? time - this.lastFiredAt >= def.fireRate
        : (this.scene.input.activePointer.justDown || time - this.lastFiredAt >= def.fireRate) && this.scene.input.activePointer.justDown === false
          ? false
          : this.scene.input.activePointer.isDown && !this._wasPointerDown && time - this.lastFiredAt >= def.fireRate;

      // Simplified: just check fire rate
      if (time - this.lastFiredAt >= def.fireRate) {
        if (!isAuto && !this.scene.input.activePointer.justDown && this._wasFiring) return;
        if (weapon.ammo > 0) {
          this._fire(time, weapon, def);
        }
      }
    }
    this._wasFiring = this.scene.input.activePointer.isDown;
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
    if (weapon.ammo !== Infinity) {
      weapon.ammo = Math.max(0, weapon.ammo - 1);
      if (weapon.ammo === 0) {
        this._switchToNextAvailableWeapon();
      }
    }
  }

  _updateEnterVehicle(time) {
    const fDown = this.fKey.isDown;
    if (fDown && !this._fWasDown) {
      this.scene.events.emit('player_try_enter_vehicle', this);
    }
    this._fWasDown = fDown;
  }

  _updateInVehicle(time, delta) {
    // While in vehicle, F key exits
    const fDown = this.fKey.isDown;
    if (fDown && !this._fWasDown) {
      this.scene.events.emit('player_exit_vehicle', this);
    }
    this._fWasDown = fDown;

    // Position follows vehicle
    if (this.currentVehicle) {
      this.setPosition(this.currentVehicle.x, this.currentVehicle.y);
      this.setRotation(this.currentVehicle.rotation);
    }
  }

  enterVehicle(vehicle) {
    this.inVehicle = true;
    this.currentVehicle = vehicle;
    this.setVisible(false);
    this.body.enable = false;
    vehicle.setDriver(this);
    this.scene.registry.set('inVehicle', true);
  }

  exitVehicle() {
    if (!this.currentVehicle) return;
    const vehicle = this.currentVehicle;
    // Place player beside the vehicle
    const exitAngle = vehicle.rotation + Math.PI / 2;
    this.setPosition(
      vehicle.x + Math.cos(exitAngle) * 36,
      vehicle.y + Math.sin(exitAngle) * 36
    );
    this.inVehicle = false;
    this.currentVehicle = null;
    this.setVisible(true);
    this.body.enable = true;
    vehicle.removeDriver();
    this.scene.registry.set('inVehicle', false);
  }

  takeDamage(amount) {
    if (!this.isAlive) return;
    // Armor absorbs first
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, amount);
      this.armor -= absorbed;
      amount -= absorbed;
    }
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this._die();
    }
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
      if (this.weapons[i].ammo > 0 || this.weapons[i].ammo === Infinity) {
        this.currentWeaponIndex = i;
        this._syncRegistry();
        return;
      }
    }
    this.currentWeaponIndex = 0; // fallback to fists
    this._syncRegistry();
  }

  _die() {
    this.isAlive = false;
    this.setVelocity(0, 0);
    this.setTint(0xff0000);
    this.scene.time.delayedCall(1500, () => {
      this.scene.scene.start('GameOverScene');
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
  }
}
