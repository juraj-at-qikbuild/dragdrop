class MapSystem {
  constructor() {
    this.map = null;
    this.groundLayer = null;
    this.collisionLayer = null;
  }

  create(scene) {
    // Build tilemap from the 2D array in MapData.js
    this.map = scene.make.tilemap({
      data: MAP_DATA,
      tileWidth: MAP_TILE_SIZE,
      tileHeight: MAP_TILE_SIZE,
    });

    // Add tilesets — one texture per tile type
    // We use a blank tileset name and map frames manually
    const tilesetImages = [
      { name: 'grass', key: 'tile_grass' },
      { name: 'sidewalk', key: 'tile_sidewalk' },
      { name: 'road_h', key: 'tile_road_h' },
      { name: 'road_v', key: 'tile_road_v' },
      { name: 'intersection', key: 'tile_intersection' },
      { name: 'building', key: 'tile_building' },
      { name: 'lot', key: 'tile_lot' },
    ];

    // Phaser's tilemap-from-data uses a single tileset.
    // We build the tileset as a spritesheet of 7 tiles (each 32x32),
    // but since we generated individual textures, we create a combined
    // canvas texture dynamically.
    this._buildTilesetTexture(scene);

    const tileset = this.map.addTilesetImage('tileset', 'tileset_combined', 32, 32, 0, 0);

    // Single layer (ground + buildings merged — buildings will have collision)
    this.groundLayer = this.map.createLayer(0, tileset, 0, 0);

    // Set collision on building tiles (ID 5)
    this.groundLayer.setCollisionBetween(TILE.BUILDING, TILE.BUILDING);

    // Set world and camera bounds
    scene.physics.world.setBounds(0, 0, MAP_WORLD_WIDTH, MAP_WORLD_HEIGHT);

    return this;
  }

  _buildTilesetTexture(scene) {
    // Combine 7 tile textures horizontally into one 224x32 tileset image
    // Order must match tile IDs 0-6
    const keys = [
      'tile_grass',      // 0
      'tile_sidewalk',   // 1
      'tile_road_h',     // 2
      'tile_road_v',     // 3
      'tile_intersection', // 4
      'tile_building',   // 5
      'tile_lot',        // 6
    ];

    const rt = scene.add.renderTexture(0, 0, keys.length * 32, 32);
    rt.setVisible(false);

    keys.forEach((key, i) => {
      rt.draw(key, i * 32 + 16, 16); // draw centered in each cell
    });

    rt.saveTexture('tileset_combined');
    rt.destroy();
  }

  /** Convert tile coordinates to world pixel center */
  tileToWorld(tx, ty) {
    return {
      x: tx * MAP_TILE_SIZE + MAP_TILE_SIZE / 2,
      y: ty * MAP_TILE_SIZE + MAP_TILE_SIZE / 2,
    };
  }

  /** Returns true if the tile at (tx,ty) is a road tile */
  isRoad(tx, ty) {
    const id = MAP_DATA[ty] && MAP_DATA[ty][tx];
    return id === TILE.ROAD_H || id === TILE.ROAD_V || id === TILE.INTERSECTION;
  }

  /** Returns true if the tile at (tx,ty) is walkable (not building) */
  isWalkable(tx, ty) {
    const id = MAP_DATA[ty] && MAP_DATA[ty][tx];
    return id !== TILE.BUILDING && id !== undefined;
  }

  /** Add arcade collider between a physics object/group and buildings */
  addBuildingCollider(scene, obj, callback) {
    return scene.physics.add.collider(obj, this.groundLayer, callback);
  }
}
