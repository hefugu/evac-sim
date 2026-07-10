import { getFloorByIndex, normalizeFloors3D } from "./floors3d.js";
import {
  normalizeStairLink,
  stairSmokeTransferFactor,
  STAIR_TYPE_META
} from "./stairs3d.js";

export const DEFAULT_SMOKE3D_OPTIONS = Object.freeze({
  maxSmokeDensity: 4.5,
  fireSourcePerSec: 3.8,
  diffusionPerMeterSec: 0.42,
  spreadMix: 0.65,
  diagonalMix: 0.25,
  decayPerSec: 0.006,
  ventDecayBonusPerSec: 0.08,
  exitVentRadiusCells: 2.2,
  verticalTransferRatePerSec: 1,
  opticalDensityPerSmokeDensity: 0.32,
  coPpmPerSmokeDensity: 260,
  visibilityNumerator: 3,
  maxVisibilityMeters: 30,
  referenceVisibilityMeters: 30,
  smokeCeilingThreshold: 0.04
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
    ...DEFAULT_SMOKE3D_OPTIONS,
    ...options,
    maxSmokeDensity: Math.max(0.001, finiteNumber(options.maxSmokeDensity, DEFAULT_SMOKE3D_OPTIONS.maxSmokeDensity)),
    fireSourcePerSec: Math.max(0, finiteNumber(options.fireSourcePerSec, DEFAULT_SMOKE3D_OPTIONS.fireSourcePerSec)),
    diffusionPerMeterSec: Math.max(0, finiteNumber(options.diffusionPerMeterSec, DEFAULT_SMOKE3D_OPTIONS.diffusionPerMeterSec)),
    spreadMix: Math.max(0, finiteNumber(options.spreadMix, DEFAULT_SMOKE3D_OPTIONS.spreadMix)),
    diagonalMix: Math.max(0, finiteNumber(options.diagonalMix, DEFAULT_SMOKE3D_OPTIONS.diagonalMix)),
    decayPerSec: Math.max(0, finiteNumber(options.decayPerSec, DEFAULT_SMOKE3D_OPTIONS.decayPerSec)),
    verticalTransferRatePerSec: Math.max(0, finiteNumber(
      options.verticalTransferRatePerSec,
      DEFAULT_SMOKE3D_OPTIONS.verticalTransferRatePerSec
    ))
  };
}

export function normalizeFdsSmokeRecord(record, options = {}) {
  if (!record || typeof record !== "object") return null;
  const config = normalizedOptions(options);
  const explicitSmokeDensity = finiteNumber(
    record.smokeDensity ?? record.smoke_density,
    NaN
  );
  const opticalDensity = finiteNumber(
    record.opticalDensity ?? record.opticalDensityM1 ?? record.optical_density_m_1 ?? record.optical_density,
    NaN
  );
  const coPpm = finiteNumber(record.coPpm ?? record.co_ppm, NaN);
  let visibilityMeters = finiteNumber(
    record.visibilityMeters ?? record.visibilityM ?? record.visibility_m,
    NaN
  );
  if (!Number.isFinite(visibilityMeters)) {
    const looseVisibility = finiteNumber(record.visibility, NaN);
    if (looseVisibility > 1) visibilityMeters = looseVisibility;
  }
  if (
    !Number.isFinite(explicitSmokeDensity) &&
    !Number.isFinite(opticalDensity) &&
    !Number.isFinite(coPpm) &&
    !Number.isFinite(visibilityMeters)
  ) return null;

  const density = Number.isFinite(explicitSmokeDensity)
    ? Math.max(0, explicitSmokeDensity)
    : (Number.isFinite(opticalDensity)
        ? Math.max(0, opticalDensity) / Math.max(0.0001, config.opticalDensityPerSmokeDensity)
        : null);
  return {
    smokeDensity: density,
    opticalDensity: Number.isFinite(opticalDensity) ? Math.max(0, opticalDensity) : null,
    coPpm: Number.isFinite(coPpm) ? Math.max(0, coPpm) : null,
    visibilityMeters: Number.isFinite(visibilityMeters) ? Math.max(0, visibilityMeters) : null,
    source: "fds_csv"
  };
}

