/**
 * Corridor gravity-current closure for the existing conserved cell smoke model.
 * This is a reduced-order route-comparison approximation, not a CFD solver or
 * the complete CFAST corridor correlation. See docs/corridor-model.md.
 */
export const DEFAULT_CORRIDOR_OPTIONS = Object.freeze({
  corridorModelEnabled: true,
  corridorAutoDetect: true,
  corridorMinLengthMeters: 6,
  corridorMaxWidthMeters: 4,
  corridorMinAspectRatio: 3,
  corridorFroudeNumber: 0.7,
  corridorMaxFrontVelocityMps: 5,
  corridorMaxTransferFraction: 0.3,
  corridorFrontDepthThresholdMeters: 0.01
});

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const geometryCache = new WeakMap();
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = (value, fallback) => Math.max(0, finite(value, fallback));

function configFor(options) {
  const config = { ...DEFAULT_CORRIDOR_OPTIONS, ...options };
  for (const key of Object.keys(DEFAULT_CORRIDOR_OPTIONS)) {
    if (typeof DEFAULT_CORRIDOR_OPTIONS[key] === "number") {
      config[key] = positive(options[key], DEFAULT_CORRIDOR_OPTIONS[key]);
    }
  }
  return config;
}

function dimensions(floor) {
  const height = floor.grid?.length || 0;
  const width = floor.grid?.reduce((max, row) => Math.max(max, row?.length || 0), 0) || 0;
  return { width, height, cellSizeMeters: Math.max(0.05, finite(floor.cellSizeMeters, 0.5)) };
}

/** Legacy doors without an explicit state remain open. Closed doors seal smoke. */
export function corridorSmokePassable(cell) {
  if (!cell) return false;
  if (cell.door && (cell.doorOpen === false || cell.doorClosed === true || cell.doorState === "closed")) {
    return false;
  }
  // A placed legacy fire can have walkable=false; a real wall never qualifies.
  return !cell.wall && !!(cell.walkable || cell.stair || cell.door || cell.atrium || cell.fire);
}

/**
 * g' = g (Tu-Ta)/Tu [m/s²], v = Fr sqrt(g' h) [m/s]. Tu and Ta are Kelvin.
 * This uses an ideal-gas reduced gravity referenced to ambient density. NIST
 * SP 1026r1 section 3.4.4 motivates depth/temperature-controlled gravity flow;
 * this local closure is NOT a reproduction of its fitted corridor equations.
 * Fr=0.7 and the 5 m/s numerical cap are explicit scenario assumptions.
 */
export function corridorFrontVelocityMps(depthMeters, temperatureC, options = {}) {
  const config = configFor(options);
  const ambient = finite(options.ambientTemperatureC, 20) + 273.15;
  const upper = Math.max(1, finite(temperatureC, ambient - 273.15) + 273.15);
  const reducedGravity = positive(options.gravityMps2, 9.81) * Math.max(0, upper - ambient) / upper;
  return Math.min(config.corridorMaxFrontVelocityMps,
    config.corridorFroudeNumber * Math.sqrt(reducedGravity * positive(depthMeters, 0)));
}

function cellIndex(cell, width, height) {
  const cx = Number(cell?.cx ?? cell?.x);
  const cy = Number(cell?.cy ?? cell?.y);
  return Number.isInteger(cx) && Number.isInteger(cy) && cx >= 0 && cy >= 0 && cx < width && cy < height
    ? cy * width + cx : -1;
}

// Split into straight, constant-width strips. Walls/closed doors split strips;
// bends, width changes and intersections are handed back to the cell fallback.
function strips(mask, axis, width, height) {
  const alongCount = axis === "x" ? width : height;
  const acrossCount = axis === "x" ? height : width;
  const active = new Map();
  const result = [];
  const indexAt = (along, across) => axis === "x" ? across * width + along : along * width + across;
  for (let along = 0; along <= alongCount; along++) {
    const seen = new Set();
    for (let across = 0; along < alongCount && across < acrossCount;) {
      if (!mask[indexAt(along, across)]) { across++; continue; }
      const startAcross = across;
      while (across < acrossCount && mask[indexAt(along, across)]) across++;
      const endAcross = across - 1;
      const key = `${startAcross}:${endAcross}`;
      seen.add(key);
      let strip = active.get(key);
      if (!strip) {
        strip = { axis, startAlong: along, endAlong: along, startAcross, endAcross, indices: [] };
        active.set(key, strip);
      }
      strip.endAlong = along;
      for (let offset = startAcross; offset <= endAcross; offset++) strip.indices.push(indexAt(along, offset));
    }
    for (const [key, strip] of active) {
      if (!seen.has(key)) { result.push(strip); active.delete(key); }
    }
  }
  return result;
}

