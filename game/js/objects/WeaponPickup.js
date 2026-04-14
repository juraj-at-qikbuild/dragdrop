class WeaponPickup extends Phaser.Physics.Arcade.Image {
  constructor(scene, x, y, weaponId) {
    const def = WEAPON_DEFS[weaponId];
    super(scene, x, y, def ? def.pickupTexture : 'pickup_pistol');
    scene.add.existing(this);
    scene.physics.add.existing(this, true); // static body

    this.weaponId = weaponId;
    this.setDepth(5);

    // Gentle bob animation
    scene.tweens.add({
      targets: this,
      y: y - 4,
      duration: 800,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  static createAll(scene, pickupGroup) {
    SPAWN_POINTS.weaponPickups.forEach(({ tx, ty, weaponId }) => {
      const wx = tx * MAP_TILE_SIZE + MAP_TILE_SIZE / 2;
      const wy = ty * MAP_TILE_SIZE + MAP_TILE_SIZE / 2;
      const pickup = new WeaponPickup(scene, wx, wy, weaponId);
      pickupGroup.add(pickup);
    });
  }
}
