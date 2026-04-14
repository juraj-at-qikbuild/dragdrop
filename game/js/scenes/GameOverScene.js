class GameOverScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameOverScene' });
  }

  create() {
    const W = this.scale.width;
    const H = this.scale.height;

    // Dark overlay
    this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.75);

    // Title
    this.add.text(W / 2, H / 2 - 70, 'WASTED', {
      fontSize: '56px',
      color: '#ff2200',
      fontFamily: 'monospace',
      stroke: '#000000',
      strokeThickness: 6,
    }).setOrigin(0.5);

    // Stats
    const money = this.registry.get('playerMoney') || 0;
    this.add.text(W / 2, H / 2, `Cash: $${money}`, {
      fontSize: '20px', color: '#ffdd44', fontFamily: 'monospace',
    }).setOrigin(0.5);

    // Restart button
    const btn = this.add.text(W / 2, H / 2 + 60, '[ PLAY AGAIN ]', {
      fontSize: '22px',
      color: '#ffffff',
      fontFamily: 'monospace',
      stroke: '#000000',
      strokeThickness: 4,
      backgroundColor: '#333333',
      padding: { x: 16, y: 8 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    btn.on('pointerover', () => btn.setStyle({ color: '#ffdd44' }));
    btn.on('pointerout', () => btn.setStyle({ color: '#ffffff' }));
    btn.on('pointerdown', () => {
      // Reset registry
      this.registry.set('playerHealth', 100);
      this.registry.set('playerArmor', 0);
      this.registry.set('playerMoney', 0);
      this.registry.set('wantedLevel', 0);
      this.registry.set('gangRelationships', { loonies: 0, zaibatsu: 0, rednecks: 0 });

      this.scene.stop('HUDScene');
      this.scene.start('GameScene');
    });

    // Flicker effect on WASTED text
    this.tweens.add({
      targets: this.children.list[1], // WASTED text
      alpha: { from: 1, to: 0.3 },
      duration: 300,
      yoyo: true,
      repeat: 3,
    });
  }
}