/**
 * Scenario input: floor.corridorRegions=[{id, axis:"x"|"y", cells:[{cx,cy}]}].
 * Alternative: cell.corridor=true and optional cell.corridorAxis / corridorId.
 * Auto detection requires length >=6 m, width <=4 m, aspect ratio >=3 by default.
 */
export function identifyCorridorSegments(floor, options = {}) {
  const config = configFor(options);
  const { width, height, cellSizeMeters } = dimensions(floor);
  const membership = new Uint8Array(width * height);
  const segmentIndexByCell = new Int32Array(width * height).fill(-1);
  const segments = [];
  if (!config.corridorModelEnabled) return { membership, segmentIndexByCell, segments };
  const passable = new Uint8Array(width * height);
  const tagged = new Map();
  for (let cy = 0; cy < height; cy++) for (let cx = 0; cx < width; cx++) {
    const cell = floor.grid[cy]?.[cx];
    const index = cy * width + cx;
    if (!corridorSmokePassable(cell)) continue;
    passable[index] = 1;
    if (cell.corridor || cell.regionType === "corridor") {
      const key = String(cell.corridorId || "tagged");
      if (!tagged.has(key)) tagged.set(key, { id: key, axis: cell.corridorAxis, cells: [] });
      tagged.get(key).cells.push({ cx, cy });
    }
  }
  const add = (strip, id, source, explicit) => {
    const lengthCells = strip.endAlong - strip.startAlong + 1;
    const widthCells = strip.endAcross - strip.startAcross + 1;
    if (lengthCells < 2) return;
    if (!explicit && (lengthCells * cellSizeMeters < config.corridorMinLengthMeters ||
      widthCells * cellSizeMeters > config.corridorMaxWidthMeters ||
      lengthCells / widthCells < config.corridorMinAspectRatio)) return;
    // Explicit regions take precedence. Ambiguous overlaps retain their first
    // declared strip; the remaining geometry uses the ordinary cell model.
    if (strip.indices.some(index => membership[index])) return;
    const segment = {
      ...strip,
      id: `${id}:${strip.axis}:${strip.startAlong}:${strip.startAcross}`,
      source,
      lengthMeters: lengthCells * cellSizeMeters,
      widthMeters: widthCells * cellSizeMeters
    };
    for (const index of segment.indices) {
      membership[index] = 1;
      segmentIndexByCell[index] = segments.length;
    }
    segments.push(segment);
  };
  const regions = [...(Array.isArray(floor.corridorRegions) ? floor.corridorRegions : []), ...tagged.values()];
  for (const [regionOffset, region] of regions.entries()) {
    const mask = new Uint8Array(width * height);
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (const cell of Array.isArray(region?.cells) ? region.cells : []) {
      const index = cellIndex(cell, width, height);
      if (index < 0 || !passable[index]) continue;
      mask[index] = 1;
      minX = Math.min(minX, index % width); maxX = Math.max(maxX, index % width);
      minY = Math.min(minY, Math.floor(index / width)); maxY = Math.max(maxY, Math.floor(index / width));
    }
    const axis = region.axis === "x" || region.axis === "y" ? region.axis
      : (maxX - minX >= maxY - minY ? "x" : "y");
    for (const strip of strips(mask, axis, width, height)) add(strip, String(region.id || `region-${regionOffset}`), "scenario", true);
  }
  if (config.corridorAutoDetect) {
    for (const axis of ["x", "y"]) {
      for (const strip of strips(passable, axis, width, height)) add(strip, "auto", "geometry", false);
    }
  }
  return { membership, segmentIndexByCell, segments };
}

function geometryFor(floor, physics, options) {
  // topologyHash is rebuilt by smoke3d for structural edits/door changes.
  // Increment floor.corridorRevision when changing per-cell corridor tags.
  const signature = JSON.stringify([
    physics.topologyHash, physics.width, physics.height, floor.cellSizeMeters,
    floor.corridorRevision || 0, floor.corridorRegions || null,
    ...Object.keys(DEFAULT_CORRIDOR_OPTIONS).map(key => options[key])
  ]);
  const cached = geometryCache.get(physics);
  if (cached?.signature === signature) return cached.geometry;
  const geometry = identifyCorridorSegments(floor, options);
  geometryCache.set(physics, { signature, geometry });
  return geometry;
}

/**
 * Plan physical transfers without modifying any extensive quantity. The caller
 * MUST skip its generic advection for membership cells and apply these requests
 * using its shared equal-and-opposite volume/soot/CO/enthalpy flux accounting.
 * Incoming stair/door smoke seeds the next call directly from physical contents;
 * there is no independent source or externally imposed concentration field.
 */
