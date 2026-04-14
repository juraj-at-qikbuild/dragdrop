class Bullet extends Phaser.Physics.Arcade.Image {
  constructor(scene, x, y) {
    super(scene, x, y, 'bullet');
    this.startX = 0;
    this.startY = 0;
    this.range = 400;
    this.damage = 25;
    this.owner = 'player'; // 'player' | 'npc'
  }

  fire(x, y, angle, speed, range, damage, owner = 'player') {
    this.setActive(true);
    this.setVisible(true);
    this.setPosition(x, y);
    this.setRotation(angle);
    this.startX = x;
    this.startY = y;
    this.range = range;
    this.damage = damage;
    this.owner = owner;

    this.scene.physics.velocityFromRotation(angle, speed, this.body.velocity);
  }

  preUpdate(time, delta) {
    super.preUpdate(time, delta);
    if (!this.active) return;

    const dist = Phaser.Math.Distance.Between(this.startX, this.startY, this.x, this.y);
    if (dist > this.range) {
      this.deactivate();
    }
  }

  deactivate() {
    this.setActive(false);
    this.setVisible(false);
    this.body.stop();
  }
}
