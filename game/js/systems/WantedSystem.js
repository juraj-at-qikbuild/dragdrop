class WantedSystem {
  constructor() {
    this.scene = null;
    this.level = 0;
    this.crimeHeat = 0;
    this.decayTimer = 0;
    this.policeUnitsActive = [];
    this.playerInSight = false;
    this.player = null;
    this.npcGroup = null;
    this._pendingSpawns = 0;
    this._spawnTimers = [];

    // Heat → star thresholds
    this.heatThresholds = [0, 10, 30, 60, 100, 155, 225];
    this.maxPoliceByLevel = [0, 1, 1, 2, 3, 5, 6];
  }

  create(scene, player, npcGroup) {
    this.scene = scene;
    this.player = player;
    this.npcGroup = npcGroup;

    scene.events.on('crime_committed', this._onCrime, this);

    // 1-second tick for decay
    scene.time.addEvent({
      delay: 1000,
      loop: true,
      callback: this._tick,
      callbackScope: this,
    });

    scene.registry.set('wantedLevel', 0);
    return this;
  }

  _onCrime(data) {
    const heat = {
      assault_civilian: 5,
      killed_civilian:  18,
      killed_police:    35,
      car_theft:        8,
    }[data.type] || 5;

    this.crimeHeat += heat;
    this.decayTimer = 7; // seconds before decay starts

    const oldLevel = this.level;
    this._updateLevel();

    if (this.level > oldLevel && this.scene.soundSystem) {
      this.scene.soundSystem.play('star_up');
    }
  }

  _tick() {
    if (!this.scene || !this.player || !this.player.isAlive) return;

    // Clean dead police refs
    this.policeUnitsActive = this.policeUnitsActive.filter(c => c && c.active && c.isAlive);

    this._updateSightCheck();

    if (this.decayTimer > 0) {
      this.decayTimer--;
      return;
    }

    // Decay faster when player is hidden
    const decayRate = this.playerInSight ? 1 : 5;
    this.crimeHeat = Math.max(0, this.crimeHeat - decayRate);
    this._updateLevel();

    // Siren: start when wanted, stop when clear
    if (this.scene.soundSystem) {
      if (this.level >= 1) this.scene.soundSystem.startSiren();
      else this.scene.soundSystem.stopSiren();
    }
  }

  _updateSightCheck() {
    if (!this.policeUnitsActive.length) {
      this.playerInSight = false;
      return;
    }
    this.playerInSight = this.policeUnitsActive.some(cop => {
      if (!cop.active || !cop.isAlive) return false;
      return Phaser.Math.Distance.Between(cop.x, cop.y, this.player.x, this.player.y) < 320;
    });
  }

  _updateLevel() {
    let newLevel = 0;
    for (let i = this.heatThresholds.length - 1; i >= 0; i--) {
      if (this.crimeHeat >= this.heatThresholds[i]) { newLevel = i; break; }
    }
    newLevel = Math.min(newLevel, 6);

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
    const liveCops = this.policeUnitsActive.filter(c => c.active && c.isAlive).length;
    const toSpawn = Math.max(0, maxCops - liveCops - this._pendingSpawns);

    for (let i = 0; i < toSpawn; i++) {
      this._pendingSpawns++;
      const timer = this.scene.time.delayedCall(i * 1200, () => {
        this._pendingSpawns = Math.max(0, this._pendingSpawns - 1);
        if (!this.scene || !this.player.isAlive) return;
        if (this.level === 0) return;

        const pos = this._getOffscreenSpawnPos();
        if (!pos) return;

        const cop = new PoliceOfficer(this.scene, pos.x, pos.y);
        cop.setPlayerRef(this.player);
        this.npcGroup.add(cop);
        this.policeUnitsActive.push(cop);

        // Police car at level 3+
        if (this.level >= 3 && this.scene.vehicleGroup) {
          const car = new Vehicle(this.scene, pos.x + 36, pos.y, 'police');
          this.scene.vehicleGroup.add(car);
        }
      });
      this._spawnTimers.push(timer);
    }
  }

  _despawnExcessPolice() {
    const maxCops = this.maxPoliceByLevel[this.level] || 0;
    const excess = this.policeUnitsActive.length - maxCops;
    for (let i = 0; i < excess; i++) {
      const cop = this.policeUnitsActive.pop();
      if (cop && cop.active) {
        cop.aiState = 'wander';
        cop.alertedBy = null;
        this.scene.time.delayedCall(4000, () => { if (cop && cop.active) cop.destroy(); });
      }
    }
  }

  _getOffscreenSpawnPos() {
    const cam = this.scene.cameras.main;
    const margin = 100;

    for (let attempt = 0; attempt < 8; attempt++) {
      const side = Math.floor(Math.random() * 4);
      let x, y;
      if (side === 0)      { x = cam.scrollX - margin;              y = cam.scrollY + Math.random() * cam.height; }
      else if (side === 1) { x = cam.scrollX + cam.width + margin;  y = cam.scrollY + Math.random() * cam.height; }
      else if (side === 2) { x = cam.scrollX + Math.random() * cam.width; y = cam.scrollY - margin; }
      else                 { x = cam.scrollX + Math.random() * cam.width; y = cam.scrollY + cam.height + margin; }

      x = Phaser.Math.Clamp(x, MAP_TILE_SIZE, MAP_WORLD_WIDTH - MAP_TILE_SIZE);
      y = Phaser.Math.Clamp(y, MAP_TILE_SIZE, MAP_WORLD_HEIGHT - MAP_TILE_SIZE);
      const tx = Math.floor(x / MAP_TILE_SIZE);
      const ty = Math.floor(y / MAP_TILE_SIZE);
      const id = MAP_DATA[ty] && MAP_DATA[ty][tx];
      if (id !== TILE.BUILDING) return { x, y };
    }
    return null;
  }

  policeDied(cop) {
    this.policeUnitsActive = this.policeUnitsActive.filter(c => c !== cop);
    this._onCrime({ type: 'killed_police' });
  }
}