export function deriveSmokeMetrics(smokeDensity, options = {}) {
  const config = normalizedOptions(options);
  const density = clamp(finiteNumber(smokeDensity, 0), 0, config.maxSmokeDensity);
  const opticalDensity = density * config.opticalDensityPerSmokeDensity;
  const visibilityMeters = opticalDensity > 0.001
    ? Math.min(config.maxVisibilityMeters, config.visibilityNumerator / opticalDensity)
    : config.maxVisibilityMeters;
  return {
    smokeDensity: density,
    opticalDensity,
    coPpm: density * config.coPpmPerSmokeDensity,
    visibilityMeters,
    visibility: clamp(visibilityMeters / config.referenceVisibilityMeters, 0, 1),
    source: "fallback_smoke"
  };
}

/** FDS values replace only fields actually present in the CSV record. */
export function applyFdsSmokeRecord(metrics, record, options = {}) {
  const config = normalizedOptions(options);
  const fds = normalizeFdsSmokeRecord(record, config);
  if (!fds) return { ...metrics };
  const smokeDensity = fds.smokeDensity == null ? metrics.smokeDensity : fds.smokeDensity;
  const opticalDensity = fds.opticalDensity == null
    ? (fds.smokeDensity == null ? metrics.opticalDensity : smokeDensity * config.opticalDensityPerSmokeDensity)
    : fds.opticalDensity;
  const coPpm = fds.coPpm == null ? metrics.coPpm : fds.coPpm;
  const visibilityMeters = fds.visibilityMeters == null
    ? (opticalDensity > 0.001
        ? Math.min(config.maxVisibilityMeters, config.visibilityNumerator / opticalDensity)
        : config.maxVisibilityMeters)
    : fds.visibilityMeters;
  return {
    smokeDensity: clamp(smokeDensity, 0, config.maxSmokeDensity),
    opticalDensity: Math.max(0, opticalDensity),
    coPpm: Math.max(0, coPpm),
    visibilityMeters: Math.max(0, visibilityMeters),
    visibility: clamp(visibilityMeters / config.referenceVisibilityMeters, 0, 1),
    source: "fds_csv"
  };
}

function fdsRecordAt(options, floorIndex, cx, cy, timeSec) {
  const lookup = options.fdsLookup || options.fdsProvider?.lookup;
  return typeof lookup === "function" ? lookup(floorIndex, cx, cy, timeSec) : null;
}

function smokePassable(cell) {
  return !!cell && (cell.fire || (!cell.wall && !!(
    cell.walkable || cell.stair || cell.door || cell.atrium
  )));
}

function makeNumberGrid(width, height, fill = 0) {
  return Array.from({ length: height }, () => Array(width).fill(fill));
}

function ventilationGrid(floor, config) {
  const vent = makeNumberGrid(floor.gridWidth, floor.gridHeight, 0);
  for (let cy = 0; cy < floor.gridHeight; cy++) {
    for (let cx = 0; cx < floor.gridWidth; cx++) {
      const cell = floor.grid[cy][cx];
      vent[cy][cx] = Math.max(0, finiteNumber(cell.ventilation, 0));
      if (cell.stair && cell.stairType === "outdoor") vent[cy][cx] = Math.max(vent[cy][cx], 1);
    }
  }
  (Array.isArray(floor.exits) ? floor.exits : []).forEach(exit => {
    const ex = Math.round(finiteNumber(exit.cx ?? exit.x, -10000));
    const ey = Math.round(finiteNumber(exit.cy ?? exit.y, -10000));
    const radius = config.exitVentRadiusCells;
    const search = Math.ceil(radius);
    for (let dy = -search; dy <= search; dy++) {
      for (let dx = -search; dx <= search; dx++) {
        const nx = ex + dx;
        const ny = ey + dy;
        if (!vent[ny]?.[nx] && vent[ny]?.[nx] !== 0) continue;
        const distance = Math.hypot(dx, dy);
        if (distance <= radius) vent[ny][nx] = Math.max(vent[ny][nx], 1 - distance / (radius + 0.001));
      }
    }
  });
  return vent;
}

