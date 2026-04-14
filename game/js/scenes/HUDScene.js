class HUDScene extends Phaser.Scene {
  constructor() {
    super({ key: 'HUDScene' });
  }

  create() {
    const W = this.scale.width;
    const H = this.scale.height;

    // --- Top-left panel: Health / Armor / Money ---
    const panelX = 10, panelY = 10;

    // Dark panel background
    this._topPanel = this.add.rectangle(panelX + 90, panelY + 38, 190, 76, 0x000000, 0.65)
      .setScrollFactor(0).setDepth(199).setOrigin(0.5);

    // Health label + bar
    this.add.text(panelX + 4, panelY + 6, 'HP', {
      fontSize: '11px', color: '#ff6666', fontFamily: 'monospace', fontStyle: 'bold'
    }).setScrollFactor(0).setDepth(201);

    const barBgH = this.add.rectangle(panelX + 24 + 64, panelY + 12, 130, 14, 0x440000)
      .setScrollFactor(0).setDepth(200);
    this.healthBar = this.add.rectangle(panelX + 24, panelY + 12, 128, 12, 0xff3333)
      .setScrollFactor(0).setDepth(201).setOrigin(0, 0.5);
    this.healthText = this.add.text(panelX + 160, panelY + 6, '100', {
      fontSize: '11px', color: '#ffaaaa', fontFamily: 'monospace'
    }).setScrollFactor(0).setDepth(201);

    // Armor label + bar
    this.add.text(panelX + 4, panelY + 28, 'AR', {
      fontSize: '11px', color: '#66aaff', fontFamily: 'monospace', fontStyle: 'bold'
    }).setScrollFactor(0).setDepth(201);

    const barBgA = this.add.rectangle(panelX + 24 + 64, panelY + 34, 130, 14, 0x001133)
      .setScrollFactor(0).setDepth(200);
    this.armorBar = this.add.rectangle(panelX + 24, panelY + 34, 0, 12, 0x33aaff)
      .setScrollFactor(0).setDepth(201).setOrigin(0, 0.5);
    this.armorText = this.add.text(panelX + 160, panelY + 28, '0', {
      fontSize: '11px', color: '#aaccff', fontFamily: 'monospace'
    }).setScrollFactor(0).setDepth(201);

    // Money
    this.moneyText = this.add.text(panelX + 4, panelY + 52, '$0', {
      fontSize: '15px', color: '#ffdd44', fontFamily: 'monospace',
      stroke: '#000000', strokeThickness: 2,
    }).setScrollFactor(0).setDepth(201);

    // --- Top-right: Wanted stars ---
    this.stars = [];
    for (let i = 0; i < 6; i++) {
      const star = this.add.image(W - 14 - (5 - i) * 22, 18, 'star_empty')
        .setScrollFactor(0).setDepth(201).setScale(1.1);
      this.stars.push(star);
    }
    this.add.rectangle(W - 14 - 5 * 22 - 8, 18, 148, 24, 0x000000, 0.6)
      .setScrollFactor(0).setDepth(199).setOrigin(0, 0.5);

    // --- Bottom-left: Weapon slots ---
    this._weaponSlots = [];
    const slotY = H - 54;
    const slotW = 52, slotH = 46;
    const maxSlots = 5; // show up to 5 slots

    // Background strip for weapon slots
    const stripW = maxSlots * (slotW + 2) + 6;
    this.add.rectangle(6 + stripW / 2, slotY + slotH / 2 + 2, stripW, slotH + 8, 0x000000, 0.65)
      .setScrollFactor(0).setDepth(199).setOrigin(0.5);

    for (let i = 0; i < maxSlots; i++) {
      const sx = 8 + i * (slotW + 2);
      const bg = this.add.rectangle(sx + slotW / 2, slotY + slotH / 2 + 2, slotW, slotH, 0x222222, 0.8)
        .setScrollFactor(0).setDepth(200).setOrigin(0.5);
      const icon = this.add.image(sx + slotW / 2, slotY + 14, 'pickup_pistol')
        .setScrollFactor(0).setDepth(201).setVisible(false);
      const nameText = this.add.text(sx + slotW / 2, slotY + 28, '', {
        fontSize: '9px', color: '#aaaaaa', fontFamily: 'monospace'
      }).setScrollFactor(0).setDepth(201).setOrigin(0.5, 0);
      const ammoText = this.add.text(sx + slotW / 2, slotY + 38, '', {
        fontSize: '9px', color: '#ffdd44', fontFamily: 'monospace'
      }).setScrollFactor(0).setDepth(201).setOrigin(0.5, 0);
      const numKey = this.add.text(sx + 3, slotY + 3, String(i + 1), {
        fontSize: '9px', color: '#555555', fontFamily: 'monospace'
      }).setScrollFactor(0).setDepth(201);

      this._weaponSlots.push({ bg, icon, nameText, ammoText, numKey });
    }

    // Current weapon highlight border
    this._slotHighlight = this.add.rectangle(8 + slotW / 2, slotY + slotH / 2 + 2, slotW, slotH, 0x000000, 0)
      .setScrollFactor(0).setDepth(202).setOrigin(0.5)
      .setStrokeStyle(2, 0xffdd44);

    // In-vehicle indicator
    this._vehicleLabel = this.add.text(W / 2, H - 18, 'DRIVING — WASD to steer | F to exit', {
      fontSize: '11px', color: '#aaffaa', fontFamily: 'monospace',
      stroke: '#000000', strokeThickness: 2,
    }).setScrollFactor(0).setDepth(201).setOrigin(0.5, 1).setVisible(false);

    // --- Controls hint (fades after 7s) ---
    const hint = this.add.text(W / 2, H - 20, 'WASD: Move  |  Mouse: Aim  |  Click: Shoot  |  F: Enter/Exit Car  |  Scroll: Switch Weapon', {
      fontSize: '10px', color: '#666666', fontFamily: 'monospace',
    }).setScrollFactor(0).setDepth(201).setOrigin(0.5, 1);
    this.time.delayedCall(7000, () => {
      this.tweens.add({ targets: hint, alpha: 0, duration: 2000, onComplete: () => hint.destroy() });
    });

    // --- Registry listener ---
    this.registry.events.on('changedata', this._refresh, this);
    this._refresh();
  }

  _refresh() {
    const reg = this.registry;
    const health    = reg.get('playerHealth')    ?? 100;
    const maxHealth = reg.get('playerMaxHealth') ?? 100;
    const armor     = reg.get('playerArmor')     ?? 0;
    const maxArmor  = reg.get('playerMaxArmor')  ?? 100;
    const money     = reg.get('playerMoney')     ?? 0;
    const wanted    = reg.get('wantedLevel')     ?? 0;
    const weaponId  = reg.get('playerWeapon')    ?? 'fists';
    const ammo      = reg.get('playerAmmo')      ?? 0;
    const weapons   = reg.get('playerWeapons')   ?? ['fists'];
    const weaponIdx = reg.get('playerWeaponIndex') ?? 0;
    const inVehicle = reg.get('inVehicle')       ?? false;

    // Health bar (max width 128)
    const hp = Math.max(0, health / maxHealth);
    this.healthBar.width = hp * 128;
    this.healthBar.x = 10 + 24;
    // Color shifts: green → yellow → red
    const hColor = hp > 0.5 ? 0x33cc33 : hp > 0.25 ? 0xffaa00 : 0xff2222;
    this.healthBar.setFillStyle(hColor);
    this.healthText.setText(String(Math.ceil(health)));

    // Armor bar
    const ap = Math.max(0, armor / maxArmor);
    this.armorBar.width = ap * 128;
    this.armorBar.x = 10 + 24;
    this.armorText.setText(String(Math.ceil(armor)));

    // Money
    this.moneyText.setText('$' + money.toLocaleString());

    // Wanted stars
    for (let i = 0; i < 6; i++) {
      this.stars[i].setTexture(i < wanted ? 'star_filled' : 'star_empty');
      this.stars[i].setAlpha(i < wanted ? 1 : 0.35);
    }

    // Weapon slots
    const iconMap = {
      fists: null, pistol: 'pickup_pistol', shotgun: 'pickup_shotgun', machineGun: 'pickup_machineGun',
    };
    for (let i = 0; i < this._weaponSlots.length; i++) {
      const slot = this._weaponSlots[i];
      if (i < weapons.length) {
        const wid = weapons[i];
        const def = WEAPON_DEFS[wid];
        const isCurrent = (i === weaponIdx);

        slot.bg.setAlpha(isCurrent ? 0.95 : 0.5);
        slot.nameText.setText(def ? def.displayName.substring(0, 6).toUpperCase() : wid.toUpperCase().substring(0,6));
        slot.nameText.setColor(isCurrent ? '#ffffff' : '#777777');

        const wAmmo = reg.get('playerAmmo') ?? 0;
        if (isCurrent) {
          slot.ammoText.setText(wAmmo === Infinity ? '∞' : String(wAmmo));
        } else {
          slot.ammoText.setText('');
        }

        if (iconMap[wid]) {
          slot.icon.setTexture(iconMap[wid]).setVisible(true).setAlpha(isCurrent ? 1 : 0.5);
        } else {
          slot.icon.setVisible(false);
          slot.nameText.setY(slot.nameText.y - 0); // fists: just show name
        }
      } else {
        slot.bg.setAlpha(0.2);
        slot.icon.setVisible(false);
        slot.nameText.setText('');
        slot.ammoText.setText('');
      }
    }

    // Highlight border on active slot
    if (weaponIdx < this._weaponSlots.length) {
      const sx = 8 + weaponIdx * 54;
      this._slotHighlight.x = sx + 26;
    }

    // In-vehicle indicator
    this._vehicleLabel.setVisible(inVehicle);
  }
}
