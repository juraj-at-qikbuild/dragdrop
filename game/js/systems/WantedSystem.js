class WantedSystem {
  constructor() {
    this.scene = null;
    this.level = 0;
    this.crimeHeat = 0;
    this.decayTimer = 0;
    this.policeUnitsActive = [];
    this.playerInSight = false;
    this.lastSightCheck = 0;
    this.player = null;
    this.npcGroup = null;

    // Heat thresholds for each star level
    this.heatThresholds = [0, 10, 30, 60, 100, 150, 220];
    this.maxPoliceByLevel = [0, 1, 1, 2, 3, 4, 6];
  }

  create(scene, player, npcGroup) {
    this.scene = scene;
    this.player = player;
    this.npcGroup = npcGroup;

    // Listen for crimes
    scene.events.on('crime_committed', this._onCrime, this);

    // Tick every second
    scene.time.addEvent({
      delay: 1000,
      loop: true,
      callback: this._tick,
      callbackScope: this,
    });

    // Update registry
    scene.registry.set('wantedLevel', 0);

    return this;
  }

  _onCrime(data) {
    const heatByType = {
      assault_civilian: 5,
      killed_civilian: 15,
      killed_police: 30,
      car_theft: 8,
    };
    const heat = heatByType[data.type] || 5;
    this.crimeHeat += heat;
    this.decayTimer = 8000; // reset decay window

    this._updateLevel();
  }

  _tick() {
    if (!this.scene || !this.player || !this.player.isAlive) return;

    // Check if police can see player
    this._updateSightCheck();

    if (this.decayTimer > 0) {
      this.decayTimer -= 1000;
      return;
    }

    // Decay heat
    const decayRate = this.playerInSight ? 1 : 4;
    this.crimeHeat = Math.max(0, this.crimeHeat - decayRate);
    this._updateLevel();
  }

  _updateSightCheck() {
    if (!this.policeUnitsActive.length) {
      this.playerInSight = false;
      return;
    }
    // Sight = any active police within 300px of player
    this.playerInSight = this.policeUnitsActive.some(cop => {
      if (!cop.active || !cop.isAlive) return false;
      const dist = Phaser.Math.Distance.Between(cop.x, cop.y, this.player.x, this.player.y);
      return dist < 300;
    });
  }

  _updateLevel() {
    let newLevel = 0;
    for (let i = this.heatThresholds.length - 1; i >= 0; i--) {
      if (this.crimeHeat >= this.heatThresholds[i]) {
        newLevel = i;
        break;
      }
    }

    if (newLevel !== this.level) {
      const oldLevel = this.level;
      this.level = newLevel;
      this.scene.registry.set('wantedLevel', newLevel);

      if (newLevel > oldLevel) {
        this._spawnPolice();
      } else {
        this._despawnExcessPolice();
      }
    }
  }

  _spawnPolice() {
    const maxCops = this.maxPoliceByLevel[this.level] || 0;
    const currentCops = this.policeUnitsActive.filter(c => c.active && c.isAlive).length;
    const toSpawn = maxCops - currentCops;

    for (let i = 0; i < toSpawn; i++) {
      this.scene.time.delayedCall(i * 800, () => {
        const spawnPos = this._getOffscreenSpawnPos();
        if (!spawnPos) return;
        const cop = new PoliceOfficer(this.scene, spawnPos.x, spawnPos.y);
        cop.setPlayerRef(this.player);
        this.npcGroup.add(cop);
        this.policeUnitsActive.push(cop);

        // Also spawn a police car nearby at higher wanted levels
        if (this.level >= 3) {
          const vehicle = new Vehicle(this.scene, spawnPos.x + 30, spawnPos.y, 'police');
          this.scene.vehicleGroup.add(vehicle);
        }
      });
    }
  }

  _despawnExcessPolice() {
    // Clean up dead/destroyed refs
    this.policeUnitsActive = this.policeUnitsActive.filter(c => c.active && c.isAlive);

    const maxCops = this.maxPoliceByLevel[this.level] || 0;
    while (this.policeUnitsActive.length > maxCops) {
      const cop = this.policeUnitsActive.pop();
      if (cop && cop.active) {
        cop.aiState = 'wander';
        cop.alertedBy = null;
        this.scene.time.delayedCall(5000, () => {
          if (cop.active) cop.destroy();
        });
      }
    }
  }

  _getOffscreenSpawnPos() {
    const cam = this.scene.cameras.main;
    const margin = 80;
    const side = Math.floor(Math.random() * 4);
    let x, y;

    if (side === 0) { x = cam.scrollX - margin; y = cam.scrollY + Math.random() * cam.height; }
    else if (side === 1) { x = cam.scrollX + cam.width + margin; y = cam.scrollY + Math.random() * cam.height; }
    else if (side === 2) { x = cam.scrollX + Math.random() * cam.width; y = cam.scrollY - margin; }
    else { x = cam.scrollX + Math.random() * cam.width; y = cam.scrollY + cam.height + margin; }

    // Clamp to world bounds and ensure not inside building
    x = Phaser.Math.Clamp(x, MAP_TILE_SIZE, MAP_WORLD_WIDTH - MAP_TILE_SIZE);
    y = Phaser.Math.Clamp(y, MAP_TILE_SIZE, MAP_WORLD_HEIGHT - MAP_TILE_SIZE);
    const tx = Math.floor(x / MAP_TILE_SIZE);
    const ty = Math.floor(y / MAP_TILE_SIZE);
    const id = MAP_DATA[ty] && MAP_DATA[ty][tx];
    if (id === TILE.BUILDING) return null;
    return { x, y };
  }

  // Called when a police NPC dies
  policeDied(cop) {
    this.policeUnitsActive = this.policeUnitsActive.filter(c => c !== cop);
    this._onCrime({ type: 'killed_police' });
  }
}
