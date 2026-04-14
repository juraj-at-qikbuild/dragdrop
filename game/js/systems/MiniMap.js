class MiniMap {
  constructor() {
    this.mapRT = null;       // static map background (drawn once)
    this.overlayRT = null;   // entity dots (updated each frame)
    this.dotsG = null;       // graphics object for dots (reused)
    this.frameCount = 0;
    this.scene = null;
    this.mapSize = 150;
    this.mapX = 0;
    this.mapY = 0;
  }

  create(scene) {
    this.scene = scene;
    const size = this.mapSize;
    const margin = 12;
    const x = scene.scale.width - size - margin;
    const y = scene.scale.height - size - margin;
    this.mapX = x;
    this.mapY = y;

    // Border
    scene.add.rectangle(x + size / 2, y + size / 2, size + 6, size + 6, 0x000000, 0.9)
      .setScrollFactor(0).setDepth(98);

    // Label
    scene.add.text(x + 2, y - 14, 'MAP', {
      fontSize: '10px', color: '#888888', fontFamily: 'monospace',
    }).setScrollFactor(0).setDepth(99);

    // Static map background — drawn ONCE
    this.mapRT = scene.add.renderTexture(x, y, size, size)
      .setScrollFactor(0).setDepth(99);
    this._drawStaticMap();

    // Dynamic overlay — only entity dots, redrawn each update
    this.overlayRT = scene.add.renderTexture(x, y, size, size)
      .setScrollFactor(0).setDepth(100);

    // Reusable graphics for dots
    this.dotsG = scene.add.graphics().setScrollFactor(0).setDepth(101);

    return this;
  }

  _drawStaticMap() {
    const worldW = MAP_WORLD_WIDTH;
    const worldH = MAP_WORLD_HEIGHT;
    const mw = this.mapSize;
    const mh = this.mapSize;
    const step = 4;

    const tileW = (MAP_TILE_SIZE * step / worldW) * mw;
    const tileH = (MAP_TILE_SIZE * step / worldH) * mh;

    const g = this.scene.add.graphics();
    for (let ty = 0; ty < MAP_HEIGHT; ty += step) {
      for (let tx = 0; tx < MAP_WIDTH; tx += step) {
        const id = MAP_DATA[ty][tx];
        let color = 0x2d5a1b; // grass
        if (id === TILE.ROAD_H || id === TILE.ROAD_V || id === TILE.INTERSECTION) color = 0x4a4a4a;
        else if (id === TILE.SIDEWALK) color = 0x7a7a7a;
        else if (id === TILE.BUILDING) color = 0x7a5c3a;
        else if (id === TILE.LOT) color = 0x555555;

        const mx = (tx * MAP_TILE_SIZE / worldW) * mw;
        const my = (ty * MAP_TILE_SIZE / worldH) * mh;
        g.fillStyle(color);
        g.fillRect(mx, my, Math.max(1, tileW), Math.max(1, tileH));
      }
    }
    this.mapRT.draw(g, 0, 0);
    g.destroy();
  }

  update(scene, player, npcGroup, vehicleGroup) {
    this.frameCount++;
    if (this.frameCount % 3 !== 0) return;

    const worldW = MAP_WORLD_WIDTH;
    const worldH = MAP_WORLD_HEIGHT;
    const mw = this.mapSize;
    const mh = this.mapSize;

    const toX = (wx) => Phaser.Math.Clamp((wx / worldW) * mw, 0, mw - 1);
    const toY = (wy) => Phaser.Math.Clamp((wy / worldH) * mh, 0, mh - 1);

    const g = this.dotsG;
    g.clear();

    // NPCs
    npcGroup.getChildren().forEach(npc => {
      if (!npc.active || !npc.isAlive) return;
      const mx = this.mapX + toX(npc.x);
      const my = this.mapY + toY(npc.y);
      g.fillStyle(npc.npcType === 'police' ? 0x4488ff : 0xff4444);
      g.fillRect(mx - 1, my - 1, 3, 3);
    });

    // Vehicles
    g.fillStyle(0xddaa22);
    vehicleGroup.getChildren().forEach(v => {
      if (!v.active) return;
      const mx = this.mapX + toX(v.x);
      const my = this.mapY + toY(v.y);
      g.fillRect(mx - 1, my - 1, 3, 3);
    });

    // Player (blinking white dot)
    if (player && player.active) {
      const px = this.mapX + toX(player.x);
      const py = this.mapY + toY(player.y);
      // Blink every ~500ms
      if (Math.floor(this.frameCount / 10) % 2 === 0) {
        g.fillStyle(0xffffff);
        g.fillCircle(px, py, 3);
      }

      // Camera viewport rectangle
      const cam = scene.cameras.main;
      const vx = this.mapX + toX(cam.scrollX);
      const vy = this.mapY + toY(cam.scrollY);
      const vw = (cam.width / worldW) * mw;
      const vh = (cam.height / worldH) * mh;
      g.lineStyle(1, 0xffffff, 0.3);
      g.strokeRect(vx, vy, vw, vh);
    }
  }

  destroy() {
    if (this.mapRT) this.mapRT.destroy();
    if (this.overlayRT) this.overlayRT.destroy();
    if (this.dotsG) this.dotsG.destroy();
  }
}
