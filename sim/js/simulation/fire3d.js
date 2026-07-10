import {
  getFloorByIndex,
  normalizeFloors3D,
  updateFloorCell
} from "./floors3d.js";
import { normalizeStairLink } from "./stairs3d.js";

export const DEFAULT_FIRE3D_OPTIONS = Object.freeze({
  alphaKwPerSec2: 0.0469,
  maxHrrKw: 3000,
  initialIntensity: 0.05,
  spreadRatePerSec: 0.018,
  diagonalSpreadFactor: 0.7,
  doorSpreadFactor: 1.15,
  stairSpreadFactor: 1.25,
  atriumSpreadFactor: 1.4,
  verticalSpreadFactor: 0.18,
  ambientTemperatureC: 20,
  peakTemperatureC: 800,
  peakHeatFluxKwM2: 12
});

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizedOptions(options = {}) {
  return {
    ...DEFAULT_FIRE3D_OPTIONS,
    ...options,
    alphaKwPerSec2: Math.max(0, finiteNumber(options.alphaKwPerSec2, DEFAULT_FIRE3D_OPTIONS.alphaKwPerSec2)),
    maxHrrKw: Math.max(1, finiteNumber(options.maxHrrKw, DEFAULT_FIRE3D_OPTIONS.maxHrrKw)),
    spreadRatePerSec: Math.max(0, finiteNumber(options.spreadRatePerSec, DEFAULT_FIRE3D_OPTIONS.spreadRatePerSec))
  };
}

/** Medium t-squared fire by default. */
export function tSquaredFireHrrKw(timeSec, options = {}) {
  const config = normalizedOptions(options);
  const time = Math.max(0, finiteNumber(timeSec, 0));
  return Math.min(config.maxHrrKw, config.alphaKwPerSec2 * time * time);
}

export function normalizeFdsFireRecord(record) {
  if (!record || typeof record !== "object") return null;
  const heatFluxKwM2 = finiteNumber(
    record.heatFluxKwM2 ?? record.heat_flux_kw_m2 ?? record.heat_flux,
    NaN
  );
  const temperatureC = finiteNumber(
    record.temperatureC ?? record.temperature_c ?? record.temperature,
    NaN
  );
  if (!Number.isFinite(heatFluxKwM2) && !Number.isFinite(temperatureC)) return null;
  return {
    heatFluxKwM2: Number.isFinite(heatFluxKwM2) ? Math.max(0, heatFluxKwM2) : null,
    temperatureC: Number.isFinite(temperatureC) ? temperatureC : null,
    source: "fds_csv"
  };
}

export function deriveFireMetrics(intensity, options = {}) {
  const config = normalizedOptions(options);
  const level = clamp(finiteNumber(intensity, 0), 0, 1);
  return {
    fireIntensity: level,
    temperatureC: config.ambientTemperatureC +
      (config.peakTemperatureC - config.ambientTemperatureC) * Math.pow(level, 0.7),
    heatFluxKwM2: config.peakHeatFluxKwM2 * level,
    source: "fallback_t2"
  };
}

/** FDS values replace the corresponding fallback fields, one field at a time. */
export function applyFdsFireRecord(metrics, record) {
  const fds = normalizeFdsFireRecord(record);
  if (!fds) return { ...metrics };
  return {
    ...metrics,
    temperatureC: fds.temperatureC == null ? metrics.temperatureC : fds.temperatureC,
    heatFluxKwM2: fds.heatFluxKwM2 == null ? metrics.heatFluxKwM2 : fds.heatFluxKwM2,
    source: "fds_csv"
  };
}

function fdsRecordAt(options, floorIndex, cx, cy, timeSec) {
  const lookup = options.fdsLookup || options.fdsProvider?.lookup;
  return typeof lookup === "function" ? lookup(floorIndex, cx, cy, timeSec) : null;
}

