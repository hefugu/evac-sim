/**
 * Canonical 2.5D floor data helpers.
 *
 * The existing simulator stores most floor metadata beside the cell grid.  The
 * helpers in this module intentionally accept that legacy shape and expose a
 * richer, renderer-independent snapshot without requiring core.js to change.
 */

export const DEFAULT_3D_CONFIG = Object.freeze({
  cellSizeMeters: 0.5,
  floorHeightMeters: 3.5,
  wallHeightMeters: 2.8,
  referenceVisibilityMeters: 30
});

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveNumber(value, fallback) {
  const n = finiteNumber(value, fallback);
  return n > 0 ? n : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  return Math.max(0, finiteNumber(value, fallback));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function inferGridWidth(grid, fallback = 0) {
  if (!Array.isArray(grid)) return Math.max(0, Math.floor(fallback));
  return grid.reduce(
    (width, row) => Math.max(width, Array.isArray(row) ? row.length : 0),
    Math.max(0, Math.floor(fallback))
  );
}

/** Create one canonical cell while retaining unknown application fields. */
export function createCell3D(overrides = {}) {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  const walkable = source.walkable == null ? false : !!source.walkable;
  const stair = !!source.stair;
  const fireIntensity = nonNegativeNumber(
    source.fireIntensity,
    source.fire ? 0.05 : 0
  );
  const fire = !!source.fire || fireIntensity > 0;
  // core.js marks a placed fire source as walkable=false. It is still a
  // corridor hazard marker, not a newly-created structural wall.
  const wall = source.wall == null ? (!walkable && !stair && !fire) : !!source.wall;
  const smokeDensity = nonNegativeNumber(source.smokeDensity, source.smoke || 0);
  const opticalDensity = nonNegativeNumber(
    source.opticalDensity ?? source.opticalDensityM1,
    smokeDensity * 0.32
  );
  const coPpm = nonNegativeNumber(source.coPpm, source.co || 0);
  const visibilityMeters = nonNegativeNumber(
    source.visibilityMeters ?? source.visibilityM,
    opticalDensity > 0.001 ? Math.min(30, 3 / opticalDensity) : 30
  );
  const normalizedVisibility = clamp(
    finiteNumber(source.visibility, visibilityMeters / DEFAULT_3D_CONFIG.referenceVisibilityMeters),
    0,
    1
  );
  const heatFluxKwM2 = nonNegativeNumber(
    source.heatFluxKwM2,
    source.heat || 0
  );

  return {
    ...source,
    walkable,
    wall,
    door: !!source.door,
    stair,
    atrium: !!source.atrium,
    flammable: source.flammable == null ? (walkable && !wall) : !!source.flammable,
    ventilation: nonNegativeNumber(source.ventilation, 0),
    fire,
    fireIntensity,
    fireAgeSec: nonNegativeNumber(source.fireAgeSec, 0),
    temperatureC: finiteNumber(source.temperatureC, 20),
    heatFluxKwM2,
    smokeDensity,
    opticalDensity,
    coPpm,
    visibilityMeters,

    // Legacy aliases used by the current 2D renderer/core.
    smoke: smokeDensity,
    heat: heatFluxKwM2,
    co: coPpm,
    visibility: normalizedVisibility
  };
}

/** Create a rectangular canonical cell grid. */
export function createGrid3D(width, height, cellFactory = null) {
  const gridWidth = Math.max(0, Math.floor(finiteNumber(width, 0)));
  const gridHeight = Math.max(0, Math.floor(finiteNumber(height, 0)));
  const factory = typeof cellFactory === "function"
    ? cellFactory
    : () => (cellFactory && typeof cellFactory === "object" ? cellFactory : {});

  return Array.from({ length: gridHeight }, (_, cy) =>
    Array.from({ length: gridWidth }, (_, cx) => createCell3D(factory(cx, cy)))
  );
}

function cellSourceAt(source, cx, cy) {
  const cell = source.grid?.[cy]?.[cx];
  const templateWalkable = source.walkableTemplate?.[cy]?.[cx];
  const smoke = source.smokeMap?.[cy]?.[cx];
  const risk = source.riskGrid?.[cy]?.[cx] || source.hazardGrid?.[cy]?.[cx];

  return {
    ...(cell && typeof cell === "object" ? cell : {}),
    ...(risk && typeof risk === "object" ? risk : {}),
    walkable: cell?.walkable ?? templateWalkable ?? false,
    smokeDensity: cell?.smokeDensity ?? smoke ?? cell?.smoke ?? risk?.smokeDensity ?? risk?.smoke,
    stair: cell?.stair ?? false,
    fire: cell?.fire ?? false
  };
}

/**
 * Convert either a canonical floor or a current core.js floorState into the
 * canonical shape. The input is never mutated.
 */
export function createFloor3D(input = {}, options = {}) {
  const source = input && typeof input === "object" ? input : {};
  const floorIndex = Math.floor(finiteNumber(
    source.floorIndex ?? source.floor,
    finiteNumber(options.floorIndex, 0)
  ));
  const floorHeightMeters = positiveNumber(
    source.floorHeightMeters ?? options.floorHeightMeters,
    DEFAULT_3D_CONFIG.floorHeightMeters
  );
  const cellSizeMeters = positiveNumber(
    source.cellSizeMeters ?? options.cellSizeMeters,
    DEFAULT_3D_CONFIG.cellSizeMeters
  );
  const gridHeight = Math.max(
    0,
    Math.floor(finiteNumber(
      source.gridHeight,
      Array.isArray(source.grid)
        ? source.grid.length
        : (Array.isArray(source.walkableTemplate) ? source.walkableTemplate.length : 0)
    ))
  );
  const gridWidth = Math.max(
    0,
    Math.floor(finiteNumber(
      source.gridWidth,
      inferGridWidth(source.grid, inferGridWidth(source.walkableTemplate, 0))
    ))
  );
  const elevationMeters = finiteNumber(
    source.elevationMeters ?? source.zMeters,
    floorIndex * floorHeightMeters
  );
  const grid = createGrid3D(
    gridWidth,
    gridHeight,
    (cx, cy) => cellSourceAt(source, cx, cy)
  );
  const smokeMap = grid.map(row => row.map(cell => cell.smokeDensity));
  const smokeCeil = Array.from({ length: gridHeight }, (_, cy) =>
    Array.from({ length: gridWidth }, (_, cx) => !!source.smokeCeil?.[cy]?.[cx])
  );
  const walkableTemplate = grid.map(row => row.map(cell => !!cell.walkable));

  return {
    ...source,
    floorIndex,
    name: source.name || `${floorIndex + 1}F`,
    zMeters: elevationMeters,
    elevationMeters,
    floorHeightMeters,
    wallHeightMeters: positiveNumber(
      source.wallHeightMeters ?? options.wallHeightMeters,
      DEFAULT_3D_CONFIG.wallHeightMeters
    ),
    gridWidth,
    gridHeight,
    cellSizeMeters,
    grid,
    walkableTemplate,
    smokeMap,
    smokeCeil,
    exits: Array.isArray(source.exits) ? source.exits.map(exit => ({ ...exit })) : [],
    spawns: Array.isArray(source.spawns) ? source.spawns.map(spawn => ({ ...spawn })) : [],
    stairs: Array.isArray(source.stairs) ? source.stairs.map(stair => ({ ...stair })) : []
  };
}

export const normalizeFloor3D = createFloor3D;

/** Normalize and order an arbitrary floor collection. */
export function normalizeFloors3D(floors, options = {}) {
  if (!Array.isArray(floors)) return [];
  const offset = Math.floor(finiteNumber(options.floorIndexOffset, 0));
  return floors
    .filter(Boolean)
    .map((floor, index) => createFloor3D(floor, {
      ...options,
      floorIndex: floor?.floorIndex ?? floor?.floor ?? (index + offset)
    }))
    .sort((a, b) => a.floorIndex - b.floorIndex);
}

/**
 * Lightweight read-through wrappers for live rendering. Grid, smokeMap,
 * exits, spawns and baseImage remain the exact references owned by core.js;
 * only floor metadata is wrapped. Use normalizeFloors3D when an isolated
 * calculation snapshot is required instead.
 */
export function simulationFloorsView(state, options = {}) {
  const spatial = state?.spatial || {};
  const defaultCellSizeMeters = options.cellSizeMeters ?? spatial.cellSizeMeters;
  const defaultFloorHeightMeters = options.floorHeightMeters ?? spatial.floorHeightMeters;
  const defaultWallHeightMeters = options.wallHeightMeters ?? spatial.wallHeightMeters;
  const floorStates = state?.map?.floorStates;
  const publicFloors = state?.floors;
  let source = Array.isArray(floorStates) && floorStates.length
    ? floorStates
    : (Array.isArray(publicFloors) ? publicFloors : []);

  if (!source.length && state?.map?.grid) {
    source = [{
      grid: state.map.grid,
      gridWidth: state.map.gridW,
      gridHeight: state.map.gridH,
      smokeMap: state.sim?.smokeMap,
      smokeCeil: state.sim?.smokeCeil,
      exits: state.exits || state.map.allExitPoints || [],
      spawns: state.spawns || state.map.allSpawnPoints || [],
      floorIndex: state.map.currentFloor ?? state.currentFloor ?? 0
    }];
  }

  const offset = Math.floor(finiteNumber(options.floorIndexOffset, 0));
  return source.filter(Boolean).map((floor, index) => {
    const floorIndex = Math.floor(finiteNumber(
      floor.floorIndex ?? floor.floor,
      index + offset
    ));
    const floorHeightMeters = positiveNumber(
      floor.floorHeightMeters ?? defaultFloorHeightMeters,
      DEFAULT_3D_CONFIG.floorHeightMeters
    );
    const grid = Array.isArray(floor.grid) ? floor.grid : [];
    return {
      ...floor,
      floorIndex,
      name: floor.name || `${floorIndex + 1}F`,
      zMeters: finiteNumber(floor.zMeters ?? floor.elevationMeters, floorIndex * floorHeightMeters),
      elevationMeters: finiteNumber(floor.elevationMeters ?? floor.zMeters, floorIndex * floorHeightMeters),
      floorHeightMeters,
      wallHeightMeters: positiveNumber(
        floor.wallHeightMeters ?? defaultWallHeightMeters,
        DEFAULT_3D_CONFIG.wallHeightMeters
      ),
      cellSizeMeters: positiveNumber(
        floor.cellSizeMeters ?? defaultCellSizeMeters,
        DEFAULT_3D_CONFIG.cellSizeMeters
      ),
      gridWidth: Math.max(0, Math.floor(finiteNumber(floor.gridWidth, inferGridWidth(grid, 0)))),
      gridHeight: Math.max(0, Math.floor(finiteNumber(floor.gridHeight, grid.length))),
      grid,
      smokeMap: floor.smokeMap || null,
      smokeCeil: floor.smokeCeil || null,
      exits: Array.isArray(floor.exits) ? floor.exits : [],
      spawns: Array.isArray(floor.spawns) ? floor.spawns : [],
      stairs: Array.isArray(floor.stairs) ? floor.stairs : []
    };
  });
}

/**
 * Read the public simulator state without creating a second simulation state.
 * Call this again when a fresh renderer snapshot is needed.
 */
export function floorsFromSimulationState(state, options = {}) {
  return normalizeFloors3D(simulationFloorsView(state, options), options);
}

export function getFloorByIndex(floors, floorIndex) {
  if (!Array.isArray(floors)) return null;
  const target = Math.floor(finiteNumber(floorIndex, 0));
  return floors.find((floor, arrayIndex) =>
    Math.floor(finiteNumber(floor?.floorIndex ?? floor?.floor, arrayIndex)) === target
  ) || null;
}

export function getFloorCell(floor, cx, cy) {
  const x = Math.floor(finiteNumber(cx, -1));
  const y = Math.floor(finiteNumber(cy, -1));
  if (x < 0 || y < 0) return null;
  return floor?.grid?.[y]?.[x] || null;
}

/** Copy-on-write update of one floor cell. */
export function updateFloorCell(floor, cx, cy, updater) {
  const x = Math.floor(finiteNumber(cx, -1));
  const y = Math.floor(finiteNumber(cy, -1));
  const previous = getFloorCell(floor, x, y);
  if (!previous) return floor;

  const patch = typeof updater === "function" ? updater(previous, x, y) : updater;
  if (!patch || typeof patch !== "object") return floor;
  const nextCell = createCell3D({ ...previous, ...patch });
  const nextGrid = floor.grid.slice();
  nextGrid[y] = floor.grid[y].slice();
  nextGrid[y][x] = nextCell;
  const nextSmokeMap = Array.isArray(floor.smokeMap)
    ? floor.smokeMap.map((row, rowIndex) =>
        rowIndex === y ? row.map((value, columnIndex) =>
          columnIndex === x ? nextCell.smokeDensity : value
        ) : row
      )
    : nextGrid.map(row => row.map(cell => cell.smokeDensity));
  const nextWalkableTemplate = Array.isArray(floor.walkableTemplate)
    ? floor.walkableTemplate.map((row, rowIndex) => {
        if (rowIndex !== y || !Array.isArray(row)) return row;
        const nextRow = row.slice();
        nextRow[x] = !!nextCell.walkable;
        return nextRow;
      })
    : nextGrid.map(row => row.map(cell => !!cell.walkable));

  return {
    ...floor,
    grid: nextGrid,
    walkableTemplate: nextWalkableTemplate,
    smokeMap: nextSmokeMap
  };
}

/** Exact grid-to-world conversion used by both agents and renderers. */
export function gridToWorld(position = {}, options = {}) {
  const floor = options.floor || null;
  const cellSizeMeters = positiveNumber(
    options.cellSizeMeters ?? floor?.cellSizeMeters,
    DEFAULT_3D_CONFIG.cellSizeMeters
  );
  const floorHeightMeters = positiveNumber(
    options.floorHeightMeters ?? floor?.floorHeightMeters,
    DEFAULT_3D_CONFIG.floorHeightMeters
  );
  const floorIndex = finiteNumber(
    position.floorIndex ?? position.floor ?? floor?.floorIndex,
    0
  );
  const x = finiteNumber(position.cx ?? position.x, 0);
  const y = finiteNumber(position.cy ?? position.y, 0);
  const elevation = finiteNumber(
    options.elevationMeters ?? floor?.elevationMeters ?? floor?.zMeters,
    floorIndex * floorHeightMeters
  );

  return {
    worldX: finiteNumber(options.originX, 0) + x * cellSizeMeters,
    worldY: finiteNumber(options.originY, 0) + elevation + finiteNumber(options.heightOffsetMeters, 0),
    worldZ: finiteNumber(options.originZ, 0) + y * cellSizeMeters
  };
}

/** World-to-grid inverse. Continuous x/y and rounded cx/cy are both returned. */
export function worldToGrid(position = {}, options = {}) {
  const cellSizeMeters = positiveNumber(
    options.cellSizeMeters,
    DEFAULT_3D_CONFIG.cellSizeMeters
  );
  const floorHeightMeters = positiveNumber(
    options.floorHeightMeters,
    DEFAULT_3D_CONFIG.floorHeightMeters
  );
  const x = (finiteNumber(position.worldX ?? position.x, 0) - finiteNumber(options.originX, 0)) / cellSizeMeters;
  const y = (finiteNumber(position.worldZ ?? position.z, 0) - finiteNumber(options.originZ, 0)) / cellSizeMeters;
  const elevation = finiteNumber(position.worldY ?? position.y, 0) - finiteNumber(options.originY, 0);
  const floorIndex = Math.round(elevation / floorHeightMeters);

  return { x, y, cx: Math.round(x), cy: Math.round(y), floorIndex, floor: floorIndex };
}

export function validateFloor3D(floor) {
  const errors = [];
  if (!floor || typeof floor !== "object") return { valid: false, errors: ["floor must be an object"] };
  if (!Number.isInteger(floor.floorIndex)) errors.push("floorIndex must be an integer");
  if (!(floor.cellSizeMeters > 0)) errors.push("cellSizeMeters must be positive");
  if (!(floor.floorHeightMeters > 0)) errors.push("floorHeightMeters must be positive");
  if (!Array.isArray(floor.grid)) errors.push("grid must be an array");
  if (Array.isArray(floor.grid) && floor.grid.length !== floor.gridHeight) {
    errors.push("gridHeight does not match grid");
  }
  if (Array.isArray(floor.grid) && floor.grid.some(row => !Array.isArray(row) || row.length !== floor.gridWidth)) {
    errors.push("gridWidth does not match one or more rows");
  }
  return { valid: errors.length === 0, errors };
}