export function computeCorridorSmokeTransport(floor, physics, dtSeconds, options = {}) {
  const config = configFor(options);
  const geometry = geometryFor(floor, physics, config);
  const { width, height, cellSizeMeters } = dimensions(floor);
  const area = cellSizeMeters ** 2;
  const roomHeight = Math.max(0.1, finite(physics.roomHeightMeters, 2.8));
  const ambient = finite(options.ambientTemperatureC, 20);
  const density = Math.max(0.1, finite(options.airDensityKgM3, 1.2));
  const cp = Math.max(0.01, finite(options.airSpecificHeatKJKgK, 1.005));
  const dt = positive(dtSeconds, 0);
  const maxFraction = Math.min(0.3, config.corridorMaxTransferFraction,
    Math.max(0, finite(options.cflNumber, 0.42)));
  const volumeAt = index => positive(physics.hotGasVolumeM3?.[index], 0);
  const depthAt = index => Math.min(roomHeight, volumeAt(index) / area);
  const temperatureAt = index => ambient + positive(physics.excessHeatKJ?.[index], 0) /
    Math.max(1e-12, density * cp * volumeAt(index));
  const transfers = [];
  let maxFrontVelocityMps = 0;
  const segments = geometry.segments.map((segment, segmentIndex) => {
    let totalVolume = 0, totalHeat = 0, occupiedCells = 0;
    let frontMin = Infinity, frontMax = -Infinity, leftSpeed = 0, rightSpeed = 0;
    for (const index of segment.indices) {
      const volume = volumeAt(index);
      const depth = depthAt(index);
      const temperature = temperatureAt(index);
      const speed = corridorFrontVelocityMps(depth, temperature, config);
      maxFrontVelocityMps = Math.max(maxFrontVelocityMps, speed);
      totalVolume += volume;
      totalHeat += positive(physics.excessHeatKJ?.[index], 0);
      const cx = index % width, cy = Math.floor(index / width);
      if (depth >= config.corridorFrontDepthThresholdMeters && volume > 1e-12) {
        occupiedCells++;
        const position = ((segment.axis === "x" ? cx : cy) - segment.startAlong) * cellSizeMeters;
        if (position < frontMin) { frontMin = position; leftSpeed = speed; }
        if (position + cellSizeMeters > frontMax) { frontMax = position + cellSizeMeters; rightSpeed = speed; }
      }
      if (!(volume > 1e-12) || !(speed > 0) || !(dt > 0)) continue;
      // An upwind depth-gradient closure pushes the current towards thinner
      // layers. Transverse within-strip mixing stays in the cell model; open
      // side doors/endpoints exchange directly with the adjacent fallback cell.
      const targets = [];
      let weightSum = 0;
      for (const [dx, dy] of DIRECTIONS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const target = ny * width + nx;
        if (!corridorSmokePassable(floor.grid[ny]?.[nx])) continue;
        if (physics.passableMask && !physics.passableMask[target]) continue;
        const sameSegment = geometry.segmentIndexByCell[target] === segmentIndex;
        const axial = segment.axis === "x" ? dx !== 0 : dy !== 0;
        if (sameSegment && !axial) continue;
        const weight = Math.max(0, depth - depthAt(target));
        if (!(weight > 1e-12)) continue;
        targets.push({ target, weight }); weightSum += weight;
      }
      if (!targets.length) continue;
      // V_out=V*(1-exp(-v*dt/dx)) [m³], capped before fan-out. Every target
      // receives a share of ONE source budget, never a duplicate source volume.
      // Taper to zero as neighboring layer depths equilibrate; otherwise
      // normalizing tiny gradients would cause full-speed flux reversals.
      const gradientFraction = Math.min(1, weightSum / Math.max(1e-12, depth));
      const outgoing = volume * Math.min(maxFraction, -Math.expm1(-speed * dt / cellSizeMeters)) * gradientFraction;
      for (const { target, weight } of targets) {
        transfers.push({ fromIndex: index, toIndex: target, volumeM3: outgoing * weight / weightSum });
      }
    }
    const active = occupiedCells > 0;
    return {
      id: segment.id, axis: segment.axis, source: segment.source,
      startCell: segment.axis === "x"
        ? { cx: segment.startAlong, cy: segment.startAcross }
        : { cx: segment.startAcross, cy: segment.startAlong },
      lengthMeters: segment.lengthMeters, widthMeters: segment.widthMeters,
      active,
      frontPositionMeters: active ? frontMax : 0,
      frontMinPositionMeters: active ? frontMin : 0,
      frontVelocityMps: active ? Math.max(leftSpeed, rightSpeed) : 0,
      upperLayerDepthMeters: Math.min(roomHeight, totalVolume / Math.max(area, segment.indices.length * area)),
      upperLayerTemperatureC: totalVolume > 1e-12 ? ambient + totalHeat / (density * cp * totalVolume) : ambient,
      fronts: active ? [
        { direction: -1, positionMeters: frontMin, velocityMps: leftSpeed },
        { direction: 1, positionMeters: frontMax, velocityMps: rightSpeed }
      ] : []
    };
  });
  return { membership: geometry.membership, transfers, segments, maxFrontVelocityMps };
}