function floorArrayIndex(floors, floorIndex) {
  return floors.findIndex((floor, index) =>
    Math.floor(finiteNumber(floor?.floorIndex ?? floor?.floor, index)) === floorIndex
  );
}

/** Add or replace a fire source without changing the input floor array. */
export function igniteFloorCell(floors, endpoint = {}, options = {}) {
  if (!Array.isArray(floors)) return [];
  const floorIndex = Math.floor(finiteNumber(endpoint.floorIndex ?? endpoint.floor, 0));
  const cx = Math.floor(finiteNumber(endpoint.cx ?? endpoint.x, -1));
  const cy = Math.floor(finiteNumber(endpoint.cy ?? endpoint.y, -1));
  const index = floorArrayIndex(floors, floorIndex);
  if (index < 0 || !floors[index]?.grid?.[cy]?.[cx]) return floors;
  const initialIntensity = clamp(
    finiteNumber(options.fireIntensity, DEFAULT_FIRE3D_OPTIONS.initialIntensity),
    0,
    1
  );
  const metrics = deriveFireMetrics(initialIntensity, options);
  const floor = updateFloorCell(floors[index], cx, cy, cell => ({
    ...cell,
    ...metrics,
    fire: true,
    fireAgeSec: Math.max(0, finiteNumber(options.fireAgeSec, 0)),
    fireSource: options.fireSource || "manual"
  }));
  const next = floors.slice();
  next[index] = floor;
  return next;
}

function spreadFactor(source, target, dx, dy, config) {
  if (!source?.fire || !target || target.fire || target.wall || target.flammable === false) return 0;
  if (!target.walkable && !target.door && !target.stair && !target.atrium) return 0;
  let factor = (dx !== 0 && dy !== 0) ? config.diagonalSpreadFactor : 1;
  if (source.door || target.door) factor *= config.doorSpreadFactor;
  if (source.stair || target.stair) factor *= config.stairSpreadFactor;
  if (source.atrium || target.atrium) factor *= config.atriumSpreadFactor;
  return Math.max(0, factor / Math.max(1, Math.hypot(dx, dy)));
}

function cloneGrid(grid) {
  return grid.map(row => row.map(cell => ({ ...cell })));
}

/**
 * Advance growth and probabilistic spread. Supply options.random for repeatable
 * tests. The result contains a fresh floor array and ignition events.
 */
