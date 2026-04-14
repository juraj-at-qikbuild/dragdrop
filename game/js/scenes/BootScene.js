class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload() {
    // Loading bar
    const { width, height } = this.scale;
    const barBg = this.add.graphics();
    barBg.fillStyle(0x222222);
    barBg.fillRect(width / 2 - 200, height / 2 - 20, 400, 40);

    const bar = this.add.graphics();
    this.load.on('progress', (value) => {
      bar.clear();
      bar.fillStyle(0xff6600);
      bar.fillRect(width / 2 - 198, height / 2 - 18, 396 * value, 36);
    });

    const label = this.add.text(width / 2, height / 2 + 40, 'Loading...', {
      fontSize: '18px', color: '#ffffff', fontFamily: 'monospace'
    }).setOrigin(0.5);

    this.load.on('complete', () => { label.setText('Starting...'); });
  }

  create() {
    this._generateTextures();
    this._defineAnimations();
    this.scene.start('GameScene');
  }

  _generateTextures() {
    const g = this.add.graphics();

    // --- Tile textures (32x32) ---
    // Grass
    g.clear(); g.fillStyle(0x2d5a1b); g.fillRect(0, 0, 32, 32);
    g.fillStyle(0x3a6e24, 0.5); g.fillRect(4, 4, 8, 8); g.fillRect(18, 14, 6, 6);
    g.generateTexture('tile_grass', 32, 32);

    // Sidewalk
    g.clear(); g.fillStyle(0x9e9e9e); g.fillRect(0, 0, 32, 32);
    g.fillStyle(0x888888, 0.4); g.fillRect(0, 0, 16, 16); g.fillRect(16, 16, 16, 16);
    g.generateTexture('tile_sidewalk', 32, 32);

    // Road horizontal
    g.clear(); g.fillStyle(0x333333); g.fillRect(0, 0, 32, 32);
    g.fillStyle(0xffff00); g.fillRect(0, 15, 32, 2); // center line
    g.fillStyle(0x555555); g.fillRect(0, 0, 32, 2); g.fillRect(0, 30, 32, 2);
    g.generateTexture('tile_road_h', 32, 32);

    // Road vertical
    g.clear(); g.fillStyle(0x333333); g.fillRect(0, 0, 32, 32);
    g.fillStyle(0xffff00); g.fillRect(15, 0, 2, 32); // center line
    g.fillStyle(0x555555); g.fillRect(0, 0, 2, 32); g.fillRect(30, 0, 2, 32);
    g.generateTexture('tile_road_v', 32, 32);

    // Intersection
    g.clear(); g.fillStyle(0x333333); g.fillRect(0, 0, 32, 32);
    g.fillStyle(0x555555); g.fillRect(0, 0, 2, 32); g.fillRect(30, 0, 2, 32);
    g.fillRect(0, 0, 32, 2); g.fillRect(0, 30, 32, 2);
    g.generateTexture('tile_intersection', 32, 32);

    // Building
    g.clear(); g.fillStyle(0x5c4a3a); g.fillRect(0, 0, 32, 32);
    g.fillStyle(0x4a3828); g.lineStyle(1, 0x3a2818);
    g.fillRect(2, 2, 28, 28);
    g.fillStyle(0x7a6a56, 0.6); g.fillRect(6, 6, 8, 10); g.fillRect(18, 6, 8, 10);
    g.generateTexture('tile_building', 32, 32);

    // Lot (open pavement/parking)
    g.clear(); g.fillStyle(0x666666); g.fillRect(0, 0, 32, 32);
    g.fillStyle(0x555555, 0.5); g.fillRect(0, 0, 16, 16); g.fillRect(16, 16, 16, 16);
    g.generateTexture('tile_lot', 32, 32);

    // --- Player (24x24) ---
    g.clear();
    g.fillStyle(0x2255cc); g.fillRect(2, 2, 20, 20);
    g.fillStyle(0xffd700); g.fillRect(9, 0, 6, 8); // nose indicator (forward = up)
    g.fillStyle(0xffffff); g.fillRect(5, 12, 6, 6); g.fillRect(13, 12, 6, 6); // legs
    g.generateTexture('player', 24, 24);

    // Player with gun
    g.clear();
    g.fillStyle(0x2255cc); g.fillRect(2, 2, 20, 20);
    g.fillStyle(0xffd700); g.fillRect(9, 0, 6, 8);
    g.fillStyle(0x333333); g.fillRect(18, 8, 8, 4); // gun barrel
    g.generateTexture('player_armed', 24, 24);

    // --- Vehicles ---
    // Sedan (40x24)
    g.clear();
    g.fillStyle(0x22aa44); g.fillRect(0, 2, 40, 20);
    g.fillStyle(0x188833); g.fillRect(4, 0, 32, 4); // roof
    g.fillStyle(0x99ddff, 0.8); g.fillRect(6, 4, 12, 8); g.fillRect(22, 4, 12, 8); // windows
    g.fillStyle(0x111111); g.fillRect(2, 18, 8, 4); g.fillRect(30, 18, 8, 4); // rear wheels
    g.fillRect(2, 2, 8, 4); g.fillRect(30, 2, 8, 4); // front wheels
    g.fillStyle(0xffffaa); g.fillRect(36, 8, 4, 6); // headlight
    g.generateTexture('vehicle_sedan', 40, 24);

    // Truck (52x28)
    g.clear();
    g.fillStyle(0xaa4422); g.fillRect(0, 2, 52, 24);
    g.fillStyle(0x882200); g.fillRect(4, 0, 20, 4);
    g.fillStyle(0x99ddff, 0.8); g.fillRect(6, 4, 14, 8);
    g.fillStyle(0x111111); g.fillRect(2, 22, 10, 4); g.fillRect(40, 22, 10, 4);
    g.fillRect(2, 2, 10, 4); g.fillRect(40, 2, 10, 4);
    g.fillStyle(0xffffaa); g.fillRect(48, 8, 4, 8);
    g.generateTexture('vehicle_truck', 52, 28);

    // Police car (40x24) - black and white
    g.clear();
    g.fillStyle(0xffffff); g.fillRect(0, 2, 20, 20);
    g.fillStyle(0x111111); g.fillRect(20, 2, 20, 20);
    g.fillStyle(0x333333); g.fillRect(4, 0, 32, 4);
    g.fillStyle(0x99ddff, 0.8); g.fillRect(6, 4, 12, 8); g.fillRect(22, 4, 12, 8);
    g.fillStyle(0x111111); g.fillRect(2, 18, 8, 4); g.fillRect(30, 18, 8, 4);
    g.fillRect(2, 2, 8, 4); g.fillRect(30, 2, 8, 4);
    g.fillStyle(0xff0000); g.fillRect(14, 0, 6, 3); // light bar
    g.fillStyle(0x0000ff); g.fillRect(20, 0, 6, 3);
    g.fillStyle(0xffffaa); g.fillRect(36, 8, 4, 6);
    g.generateTexture('vehicle_police', 40, 24);

    // --- NPCs (16x16) ---
    // Pedestrian
    g.clear();
    g.fillStyle(0xcc8844); g.fillRect(4, 0, 8, 8); // head
    g.fillStyle(0x4488cc); g.fillRect(2, 8, 12, 6); // body
    g.fillStyle(0x333333); g.fillRect(2, 14, 5, 2); g.fillRect(9, 14, 5, 2); // legs
    g.generateTexture('npc_pedestrian', 16, 16);

    // Gang Loonies (purple)
    g.clear();
    g.fillStyle(0xcc8844); g.fillRect(4, 0, 8, 8);
    g.fillStyle(0x8800cc); g.fillRect(2, 8, 12, 6);
    g.fillStyle(0x333333); g.fillRect(2, 14, 5, 2); g.fillRect(9, 14, 5, 2);
    g.generateTexture('npc_loonies', 16, 16);

    // Gang Zaibatsu (red)
    g.clear();
    g.fillStyle(0xcc8844); g.fillRect(4, 0, 8, 8);
    g.fillStyle(0xcc0000); g.fillRect(2, 8, 12, 6);
    g.fillStyle(0x333333); g.fillRect(2, 14, 5, 2); g.fillRect(9, 14, 5, 2);
    g.generateTexture('npc_zaibatsu', 16, 16);

    // Gang Rednecks (orange)
    g.clear();
    g.fillStyle(0xcc8844); g.fillRect(4, 0, 8, 8);
    g.fillStyle(0xcc6600); g.fillRect(2, 8, 12, 6);
    g.fillStyle(0x333333); g.fillRect(2, 14, 5, 2); g.fillRect(9, 14, 5, 2);
    g.generateTexture('npc_rednecks', 16, 16);

    // Police officer
    g.clear();
    g.fillStyle(0xcc8844); g.fillRect(4, 0, 8, 8);
    g.fillStyle(0x002299); g.fillRect(2, 8, 12, 6);
    g.fillStyle(0x001166); g.fillRect(2, 14, 5, 2); g.fillRect(9, 14, 5, 2);
    g.fillStyle(0xffdd00); g.fillRect(5, 9, 6, 3); // badge
    g.generateTexture('npc_police', 16, 16);

    // --- Weapon pickups (16x16) ---
    // Pistol
    g.clear(); g.fillStyle(0x888888); g.fillRect(2, 6, 12, 6); g.fillRect(6, 2, 4, 6);
    g.generateTexture('pickup_pistol', 16, 16);

    // Shotgun
    g.clear(); g.fillStyle(0x8B4513); g.fillRect(0, 7, 16, 4); g.fillRect(2, 4, 4, 6);
    g.generateTexture('pickup_shotgun', 16, 16);

    // Machine gun
    g.clear(); g.fillStyle(0x555555); g.fillRect(0, 6, 16, 4); g.fillRect(2, 2, 6, 8);
    g.fillStyle(0x888888); g.fillRect(12, 5, 4, 6);
    g.generateTexture('pickup_machineGun', 16, 16);

    // --- Bullet (6x2) ---
    g.clear(); g.fillStyle(0xffdd44); g.fillRect(0, 0, 6, 2);
    g.generateTexture('bullet', 6, 2);

    // --- Explosion frames (32x32 each, 6 frames in row) ---
    // Frame 0: small flash
    g.clear(); g.fillStyle(0xffff00, 0.9); g.fillCircle(16, 16, 6);
    g.generateTexture('explosion_0', 32, 32);
    g.clear(); g.fillStyle(0xff8800, 0.9); g.fillCircle(16, 16, 10);
    g.generateTexture('explosion_1', 32, 32);
    g.clear(); g.fillStyle(0xff4400, 0.8); g.fillCircle(16, 16, 14);
    g.generateTexture('explosion_2', 32, 32);
    g.clear(); g.fillStyle(0xff2200, 0.6); g.fillCircle(16, 16, 12);
    g.generateTexture('explosion_3', 32, 32);
    g.clear(); g.fillStyle(0x883300, 0.4); g.fillCircle(16, 16, 8);
    g.generateTexture('explosion_4', 32, 32);
    g.clear(); g.fillStyle(0x444444, 0.2); g.fillCircle(16, 16, 4);
    g.generateTexture('explosion_5', 32, 32);

    // Phone booth (16x20)
    g.clear();
    g.fillStyle(0x0044cc); g.fillRect(2, 0, 12, 20);
    g.fillStyle(0x99ddff, 0.8); g.fillRect(4, 3, 8, 10);
    g.fillStyle(0xffffff); g.fillRect(6, 14, 4, 4);
    g.generateTexture('phone_booth', 16, 20);

    // HUD star (filled)
    g.clear();
    g.fillStyle(0xffdd00);
    // Simple 5-pointed star approximation
    const cx = 8, cy = 8, ro = 8, ri = 3.5;
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const angle = (i * Math.PI / 5) - Math.PI / 2;
      const r = i % 2 === 0 ? ro : ri;
      pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
    g.fillPoints(pts, true);
    g.generateTexture('star_filled', 16, 16);

    // HUD star (empty)
    g.clear();
    g.lineStyle(2, 0x888888);
    const pts2 = [];
    for (let i = 0; i < 10; i++) {
      const angle = (i * Math.PI / 5) - Math.PI / 2;
      const r = i % 2 === 0 ? 7 : 3;
      pts2.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
    g.strokePoints(pts2, true);
    g.generateTexture('star_empty', 16, 16);

    // Health icon
    g.clear(); g.fillStyle(0xff3333);
    g.fillRect(4, 0, 8, 16); g.fillRect(0, 4, 16, 8);
    g.generateTexture('icon_health', 16, 16);

    // Armor icon
    g.clear(); g.fillStyle(0x33aaff);
    g.fillTriangle(8, 0, 0, 16, 16, 16);
    g.generateTexture('icon_armor', 16, 16);

    g.destroy();
  }

  _defineAnimations() {
    // No spritesheet animations needed — we use single-frame textures.
    // Future: swap for real spritesheets here.
  }
}
