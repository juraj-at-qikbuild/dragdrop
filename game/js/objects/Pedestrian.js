class Pedestrian extends NPC {
  constructor(scene, x, y) {
    super(scene, x, y, 'npc_pedestrian', {
      type: 'pedestrian',
      health: 40,
      speed: 60,
    });
    this.aiState = 'wander';
    this.targetPosition = this._pickRandomNearbyTile();
    this.stateTimer = 0;
    this._fleeTarget = null;
  }

  _runAI(time) {
    switch (this.aiState) {
      case 'wander': this._doWander(time); break;
      case 'idle':   this._doIdle(time); break;
      case 'flee':   this._doFlee(time); break;
    }
  }

  _doWander(time) {
    if (!this.targetPosition) {
      this.targetPosition = this._pickRandomNearbyTile();
    }
    const dist = Phaser.Math.Distance.Between(this.x, this.y, this.targetPosition.x, this.targetPosition.y);
    if (dist < 16) {
      // Arrived — idle briefly then pick new target
      this._stopMoving();
      this.aiState = 'idle';
      this.stateTimer = time + Phaser.Math.Between(800, 2500);
    } else {
      this._moveToward(this.targetPosition.x, this.targetPosition.y, this.speed);
    }
  }

  _doIdle(time) {
    this._stopMoving();
    if (time > this.stateTimer) {
      this.aiState = 'wander';
      this.targetPosition = this._pickRandomNearbyTile();
    }
  }

  _doFlee(time) {
    if (!this._fleeTarget) { this.aiState = 'wander'; return; }
    // Flee away from target
    const angle = Phaser.Math.Angle.Between(this._fleeTarget.x, this._fleeTarget.y, this.x, this.y);
    const fleeX = this.x + Math.cos(angle) * 100;
    const fleeY = this.y + Math.sin(angle) * 100;
    this._moveToward(fleeX, fleeY, this.speed * 1.4);

    if (time > this.stateTimer) {
      this.aiState = 'wander';
      this._fleeTarget = null;
    }
  }

  // Called when gunshots are heard nearby
  startFleeing(fromTarget) {
    this._fleeTarget = fromTarget;
    this.aiState = 'flee';
    this.stateTimer = this.scene.time.now + 5000;
  }

  _die(attacker) {
    super._die(attacker);
    // Civilians dying triggers wanted level
    this.scene.events.emit('crime_committed', { type: 'killed_civilian', x: this.x, y: this.y });
  }
}