export function stepFire3D(floorsInput, dtSeconds, options = {}) {
  const config = normalizedOptions(options);
  const dt = Math.max(0, finiteNumber(dtSeconds, 0));
  const timeSec = Math.max(0, finiteNumber(options.timeSec, dt));
  const random = typeof options.random === "function" ? options.random : Math.random;
  const floors = normalizeFloors3D(floorsInput, options);
  const grownGrids = new Map();
  let totalHrrKw = 0;

  for (const floor of floors) {
    const nextGrid = cloneGrid(floor.grid);
    for (let cy = 0; cy < floor.gridHeight; cy++) {
      for (let cx = 0; cx < floor.gridWidth; cx++) {
        const previous = floor.grid[cy][cx];
        const next = nextGrid[cy][cx];
        if (previous.fire) {
          const age = Math.max(0, finiteNumber(previous.fireAgeSec, 0)) + dt;
          const hrrKw = tSquaredFireHrrKw(age, config);
          const intensity = clamp(Math.max(
            finiteNumber(previous.fireIntensity, config.initialIntensity),
            hrrKw / config.maxHrrKw
          ), 0, 1);
          const fallback = deriveFireMetrics(intensity, config);
          const metrics = applyFdsFireRecord(
            fallback,
            fdsRecordAt(config, floor.floorIndex, cx, cy, timeSec)
          );
          Object.assign(next, metrics, {
            fire: true,
            fireAgeSec: age,
            hrrKw,
            heat: metrics.heatFluxKwM2
          });
          totalHrrKw += hrrKw;
        } else {
          const fds = normalizeFdsFireRecord(fdsRecordAt(config, floor.floorIndex, cx, cy, timeSec));
          if (fds) {
            if (fds.temperatureC != null) next.temperatureC = fds.temperatureC;
            if (fds.heatFluxKwM2 != null) {
              next.heatFluxKwM2 = fds.heatFluxKwM2;
              next.heat = fds.heatFluxKwM2;
            }
            next.fireDataSource = "fds_csv";
          }
        }
      }
    }
    grownGrids.set(floor.floorIndex, nextGrid);
  }

  const ignitionHazard = new Map();
  const addHazard = (floorIndex, cx, cy, value, source) => {
    if (!(value > 0)) return;
    const key = `${floorIndex}:${cx}:${cy}`;
    const current = ignitionHazard.get(key) || { hazard: 0, sources: [] };
    current.hazard += value;
    current.sources.push(source);
    ignitionHazard.set(key, current);
  };
  const directions = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],             [1, 0],
    [-1, 1],  [0, 1],   [1, 1]
  ];

  for (const floor of floors) {
    const grid = grownGrids.get(floor.floorIndex);
    for (let cy = 0; cy < floor.gridHeight; cy++) {
      for (let cx = 0; cx < floor.gridWidth; cx++) {
        const source = grid[cy][cx];
        if (!source.fire) continue;
        for (const [dx, dy] of directions) {
          const nx = cx + dx;
          const ny = cy + dy;
          const target = grid[ny]?.[nx];
          const factor = spreadFactor(source, target, dx, dy, config);
          addHazard(
            floor.floorIndex,
            nx,
            ny,
            config.spreadRatePerSec * source.fireIntensity * factor * dt,
            { floorIndex: floor.floorIndex, cx, cy }
          );
        }
      }
    }
  }

  // A small vertical ignition path gives stairwells/atria a meaningful role
  // without pretending to be a CFD solver.
  (Array.isArray(options.stairLinks) ? options.stairLinks : []).forEach(raw => {
    const link = normalizeStairLink(raw);
    for (const [from, to] of [[link.from, link.to], [link.to, link.from]]) {
      const fromFloor = getFloorByIndex(floors, from.floorIndex);
      const toFloor = getFloorByIndex(floors, to.floorIndex);
      const source = grownGrids.get(from.floorIndex)?.[from.cy]?.[from.cx];
      const target = grownGrids.get(to.floorIndex)?.[to.cy]?.[to.cx];
      if (!fromFloor || !toFloor || !source?.fire || !target || target.fire || target.wall || target.flammable === false) continue;
      const upward = toFloor.elevationMeters > fromFloor.elevationMeters;
      const directionFactor = upward ? 1 : 0.3;
      addHazard(
        to.floorIndex,
        to.cx,
        to.cy,
        config.spreadRatePerSec * source.fireIntensity * config.verticalSpreadFactor * directionFactor * dt,
        { floorIndex: from.floorIndex, cx: from.cx, cy: from.cy, stairId: link.id }
      );
    }
  });

  const ignited = [];
  for (const [key, record] of ignitionHazard.entries()) {
    const [floorIndex, cx, cy] = key.split(":").map(Number);
    const probability = 1 - Math.exp(-record.hazard);
    if (random() >= probability) continue;
    const grid = grownGrids.get(floorIndex);
    const target = grid?.[cy]?.[cx];
    if (!target || target.fire) continue;
    const metrics = deriveFireMetrics(config.initialIntensity, config);
    Object.assign(target, metrics, {
      fire: true,
      fireAgeSec: 0,
      hrrKw: 0,
      fireSource: "spread",
      heat: metrics.heatFluxKwM2
    });
    ignited.push({ floorIndex, cx, cy, probability, sources: record.sources });
  }

  let activeFireCount = 0;
  const nextFloors = floors.map(floor => {
    const grid = grownGrids.get(floor.floorIndex);
    const heatmap = grid.map(row => row.map(cell => {
      if (cell.fire) activeFireCount += 1;
      return cell.heatFluxKwM2;
    }));
    return { ...floor, grid, fireHeatMap: heatmap };
  });

  return { floors: nextFloors, ignited, activeFireCount, totalHrrKw, timeSec };
}

