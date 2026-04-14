class MiniMap {
  constructor() {
    this.renderTexture = null;
    this.container = null;
    this.g = null;
    this.frameCount = 0;
    this.scene = null;
  }

  create(scene) {
    this.scene = scene;
    const size = 140;
    const margin = 12;
    const x = scene.scale.width - size - margin;
    const y = scene.scale.height - size - margin;

    // Background
    const bg = scene.add.rectangle(x + size / 2, y + size / 2, size + 4, size + 4, 0x000000, 0.8)
      .setScrollFactor(0).setDepth(99);

    // RenderTexture for the map content
    this.renderTexture = scene.add.renderTexture(x, y, size, size)
      .setScrollFactor(0).setDepth(100);

    this.mapSize = size;
    this.mapX = x;
    this.mapY = y;

    // Graphics for drawing dots
    this.g = scene.add.graphics().setDepth(101).setScrollFactor(0);

    return this;
  }

  update(scene, player, npcGroup, vehicleGroup) {
    this.frameCount++;
    if (this.frameCount % 4 !== 0) return; // update every 4 frames

    const rt = this.renderTexture;
    if (!rt) return;
    rt.clear();

    const worldW = MAP_WORLD_WIDTH;
    const worldH = MAP_WORLD_HEIGHT;
    const mw = this.mapSize;
    const mh = this.mapSize;

    const toMapX = (wx) => (wx / worldW) * mw;
    const toMapY = (wy) => (wy / worldH) * mh;

    // Draw simplified map tiles (sample every N tiles)
    const step = 4; // sample every 4 tiles
    const tileScreenW = (MAP_TILE_SIZE * step / worldW) * mw;
    const tileScreenH = (MAP_TILE_SIZE * step / worldH) * mh;

    const g = scene.add.graphics();
    for (let ty = 0; ty < MAP_HEIGHT; ty += step) {
      for (let tx = 0; tx < MAP_WIDTH; tx += step) {
        const id = MAP_DATA[ty][tx];
        let color = 0x2d5a1b; // grass
        if (id === TILE.ROAD_H || id === TILE.ROAD_V || id === TILE.INTERSECTION) color = 0x555555;
        else if (id === TILE.SIDEWALK) color = 0x888888;
        else if (id === TILE.BUILDING) color = 0x8B4513;
        else if (id === TILE.LOT) color = 0x666666;

        const mx = toMapX(tx * MAP_TILE_SIZE);
        const my = toMapY(ty * MAP_TILE_SIZE);
        g.fillStyle(color);
        g.fillRect(mx, my, Math.max(1, tileScreenW), Math.max(1, tileScreenH));
      }
    }
    rt.draw(g, 0, 0);
    g.destroy();

    // Draw dots on the graphics overlay
    this.g.clear();

    // NPCs — red dots
    this.g.fillStyle(0xff4444);
    npcGroup.getChildren().forEach(npc => {
      if (!npc.active || !npc.isAlive) return;
      const mx = this.mapX + toMapX(npc.x);
      const my = this.mapY + toMapY(npc.y);
      const isPolice = npc.npcType === 'police';
      this.g.fillStyle(isPolice ? 0x4444ff : 0xff4444);
      this.g.fillCircle(mx, my, 2);
    });

    // Vehicles — yellow dots
    this.g.fillStyle(0xffdd44);
    vehicleGroup.getChildren().forEach(v => {
      if (!v.active) return;
      const mx = this.mapX + toMapX(v.x);
      const my = this.mapY + toMapY(v.y);
      this.g.fillCircle(mx, my, 2);
    });

    // Player — bright white dot (larger)
    if (player && player.active) {
      const px = this.mapX + toMapX(player.x);
      const py = this.mapY + toMapY(player.y);
      this.g.fillStyle(0xffffff);
      this.g.fillCircle(px, py, 3);
    }
  }

  destroy() {
    if (this.renderTexture) this.renderTexture.destroy();
    if (this.g) this.g.destroy();
  }
}
