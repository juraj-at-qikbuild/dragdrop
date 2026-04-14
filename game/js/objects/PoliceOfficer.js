class PoliceOfficer extends NPC {
  constructor(scene, x, y) {
    super(scene, x, y, 'npc_police', {
      type: 'police',
      health: 80,
      speed: 100,
      weaponId: 'pistol',
      fireRange: 180,
    });
    this.player = null;
    this.aggroRange = 400; // Police always chase if wanted level > 0
    this.aiState = 'chase';
    this._lastWantedCheck = 0;
  }

  setPlayerRef(player) { this.player = player; }

  _runAI(time) {
    if (!this.player || !this.player.isAlive) {
      this.aiState = 'wander';
      this._doWander(time);
      return;
    }

    const wantedLevel = this.scene.registry.get('wantedLevel') || 0;
    if (wantedLevel === 0) {
      this.aiState = 'wander';
      this._doWander(time);
      return;
    }

    const dist = Phaser.Math.Distance.Between(this.x, this.y, this.player.x, this.player.y);

    if (dist <= this.fireRange * 0.85) {
      this.aiState = 'attack';
    } else {
      this.aiState = 'chase';
    }

    switch (this.aiState) {
      case 'chase':  this._doChase(time, dist); break;
      case 'attack': this._doAttack(time); break;
      case 'wander': this._doWander(time); break;
    }
  }

  _doChase(time, dist) {
    this._moveToward(this.player.x, this.player.y, this.speed);
  }

  _doAttack(time) {
    this._stopMoving();
    const angle = Phaser.Math.Angle.Between(this.x, this.y, this.player.x, this.player.y);
    this.setRotation(angle + Math.PI / 2);
    this._tryShootAt(this.player, time);
  }

  _doWander(time) {
    if (!this.targetPosition) {
      this.targetPosition = this._pickRandomNearbyTile();
    }
    const dist = Phaser.Math.Distance.Between(this.x, this.y, this.targetPosition.x, this.targetPosition.y);
    if (dist < 20) {
      this._stopMoving();
      this.targetPosition = null;
    } else {
      this._moveToward(this.targetPosition.x, this.targetPosition.y, this.speed * 0.5);
    }
  }

  _die(attacker) {
    super._die(attacker);
    this.scene.events.emit('police_died', this);
  }
}