/** Local radial risk helper for routing and rendering. */
export function fireRiskAt3D(floors, endpoint = {}, options = {}) {
  const floorIndex = Math.floor(finiteNumber(endpoint.floorIndex ?? endpoint.floor, 0));
  const cx = Math.round(finiteNumber(endpoint.cx ?? endpoint.x, 0));
  const cy = Math.round(finiteNumber(endpoint.cy ?? endpoint.y, 0));
  const floor = getFloorByIndex(floors, floorIndex);
  const radius = Math.max(0, finiteNumber(options.radiusCells, 3));
  const lethalRadius = Math.max(0, finiteNumber(options.lethalRadiusCells, 1.1));
  if (!floor) return { heat: 0, heatFluxKwM2: 0, lethal: false };

  let heat = 0;
  let heatFluxKwM2 = 0;
  let lethal = false;
  const search = Math.ceil(radius);
  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      const cell = floor.grid?.[cy + dy]?.[cx + dx];
      if (!cell?.fire) continue;
      const distance = Math.hypot(dx, dy);
      if (distance <= lethalRadius) lethal = true;
      if (distance <= radius) {
        const weight = radius > 0 ? (radius - distance) / radius : 1;
        heat += weight * Math.max(0, finiteNumber(cell.fireIntensity, 0));
        heatFluxKwM2 += weight * Math.max(0, finiteNumber(cell.heatFluxKwM2, 0));
      }
    }
  }
  return { heat, heatFluxKwM2, lethal };
}

function matchingLegacyFloor(legacyFloors, sourceFloor, sourceArrayIndex, options = {}) {
  const floorIndex = Math.floor(finiteNumber(sourceFloor?.floorIndex ?? sourceFloor?.floor, sourceArrayIndex));
  const explicit = legacyFloors.find((floor, arrayIndex) => {
    if (floor?.floorIndex == null && floor?.floor == null) return false;
    return Math.floor(finiteNumber(floor.floorIndex ?? floor.floor, arrayIndex)) === floorIndex;
  });
  if (explicit) return explicit;
  const offsetIndex = floorIndex - Math.floor(finiteNumber(options.floorIndexOffset, 0));
  return legacyFloors[sourceArrayIndex] || legacyFloors[offsetIndex] || legacyFloors[floorIndex] || null;
}

/**
 * Apply a canonical stepFire3D result to core.js floorStates in place. Unknown
 * legacy fields and all array identities are retained, so the 2D renderer keeps
 * its existing references. Fire flags are additive unless copyClearedFire=true.
 */
