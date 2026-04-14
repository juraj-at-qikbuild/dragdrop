class HUDScene extends Phaser.Scene {
  constructor() {
    super({ key: 'HUDScene' });
  }

  create() {
    const W = this.scale.width;
    const H = this.scale.height;
    const reg = this.registry;

    // --- Health bar ---
    const hX = 12, hY = 12;
    this.add.image(hX + 8, hY + 8, 'icon_health').setScrollFactor(0).setDepth(200);
    this.healthBg = this.add.rectangle(hX + 90, hY + 8, 120, 12, 0x440000)
      .setScrollFactor(0).setDepth(200);
    this.healthBar = this.add.rectangle(hX + 30, hY + 8, 120, 10, 0xff3333)
      .setScrollFactor(0).setDepth(201).setOrigin(0, 0.5);
    this.healthText = this.add.text(hX + 155, hY + 2, '100', {
      fontSize: '12px', color: '#ff9999', fontFamily: 'monospace'
    }).setScrollFactor(0).setDepth(201);

    // --- Armor bar ---
    const aX = 12, aY = 32;
    this.add.image(aX + 8, aY + 8, 'icon_armor').setScrollFactor(0).setDepth(200);
    this.armorBg = this.add.rectangle(aX + 90, aY + 8, 120, 12, 0x001133)
      .setScrollFactor(0).setDepth(200);
    this.armorBar = this.add.rectangle(aX + 30, aY + 8, 0, 10, 0x33aaff)
      .setScrollFactor(0).setDepth(201).setOrigin(0, 0.5);
    this.armorText = this.add.text(aX + 155, aY + 2, '0', {
      fontSize: '12px', color: '#99ccff', fontFamily: 'monospace'
    }).setScrollFactor(0).setDepth(201);

    // --- Money ---
    this.moneyText = this.add.text(12, 56, '$0', {
      fontSize: '16px', color: '#ffdd44', fontFamily: 'monospace',
      stroke: '#000000', strokeThickness: 3,
    }).setScrollFactor(0).setDepth(201);

    // --- Wanted stars (top right) ---
    this.stars = [];
    for (let i = 0; i < 6; i++) {
      const star = this.add.image(W - 12 - (5 - i) * 20, 18, 'star_empty')
        .setScrollFactor(0).setDepth(201).setScale(1.1);
      this.stars.push(star);
    }

    // --- Weapon info (bottom left) ---
    this.weaponText = this.add.text(12, H - 44, 'FISTS', {
      fontSize: '14px', color: '#ffffff', fontFamily: 'monospace',
      stroke: '#000000', strokeThickness: 3,
    }).setScrollFactor(0).setDepth(201);
    this.ammoText = this.add.text(12, H - 26, '', {
      fontSize: '12px', color: '#aaaaaa', fontFamily: 'monospace',
      stroke: '#000000', strokeThickness: 2,
    }).setScrollFactor(0).setDepth(201);

    // --- Controls hint (bottom center, fades after 5s) ---
    const hint = this.add.text(W / 2, H - 20, 'WASD: Move | Mouse: Aim | Click: Shoot | F: Enter/Exit Vehicle | 1-9: Switch Weapon', {
      fontSize: '10px', color: '#888888', fontFamily: 'monospace',
    }).setScrollFactor(0).setDepth(201).setOrigin(0.5, 1);
    this.time.delayedCall(6000, () => {
      this.tweens.add({ targets: hint, alpha: 0, duration: 2000 });
    });

    // --- Listen for registry changes ---
    this.registry.events.on('changedata', this._onRegistryChange, this);

    // Initial sync
    this._refresh();
  }

  _onRegistryChange(parent, key, value) {
    this._refresh();
  }

  _refresh() {
    const reg = this.registry;

    const health = reg.get('playerHealth') ?? 100;
    const maxHealth = reg.get('playerMaxHealth') ?? 100;
    const armor = reg.get('playerArmor') ?? 0;
    const maxArmor = reg.get('playerMaxArmor') ?? 100;
    const money = reg.get('playerMoney') ?? 0;
    const wanted = reg.get('wantedLevel') ?? 0;
    const weaponId = reg.get('playerWeapon') ?? 'fists';
    const ammo = reg.get('playerAmmo') ?? 0;

    // Health bar (max width = 120)
    const hp = Math.max(0, health / maxHealth);
    this.healthBar.width = hp * 120;
    this.healthText.setText(String(Math.ceil(health)));
    this.healthBar.x = 12 + 30;

    // Armor bar
    const ap = Math.max(0, armor / maxArmor);
    this.armorBar.width = ap * 120;
    this.armorText.setText(String(Math.ceil(armor)));

    // Money
    this.moneyText.setText('$' + money);

    // Wanted stars
    for (let i = 0; i < 6; i++) {
      this.stars[i].setTexture(i < wanted ? 'star_filled' : 'star_empty');
    }

    // Weapon
    const def = WEAPON_DEFS[weaponId];
    this.weaponText.setText(def ? def.displayName.toUpperCase() : 'FISTS');
    if (ammo === Infinity || weaponId === 'fists') {
      this.ammoText.setText('');
    } else {
      this.ammoText.setText('Ammo: ' + ammo);
    }
  }
}
