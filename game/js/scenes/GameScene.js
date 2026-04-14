class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  create() {
    // Init registry defaults
    this.registry.set('playerHealth', 100);
    this.registry.set('playerMaxHealth', 100);
    this.registry.set('playerArmor', 0);
    this.registry.set('playerMaxArmor', 100);
    this.registry.set('playerMoney', 0);
    this.registry.set('wantedLevel', 0);
    this.registry.set('playerWeapon', 'fists');
    this.registry.set('playerAmmo', 0);
    this.registry.set('inVehicle', false);
    if (!this.registry.get('gangRelationships')) {
      this.registry.set('gangRelationships', { loonies: 0, zaibatsu: 0, rednecks: 0 });
    }

    // --- Sound system (Web Audio, no files) ---
    this.soundSystem = new SoundSystem();

    // --- Shared driving input (read by Vehicle when player is driver) ---
    this.drivingKeys = this.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
    // Arrow keys also work for driving
    const arrows = this.input.keyboard.createCursorKeys();
    // Merge arrow keys into drivingKeys via proxy each frame in update()
    this._arrowKeys = arrows;

    // --- Map ---
    this.mapSystem = new MapSystem();
    this.mapSystem.create(this);

    // --- Groups (single declaration each) ---
    this.npcGroup     = this.physics.add.group();
    this.vehicleGroup = this.physics.add.group();
    this.pickupGroup  = this.physics.add.staticGroup();

    // --- Player ---
    const spawn  = SPAWN_POINTS.player;
    const spawnW = this.mapSystem.tileToWorld(spawn.tx, spawn.ty);
    this.player  = new Player(this, spawnW.x, spawnW.y);

    // --- Spawn everything ---
    this._spawnVehicles();
    this._spawnNPCs();
    WeaponPickup.createAll(this, this.pickupGroup);
    this._spawnPhoneBooths();

    // --- Systems ---
    this.weaponSystem = new WeaponSystem();
    this.weaponSystem.create(this);
    this.weaponSystem.wireCollisions(this, this.player, this.npcGroup, this.vehicleGroup, this.mapSystem);

    this.wantedSystem = new WantedSystem();
    this.wantedSystem.create(this, this.player, this.npcGroup);

    this.miniMap = new MiniMap();
    this.miniMap.create(this);

    // --- Colliders ---
    this.mapSystem.addBuildingCollider(this, this.player);
    this.mapSystem.addBuildingCollider(this, this.npcGroup);
    this.mapSystem.addBuildingCollider(this, this.vehicleGroup);

    this.physics.add.collider(this.vehicleGroup, this.vehicleGroup);

    // Player run over by vehicle
    this.physics.add.overlap(this.player, this.vehicleGroup, (player, vehicle) => {
      if (!player.inVehicle && vehicle.active) {
        const spd = Math.hypot(vehicle.body.velocity.x, vehicle.body.velocity.y);
        if (spd > 90) player.takeDamage(Math.floor(spd / 18));
      }
    });

    // NPC run over by vehicle
    this.physics.add.overlap(this.npcGroup, this.vehicleGroup, (npc, vehicle) => {
      if (!npc.isAlive || !vehicle.active) return;
      const spd = Math.hypot(vehicle.body.velocity.x, vehicle.body.velocity.y);
      if (spd > 60) npc.takeDamage(Math.floor(spd / 14), this.player);
    });

    // Pickup collection
    this.physics.add.overlap(this.player, this.pickupGroup, (player, pickup) => {
      if (!pickup.active) return;
      const def = WEAPON_DEFS[pickup.weaponId];
      if (!def) return;
      player.addWeapon(pickup.weaponId, def.defaultAmmo);
      this._showFloatingText(pickup.x, pickup.y, '+' + def.displayName, '#ffdd44');
      pickup.destroy();
    });

    // --- Events ---
    this.events.on('player_try_enter_vehicle', this._onTryEnterVehicle, this);
    this.events.on('player_exit_vehicle', (player) => {
      player.exitVehicle();
      this.soundSystem.stopEngine();
    }, this);
    this.events.on('explosion', (data) => {
      this.weaponSystem.spawnExplosion(data.x, data.y);
      this._explosionDamage(data.x, data.y, 90, 65);
      this.cameras.main.shake(300, 0.015);
    }, this);
    this.events.on('npc_died', this._onNPCDied, this);
    this.events.on('police_died', (cop) => this.wantedSystem.policeDied(cop), this);
    this.events.on('money_dropped', (data) => {
      this.player.addMoney(data.amount);
      this._showFloatingText(data.x, data.y, '+$' + data.amount, '#ffdd44');
    }, this);
    this.events.on('player_melee', this._onMeleeAttack, this);
    this.events.on('gunshot_heard', (data) => {
      this._alertNearbyPedestrians(data.x, data.y, data.radius || 250);
    }, this);
    this.events.on('crime_committed', (data) => {
      // Show brief "WANTED!" flash when heat first rises
    }, this);

    // --- HUD ---
    this.scene.launch('HUDScene');

    // Dim the camera when player enters a tunnel / alley — based on building proximity
    // (simple atmosphere trick: very slight vignette via camera tint in dark areas)
  }

  update(time, delta) {
    if (!this.player) return;

    // Merge arrow keys into drivingKeys so arrows also drive
    if (this._arrowKeys) {
      if (this._arrowKeys.up.isDown)    this.drivingKeys.up.isDown    = true;
      if (this._arrowKeys.down.isDown)  this.drivingKeys.down.isDown  = true;
      if (this._arrowKeys.left.isDown)  this.drivingKeys.left.isDown  = true;
      if (this._arrowKeys.right.isDown) this.drivingKeys.right.isDown = true;
      // Reset next tick — Phaser Key objects manage their own state,
      // so we just let them be read directly alongside WASD
    }

    this.player.update(time, delta);

    this.vehicleGroup.getChildren().forEach(v => { if (v.update) v.update(time, delta); });
    this.npcGroup.getChildren().forEach(npc => { if (npc.update) npc.update(time, delta); });

    this.miniMap.update(this, this.player, this.npcGroup, this.vehicleGroup);

    // Engine sound management
    if (this.player.inVehicle && this.player.currentVehicle) {
      if (!this.soundSystem._engineActive) this.soundSystem.startEngine();
    } else {
      if (this.soundSystem._engineActive) this.soundSystem.stopEngine();
    }
  }

  _spawnVehicles() {
    SPAWN_POINTS.vehicles.forEach(({ tx, ty, type }) => {
      const w = this.mapSystem.tileToWorld(tx, ty);
      const vehicle = new Vehicle(this, w.x, w.y, type);
      this.vehicleGroup.add(vehicle);
    });
  }

  _spawnNPCs() {
    SPAWN_POINTS.pedestrians.forEach(({ tx, ty }) => {
      const w = this.mapSystem.tileToWorld(tx, ty);
      this.npcGroup.add(new Pedestrian(this, w.x, w.y));
    });
    SPAWN_POINTS.gangMembers.forEach(({ tx, ty, gang }) => {
      const w = this.mapSystem.tileToWorld(tx, ty);
      const member = new GangMember(this, w.x, w.y, gang);
      member.setPlayerRef(this.player);
      this.npcGroup.add(member);
    });
  }

  _spawnPhoneBooths() {
    this._missionShown = false;
    SPAWN_POINTS.phoneBooths.forEach(({ tx, ty, missionId }) => {
      const w = this.mapSystem.tileToWorld(tx, ty);
      this.add.image(w.x, w.y, 'phone_booth').setDepth(6);

      const zone = this.add.zone(w.x, w.y, 52, 52);
      this.physics.add.existing(zone, true);
      this.physics.add.overlap(this.player, zone, () => {
        if (!this._missionShown) {
          this._missionShown = true;
          this._showMissionPrompt(missionId, w.x, w.y);
          this.time.delayedCall(9000, () => { this._missionShown = false; });
        }
      });
    });
  }

  _showMissionPrompt(missionId, x, y) {
    const missions = {
      loonies_1:  'LOONIES JOB:\nEliminate the Zaibatsu spotter\nnear the east intersection.',
      zaibatsu_1: 'ZAIBATSU JOB:\nSteal the Redneck truck\nnear the south district.',
      rednecks_1: 'REDNECKS JOB:\nCause mayhem — reach\n2-star wanted level.',
    };
    const text = missions[missionId] || 'Mission available...';
    const popup = this.add.text(x, y - 52, '📞 ' + text, {
      fontSize: '11px', color: '#ffffff', fontFamily: 'monospace',
      backgroundColor: '#000000dd',
      padding: { x: 10, y: 7 },
      wordWrap: { width: 220 },
    }).setDepth(50).setOrigin(0.5, 1);

    this.tweens.add({
      targets: popup, alpha: 0, y: y - 90,
      delay: 7000, duration: 1500,
      onComplete: () => popup.destroy(),
    });
  }

  _onTryEnterVehicle(player) {
    let closest = null;
    let minDist = 65;
    this.vehicleGroup.getChildren().forEach(vehicle => {
      if (!vehicle.active || !vehicle.canEnter()) return;
      const dist = Phaser.Math.Distance.Between(player.x, player.y, vehicle.x, vehicle.y);
      if (dist < minDist) { minDist = dist; closest = vehicle; }
    });
    if (closest) player.enterVehicle(closest);
  }

  _onNPCDied(data) {
    const { npc } = data;
    // Blood pool
    const pool = this.add.circle(npc.x, npc.y, 7, 0x880000, 0.6).setDepth(3);
    this.time.delayedCall(15000, () => { if (pool.active) pool.destroy(); });
  }

  _onMeleeAttack(player) {
    this.npcGroup.getChildren().forEach(npc => {
      if (!npc.isAlive) return;
      const dist = Phaser.Math.Distance.Between(player.x, player.y, npc.x, npc.y);
      if (dist < 34) {
        npc.takeDamage(WEAPON_DEFS.fists.damage, player);
        this.soundSystem.play('npc_hurt');
      }
    });
  }

  _explosionDamage(cx, cy, radius, damage) {
    const pd = Phaser.Math.Distance.Between(cx, cy, this.player.x, this.player.y);
    if (pd < radius) this.player.takeDamage(Math.floor(damage * (1 - pd / radius)));

    this.npcGroup.getChildren().forEach(npc => {
      if (!npc.isAlive) return;
      const d = Phaser.Math.Distance.Between(cx, cy, npc.x, npc.y);
      if (d < radius) npc.takeDamage(Math.floor(damage * (1 - d / radius)), this.player);
    });
  }

  _alertNearbyPedestrians(x, y, radius) {
    this.npcGroup.getChildren().forEach(npc => {
      if (!npc.isAlive || !(npc instanceof Pedestrian)) return;
      if (Phaser.Math.Distance.Between(x, y, npc.x, npc.y) < radius && npc.aiState !== 'flee') {
        npc.startFleeing(this.player);
      }
    });
  }

  _showFloatingText(x, y, message, color = '#ffffff') {
    const t = this.add.text(x, y - 20, message, {
      fontSize: '13px', color, fontFamily: 'monospace',
      stroke: '#000000', strokeThickness: 3,
    }).setDepth(30).setOrigin(0.5);

    this.tweens.add({
      targets: t, y: y - 52, alpha: 0,
      duration: 1200, ease: 'Cubic.easeOut',
      onComplete: () => t.destroy(),
    });
  }
}