function diffuseFloorSmoke(floor, dt, config) {
  const next = makeNumberGrid(floor.gridWidth, floor.gridHeight, 0);
  const vent = ventilationGrid(floor, config);
  const moveFraction = clamp(
    (config.diffusionPerMeterSec / Math.max(0.05, floor.cellSizeMeters)) * config.spreadMix * dt,
    0,
    0.92
  );
  const cardinal = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]];
  const diagonal = [[1, 1], [-1, 1], [1, -1], [-1, -1]];

  for (let cy = 0; cy < floor.gridHeight; cy++) {
    for (let cx = 0; cx < floor.gridWidth; cx++) {
      const cell = floor.grid[cy][cx];
      if (!smokePassable(cell)) continue;
      const fireIntensity = cell.fire
        ? Math.max(0.05, finiteNumber(cell.fireIntensity, 0.05))
        : 0;
      let amount = Math.max(0, finiteNumber(cell.smokeDensity, floor.smokeMap?.[cy]?.[cx] || 0));
      amount += config.fireSourcePerSec * fireIntensity * dt;
      if (amount <= 0.000001) continue;

      const targets = [];
      cardinal.forEach(([dx, dy, weight]) => {
        if (smokePassable(floor.grid?.[cy + dy]?.[cx + dx])) targets.push({ cx: cx + dx, cy: cy + dy, weight });
      });
      if (config.diagonalMix > 0) {
        diagonal.forEach(([dx, dy]) => {
          const target = floor.grid?.[cy + dy]?.[cx + dx];
          if (!smokePassable(target)) return;
          const sideA = smokePassable(floor.grid?.[cy]?.[cx + dx]);
          const sideB = smokePassable(floor.grid?.[cy + dy]?.[cx]);
          if (sideA || sideB) targets.push({ cx: cx + dx, cy: cy + dy, weight: config.diagonalMix });
        });
      }

      let remaining = amount;
      if (targets.length) {
        const moved = amount * moveFraction;
        const totalWeight = targets.reduce((sum, target) => sum + target.weight, 0);
        remaining -= moved;
        targets.forEach(target => {
          next[target.cy][target.cx] += moved * target.weight / totalWeight;
        });
      }
      next[cy][cx] += remaining;
    }
  }

  for (let cy = 0; cy < floor.gridHeight; cy++) {
    for (let cx = 0; cx < floor.gridWidth; cx++) {
      if (!smokePassable(floor.grid[cy][cx])) {
        next[cy][cx] = 0;
        continue;
      }
      const cellVent = Math.max(0, finiteNumber(vent[cy][cx], 0));
      const decay = Math.exp(-(
        config.decayPerSec + config.ventDecayBonusPerSec * cellVent
      ) * dt);
      next[cy][cx] = clamp(next[cy][cx] * decay, 0, config.maxSmokeDensity);
    }
  }
  return next;
}

