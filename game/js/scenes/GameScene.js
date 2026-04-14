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

    // --- 1. Map ---
    this.mapSystem = new MapSystem();
    this.mapSystem.create(this);

    // --- 2. Groups ---
    this.npcGroup = this.physics.add.group();
    this.vehicleGroup = this.physics.add.group();
    this.pickupGroup = this.physics.add.staticGroup();

    // Make vehicleGroup accessible on scene for WantedSystem police car spawning
    this.vehicleGroup = this.physics.add.group();

    // --- 3. Player ---
    const spawn = SPAWN_POINTS.player;
    const spawnW = this.mapSystem.tileToWorld(spawn.tx, spawn.ty);
    this.player = new Player(this, spawnW.x, spawnW.y);

    // --- 4. Vehicles ---
    this._spawnVehicles();

    // --- 5. NPCs ---
    this._spawnNPCs();

    // --- 6. Weapon pickups ---
    WeaponPickup.createAll(this, this.pickupGroup);

    // --- 7. Phone booths ---
    this._spawnPhoneBooths();

    // --- 8. Systems ---
    this.weaponSystem = new WeaponSystem();
    this.weaponSystem.create(this);
    this.weaponSystem.wireCollisions(this, this.player, this.npcGroup, this.vehicleGroup, this.mapSystem);

    this.wantedSystem = new WantedSystem();
    this.wantedSystem.create(this, this.player, this.npcGroup);

    this.miniMap = new MiniMap();
    this.miniMap.create(this);

    // --- 9. Colliders ---
    this.mapSystem.addBuildingCollider(this, this.player);
    this.mapSystem.addBuildingCollider(this, this.npcGroup);
    this.mapSystem.addBuildingCollider(this, this.vehicleGroup);

    // Vehicle-vehicle collision
    this.physics.add.collider(this.vehicleGroup, this.vehicleGroup);

    // Player-vehicle collision (when on foot)
    this.physics.add.overlap(this.player, this.vehicleGroup, (player, vehicle) => {
      if (!player.inVehicle && vehicle.occupied && vehicle.active) {
        // Being hit by a moving vehicle
        const speed = Math.sqrt(vehicle.body.velocity.x ** 2 + vehicle.body.velocity.y ** 2);
        if (speed > 80) {
          player.takeDamage(Math.floor(speed / 20));
        }
      }
    });

    // NPC hit by vehicle
    this.physics.add.overlap(this.npcGroup, this.vehicleGroup, (npc, vehicle) => {
      if (!npc.isAlive || !vehicle.active) return;
      const speed = Math.sqrt(vehicle.body.velocity.x ** 2 + vehicle.body.velocity.y ** 2);
      if (speed > 60) {
        npc.takeDamage(Math.floor(speed / 15), this.player);
      }
    });

    // Pickup collection
    this.physics.add.overlap(this.player, this.pickupGroup, (player, pickup) => {
      if (pickup.active) {
        player.addWeapon(pickup.weaponId, WEAPON_DEFS[pickup.weaponId].defaultAmmo);
        this._showFloatingText(pickup.x, pickup.y, '+' + WEAPON_DEFS[pickup.weaponId].displayName, '#ffdd44');
        pickup.destroy();
      }
    });

    // --- 10. Event listeners ---
    this.events.on('player_try_enter_vehicle', this._onTryEnterVehicle, this);
    this.events.on('player_exit_vehicle', (player) => player.exitVehicle(), this);
    this.events.on('explosion', (data) => {
      this.weaponSystem.spawnExplosion(data.x, data.y);
      // Damage things nearby
      this._explosionDamage(data.x, data.y, 80, 60);
    }, this);
    this.events.on('npc_died', this._onNPCDied, this);
    this.events.on('police_died', (cop) => this.wantedSystem.policeDied(cop), this);
    this.events.on('money_dropped', (data) => {
      this.player.addMoney(data.amount);
      this._showFloatingText(data.x, data.y, '+$' + data.amount, '#ffdd44');
    }, this);
    this.events.on('player_melee', this._onMeleeAttack, this);

    // --- 11. Launch HUD ---
    this.scene.launch('HUDScene');

    // --- 12. Background music (simple oscillator) ---
    this._startAmbientSound();
  }

  update(time, delta) {
    if (!this.player) return;

    this.player.update(time, delta);

    this.vehicleGroup.getChildren().forEach(v => v.update(time, delta));

    this.npcGroup.getChildren().forEach(npc => {
      if (npc.update) npc.update(time, delta);
    });

    // Alert nearby pedestrians to flee from gunfire (if player recently fired)
    if (this.player.lastFiredAt > time - 200) {
      this._alertNearbyPedestrians(this.player.x, this.player.y, 250);
    }

    this.miniMap.update(this, this.player, this.npcGroup, this.vehicleGroup);
  }

  _spawnVehicles() {
    SPAWN_POINTS.vehicles.forEach(({ tx, ty, type }) => {
      const w = this.mapSystem.tileToWorld(tx, ty);
      const vehicle = new Vehicle(this, w.x, w.y, type);
      this.vehicleGroup.add(vehicle);
    });
  }

  _spawnNPCs() {
    // Pedestrians
    SPAWN_POINTS.pedestrians.forEach(({ tx, ty }) => {
      const w = this.mapSystem.tileToWorld(tx, ty);
      const ped = new Pedestrian(this, w.x, w.y);
      this.npcGroup.add(ped);
    });

    // Gang members
    SPAWN_POINTS.gangMembers.forEach(({ tx, ty, gang }) => {
      const w = this.mapSystem.tileToWorld(tx, ty);
      const member = new GangMember(this, w.x, w.y, gang);
      member.setPlayerRef(this.player);
      this.npcGroup.add(member);
    });
  }

  _spawnPhoneBooths() {
    SPAWN_POINTS.phoneBooths.forEach(({ tx, ty, missionId }) => {
      const w = this.mapSystem.tileToWorld(tx, ty);
      const booth = this.add.image(w.x, w.y, 'phone_booth').setDepth(6);

      // Proximity trigger
      const zone = this.add.zone(w.x, w.y, 48, 48);
      this.physics.add.existing(zone, true);

      this.physics.add.overlap(this.player, zone, () => {
        if (!this._missionShown) {
          this._missionShown = true;
          this._showMissionPrompt(missionId, w.x, w.y);
          this.time.delayedCall(8000, () => { this._missionShown = false; });
        }
      });
    });
    this._missionShown = false;
  }

  _showMissionPrompt(missionId, x, y) {
    const missions = {
      loonies_1: 'LOONIES: Eliminate the Zaibatsu lookout!\n(Kill the red-suited man near the east road)',
      zaibatsu_1: 'ZAIBATSU: Steal the Redneck vehicle!\n(Carjack the truck near the south)',
      rednecks_1: 'REDNECKS: Cause some mayhem!\n(Get a 2-star wanted level)',
    };
    const text = missions[missionId] || 'Mission available...';
    const popup = this.add.text(x, y - 48, text, {
      fontSize: '11px', color: '#ffffff', fontFamily: 'monospace',
      backgroundColor: '#000000cc',
      padding: { x: 8, y: 6 },
      wordWrap: { width: 220 },
    }).setDepth(50).setOrigin(0.5, 1);

    this.tweens.add({
      targets: popup, alpha: 0, y: y - 80,
      delay: 6000, duration: 1500,
      onComplete: () => popup.destroy(),
    });
  }

  _onTryEnterVehicle(player) {
    let closest = null;
    let minDist = 60;

    this.vehicleGroup.getChildren().forEach(vehicle => {
      if (!vehicle.active || !vehicle.canEnter()) return;
      const dist = Phaser.Math.Distance.Between(player.x, player.y, vehicle.x, vehicle.y);
      if (dist < minDist) {
        minDist = dist;
        closest = vehicle;
      }
    });

    if (closest) {
      player.enterVehicle(closest);
    }
  }

  _onNPCDied(data) {
    const { npc, attacker } = data;
    // Scatter some spent brass
    for (let i = 0; i < 3; i++) {
      const dot = this.add.circle(
        npc.x + Phaser.Math.Between(-8, 8),
        npc.y + Phaser.Math.Between(-8, 8),
        2, 0xcc9900, 0.6
      ).setDepth(4);
      this.time.delayedCall(10000, () => { if (dot.active) dot.destroy(); });
    }
  }

  _onMeleeAttack(player) {
    // Damage nearby NPCs
    this.npcGroup.getChildren().forEach(npc => {
      if (!npc.isAlive) return;
      const dist = Phaser.Math.Distance.Between(player.x, player.y, npc.x, npc.y);
      if (dist < 32) {
        npc.takeDamage(WEAPON_DEFS.fists.damage, player);
      }
    });
  }

  _explosionDamage(cx, cy, radius, damage) {
    // Damage player
    const pd = Phaser.Math.Distance.Between(cx, cy, this.player.x, this.player.y);
    if (pd < radius) this.player.takeDamage(Math.floor(damage * (1 - pd / radius)));

    // Damage NPCs
    this.npcGroup.getChildren().forEach(npc => {
      if (!npc.isAlive) return;
      const d = Phaser.Math.Distance.Between(cx, cy, npc.x, npc.y);
      if (d < radius) npc.takeDamage(Math.floor(damage * (1 - d / radius)), this.player);
    });
  }

  _alertNearbyPedestrians(x, y, radius) {
    this.npcGroup.getChildren().forEach(npc => {
      if (!npc.isAlive || !(npc instanceof Pedestrian)) return;
      const dist = Phaser.Math.Distance.Between(x, y, npc.x, npc.y);
      if (dist < radius && npc.aiState !== 'flee') {
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
      targets: t, y: y - 50, alpha: 0,
      duration: 1200, ease: 'Cubic.easeOut',
      onComplete: () => t.destroy(),
    });
  }

  _startAmbientSound() {
    // No audio files — silently skip
  }
}