export function applyFire3DResultToLegacyFloors(
  legacyFloors,
  resultOrFloors,
  options = {}
) {
  if (!Array.isArray(legacyFloors)) {
    return { legacyFloors: [], updatedCells: [], ignitedCells: [] };
  }
  const sourceFloors = Array.isArray(resultOrFloors)
    ? resultOrFloors
    : (Array.isArray(resultOrFloors?.floors) ? resultOrFloors.floors : []);
  const updatedCells = [];
  const ignitedCells = [];

  sourceFloors.forEach((sourceFloor, sourceArrayIndex) => {
    const targetFloor = matchingLegacyFloor(legacyFloors, sourceFloor, sourceArrayIndex, options);
    if (!targetFloor?.grid || !sourceFloor?.grid) return;
    const floorIndex = Math.floor(finiteNumber(
      sourceFloor.floorIndex ?? sourceFloor.floor,
      sourceArrayIndex
    ));
    const height = Math.min(targetFloor.grid.length, sourceFloor.grid.length);
    for (let cy = 0; cy < height; cy++) {
      const width = Math.min(targetFloor.grid[cy]?.length || 0, sourceFloor.grid[cy]?.length || 0);
      for (let cx = 0; cx < width; cx++) {
        const source = sourceFloor.grid[cy][cx];
        const target = targetFloor.grid[cy][cx];
        if (!source || !target) continue;
        const wasFire = !!target.fire;
        const sourceHasHazard = !!source.fire ||
          finiteNumber(source.fireIntensity, 0) > 0 ||
          finiteNumber(source.heatFluxKwM2, 0) > 0 ||
          source.fireDataSource === "fds_csv" || source.source === "fds_csv";
        if (!sourceHasHazard && !options.copyClearedFire) continue;

        if (source.fire) target.fire = true;
        else if (options.copyClearedFire) target.fire = false;
        if (Number.isFinite(Number(source.fireIntensity))) target.fireIntensity = Math.max(0, Number(source.fireIntensity));
        if (Number.isFinite(Number(source.fireAgeSec))) target.fireAgeSec = Math.max(0, Number(source.fireAgeSec));
        if (Number.isFinite(Number(source.hrrKw))) target.hrrKw = Math.max(0, Number(source.hrrKw));
        if (Number.isFinite(Number(source.temperatureC))) target.temperatureC = Number(source.temperatureC);
        if (Number.isFinite(Number(source.heatFluxKwM2))) {
          target.heatFluxKwM2 = Math.max(0, Number(source.heatFluxKwM2));
          target.heat = target.heatFluxKwM2;
        }
        if (source.fireSource != null) target.fireSource = source.fireSource;
        if (source.fireDataSource != null || source.source != null) {
          target.fireDataSource = source.fireDataSource || source.source;
        }
        if (!wasFire && target.fire) {
          if (options.blockIgnitedCells) target.walkable = false;
          ignitedCells.push({ floorIndex, cx, cy });
        }
        updatedCells.push({ floorIndex, cx, cy, fire: !!target.fire });
      }
    }
  });

  return { legacyFloors, updatedCells, ignitedCells };
}

/**
 * Very light per-tick adapter when spread is not required: update t-squared
 * metrics directly on existing fire cells and preserve every legacy identity.
 */
export function stepLegacyFireMetricsInPlace(floors, dtSeconds, options = {}) {
  if (!Array.isArray(floors)) return { activeFireCount: 0, totalHrrKw: 0, updatedCells: [] };
  const config = normalizedOptions(options);
  const dt = Math.max(0, finiteNumber(dtSeconds, 0));
  const timeSec = Math.max(0, finiteNumber(options.timeSec, dt));
  let activeFireCount = 0;
  let totalHrrKw = 0;
  const updatedCells = [];

  floors.forEach((floor, arrayIndex) => {
    if (!Array.isArray(floor?.grid)) return;
    const floorIndex = Math.floor(finiteNumber(floor.floorIndex ?? floor.floor, arrayIndex));
    floor.grid.forEach((row, cy) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, cx) => {
        if (!cell?.fire) return;
        const age = Math.max(0, finiteNumber(cell.fireAgeSec, 0)) + dt;
        const hrrKw = tSquaredFireHrrKw(age, config);
        const intensity = clamp(Math.max(
          finiteNumber(cell.fireIntensity, config.initialIntensity),
          hrrKw / config.maxHrrKw
        ), 0, 1);
        const metrics = applyFdsFireRecord(
          deriveFireMetrics(intensity, config),
          fdsRecordAt(config, floorIndex, cx, cy, timeSec)
        );
        Object.assign(cell, metrics, {
          fire: true,
          fireAgeSec: age,
          hrrKw,
          heat: metrics.heatFluxKwM2,
          fireDataSource: metrics.source
        });
        activeFireCount += 1;
        totalHrrKw += hrrKw;
        updatedCells.push({ floorIndex, cx, cy });
      });
    });
  });
  return { activeFireCount, totalHrrKw, updatedCells };
}