function applyVerticalSmoke(densityByFloor, floors, links, dt, config) {
  const delta = new Map();
  const transfers = [];
  const deltaGridFor = floor => {
    if (!delta.has(floor.floorIndex)) {
      delta.set(floor.floorIndex, makeNumberGrid(floor.gridWidth, floor.gridHeight, 0));
    }
    return delta.get(floor.floorIndex);
  };

  links.forEach(raw => {
    const link = normalizeStairLink(raw);
    if (link.from.floorIndex === link.to.floorIndex) return;
    const floorA = getFloorByIndex(floors, link.from.floorIndex);
    const floorB = getFloorByIndex(floors, link.to.floorIndex);
    if (!floorA || !floorB) return;
    const lower = floorA.elevationMeters <= floorB.elevationMeters ? link.from : link.to;
    const upper = lower === link.from ? link.to : link.from;
    const lowerFloor = getFloorByIndex(floors, lower.floorIndex);
    const upperFloor = getFloorByIndex(floors, upper.floorIndex);
    const lowerGrid = densityByFloor.get(lower.floorIndex);
    const upperGrid = densityByFloor.get(upper.floorIndex);
    if (!lowerGrid?.[lower.cy] || !upperGrid?.[upper.cy]) return;
    if (!smokePassable(lowerFloor.grid?.[lower.cy]?.[lower.cx])) return;
    if (!smokePassable(upperFloor.grid?.[upper.cy]?.[upper.cx])) return;

    const sourceDensity = Math.max(0, lowerGrid[lower.cy][lower.cx]);
    const rate = stairSmokeTransferFactor(link) * config.verticalTransferRatePerSec;
    const typeMeta = STAIR_TYPE_META[link.type] || STAIR_TYPE_META.indoor;
    const ventFraction = typeMeta.ventilationFactor >= 0.5
      ? clamp(1 - Math.exp(-config.ventDecayBonusPerSec * typeMeta.ventilationFactor * dt), 0, 0.45)
      : 0;
    const fraction = clamp(1 - Math.exp(-rate * dt), 0, Math.max(0, 0.9 - ventFraction));
    const amount = sourceDensity * fraction;
    const lowerVented = sourceDensity * ventFraction;
    const upperDensity = Math.max(0, upperGrid[upper.cy][upper.cx]);
    const upperVented = upperDensity * ventFraction;
    if (!(amount > 0) && !(lowerVented > 0) && !(upperVented > 0)) return;
    deltaGridFor(lowerFloor)[lower.cy][lower.cx] -= amount + lowerVented;
    deltaGridFor(upperFloor)[upper.cy][upper.cx] += amount - upperVented;
    transfers.push({
      stairId: link.id,
      from: lower,
      to: upper,
      amount,
      fraction,
      ventedAmount: lowerVented + upperVented
    });
  });

  delta.forEach((floorDelta, floorIndex) => {
    const density = densityByFloor.get(floorIndex);
    for (let cy = 0; cy < floorDelta.length; cy++) {
      for (let cx = 0; cx < floorDelta[cy].length; cx++) {
        density[cy][cx] = clamp(
          density[cy][cx] + floorDelta[cy][cx],
          0,
          config.maxSmokeDensity
        );
      }
    }
  });
  return transfers;
}

/**
 * Advance per-floor smoke, then transfer it upward through typed stair links.
 * No input floor, cell, link, or FDS record is mutated.
 */
export function stepSmoke3D(floorsInput, stairLinksInput, dtSeconds, options = {}) {
  const config = normalizedOptions(options);
  const dt = Math.max(0, finiteNumber(dtSeconds, 0));
  const timeSec = Math.max(0, finiteNumber(options.timeSec, dt));
  const floors = normalizeFloors3D(floorsInput, options);
  const links = (Array.isArray(stairLinksInput) ? stairLinksInput : []).map(raw => normalizeStairLink(raw));
  const densityByFloor = new Map();
  floors.forEach(floor => densityByFloor.set(floor.floorIndex, diffuseFloorSmoke(floor, dt, config)));
  const verticalTransfers = applyVerticalSmoke(densityByFloor, floors, links, dt, config);

  let maxSmokeDensity = 0;
  let totalSmoke = 0;
  const nextFloors = floors.map(floor => {
    const density = densityByFloor.get(floor.floorIndex);
    const grid = floor.grid.map((row, cy) => row.map((cell, cx) => {
      const fallback = deriveSmokeMetrics(density[cy][cx], config);
      const metrics = applyFdsSmokeRecord(
        fallback,
        fdsRecordAt(config, floor.floorIndex, cx, cy, timeSec),
        config
      );
      maxSmokeDensity = Math.max(maxSmokeDensity, metrics.smokeDensity);
      totalSmoke += metrics.smokeDensity;
      return {
        ...cell,
        ...metrics,
        smoke: metrics.smokeDensity,
        opticalDensityM1: metrics.opticalDensity,
        co: metrics.coPpm,
        visibilityM: metrics.visibilityMeters,
        smokeDataSource: metrics.source
      };
    }));
    const smokeMap = grid.map(row => row.map(cell => cell.smokeDensity));
    const smokeCeil = grid.map(row => row.map(cell => cell.smokeDensity >= config.smokeCeilingThreshold));
    return { ...floor, grid, smokeMap, smokeCeil };
  });

  return {
    floors: nextFloors,
    verticalTransfers,
    maxSmokeDensity,
    totalSmoke,
    timeSec
  };
}

