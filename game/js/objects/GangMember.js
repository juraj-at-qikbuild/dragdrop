class GangMember extends NPC {
  constructor(scene, x, y, gangId) {
    const textureMap = {
      loonies: 'npc_loonies',
      zaibatsu: 'npc_zaibatsu',
      rednecks: 'npc_rednecks',
    };
    super(scene, x, y, textureMap[gangId] || 'npc_loonies', {
      type: 'gang',
      health: 60,
      speed: 75,
      gangId,
      weaponId: 'pistol',
      fireRange: 160,
    });

    this.gangId = gangId;
    this.patrolOrigin = { x, y };
    this.patrolTarget = this._pickPatrolPoint();
    this.aggroRange = 200;
    this.aiState = 'patrol';
    this.player = null;
  }

  setPlayerRef(player) { this.player = player; }

  _runAI(time) {
    if (!this.player) return;

    const distToPlayer = Phaser.Math.Distance.Between(this.x, this.y, this.player.x, this.player.y);
    const isHostile = this._isHostileToPlayer();

    // Check if player is in aggro range and we're hostile
    if (isHostile && distToPlayer < this.aggroRange && this.player.isAlive) {
      if (this.aiState !== 'chase' && this.aiState !== 'attack') {
        this.aiState = 'chase';
      }
    }

    switch (this.aiState) {
      case 'patrol': this._doPatrol(time); break;
      case 'chase':  this._doChase(time, distToPlayer); break;
      case 'attack': this._doAttack(time); break;
      case 'idle':   this._doIdle(time); break;
    }
  }

  _isHostileToPlayer() {
    const rel = this.scene.registry.get('gangRelationships') || {};
    return (rel[this.gangId] || 0) < -20;
  }

  _doPatrol(time) {
    if (!this.patrolTarget) {
      this.patrolTarget = this._pickPatrolPoint();
    }
    const dist = Phaser.Math.Distance.Between(this.x, this.y, this.patrolTarget.x, this.patrolTarget.y);
    if (dist < 16) {
      this._stopMoving();
      this.aiState = 'idle';
      this.stateTimer = time + Phaser.Math.Between(1000, 3000);
    } else {
      this._moveToward(this.patrolTarget.x, this.patrolTarget.y, this.speed);
    }
  }

  _doIdle(time) {
    this._stopMoving();
    if (time > this.stateTimer) {
      this.patrolTarget = this._pickPatrolPoint();
      this.aiState = 'patrol';
    }
  }

  _doChase(time, distToPlayer) {
    if (!this.player || !this.player.isAlive) { this.aiState = 'patrol'; return; }

    if (distToPlayer <= this.fireRange * 0.85) {
      this.aiState = 'attack';
    } else {
      this._moveToward(this.player.x, this.player.y, this.speed);
      // Face player
      const angle = Phaser.Math.Angle.Between(this.x, this.y, this.player.x, this.player.y);
      this.setRotation(angle + Math.PI / 2);
    }
  }

  _doAttack(time) {
    if (!this.player || !this.player.isAlive) { this.aiState = 'patrol'; return; }
    const dist = Phaser.Math.Distance.Between(this.x, this.y, this.player.x, this.player.y);

    if (dist > this.fireRange * 1.2) {
      this.aiState = 'chase';
      return;
    }

    // Stop and shoot
    this._stopMoving();
    const angle = Phaser.Math.Angle.Between(this.x, this.y, this.player.x, this.player.y);
    this.setRotation(angle + Math.PI / 2);
    this._tryShootAt(this.player, time);
  }

  _pickPatrolPoint() {
    // Stay within 3 tiles of origin
    const range = 3;
    for (let i = 0; i < 8; i++) {
      const nx = this.patrolOrigin.x + (Math.random() * 2 - 1) * range * MAP_TILE_SIZE;
      const ny = this.patrolOrigin.y + (Math.random() * 2 - 1) * range * MAP_TILE_SIZE;
      const tx = Math.floor(nx / MAP_TILE_SIZE);
      const ty = Math.floor(ny / MAP_TILE_SIZE);
      if (tx >= 0 && ty >= 0 && tx < MAP_WIDTH && ty < MAP_HEIGHT) {
        const id = MAP_DATA[ty] && MAP_DATA[ty][tx];
        if (id !== TILE.BUILDING) return { x: nx, y: ny };
      }
    }
    return this.patrolOrigin;
  }

  _die(attacker) {
    super._die(attacker);
    // Killing a gang member worsens relationship
    const rel = this.scene.registry.get('gangRelationships') || {};
    rel[this.gangId] = (rel[this.gangId] || 0) - 15;
    this.scene.registry.set('gangRelationships', rel);
    this.scene.events.emit('crime_committed', { type: 'killed_civilian', x: this.x, y: this.y });
  }
}