export function smokeRiskAt3D(floors, endpoint = {}, options = {}) {
  const floorIndex = Math.floor(finiteNumber(endpoint.floorIndex ?? endpoint.floor, 0));
  const cx = Math.round(finiteNumber(endpoint.cx ?? endpoint.x, 0));
  const cy = Math.round(finiteNumber(endpoint.cy ?? endpoint.y, 0));
  const floor = getFloorByIndex(floors, floorIndex);
  const cell = floor?.grid?.[cy]?.[cx];
  if (!cell) return deriveSmokeMetrics(0, options);
  return {
    smokeDensity: Math.max(0, finiteNumber(cell.smokeDensity, cell.smoke || 0)),
    opticalDensity: Math.max(0, finiteNumber(cell.opticalDensity ?? cell.opticalDensityM1, 0)),
    coPpm: Math.max(0, finiteNumber(cell.coPpm, cell.co || 0)),
    visibilityMeters: Math.max(0, finiteNumber(cell.visibilityMeters ?? cell.visibilityM, 30)),
    visibility: clamp(finiteNumber(cell.visibility, 1), 0, 1),
    source: cell.smokeDataSource || cell.source || "floor"
  };
}

/** Useful to UI code that wants a type-aware local ventilation preview. */
export function stairVentilationFactor(linkInput) {
  const link = normalizeStairLink(linkInput);
  return STAIR_TYPE_META[link.type]?.ventilationFactor ?? 0;
}

function legacyFloorEntry(floors, floorIndex) {
  if (!Array.isArray(floors)) return null;
  const exactIndex = floors.findIndex((floor, arrayIndex) =>
    Math.floor(finiteNumber(floor?.floorIndex ?? floor?.floor, arrayIndex)) === floorIndex
  );
  if (exactIndex >= 0) return { floor: floors[exactIndex], arrayIndex: exactIndex };
  return floors[floorIndex] ? { floor: floors[floorIndex], arrayIndex: floorIndex } : null;
}

function legacyFloorElevation(entry, floorIndex, options) {
  const floorHeightMeters = Math.max(0.1, finiteNumber(
    entry?.floor?.floorHeightMeters ?? options.floorHeightMeters,
    3.5
  ));
  return finiteNumber(
    entry?.floor?.elevationMeters ?? entry?.floor?.zMeters,
    floorIndex * floorHeightMeters
  );
}

/**
 * Lightweight core.js adapter: mutate only existing floorStates.smokeMap
 * endpoint values after the legacy horizontal diffusion step. It deliberately
 * does not normalize or copy entire grids. The returned array is suitable for
 * logging/metrics and includes the actual transferred and vented amounts.
 */
export function transferLegacySmokeThroughStairs(
  floors,
  stairLinks,
  dtSeconds,
  options = {}
) {
  if (!Array.isArray(floors) || !Array.isArray(stairLinks)) return [];
  const config = normalizedOptions(options);
  const dt = Math.max(0, finiteNumber(dtSeconds, 0));
  if (!(dt > 0)) return [];
  const requests = [];
  const outgoingByCell = new Map();

  stairLinks.forEach(raw => {
    const link = normalizeStairLink(raw);
    if (link.from.floorIndex === link.to.floorIndex) return;
    const fromEntry = legacyFloorEntry(floors, link.from.floorIndex);
    const toEntry = legacyFloorEntry(floors, link.to.floorIndex);
    if (!fromEntry?.floor?.smokeMap || !toEntry?.floor?.smokeMap) return;
    const fromElevation = legacyFloorElevation(fromEntry, link.from.floorIndex, config);
    const toElevation = legacyFloorElevation(toEntry, link.to.floorIndex, config);
    const lower = fromElevation <= toElevation ? link.from : link.to;
    const upper = lower === link.from ? link.to : link.from;
    const lowerEntry = lower === link.from ? fromEntry : toEntry;
    const upperEntry = upper === link.to ? toEntry : fromEntry;
    const lowerRow = lowerEntry.floor.smokeMap?.[lower.cy];
    const upperRow = upperEntry.floor.smokeMap?.[upper.cy];
    if (!lowerRow || !upperRow || lowerRow[lower.cx] == null || upperRow[upper.cx] == null) return;

    const sourceDensity = Math.max(0, finiteNumber(lowerRow[lower.cx], 0));
    const upperDensity = Math.max(0, finiteNumber(upperRow[upper.cx], 0));
    const rate = stairSmokeTransferFactor(link) * config.verticalTransferRatePerSec;
    const typeMeta = STAIR_TYPE_META[link.type] || STAIR_TYPE_META.indoor;
    const ventFraction = typeMeta.ventilationFactor >= 0.5
      ? clamp(1 - Math.exp(-config.ventDecayBonusPerSec * typeMeta.ventilationFactor * dt), 0, 0.45)
      : 0;
    const fraction = clamp(1 - Math.exp(-rate * dt), 0, Math.max(0, 0.9 - ventFraction));
    const request = {
      stairId: link.id,
      type: link.type,
      from: lower,
      to: upper,
      lowerEntry,
      upperEntry,
      sourceDensity,
      amount: sourceDensity * fraction,
      lowerVented: sourceDensity * ventFraction,
      upperVented: upperDensity * ventFraction,
      fraction
    };
    const sourceKey = `${lowerEntry.arrayIndex}:${lower.cx}:${lower.cy}`;
    request.sourceKey = sourceKey;
    outgoingByCell.set(
      sourceKey,
      (outgoingByCell.get(sourceKey) || 0) + request.amount + request.lowerVented
    );
    requests.push(request);
  });

  const deltas = new Map();
  const deltaFor = entry => {
    if (!deltas.has(entry.arrayIndex)) {
      deltas.set(
        entry.arrayIndex,
        entry.floor.smokeMap.map(row => Array.isArray(row) ? new Array(row.length).fill(0) : [])
      );
    }
    return deltas.get(entry.arrayIndex);
  };
  const transfers = [];

  requests.forEach(request => {
    const totalOutgoing = outgoingByCell.get(request.sourceKey) || 0;
    const scale = totalOutgoing > request.sourceDensity && totalOutgoing > 0
      ? request.sourceDensity / totalOutgoing
      : 1;
    const amount = request.amount * scale;
    const lowerVented = request.lowerVented * scale;
    const lowerDelta = deltaFor(request.lowerEntry);
    const upperDelta = deltaFor(request.upperEntry);
    lowerDelta[request.from.cy][request.from.cx] -= amount + lowerVented;
    upperDelta[request.to.cy][request.to.cx] += amount - request.upperVented;
    transfers.push({
      stairId: request.stairId,
      type: request.type,
      from: { ...request.from },
      to: { ...request.to },
      amount,
      fraction: request.fraction * scale,
      ventedAmount: lowerVented + request.upperVented
    });
  });

  const touched = [];
  deltas.forEach((delta, arrayIndex) => {
    const floor = floors[arrayIndex];
    for (let cy = 0; cy < delta.length; cy++) {
      for (let cx = 0; cx < delta[cy].length; cx++) {
        if (!delta[cy][cx]) continue;
        floor.smokeMap[cy][cx] = clamp(
          finiteNumber(floor.smokeMap[cy][cx], 0) + delta[cy][cx],
          0,
          config.maxSmokeDensity
        );
        touched.push({ floor, cx, cy });
      }
    }
  });

  if (options.syncCellFields) {
    touched.forEach(({ floor, cx, cy }) => {
      const cell = floor.grid?.[cy]?.[cx];
      if (!cell) return;
      const metrics = deriveSmokeMetrics(floor.smokeMap[cy][cx], config);
      Object.assign(cell, metrics, {
        smoke: metrics.smokeDensity,
        opticalDensityM1: metrics.opticalDensity,
        co: metrics.coPpm,
        visibilityM: metrics.visibilityMeters
      });
    });
  }
  return transfers;
}
