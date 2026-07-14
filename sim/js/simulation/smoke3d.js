import { getFloorByIndex, normalizeFloors3D } from "./floors3d.js";
import {
  normalizeStairLink,
  stairSmokeTransferFactor,
  STAIR_TYPE_META
} from "./stairs3d.js";

export const DEFAULT_SMOKE3D_OPTIONS = Object.freeze({
  model: "nist_reduced_order",
  fuelPreset: "n_heptane_demo",
  // Fire/product inputs. CFAST and FDS require HRR and species yields to be
  // specified; they do not predict soot or CO production from first principles.
  sourceMultiplier: 1,
  sootYieldKgPerKg: 0.015,
  coYieldKgPerKg: 0.008,
  heatOfCombustionKJPerKg: 44500,
  radiativeFraction: 0.35,
  massExtinctionCoefficientM2PerKg: 8700,
  visibilityFactor: 3,
  // Reduced-order upper-layer / ceiling-jet transport inputs.
  ambientTemperatureC: 20,
  airDensityKgM3: 1.2,
  airSpecificHeatKJKgK: 1.005,
  gravityMps2: 9.81,
  ceilingJetVelocityMultiplier: 1,
  maxCeilingJetVelocityMps: 10,
  turbulentDiffusivityM2Sec: 0.06,
  leakageRatePerSec: 0,
  sootDepositionRatePerSec: 0,
  heatLossRatePerSec: 0.012,
  exitDischargeCoefficient: 0.7,
  exitOpeningHeightMeters: 2,
  defaultExitWidthMeters: 0.9,
  minimumVentVelocityMps: 0.05,
  exitActsAsOpenVent: false,
  stairOpeningDepthMeters: 0.8,
  stairVentFraction: 0.45,
  eyeHeightMeters: 1.6,
  layerTransitionMeters: 0.3,
  maxSubstepSec: 0.1,
  cflNumber: 0.42,
  diagonalMix: 0.15,
  minimumFireHrrKw: 0.02,
  maxExtinctionCoefficientM1: 12,
  legacyDensityPerExtinctionM1: 3.125,
  physicsStateVersion: 3,

  // Compatibility options retained for existing FDS adapters and callers.
  maxSmokeDensity: 37.5,
  fireSourcePerSec: 3.8,
  diffusionPerMeterSec: 0.42,
  spreadMix: 0.65,
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

const CARDINAL_DIRECTIONS = Object.freeze([
  Object.freeze([1, 0]),
  Object.freeze([-1, 0]),
  Object.freeze([0, 1]),
  Object.freeze([0, -1])
]);
const DIAGONAL_DIRECTIONS = Object.freeze([
  Object.freeze([1, 1]),
  Object.freeze([-1, 1]),
  Object.freeze([1, -1]),
  Object.freeze([-1, -1])
]);

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const normalizedOptionObjects = new WeakSet();

function normalizedOptions(options = {}) {
  if (options && typeof options === "object" && normalizedOptionObjects.has(options)) {
    return options;
  }
  const config = {
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
  const nonNegative = (name, fallback = DEFAULT_SMOKE3D_OPTIONS[name]) => {
    config[name] = Math.max(0, finiteNumber(options[name], fallback));
  };
  [
    "sourceMultiplier",
    "sootYieldKgPerKg",
    "coYieldKgPerKg",
    "heatOfCombustionKJPerKg",
    "radiativeFraction",
    "massExtinctionCoefficientM2PerKg",
    "visibilityFactor",
    "airDensityKgM3",
    "airSpecificHeatKJKgK",
    "gravityMps2",
    "ceilingJetVelocityMultiplier",
    "maxCeilingJetVelocityMps",
    "turbulentDiffusivityM2Sec",
    "leakageRatePerSec",
    "sootDepositionRatePerSec",
    "heatLossRatePerSec",
    "exitDischargeCoefficient",
    "exitOpeningHeightMeters",
    "defaultExitWidthMeters",
    "minimumVentVelocityMps",
    "stairOpeningDepthMeters",
    "stairVentFraction",
    "eyeHeightMeters",
    "layerTransitionMeters",
    "maxSubstepSec",
    "cflNumber",
    "diagonalMix",
    "minimumFireHrrKw",
    "maxExtinctionCoefficientM1",
    "legacyDensityPerExtinctionM1"
  ].forEach(name => nonNegative(name));
  config.ambientTemperatureC = finiteNumber(
    options.ambientTemperatureC,
    DEFAULT_SMOKE3D_OPTIONS.ambientTemperatureC
  );
  config.radiativeFraction = clamp(config.radiativeFraction, 0, 0.95);
  config.cflNumber = clamp(config.cflNumber, 0.05, 0.8);
  config.diagonalMix = clamp(config.diagonalMix, 0, 1);
  config.physicsStateVersion = Math.max(1, Math.floor(finiteNumber(
    options.physicsStateVersion,
    DEFAULT_SMOKE3D_OPTIONS.physicsStateVersion
  )));

  // Legacy UI names are interpreted as physical reduced-order parameters when
  // explicit names are not supplied.
  if (options.sourceMultiplier == null && options.fireSourceMultiplier != null) {
    config.sourceMultiplier = Math.max(0, finiteNumber(options.fireSourceMultiplier, 1));
  }
  if (options.turbulentDiffusivityM2Sec == null && options.diffusionM2Sec != null) {
    config.turbulentDiffusivityM2Sec = Math.max(0, finiteNumber(options.diffusionM2Sec, 0.06));
  }
  normalizedOptionObjects.add(config);
  return config;
}

export function normalizeFdsSmokeRecord(record, options = {}) {
  if (!record || typeof record !== "object") return null;
  const config = normalizedOptions(options);
  const explicitSmokeDensity = finiteNumber(
    record.smokeDensity ?? record.smoke_density,
    NaN
  );
  const naturalLogExtinction = finiteNumber(
    record.extinctionCoefficientM1 ?? record.extinction_coefficient_m_1 ??
      record.opticalDensity ?? record.opticalDensityM1 ??
      record.optical_density_m_1 ?? record.optical_density,
    NaN
  );
  const base10OpticalDensityPerMeter = finiteNumber(
    record.opticalDensityBase10M1 ?? record.optical_density_base10_m_1 ??
      record.odBase10M1 ?? record.od_base10_m_1,
    NaN
  );
  const opticalDensity = Number.isFinite(naturalLogExtinction)
    ? naturalLogExtinction
    : (Number.isFinite(base10OpticalDensityPerMeter)
        ? base10OpticalDensityPerMeter * Math.LN10
        : NaN);
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

function floorDimensions(floor) {
  const height = Math.max(0, Math.floor(finiteNumber(
    floor?.gridHeight,
    Array.isArray(floor?.grid) ? floor.grid.length : 0
  )));
  const width = Math.max(0, Math.floor(finiteNumber(
    floor?.gridWidth,
    Array.isArray(floor?.grid)
      ? floor.grid.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0)
      : 0
  )));
  return { width, height, size: width * height };
}

function flatIndex(width, cx, cy) {
  return cy * width + cx;
}

function emptyPhysicsState(floor, config) {
  const { width, height, size } = floorDimensions(floor);
  const cellSizeMeters = Math.max(0.05, finiteNumber(floor?.cellSizeMeters, 0.5));
  const roomHeightMeters = Math.max(1, finiteNumber(
    floor?.wallHeightMeters ?? floor?.floorHeightMeters,
    2.8
  ));
  const arrays = () => new Float64Array(size);
  const cardinalNeighborIndices = new Int32Array(size * CARDINAL_DIRECTIONS.length);
  const diagonalNeighborIndices = new Int32Array(size * DIAGONAL_DIRECTIONS.length);
  cardinalNeighborIndices.fill(-1);
  diagonalNeighborIndices.fill(-1);
  return {
    version: config.physicsStateVersion,
    width,
    height,
    cellSizeMeters,
    roomHeightMeters,
    hotGasVolumeM3: arrays(),
    sootMassKg: arrays(),
    coMassKg: arrays(),
    excessHeatKJ: arrays(),
    lastLegacyDensity: arrays(),
    activeMask: new Uint8Array(size),
    passableMask: new Uint8Array(size),
    potentialVentilationMask: new Uint8Array(size),
    openExitVentMask: new Uint8Array(size),
    potentialVentilationCount: 0,
    cardinalNeighborIndices,
    diagonalNeighborIndices,
    activeIndices: [],
    renderedMask: new Uint8Array(size),
    renderedIndices: [],
    deltaVolume: arrays(),
    deltaSoot: arrays(),
    deltaCo: arrays(),
    deltaHeat: arrays(),
    deltaTouchedMask: new Uint8Array(size),
    deltaTouchedIndices: [],
    fireDistanceCells: new Float64Array(size),
    fireSourceIndex: new Int32Array(size),
    fireSourceHrrKw: arrays(),
    fireDistanceQueue: new Int32Array(size),
    ceilingJetSpeedMps: arrays(),
    ceilingJetSpeedStamp: new Uint32Array(size),
    ceilingJetCacheGeneration: 0,
    fireIndices: [],
    topologyHash: null,
    topologyPassableCount: 0,
    generatedSootKg: 0,
    generatedCoKg: 0,
    generatedHotGasVolumeM3: 0,
    suppressedEntrainmentVolumeM3: 0,
    ventedSootKg: 0,
    ventedCoKg: 0,
    depositedSootKg: 0,
    elapsedSec: 0
  };
}

function physicsStateMatches(state, floor, config) {
  if (!state || state.version !== config.physicsStateVersion) return false;
  const { width, height, size } = floorDimensions(floor);
  return state.width === width && state.height === height &&
    state.hotGasVolumeM3?.length === size &&
    state.sootMassKg?.length === size &&
    state.coMassKg?.length === size &&
    state.excessHeatKJ?.length === size &&
    state.activeMask?.length === size &&
    state.passableMask?.length === size &&
    state.potentialVentilationMask?.length === size &&
    state.openExitVentMask?.length === size &&
    state.cardinalNeighborIndices?.length === size * CARDINAL_DIRECTIONS.length &&
    state.diagonalNeighborIndices?.length === size * DIAGONAL_DIRECTIONS.length &&
    state.renderedMask?.length === size &&
    state.deltaTouchedMask?.length === size &&
    state.fireDistanceQueue?.length === size &&
    state.ceilingJetSpeedMps?.length === size &&
    state.ceilingJetSpeedStamp?.length === size;
}

function smokeLayerSeedDepth(cell, roomHeightMeters) {
  const explicit = finiteNumber(
    cell?.smokeLayerDepthMeters ?? cell?.upperLayerDepthMeters,
    NaN
  );
  if (Number.isFinite(explicit) && explicit > 0) {
    return clamp(explicit, 0.05, roomHeightMeters);
  }
  return Math.min(roomHeightMeters, Math.max(0.3, roomHeightMeters * 0.18));
}

function hasPhysicalSmokeState(state, index) {
  return state.hotGasVolumeM3[index] > 1e-12 || state.sootMassKg[index] > 1e-15 ||
    state.coMassKg[index] > 1e-15 || state.excessHeatKJ[index] > 1e-12;
}

function activatePhysicalIndex(state, index) {
  if (index < 0 || index >= state.activeMask.length || state.activeMask[index]) return;
  state.activeMask[index] = 1;
  state.activeIndices.push(index);
}

function compactActiveIndices(state) {
  let write = 0;
  for (const index of state.activeIndices) {
    if (!state.activeMask[index]) continue;
    if (!hasPhysicalSmokeState(state, index)) {
      state.activeMask[index] = 0;
      continue;
    }
    state.activeIndices[write++] = index;
  }
  state.activeIndices.length = write;
}

function seedPhysicsCellFromLegacy(state, floor, cx, cy, legacyDensity, config, replace = false) {
  if (!(legacyDensity > 0)) return false;
  const cell = floor.grid?.[cy]?.[cx];
  if (!smokePassable(cell) || cell?.hazardDataSource === "fds_csv") return false;
  const index = flatIndex(state.width, cx, cy);
  const cellArea = state.cellSizeMeters * state.cellSizeMeters;
  const depth = smokeLayerSeedDepth(cell, state.roomHeightMeters);
  const volume = Math.max(1e-6, state.hotGasVolumeM3[index], cellArea * depth);
  const legacyExtinction = legacyDensity /
    Math.max(1e-9, config.legacyDensityPerExtinctionM1);
  const extinction = Math.max(legacyExtinction, finiteNumber(
    cell?.upperLayerExtinctionCoefficientM1 ?? cell?.extinctionCoefficientM1 ??
      cell?.opticalDensityM1 ?? cell?.opticalDensity,
    legacyExtinction
  ));
  const sootMass = extinction * volume /
    Math.max(1, config.massExtinctionCoefficientM2PerKg);
  const coPpm = Math.max(legacyDensity * config.coPpmPerSmokeDensity, finiteNumber(
    cell?.upperLayerCoPpm ?? cell?.coPpm ?? cell?.co,
    legacyDensity * config.coPpmPerSmokeDensity
  ));
  const coMass = coPpm * 1e-6 * volume * config.airDensityKgM3 * (28.01 / 28.97);
  const explicitTemperatureC = finiteNumber(
    cell?.smokeTemperatureC ?? cell?.upperLayerTemperatureC,
    NaN
  );
  const temperatureC = Number.isFinite(explicitTemperatureC) &&
    explicitTemperatureC > config.ambientTemperatureC
    ? explicitTemperatureC
    : config.ambientTemperatureC + 30;
  const heat = config.airDensityKgM3 * volume * config.airSpecificHeatKJKgK *
    (temperatureC - config.ambientTemperatureC);

  state.hotGasVolumeM3[index] = Math.max(state.hotGasVolumeM3[index], volume);
  if (replace) {
    state.sootMassKg[index] = sootMass;
    state.coMassKg[index] = coMass;
    state.excessHeatKJ[index] = heat;
  } else {
    state.sootMassKg[index] = Math.max(state.sootMassKg[index], sootMass);
    state.coMassKg[index] = Math.max(state.coMassKg[index], coMass);
    state.excessHeatKJ[index] = Math.max(state.excessHeatKJ[index], heat);
  }
  activatePhysicalIndex(state, index);
  return true;
}

function initializePhysicsFromLegacy(state, floor, config) {
  for (let cy = 0; cy < state.height; cy++) {
    for (let cx = 0; cx < state.width; cx++) {
      const legacy = Math.max(0, finiteNumber(
        floor.smokeMap?.[cy]?.[cx],
        floor.grid?.[cy]?.[cx]?.smokeDensity ?? floor.grid?.[cy]?.[cx]?.smoke ?? 0
      ));
      if (legacy > 0) seedPhysicsCellFromLegacy(state, floor, cx, cy, legacy, config, true);
      state.lastLegacyDensity[flatIndex(state.width, cx, cy)] = legacy;
    }
  }
}

function ensurePhysicsState(floor, config) {
  let state = floor?.smokePhysics;
  if (!physicsStateMatches(state, floor, config)) {
    state = emptyPhysicsState(floor, config);
    initializePhysicsFromLegacy(state, floor, config);
    floor.smokePhysics = state;
  } else {
    // Geometry controls may change without replacing the grid. Preserve the
    // extensive quantities, but immediately use the new metric geometry for
    // layer depth, capacity, CFL and correlations.
    state.cellSizeMeters = Math.max(0.05, finiteNumber(floor?.cellSizeMeters, 0.5));
    state.roomHeightMeters = Math.max(1, finiteNumber(
      floor?.wallHeightMeters ?? floor?.floorHeightMeters,
      2.8
    ));
  }
  const pending = Array.isArray(floor?.pendingSmokeDerivationIndices)
    ? floor.pendingSmokeDerivationIndices
    : [];
  for (const index of pending) {
    if (index < 0 || index >= state.renderedMask.length || state.renderedMask[index]) continue;
    state.renderedMask[index] = 1;
    state.renderedIndices.push(index);
  }
  if (pending.length) floor.pendingSmokeDerivationIndices = [];
  return state;
}

function clonePhysicsState(state) {
  if (!state || typeof state !== "object") return null;
  const copy = { ...state };
  [
    "hotGasVolumeM3", "sootMassKg", "coMassKg", "excessHeatKJ",
    "lastLegacyDensity", "deltaVolume", "deltaSoot", "deltaCo", "deltaHeat",
    "activeMask", "passableMask", "potentialVentilationMask", "openExitVentMask",
    "cardinalNeighborIndices", "diagonalNeighborIndices", "renderedMask",
    "deltaTouchedMask", "fireDistanceCells", "fireSourceIndex",
    "fireSourceHrrKw", "fireDistanceQueue", "ceilingJetSpeedMps", "ceilingJetSpeedStamp"
  ].forEach(name => {
    if (state[name]?.slice) copy[name] = state[name].slice();
  });
  copy.deltaTouchedIndices = Array.isArray(state.deltaTouchedIndices)
    ? state.deltaTouchedIndices.slice()
    : [];
  copy.activeIndices = Array.isArray(state.activeIndices) ? state.activeIndices.slice() : [];
  copy.renderedIndices = Array.isArray(state.renderedIndices) ? state.renderedIndices.slice() : [];
  copy.fireIndices = Array.isArray(state.fireIndices) ? state.fireIndices.slice() : [];
  return copy;
}

export function resetLegacySmokePhysicsState(floorsOrFloor, options = {}) {
  const floors = Array.isArray(floorsOrFloor) ? floorsOrFloor : [floorsOrFloor];
  const clearDerivedFields = !!options.clearDerivedFields;
  const config = clearDerivedFields ? normalizedOptions(options) : null;
  floors.filter(Boolean).forEach(floor => {
    floor.smokePhysics = null;
    if (!clearDerivedFields) return;
    floor.smokeMap?.forEach(row => row?.fill?.(0));
    floor.smokeCeil?.forEach(row => row?.fill?.(false));
    floor.grid?.forEach(row => row?.forEach(cell => {
      if (cell) setClearSmokeFields(cell, config);
    }));
  });
}

export function clearLegacySmokePhysicsCell(floor, cxInput, cyInput, options = {}) {
  const state = floor?.smokePhysics;
  const { width, height } = floorDimensions(floor);
  const cx = Math.round(finiteNumber(cxInput, -1));
  const cy = Math.round(finiteNumber(cyInput, -1));
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) return false;
  const index = flatIndex(width, cx, cy);
  if (state?.hotGasVolumeM3?.length === width * height) {
    state.hotGasVolumeM3[index] = 0;
    state.sootMassKg[index] = 0;
    state.coMassKg[index] = 0;
    state.excessHeatKJ[index] = 0;
    state.lastLegacyDensity[index] = 0;
    state.activeMask[index] = 0;
  }
  if (options.clearDerivedFields) {
    if (floor.smokeMap?.[cy]) floor.smokeMap[cy][cx] = 0;
    if (floor.smokeCeil?.[cy]) floor.smokeCeil[cy][cx] = false;
    const cell = floor.grid?.[cy]?.[cx];
    if (cell) setClearSmokeFields(cell, normalizedOptions(options));
  }
  return true;
}

/** Queue one externally-overlaid cell to be restored from physical state. */
export function markLegacySmokeCellForDerivation(floor, cxInput, cyInput) {
  const { width, height } = floorDimensions(floor);
  const cx = Math.round(finiteNumber(cxInput, -1));
  const cy = Math.round(finiteNumber(cyInput, -1));
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) return false;
  const index = flatIndex(width, cx, cy);
  const state = floor?.smokePhysics;
  if (state?.renderedMask?.length === width * height) {
    if (!state.renderedMask[index]) {
      state.renderedMask[index] = 1;
      state.renderedIndices.push(index);
    }
    return true;
  }
  if (!Array.isArray(floor.pendingSmokeDerivationIndices)) {
    floor.pendingSmokeDerivationIndices = [];
  }
  if (!floor.pendingSmokeDerivationIndices.includes(index)) {
    floor.pendingSmokeDerivationIndices.push(index);
  }
  return true;
}

/**
 * Heskestad plume entrainment correlation in its common engineering form.
 * Q is convective HRR [kW], z is height above the source [m], result [kg/s].
 */
export function plumeEntrainmentRateKgPerSec(hrrKw, heightMeters, options = {}) {
  const config = normalizedOptions(options);
  const totalHrr = Math.max(0, finiteNumber(hrrKw, 0));
  if (!(totalHrr > 0)) return 0;
  const convectiveHrr = totalHrr * (1 - config.radiativeFraction);
  const height = Math.max(0.1, finiteNumber(heightMeters, 2.8));
  return 0.071 * Math.cbrt(convectiveHrr) * Math.pow(height, 5 / 3) +
    0.0018 * convectiveHrr;
}

/** Alpert/Heskestad ceiling-jet velocity correlation used by CFAST. */
export function ceilingJetVelocityMps(hrrKw, radialDistanceMeters, ceilingHeightMeters, options = {}) {
  const config = normalizedOptions(options);
  const totalHrr = Math.max(0, finiteNumber(hrrKw, 0));
  if (!(totalHrr > 0)) return 0;
  const height = Math.max(0.5, finiteNumber(ceilingHeightMeters, 2.8));
  const radius = Math.max(0.02, finiteNumber(radialDistanceMeters, 0.02));
  const ambientK = config.ambientTemperatureC + 273.15;
  const convectiveW = totalHrr * (1 - config.radiativeFraction) * 1000;
  const denominator = Math.max(
    1,
    config.airDensityKgM3 * config.airSpecificHeatKJKgK * 1000 * ambientK *
      Math.sqrt(config.gravityMps2) * Math.pow(height, 2.5)
  );
  const qStar = convectiveW / denominator;
  const radiusRatio = Math.max(0.01, radius / height);
  const correlationRatio = Math.min(4, radiusRatio);
  const coefficient = correlationRatio <= 0.17
    ? 3.61
    : 1.06 * Math.pow(correlationRatio, -0.69);
  const beyondRangeDamping = radiusRatio > 4
    ? Math.exp(-0.12 * (radiusRatio - 4))
    : 1;
  return clamp(
    Math.sqrt(config.gravityMps2 * height) * Math.cbrt(qStar) * coefficient *
      beyondRangeDamping * config.ceilingJetVelocityMultiplier,
    0,
    config.maxCeilingJetVelocityMps
  );
}

function fireHrrKw(cell, config) {
  if (!cell?.fire) return 0;
  const explicit = Math.max(0, finiteNumber(cell.hrrKw, 0));
  if (explicit > 0) return Math.max(config.minimumFireHrrKw, explicit);
  const intensity = Math.max(0.01, finiteNumber(cell.fireIntensity, 0.05));
  return Math.max(config.minimumFireHrrKw, intensity * config.minimumFireHrrKw);
}

function rebuildPassableNeighborIndices(state) {
  const width = state.width;
  const height = state.height;
  const passable = state.passableMask;
  const cardinal = state.cardinalNeighborIndices;
  const diagonal = state.diagonalNeighborIndices;
  cardinal.fill(-1);
  diagonal.fill(-1);
  for (let cy = 0; cy < height; cy++) {
    const rowStart = cy * width;
    for (let cx = 0; cx < width; cx++) {
      const index = rowStart + cx;
      if (!passable[index]) continue;
      const cardinalBase = index * CARDINAL_DIRECTIONS.length;
      const right = cx + 1 < width ? index + 1 : -1;
      const left = cx > 0 ? index - 1 : -1;
      const down = cy + 1 < height ? index + width : -1;
      const up = cy > 0 ? index - width : -1;
      if (right >= 0 && passable[right]) cardinal[cardinalBase] = right;
      if (left >= 0 && passable[left]) cardinal[cardinalBase + 1] = left;
      if (down >= 0 && passable[down]) cardinal[cardinalBase + 2] = down;
      if (up >= 0 && passable[up]) cardinal[cardinalBase + 3] = up;

      const diagonalBase = index * DIAGONAL_DIRECTIONS.length;
      if (right >= 0 && down >= 0) {
        const target = down + 1;
        if (passable[target] && passable[right] && passable[down]) diagonal[diagonalBase] = target;
      }
      if (left >= 0 && down >= 0) {
        const target = down - 1;
        if (passable[target] && passable[left] && passable[down]) diagonal[diagonalBase + 1] = target;
      }
      if (right >= 0 && up >= 0) {
        const target = up + 1;
        if (passable[target] && passable[right] && passable[up]) diagonal[diagonalBase + 2] = target;
      }
      if (left >= 0 && up >= 0) {
        const target = up - 1;
        if (passable[target] && passable[left] && passable[up]) diagonal[diagonalBase + 3] = target;
      }
    }
  }
}

function beginCeilingJetCacheStep(state) {
  state.ceilingJetCacheGeneration = (state.ceilingJetCacheGeneration + 1) >>> 0;
  if (state.ceilingJetCacheGeneration === 0) {
    state.ceilingJetSpeedStamp.fill(0);
    state.ceilingJetCacheGeneration = 1;
  }
}

function buildFireDistanceField(floor, state, config) {
  const distance = state.fireDistanceCells;
  const sourceIndex = state.fireSourceIndex;
  const sourceHrr = state.fireSourceHrrKw;
  for (const index of state.fireIndices) sourceHrr[index] = 0;
  const nextFireIndices = [];
  const grid = floor?.grid;
  const smokeMap = floor?.smokeMap;
  const exitKeys = config.exitActsAsOpenVent && Array.isArray(floor?.exits) && floor.exits.length
    ? exitCellKeys(floor)
    : null;
  let topologyHash = 2166136261;
  let passableCount = 0;
  let potentialVentilationCount = 0;
  for (let cy = 0; cy < state.height; cy++) {
    const gridRow = grid?.[cy];
    const smokeRow = smokeMap?.[cy];
    for (let cx = 0; cx < state.width; cx++) {
      const cell = gridRow?.[cx];
      const index = flatIndex(state.width, cx, cy);
      const passable = smokePassable(cell);
      state.passableMask[index] = passable ? 1 : 0;
      if (passable) {
        topologyHash = Math.imul(topologyHash ^ (index + 1), 16777619) >>> 0;
        passableCount++;
      }
      const legacy = Math.max(0, finiteNumber(
        smokeRow?.[cx],
        cell?.smokeDensity ?? cell?.smoke ?? 0
      ));
      if (legacy > Math.max(0, state.lastLegacyDensity[index]) + 1e-6) {
        seedPhysicsCellFromLegacy(state, floor, cx, cy, legacy, config, false);
      }
      const isOpenExitVent = !!exitKeys?.has(`${cx}:${cy}`);
      const hasPotentialVentilation = isOpenExitVent ||
        (!!cell?.stair && cell?.stairType === "outdoor") ||
        Math.max(0, finiteNumber(cell?.ventilation, 0)) > 0;
      state.openExitVentMask[index] = isOpenExitVent ? 1 : 0;
      state.potentialVentilationMask[index] = hasPotentialVentilation ? 1 : 0;
      if (hasPotentialVentilation) potentialVentilationCount++;
      const hrr = fireHrrKw(cell, config) * config.sourceMultiplier;
      if (!(hrr > 0) || !passable) continue;
      sourceHrr[index] = hrr;
      nextFireIndices.push(index);
    }
  }
  state.potentialVentilationCount = potentialVentilationCount;
  let sameFires = nextFireIndices.length === state.fireIndices.length;
  for (let offset = 0; sameFires && offset < nextFireIndices.length; offset++) {
    sameFires = nextFireIndices[offset] === state.fireIndices[offset];
  }
  const topologyUnchanged = topologyHash === state.topologyHash &&
    passableCount === state.topologyPassableCount && sameFires;
  state.fireIndices = nextFireIndices;
  if (topologyUnchanged) return;

  state.topologyHash = topologyHash;
  state.topologyPassableCount = passableCount;
  rebuildPassableNeighborIndices(state);
  distance.fill(Infinity);
  sourceIndex.fill(-1);
  const queue = state.fireDistanceQueue;
  let head = 0;
  let tail = 0;
  for (const index of nextFireIndices) {
    distance[index] = 0;
    sourceIndex[index] = index;
    queue[tail++] = index;
  }
  while (head < tail) {
    const current = queue[head++];
    const neighborBase = current * CARDINAL_DIRECTIONS.length;
    for (let directionIndex = 0; directionIndex < CARDINAL_DIRECTIONS.length; directionIndex++) {
      const next = state.cardinalNeighborIndices[neighborBase + directionIndex];
      if (next < 0) continue;
      if (distance[next] <= distance[current] + 1) continue;
      distance[next] = distance[current] + 1;
      sourceIndex[next] = sourceIndex[current];
      queue[tail++] = next;
    }
  }
}

function clearDeltas(state) {
  for (const index of state.deltaTouchedIndices) {
    state.deltaVolume[index] = 0;
    state.deltaSoot[index] = 0;
    state.deltaCo[index] = 0;
    state.deltaHeat[index] = 0;
    state.deltaTouchedMask[index] = 0;
  }
  state.deltaTouchedIndices.length = 0;
}

function touchDelta(state, index) {
  if (index < 0 || state.deltaTouchedMask[index]) return;
  state.deltaTouchedMask[index] = 1;
  state.deltaTouchedIndices.push(index);
}

function addExtensiveDelta(state, fromIndex, toIndex, volumeM3, captureComponents = false) {
  const sourceVolume = Math.max(0, state.hotGasVolumeM3[fromIndex]);
  const available = Math.max(0, sourceVolume + state.deltaVolume[fromIndex]);
  const cellCapacity = state.cellSizeMeters * state.cellSizeMeters * state.roomHeightMeters;
  const receiverCapacity = toIndex >= 0
    ? Math.max(0, cellCapacity - state.hotGasVolumeM3[toIndex] - state.deltaVolume[toIndex])
    : Infinity;
  const volume = clamp(volumeM3, 0, Math.min(available, receiverCapacity));
  if (!(volume > 0)) return captureComponents ? null : 0;
  activatePhysicalIndex(state, fromIndex);
  if (toIndex >= 0) activatePhysicalIndex(state, toIndex);
  touchDelta(state, fromIndex);
  if (toIndex >= 0) touchDelta(state, toIndex);
  const fraction = volume / Math.max(1e-12, sourceVolume);
  const soot = Math.max(0, state.sootMassKg[fromIndex]) * fraction;
  const co = Math.max(0, state.coMassKg[fromIndex]) * fraction;
  const heat = Math.max(0, state.excessHeatKJ[fromIndex]) * fraction;
  state.deltaVolume[fromIndex] -= volume;
  state.deltaSoot[fromIndex] -= soot;
  state.deltaCo[fromIndex] -= co;
  state.deltaHeat[fromIndex] -= heat;
  if (toIndex >= 0) {
    state.deltaVolume[toIndex] += volume;
    state.deltaSoot[toIndex] += soot;
    state.deltaCo[toIndex] += co;
    state.deltaHeat[toIndex] += heat;
  }
  return captureComponents
    ? { volumeM3: volume, sootMassKg: soot, coMassKg: co, heatKJ: heat }
    : volume;
}

function applyDeltas(state) {
  for (const index of state.deltaTouchedIndices) {
    state.hotGasVolumeM3[index] = Math.max(0, state.hotGasVolumeM3[index] + state.deltaVolume[index]);
    state.sootMassKg[index] = Math.max(0, state.sootMassKg[index] + state.deltaSoot[index]);
    state.coMassKg[index] = Math.max(0, state.coMassKg[index] + state.deltaCo[index]);
    state.excessHeatKJ[index] = Math.max(0, state.excessHeatKJ[index] + state.deltaHeat[index]);
    state.deltaVolume[index] = 0;
    state.deltaSoot[index] = 0;
    state.deltaCo[index] = 0;
    state.deltaHeat[index] = 0;
    state.deltaTouchedMask[index] = 0;
  }
  state.deltaTouchedIndices.length = 0;
}

function injectFireSources(floor, state, dt, config) {
  const ceilingHeight = state.roomHeightMeters;
  for (const index of state.fireIndices) {
    const hrrKw = state.fireSourceHrrKw[index];
    if (!(hrrKw > 0)) continue;
    activatePhysicalIndex(state, index);
    const fuelRate = hrrKw / Math.max(1, config.heatOfCombustionKJPerKg);
    const soot = fuelRate * config.sootYieldKgPerKg * dt;
    const co = fuelRate * config.coYieldKgPerKg * dt;
    const plumeMassRate = plumeEntrainmentRateKgPerSec(hrrKw, ceilingHeight, config);
    const hotVolume = plumeMassRate / Math.max(0.1, config.airDensityKgM3) * dt;
    const heat = hrrKw * (1 - config.radiativeFraction) * dt;
    state.hotGasVolumeM3[index] += hotVolume;
    state.sootMassKg[index] += soot;
    state.coMassKg[index] += co;
    state.excessHeatKJ[index] += heat;
    state.generatedSootKg += soot;
    state.generatedCoKg += co;
    state.generatedHotGasVolumeM3 += hotVolume;
  }
}

function redistributeCellOverflow(floor, state) {
  const capacity = state.cellSizeMeters * state.cellSizeMeters * state.roomHeightMeters;
  clearDeltas(state);
  const donorCount = state.activeIndices.length;
  const targetIndices = new Int32Array(CARDINAL_DIRECTIONS.length);
  const targetAvailable = new Float64Array(CARDINAL_DIRECTIONS.length);
  for (let donorOffset = 0; donorOffset < donorCount; donorOffset++) {
    const index = state.activeIndices[donorOffset];
    const sourceVolume = state.hotGasVolumeM3[index];
    let remaining = Math.max(0, sourceVolume - capacity);
    if (!(remaining > 1e-12)) continue;
    let targetCount = 0;
    let totalCapacity = 0;
    const neighborBase = index * CARDINAL_DIRECTIONS.length;
    for (let directionIndex = 0; directionIndex < CARDINAL_DIRECTIONS.length; directionIndex++) {
      const targetIndex = state.cardinalNeighborIndices[neighborBase + directionIndex];
      if (targetIndex < 0) continue;
      const available = Math.max(
        0,
        capacity - state.hotGasVolumeM3[targetIndex] - state.deltaVolume[targetIndex]
      );
      if (!(available > 1e-12)) continue;
      targetIndices[targetCount] = targetIndex;
      targetAvailable[targetCount] = available;
      targetCount++;
      totalCapacity += available;
    }
    const overflowToDistribute = remaining;
    for (let targetOffset = 0; targetOffset < targetCount; targetOffset++) {
      const available = targetAvailable[targetOffset];
      const requested = Math.min(
        available,
        overflowToDistribute * available / Math.max(1e-12, totalCapacity)
      );
      const movedVolume = addExtensiveDelta(
        state,
        index,
        targetIndices[targetOffset],
        requested
      );
      remaining -= movedVolume;
    }
  }
  applyDeltas(state);
}

function finalizeCellCapacity(state) {
  const capacity = state.cellSizeMeters * state.cellSizeMeters * state.roomHeightMeters;
  for (const index of state.activeIndices) {
    const overflow = Math.max(0, state.hotGasVolumeM3[index] - capacity);
    if (!(overflow > 0)) continue;
    // Once the upper layer occupies the whole cell there is no lower-layer air
    // left for the plume correlation to entrain. Species and heat remain; only
    // the unresolvable entrainment volume is suppressed and accounted.
    state.hotGasVolumeM3[index] = capacity;
    state.suppressedEntrainmentVolumeM3 += overflow;
  }
}

function cellLayerDepth(state, index) {
  const area = state.cellSizeMeters * state.cellSizeMeters;
  return clamp(state.hotGasVolumeM3[index] / Math.max(1e-9, area), 0, state.roomHeightMeters);
}

function cellLayerTemperatureC(state, index, config) {
  const volume = Math.max(1e-9, state.hotGasVolumeM3[index]);
  const delta = state.excessHeatKJ[index] /
    Math.max(1e-9, config.airDensityKgM3 * volume * config.airSpecificHeatKJKgK);
  return config.ambientTemperatureC + Math.max(0, delta);
}

function advectCeilingLayer(floor, state, dt, config) {
  clearDeltas(state);
  const ambientK = config.ambientTemperatureC + 273.15;
  const height = state.roomHeightMeters;
  const cell = state.cellSizeMeters;
  const donorCount = state.activeIndices.length;
  const targetIndices = new Int32Array(CARDINAL_DIRECTIONS.length);
  const targetWeights = new Float64Array(CARDINAL_DIRECTIONS.length);
  for (let donorOffset = 0; donorOffset < donorCount; donorOffset++) {
      const index = state.activeIndices[donorOffset];
      const volume = state.hotGasVolumeM3[index];
      if (!(volume > 1e-12) || !state.passableMask[index]) continue;
      const currentDepth = cellLayerDepth(state, index);
      const temperatureC = cellLayerTemperatureC(state, index, config);
      const deltaTemperature = Math.max(0, temperatureC - config.ambientTemperatureC);
      let targetCount = 0;
      let weightSum = 0;
      let pressureSpeedSum = 0;
      let hasJetTarget = false;
      const currentFireDistance = state.fireDistanceCells[index];
      const hasFiniteFireDistance = Number.isFinite(currentFireDistance);
      const neighborBase = index * CARDINAL_DIRECTIONS.length;
      for (let directionIndex = 0; directionIndex < CARDINAL_DIRECTIONS.length; directionIndex++) {
        const neighborIndex = state.cardinalNeighborIndices[neighborBase + directionIndex];
        if (neighborIndex < 0) continue;
        const neighborDepth = cellLayerDepth(state, neighborIndex);
        const depthGradient = Math.max(0, currentDepth - neighborDepth);
        const outward = hasFiniteFireDistance &&
          state.fireDistanceCells[neighborIndex] > currentFireDistance;
        const pressureWeight = depthGradient / Math.max(0.05, height);
        const weight = (outward ? 1 : 0) + pressureWeight * 2.5;
        if (!(weight > 0)) continue;
        if (outward) hasJetTarget = true;
        const pressureSpeed = config.exitDischargeCoefficient * Math.sqrt(
          2 * config.gravityMps2 * depthGradient * deltaTemperature / Math.max(1, ambientK)
        );
        targetIndices[targetCount] = neighborIndex;
        targetWeights[targetCount] = weight;
        targetCount++;
        weightSum += weight;
        pressureSpeedSum += pressureSpeed * weight;
      }
      if (!targetCount || !(weightSum > 0)) continue;
      let jetSpeed = 0;
      if (hasJetTarget) {
        const cacheGeneration = state.ceilingJetCacheGeneration;
        if (state.ceilingJetSpeedStamp[index] === cacheGeneration) {
          jetSpeed = state.ceilingJetSpeedMps[index];
        } else {
          const distanceMeters = Math.max(0.5, currentFireDistance) * cell;
          const source = state.fireSourceIndex[index];
          const sourceHrrKw = source >= 0 ? state.fireSourceHrrKw[source] : 0;
          jetSpeed = ceilingJetVelocityMps(sourceHrrKw, distanceMeters, height, config);
          state.ceilingJetSpeedMps[index] = jetSpeed;
          state.ceilingJetSpeedStamp[index] = cacheGeneration;
        }
      }
      const pressureSpeed = pressureSpeedSum / weightSum;
      const speed = Math.max(0, jetSpeed + pressureSpeed);
      const moveFraction = clamp(1 - Math.exp(-speed * dt / Math.max(0.05, cell)), 0, config.cflNumber);
      if (!(moveFraction > 0)) continue;
      const movedVolume = volume * moveFraction;
      let assigned = 0;
      for (let targetOffset = 0; targetOffset < targetCount; targetOffset++) {
        const share = targetOffset === targetCount - 1
          ? Math.max(0, movedVolume - assigned)
          : movedVolume * targetWeights[targetOffset] / weightSum;
        assigned += addExtensiveDelta(state, index, targetIndices[targetOffset], share);
      }
  }
  applyDeltas(state);
}

function mixEdge(state, fromIndex, toIndex, mixFraction) {
  const fromVolume = state.hotGasVolumeM3[fromIndex];
  const toVolume = state.hotGasVolumeM3[toIndex];
  if (Math.abs(fromVolume - toVolume) <= 1e-12) return;
  const donor = fromVolume > toVolume ? fromIndex : toIndex;
  const receiver = donor === fromIndex ? toIndex : fromIndex;
  const difference = Math.abs(fromVolume - toVolume);
  const transfer = Math.min(
    difference * mixFraction,
    state.hotGasVolumeM3[donor] * 0.18
  );
  addExtensiveDelta(state, donor, receiver, transfer);
}

function turbulentMixing(floor, state, dt, config) {
  const baseMix = clamp(
    config.turbulentDiffusivityM2Sec * dt /
      Math.max(0.0025, state.cellSizeMeters * state.cellSizeMeters),
    0,
    0.06
  );
  if (!(baseMix > 0)) return;
  clearDeltas(state);
  const originCount = state.activeIndices.length;
  for (let originOffset = 0; originOffset < originCount; originOffset++) {
      const index = state.activeIndices[originOffset];
      if (!(state.hotGasVolumeM3[index] > 1e-12)) continue;
      if (!state.passableMask[index]) continue;
      const cardinalBase = index * CARDINAL_DIRECTIONS.length;
      for (let directionIndex = 0; directionIndex < CARDINAL_DIRECTIONS.length; directionIndex++) {
        const neighborIndex = state.cardinalNeighborIndices[cardinalBase + directionIndex];
        if (neighborIndex < 0) continue;
        if (state.activeMask[neighborIndex] && neighborIndex < index) continue;
        mixEdge(state, index, neighborIndex, baseMix);
      }
      if (!(config.diagonalMix > 0)) continue;
      const diagonalBase = index * DIAGONAL_DIRECTIONS.length;
      for (let directionIndex = 0; directionIndex < DIAGONAL_DIRECTIONS.length; directionIndex++) {
        // The cached diagonal is present only when the destination and both
        // orthogonal side cells are passable, preserving sealed-corner blocking.
        const neighborIndex = state.diagonalNeighborIndices[diagonalBase + directionIndex];
        if (neighborIndex < 0) continue;
        if (state.activeMask[neighborIndex] && neighborIndex < index) continue;
        mixEdge(state, index, neighborIndex, baseMix * config.diagonalMix / Math.SQRT2);
      }
  }
  applyDeltas(state);
}

function exitCellKeys(floor) {
  const keys = new Set();
  (Array.isArray(floor?.exits) ? floor.exits : []).forEach(exit => {
    const cx = Math.round(finiteNumber(exit?.cx ?? exit?.x, -10000));
    const cy = Math.round(finiteNumber(exit?.cy ?? exit?.y, -10000));
    keys.add(`${cx}:${cy}`);
  });
  return keys;
}

function applyVentilationAndLosses(floor, state, dt, config) {
  const ambientK = config.ambientTemperatureC + 273.15;
  let ventedSootKg = 0;
  let ventedCoKg = 0;
  let ventedVolumeM3 = 0;
  clearDeltas(state);
  const activeCount = state.activeIndices.length;
  const leakageFraction = clamp(1 - Math.exp(-config.leakageRatePerSec * dt), 0, 0.2);
  const hasGlobalLeakage = leakageFraction > 0;
  const needsVentilationPass = hasGlobalLeakage || state.potentialVentilationCount > 0;
  for (let activeOffset = 0; needsVentilationPass && activeOffset < activeCount; activeOffset++) {
      const index = state.activeIndices[activeOffset];
      if (!hasGlobalLeakage && !state.potentialVentilationMask[index]) continue;
      const cx = index % state.width;
      const cy = Math.floor(index / state.width);
      const volume = state.hotGasVolumeM3[index];
      if (!(volume > 1e-12)) continue;
      const cell = floor.grid?.[cy]?.[cx];
      const isExit = !!state.openExitVentMask[index];
      const outdoorStair = !!cell?.stair && cell?.stairType === "outdoor";
      // Per-cell ventilation is a first-order removal rate [1/s]. Opening-flow
      // vents (outdoor stairs / explicitly opened exits) are calculated in
      // m3/s below. Keeping the two representations separate avoids treating a
      // single value once as a dimensionless multiplier and again as velocity.
      const explicitVentRatePerSec = Math.max(0, finiteNumber(cell?.ventilation, 0));
      let outflowM3Sec = 0;
      if (isExit || outdoorStair) {
        const depth = cellLayerDepth(state, index);
        const temperatureC = cellLayerTemperatureC(state, index, config);
        const deltaTemperature = Math.max(0, temperatureC - config.ambientTemperatureC);
        const openingWidth = isExit
          ? Math.max(state.cellSizeMeters, finiteNumber(cell?.exitWidthMeters, config.defaultExitWidthMeters))
          : Math.max(state.cellSizeMeters, finiteNumber(cell?.stairWidthMeters, state.cellSizeMeters));
        const openingHeight = Math.min(
          state.roomHeightMeters,
          isExit ? config.exitOpeningHeightMeters : Math.max(1, depth)
        );
        const openingArea = openingWidth * openingHeight;
        const buoyantVelocity = config.exitDischargeCoefficient * Math.sqrt(
          2 * config.gravityMps2 * Math.max(0.05, depth) *
            deltaTemperature / Math.max(1, ambientK)
        );
        outflowM3Sec = openingArea * Math.max(
          config.minimumVentVelocityMps,
          buoyantVelocity
        );
      }
      const ventFraction = outflowM3Sec > 0
        ? clamp(1 - Math.exp(-outflowM3Sec * dt / Math.max(1e-9, volume)), 0, 0.92)
        : 0;
      const explicitVentFraction = clamp(
        1 - Math.exp(-explicitVentRatePerSec * dt),
        0,
        0.92
      );
      const removalFraction = clamp(
        1 - (1 - ventFraction) * (1 - leakageFraction) * (1 - explicitVentFraction),
        0,
        0.95
      );
      if (removalFraction > 0) {
        const removed = addExtensiveDelta(state, index, -1, volume * removalFraction, true);
        if (removed) {
          ventedSootKg += removed.sootMassKg;
          ventedCoKg += removed.coMassKg;
          ventedVolumeM3 += removed.volumeM3;
        }
      }
  }
  applyDeltas(state);

  const heatFactor = Math.exp(-config.heatLossRatePerSec * dt);
  const depositionFactor = Math.exp(-config.sootDepositionRatePerSec * dt);
  for (const index of state.activeIndices) {
    state.excessHeatKJ[index] *= heatFactor;
    const beforeSoot = state.sootMassKg[index];
    state.sootMassKg[index] *= depositionFactor;
    state.depositedSootKg += Math.max(0, beforeSoot - state.sootMassKg[index]);
  }
  compactActiveIndices(state);
  state.ventedSootKg += ventedSootKg;
  state.ventedCoKg += ventedCoKg;
  return { ventedSootKg, ventedCoKg, ventedVolumeM3 };
}

function floorIndexValue(floor, fallback) {
  return Math.floor(finiteNumber(floor?.floorIndex ?? floor?.floor, fallback));
}

function floorElevationValue(floor, fallbackIndex, config) {
  const index = floorIndexValue(floor, fallbackIndex);
  const floorHeight = Math.max(0.1, finiteNumber(floor?.floorHeightMeters, 3.5));
  return finiteNumber(floor?.elevationMeters ?? floor?.zMeters, index * floorHeight);
}

function physicalStairTransfers(floors, statesByFloor, links, dt, config) {
  if (!Array.isArray(links) || links.length === 0 || !(dt > 0)) return [];
  const requests = [];
  const outgoingByCell = new Map();
  const floorByIndex = new Map();
  floors.forEach((floor, arrayIndex) => {
    floorByIndex.set(floorIndexValue(floor, arrayIndex), { floor, arrayIndex });
    clearDeltas(statesByFloor.get(floor));
  });

  (Array.isArray(links) ? links : []).forEach(raw => {
    const link = normalizeStairLink(raw);
    const fromEntry = floorByIndex.get(link.from.floorIndex);
    const toEntry = floorByIndex.get(link.to.floorIndex);
    if (!fromEntry || !toEntry || link.from.floorIndex === link.to.floorIndex) return;
    const fromElevation = floorElevationValue(fromEntry.floor, fromEntry.arrayIndex, config);
    const toElevation = floorElevationValue(toEntry.floor, toEntry.arrayIndex, config);
    const lower = fromElevation <= toElevation ? link.from : link.to;
    const upper = lower === link.from ? link.to : link.from;
    const lowerEntry = lower === link.from ? fromEntry : toEntry;
    const upperEntry = upper === link.to ? toEntry : fromEntry;
    const lowerState = statesByFloor.get(lowerEntry.floor);
    const upperState = statesByFloor.get(upperEntry.floor);
    if (!lowerState || !upperState) return;
    if (lower.cx < 0 || lower.cy < 0 || lower.cx >= lowerState.width || lower.cy >= lowerState.height) return;
    if (upper.cx < 0 || upper.cy < 0 || upper.cx >= upperState.width || upper.cy >= upperState.height) return;
    if (!smokePassable(lowerEntry.floor.grid?.[lower.cy]?.[lower.cx]) ||
        !smokePassable(upperEntry.floor.grid?.[upper.cy]?.[upper.cx])) return;
    const lowerIndex = flatIndex(lowerState.width, lower.cx, lower.cy);
    const upperIndex = flatIndex(upperState.width, upper.cx, upper.cy);
    const sourceVolume = lowerState.hotGasVolumeM3[lowerIndex];
    if (!(sourceVolume > 1e-12)) return;
    const temperatureC = cellLayerTemperatureC(lowerState, lowerIndex, config);
    const deltaTemperature = Math.max(0, temperatureC - config.ambientTemperatureC);
    const floorRise = Math.max(0.5, Math.abs(toElevation - fromElevation));
    const ambientK = config.ambientTemperatureC + 273.15;
    const stackVelocity = config.exitDischargeCoefficient * Math.sqrt(
      2 * config.gravityMps2 * floorRise * deltaTemperature / Math.max(1, ambientK)
    );
    const openingArea = link.widthMeters * Math.max(0.1, config.stairOpeningDepthMeters);
    const baseVolume = openingArea * Math.max(config.minimumVentVelocityMps, stackVelocity) * dt;
    const typeMeta = STAIR_TYPE_META[link.type] || STAIR_TYPE_META.indoor;
    const riseRequest = Math.min(
      sourceVolume,
      baseVolume * stairSmokeTransferFactor(link) * config.verticalTransferRatePerSec
    );
    // An endpoint explicitly marked as an outdoor stair is already exhausted
    // by applyVentilationAndLosses. Only use the link-level vent when the link
    // carries that metadata but the cell itself does not, avoiding duplicate
    // removal through the same physical opening.
    const lowerCell = lowerEntry.floor.grid?.[lower.cy]?.[lower.cx];
    const localOutdoorVent = !!lowerCell?.stair && lowerCell?.stairType === "outdoor";
    const ventRequest = !localOutdoorVent && typeMeta.ventilationFactor >= 0.5
      ? Math.min(sourceVolume, baseVolume * typeMeta.ventilationFactor * config.stairVentFraction)
      : 0;
    if (!(riseRequest > 0) && !(ventRequest > 0)) return;
    const sourceKey = `${lower.floorIndex}:${lowerIndex}`;
    const request = {
      link,
      lower,
      upper,
      lowerState,
      upperState,
      lowerIndex,
      upperIndex,
      sourceKey,
      sourceVolume,
      riseRequest,
      ventRequest
    };
    outgoingByCell.set(sourceKey, (outgoingByCell.get(sourceKey) || 0) + riseRequest + ventRequest);
    requests.push(request);
  });

  const transfers = [];
  const incomingByCell = new Map();
  requests.forEach(request => {
    const requested = outgoingByCell.get(request.sourceKey) || 0;
    const scale = requested > request.sourceVolume
      ? request.sourceVolume / requested
      : 1;
    const targetKey = `${request.upper.floorIndex}:${request.upperIndex}`;
    const targetCapacity = request.upperState.cellSizeMeters * request.upperState.cellSizeMeters *
      request.upperState.roomHeightMeters;
    const receiverAvailable = Math.max(
      0,
      targetCapacity - request.upperState.hotGasVolumeM3[request.upperIndex] -
        (incomingByCell.get(targetKey) || 0)
    );
    const riseVolume = Math.min(request.riseRequest * scale, receiverAvailable);
    incomingByCell.set(targetKey, (incomingByCell.get(targetKey) || 0) + riseVolume);
    const ventVolume = request.ventRequest * scale;
    const removedVolume = riseVolume + ventVolume;
    if (!(removedVolume > 0)) return;
    const fraction = removedVolume / Math.max(1e-12, request.sourceVolume);
    const riseFractionOfRemoval = riseVolume / removedVolume;
    const sootRemoved = request.lowerState.sootMassKg[request.lowerIndex] * fraction;
    const coRemoved = request.lowerState.coMassKg[request.lowerIndex] * fraction;
    const heatRemoved = request.lowerState.excessHeatKJ[request.lowerIndex] * fraction;
    activatePhysicalIndex(request.lowerState, request.lowerIndex);
    activatePhysicalIndex(request.upperState, request.upperIndex);
    touchDelta(request.lowerState, request.lowerIndex);
    touchDelta(request.upperState, request.upperIndex);
    request.lowerState.deltaVolume[request.lowerIndex] -= removedVolume;
    request.lowerState.deltaSoot[request.lowerIndex] -= sootRemoved;
    request.lowerState.deltaCo[request.lowerIndex] -= coRemoved;
    request.lowerState.deltaHeat[request.lowerIndex] -= heatRemoved;
    request.upperState.deltaVolume[request.upperIndex] += riseVolume;
    request.upperState.deltaSoot[request.upperIndex] += sootRemoved * riseFractionOfRemoval;
    request.upperState.deltaCo[request.upperIndex] += coRemoved * riseFractionOfRemoval;
    request.upperState.deltaHeat[request.upperIndex] += heatRemoved * riseFractionOfRemoval;
    const ventedSootKg = sootRemoved * (1 - riseFractionOfRemoval);
    const ventedCoKg = coRemoved * (1 - riseFractionOfRemoval);
    request.lowerState.ventedSootKg += ventedSootKg;
    request.lowerState.ventedCoKg += ventedCoKg;
    transfers.push({
      stairId: request.link.id,
      type: request.link.type,
      from: { ...request.lower },
      to: { ...request.upper },
      amount: riseVolume,
      volumeM3: riseVolume,
      sootMassKg: sootRemoved * riseFractionOfRemoval,
      coMassKg: coRemoved * riseFractionOfRemoval,
      heatKJ: heatRemoved * riseFractionOfRemoval,
      ventedVolumeM3: ventVolume,
      ventedSootKg,
      ventedCoKg,
      fraction: riseVolume / Math.max(1e-12, request.sourceVolume)
    });
  });
  floors.forEach(floor => {
    const state = statesByFloor.get(floor);
    applyDeltas(state);
    compactActiveIndices(state);
  });
  return transfers;
}

function eyeLayerFraction(interfaceHeightMeters, config) {
  const transition = Math.max(0.02, config.layerTransitionMeters);
  return clamp(
    (config.eyeHeightMeters + transition * 0.5 - interfaceHeightMeters) / transition,
    0,
    1
  );
}

function setClearSmokeFields(cell, config) {
  Object.assign(cell, {
    smokeDensity: 0,
    eyeLevelSmokeDensity: 0,
    smoke: 0,
    extinctionCoefficientM1: 0,
    upperLayerExtinctionCoefficientM1: 0,
    eyeLevelExtinctionCoefficientM1: 0,
    opticalDensity: 0,
    opticalDensityM1: 0,
    opticalDensityBase10M1: 0,
    coPpm: 0,
    upperLayerCoPpm: 0,
    eyeLevelCoPpm: 0,
    co: 0,
    visibilityMeters: config.maxVisibilityMeters,
    upperLayerVisibilityMeters: config.maxVisibilityMeters,
    visibilityM: config.maxVisibilityMeters,
    visibility: 1,
    smokeLayerDepthMeters: 0,
    smokeLayerInterfaceHeightMeters: null,
    smokeTemperatureC: config.ambientTemperatureC,
    upperLayerTemperatureC: config.ambientTemperatureC,
    eyeLevelTemperatureC: config.ambientTemperatureC,
    sootConcentrationKgM3: 0,
    smokeDataSource: "reduced_order_nist",
    hazardDataSource: "reduced_order_nist"
  });
}

function applyFdsMetricsToCell(floor, cell, cx, cy, timeSec, config) {
  const record = fdsRecordAt(config, floorIndexValue(floor, 0), cx, cy, timeSec);
  const fds = normalizeFdsSmokeRecord(record, config);
  if (!fds) return null;
  const hasExtinction = fds.opticalDensity != null;
  const hasSmokeDensity = fds.smokeDensity != null;
  const hasCo = fds.coPpm != null;
  const hasVisibility = fds.visibilityMeters != null;
  const smokeDensity = hasSmokeDensity
    ? fds.smokeDensity
    : Math.max(0, finiteNumber(cell.smokeDensity, 0));
  const extinction = hasExtinction
    ? fds.opticalDensity
    : Math.max(0, finiteNumber(cell.extinctionCoefficientM1 ?? cell.opticalDensityM1, 0));
  const eyeExtinction = hasExtinction
    ? fds.opticalDensity
    : Math.max(0, finiteNumber(cell.eyeLevelExtinctionCoefficientM1, extinction));
  const coPpm = hasCo
    ? fds.coPpm
    : Math.max(0, finiteNumber(cell.coPpm, 0));
  const visibilityMeters = hasVisibility
    ? fds.visibilityMeters
    : ((hasExtinction || hasSmokeDensity)
        ? (eyeExtinction > 0.001
            ? Math.min(config.maxVisibilityMeters, config.visibilityNumerator / eyeExtinction)
            : config.maxVisibilityMeters)
        : Math.max(0, finiteNumber(cell.visibilityMeters, config.maxVisibilityMeters)));
  const metrics = {
    smokeDensity,
    opticalDensity: extinction,
    coPpm,
    visibilityMeters,
    visibility: clamp(visibilityMeters / config.referenceVisibilityMeters, 0, 1),
    source: "fds_csv"
  };
  const fields = {
    smokeDataSource: "fds_csv",
    hazardDataSource: "fds_csv"
  };
  if (hasSmokeDensity) {
    fields.smokeDensity = smokeDensity;
    fields.eyeLevelSmokeDensity = smokeDensity;
    fields.smoke = smokeDensity;
    if (floor.smokeMap?.[cy]) floor.smokeMap[cy][cx] = smokeDensity;
  }
  if (hasExtinction) {
    Object.assign(fields, {
      extinctionCoefficientM1: extinction,
      upperLayerExtinctionCoefficientM1: extinction,
      eyeLevelExtinctionCoefficientM1: eyeExtinction,
      opticalDensity: extinction,
      opticalDensityM1: extinction,
      opticalDensityBase10M1: extinction / Math.LN10
    });
  }
  if (hasCo) {
    Object.assign(fields, {
      coPpm,
      upperLayerCoPpm: coPpm,
      eyeLevelCoPpm: coPpm,
      co: coPpm
    });
  }
  if (hasVisibility || hasExtinction || hasSmokeDensity) {
    Object.assign(fields, {
      visibilityMeters,
      upperLayerVisibilityMeters: visibilityMeters,
      visibilityM: visibilityMeters,
      visibility: metrics.visibility
    });
  }
  Object.assign(cell, fields);
  return metrics;
}

function derivePhysicalSmokeFields(floor, state, timeSec, config) {
  if (!Array.isArray(floor.smokeMap) || floor.smokeMap.length !== state.height) {
    floor.smokeMap = makeNumberGrid(state.width, state.height, 0);
  }
  if (!Array.isArray(floor.smokeCeil) || floor.smokeCeil.length !== state.height) {
    floor.smokeCeil = makeNumberGrid(state.width, state.height, false);
  }
  let maxSmokeDensity = 0;
  let totalSmoke = 0;
  let totalSootKg = 0;
  let totalCoKg = 0;
  let totalHotGasVolumeM3 = 0;
  const area = state.cellSizeMeters * state.cellSizeMeters;
  for (let cy = 0; cy < state.height; cy++) {
    if (!Array.isArray(floor.smokeMap[cy])) floor.smokeMap[cy] = new Array(state.width).fill(0);
    if (!Array.isArray(floor.smokeCeil[cy])) floor.smokeCeil[cy] = new Array(state.width).fill(false);
  }

  const fdsEnabled = !!(config.fdsLookup || config.fdsProvider?.lookup);
  let indices;
  if (fdsEnabled) {
    indices = Array.from({ length: state.width * state.height }, (_, index) => index);
  } else {
    indices = state.renderedIndices.slice();
    for (const index of state.activeIndices) {
      if (!state.renderedMask[index]) indices.push(index);
    }
  }
  for (const index of state.renderedIndices) state.renderedMask[index] = 0;
  state.renderedIndices.length = 0;
  const markRendered = index => {
    if (state.renderedMask[index]) return;
    state.renderedMask[index] = 1;
    state.renderedIndices.push(index);
  };

  for (const index of indices) {
    const cx = index % state.width;
    const cy = Math.floor(index / state.width);
    const cell = floor.grid?.[cy]?.[cx];
    if (!cell || !smokePassable(cell)) {
      const needsClear = hasPhysicalSmokeState(state, index) ||
        state.lastLegacyDensity[index] > 0 || floor.smokeMap[cy][cx] > 0 ||
        finiteNumber(cell?.smokeDensity ?? cell?.smoke, 0) > 0 ||
        finiteNumber(cell?.smokeLayerDepthMeters, 0) > 0 ||
        cell?.smokeDataSource === "fds_csv";
      if (needsClear) {
        state.hotGasVolumeM3[index] = 0;
        state.sootMassKg[index] = 0;
        state.coMassKg[index] = 0;
        state.excessHeatKJ[index] = 0;
        state.activeMask[index] = 0;
        floor.smokeMap[cy][cx] = 0;
        floor.smokeCeil[cy][cx] = false;
        if (cell) setClearSmokeFields(cell, config);
        state.lastLegacyDensity[index] = 0;
      }
      continue;
    }

    const volume = Math.max(0, state.hotGasVolumeM3[index]);
    const sootMass = Math.max(0, state.sootMassKg[index]);
    const coMass = Math.max(0, state.coMassKg[index]);
    const heatKJ = Math.max(0, state.excessHeatKJ[index]);
    const hasContents = volume > 1e-12 && (sootMass > 0 || coMass > 0 || heatKJ > 0);
    if (!hasContents) {
      if (!(sootMass > 0) && !(coMass > 0) && !(heatKJ > 0)) {
        state.hotGasVolumeM3[index] = 0;
        state.activeMask[index] = 0;
      }
      const needsClear = state.lastLegacyDensity[index] > 0 || floor.smokeMap[cy][cx] > 0 ||
        finiteNumber(cell.smokeDensity ?? cell.smoke, 0) > 0 ||
        finiteNumber(cell.smokeLayerDepthMeters, 0) > 0 ||
        cell.smokeDataSource === "fds_csv";
      if (needsClear) {
        floor.smokeMap[cy][cx] = 0;
        floor.smokeCeil[cy][cx] = false;
        setClearSmokeFields(cell, config);
      }
      state.lastLegacyDensity[index] = 0;
      if (fdsEnabled) {
        applyFdsMetricsToCell(floor, cell, cx, cy, timeSec, config);
        state.lastLegacyDensity[index] = floor.smokeMap[cy][cx];
      }
      const displayedDensity = Math.max(0, finiteNumber(cell.smokeDensity, 0));
      if (displayedDensity > 0 || cell.smokeDataSource === "fds_csv") markRendered(index);
      maxSmokeDensity = Math.max(maxSmokeDensity, displayedDensity);
      totalSmoke += displayedDensity;
      continue;
    }

    totalSootKg += sootMass;
    totalCoKg += coMass;
    totalHotGasVolumeM3 += volume;
    const layerDepth = clamp(volume / Math.max(1e-9, area), 0, state.roomHeightMeters);
    const interfaceHeight = state.roomHeightMeters - layerDepth;
    const upperExtinction = clamp(
      config.massExtinctionCoefficientM2PerKg * sootMass / Math.max(1e-12, volume),
      0,
      config.maxExtinctionCoefficientM1
    );
    const upperCoPpm = Math.max(
      0,
      1e6 * (coMass / Math.max(1e-12, config.airDensityKgM3 * volume)) * (28.97 / 28.01)
    );
    const fractionAtEye = eyeLayerFraction(interfaceHeight, config);
    const eyeExtinction = upperExtinction * fractionAtEye;
    const eyeCoPpm = upperCoPpm * fractionAtEye;
    const upperVisibility = upperExtinction > 1e-9
      ? Math.min(config.maxVisibilityMeters, config.visibilityFactor / upperExtinction)
      : config.maxVisibilityMeters;
    const eyeVisibility = eyeExtinction > 1e-9
      ? Math.min(config.maxVisibilityMeters, config.visibilityFactor / eyeExtinction)
      : config.maxVisibilityMeters;
    const upperTemperatureC = cellLayerTemperatureC(state, index, config);
    const eyeTemperatureC = config.ambientTemperatureC +
      (upperTemperatureC - config.ambientTemperatureC) * fractionAtEye;
    const legacyDensity = upperExtinction * config.legacyDensityPerExtinctionM1;
    const eyeLegacyDensity = eyeExtinction * config.legacyDensityPerExtinctionM1;
    floor.smokeMap[cy][cx] = legacyDensity;
    floor.smokeCeil[cy][cx] = layerDepth >= config.smokeCeilingThreshold;
    Object.assign(cell, {
      smokeDensity: legacyDensity,
      eyeLevelSmokeDensity: eyeLegacyDensity,
      smoke: legacyDensity,
      extinctionCoefficientM1: upperExtinction,
      upperLayerExtinctionCoefficientM1: upperExtinction,
      eyeLevelExtinctionCoefficientM1: eyeExtinction,
      opticalDensity: upperExtinction,
      opticalDensityM1: upperExtinction,
      opticalDensityBase10M1: upperExtinction / Math.LN10,
      coPpm: eyeCoPpm,
      upperLayerCoPpm: upperCoPpm,
      eyeLevelCoPpm: eyeCoPpm,
      co: eyeCoPpm,
      visibilityMeters: eyeVisibility,
      upperLayerVisibilityMeters: upperVisibility,
      visibilityM: eyeVisibility,
      visibility: clamp(eyeVisibility / config.referenceVisibilityMeters, 0, 1),
      smokeLayerDepthMeters: layerDepth,
      smokeLayerInterfaceHeightMeters: interfaceHeight,
      smokeTemperatureC: upperTemperatureC,
      upperLayerTemperatureC: upperTemperatureC,
      eyeLevelTemperatureC: eyeTemperatureC,
      sootConcentrationKgM3: sootMass / Math.max(1e-12, volume),
      smokeDataSource: "reduced_order_nist",
      hazardDataSource: "reduced_order_nist"
    });
    markRendered(index);
    state.lastLegacyDensity[index] = legacyDensity;
    if (fdsEnabled) {
      const fdsMetrics = applyFdsMetricsToCell(floor, cell, cx, cy, timeSec, config);
      if (fdsMetrics) state.lastLegacyDensity[index] = floor.smokeMap[cy][cx];
    }
    const displayedDensity = Math.max(0, finiteNumber(cell.smokeDensity, legacyDensity));
    maxSmokeDensity = Math.max(maxSmokeDensity, displayedDensity);
    totalSmoke += displayedDensity;
  }
  compactActiveIndices(state);
  return { maxSmokeDensity, totalSmoke, totalSootKg, totalCoKg, totalHotGasVolumeM3 };
}

function aggregateVerticalTransfers(target, additions) {
  for (const item of additions) {
    const key = `${item.stairId}:${item.from.floorIndex}:${item.from.cx}:${item.from.cy}:` +
      `${item.to.floorIndex}:${item.to.cx}:${item.to.cy}`;
    let aggregate = target.get(key);
    if (!aggregate) {
      aggregate = { ...item };
      target.set(key, aggregate);
      continue;
    }
    [
      "amount", "volumeM3", "sootMassKg", "coMassKg", "heatKJ",
      "ventedVolumeM3", "ventedSootKg", "ventedCoKg"
    ].forEach(name => {
      aggregate[name] = Math.max(0, finiteNumber(aggregate[name], 0)) +
        Math.max(0, finiteNumber(item[name], 0));
    });
    const previousFraction = clamp(finiteNumber(aggregate.fraction, 0), 0, 1);
    const nextFraction = clamp(finiteNumber(item.fraction, 0), 0, 1);
    aggregate.fraction = 1 - (1 - previousFraction) * (1 - nextFraction);
  }
}

/**
 * In-place, fixed-substep reduced-order smoke transport used by the live UI.
 * Extensive quantities (hot-layer volume, soot, CO and heat) are moved with
 * equal-and-opposite face fluxes. Existing floor/grid/smokeMap identities are
 * retained for the 2D renderer and bridge.
 */
export function stepLegacySmokePhysicsInPlace(
  floors,
  stairLinks,
  dtSeconds,
  options = {}
) {
  if (!Array.isArray(floors)) {
    return {
      floors: [], verticalTransfers: [], maxSmokeDensity: 0, totalSmoke: 0,
      totalSootKg: 0, totalCoKg: 0, totalHotGasVolumeM3: 0,
      suppressedEntrainmentVolumeM3: 0, timeSec: 0
    };
  }
  const config = normalizedOptions(options);
  const dt = Math.max(0, finiteNumber(dtSeconds, 0));
  const timeSec = Math.max(0, finiteNumber(options.timeSec, dt));
  const statesByFloor = new Map();
  let maximumVelocity = 0;
  floors.forEach(floor => {
    const state = ensurePhysicsState(floor, config);
    statesByFloor.set(floor, state);
    buildFireDistanceField(floor, state, config);
    beginCeilingJetCacheStep(state);
    for (const index of state.fireIndices) {
      maximumVelocity = Math.max(
        maximumVelocity,
        ceilingJetVelocityMps(
          state.fireSourceHrrKw[index],
          state.cellSizeMeters * 0.5,
          state.roomHeightMeters,
          config
        )
      );
    }
  });

  const minimumCellSize = floors.reduce(
    (min, floor) => Math.min(min, Math.max(0.05, finiteNumber(floor?.cellSizeMeters, 0.5))),
    Infinity
  );
  const advectiveLimit = maximumVelocity > 1e-9
    ? config.cflNumber * minimumCellSize / maximumVelocity
    : config.maxSubstepSec;
  const substepLimit = Math.max(0.001, Math.min(config.maxSubstepSec, advectiveLimit));
  const substepCount = dt > 0 ? Math.min(240, Math.max(1, Math.ceil(dt / substepLimit))) : 0;
  const subDt = substepCount > 0 ? dt / substepCount : 0;
  const transferAggregate = new Map();

  for (let step = 0; step < substepCount; step++) {
    for (const floor of floors) {
      const state = statesByFloor.get(floor);
      if (state.fireIndices.length) injectFireSources(floor, state, subDt, config);
    }
    for (const floor of floors) {
      const state = statesByFloor.get(floor);
      if (state.activeIndices.length) redistributeCellOverflow(floor, state);
    }
    for (const floor of floors) {
      const state = statesByFloor.get(floor);
      if (state.activeIndices.length) advectCeilingLayer(floor, state, subDt, config);
    }
    for (const floor of floors) {
      const state = statesByFloor.get(floor);
      if (state.activeIndices.length) turbulentMixing(floor, state, subDt, config);
    }
    for (const floor of floors) {
      const state = statesByFloor.get(floor);
      if (state.activeIndices.length) redistributeCellOverflow(floor, state);
    }
    for (const floor of floors) {
      const state = statesByFloor.get(floor);
      if (state.activeIndices.length) applyVentilationAndLosses(floor, state, subDt, config);
    }
    if (Array.isArray(stairLinks) && stairLinks.length) {
      aggregateVerticalTransfers(
        transferAggregate,
        physicalStairTransfers(floors, statesByFloor, stairLinks, subDt, config)
      );
    }
    for (const floor of floors) {
      const state = statesByFloor.get(floor);
      if (state.activeIndices.length) finalizeCellCapacity(state);
    }
  }

  let maxSmokeDensity = 0;
  let totalSmoke = 0;
  let totalSootKg = 0;
  let totalCoKg = 0;
  let totalHotGasVolumeM3 = 0;
  let suppressedEntrainmentVolumeM3 = 0;
  floors.forEach(floor => {
    const state = statesByFloor.get(floor);
    state.elapsedSec += dt;
    const metrics = derivePhysicalSmokeFields(floor, state, timeSec, config);
    maxSmokeDensity = Math.max(maxSmokeDensity, metrics.maxSmokeDensity);
    totalSmoke += metrics.totalSmoke;
    totalSootKg += metrics.totalSootKg;
    totalCoKg += metrics.totalCoKg;
    totalHotGasVolumeM3 += metrics.totalHotGasVolumeM3;
    suppressedEntrainmentVolumeM3 += state.suppressedEntrainmentVolumeM3;
  });
  return {
    floors,
    verticalTransfers: [...transferAggregate.values()],
    maxSmokeDensity,
    totalSmoke,
    totalSootKg,
    totalCoKg,
    totalHotGasVolumeM3,
    suppressedEntrainmentVolumeM3,
    substepCount,
    timeSec,
    model: config.model
  };
}

/**
 * Advance reduced-order upper-layer smoke and transfer it through typed stairs.
 * No input floor, cell, link, or FDS record is mutated.
 */
export function stepSmoke3D(floorsInput, stairLinksInput, dtSeconds, options = {}) {
  const floors = normalizeFloors3D(floorsInput, options);
  // normalizeFloors3D deliberately retains unknown fields. Clone the physics
  // buffers here so this pure API never mutates a caller's previous snapshot.
  floors.forEach(floor => {
    floor.smokePhysics = clonePhysicsState(floor.smokePhysics);
  });
  return stepLegacySmokePhysicsInPlace(
    floors,
    (Array.isArray(stairLinksInput) ? stairLinksInput : []).map(raw => normalizeStairLink(raw)),
    dtSeconds,
    options
  );
}

export function smokeRiskAt3D(floors, endpoint = {}, options = {}) {
  const floorIndex = Math.floor(finiteNumber(endpoint.floorIndex ?? endpoint.floor, 0));
  const cx = Math.round(finiteNumber(endpoint.cx ?? endpoint.x, 0));
  const cy = Math.round(finiteNumber(endpoint.cy ?? endpoint.y, 0));
  const floor = getFloorByIndex(floors, floorIndex);
  const cell = floor?.grid?.[cy]?.[cx];
  if (!cell) return deriveSmokeMetrics(0, options);
  const smokeDensity = Math.max(0, finiteNumber(
    cell.eyeLevelSmokeDensity,
    cell.smokeDensity ?? cell.smoke ?? 0
  ));
  const opticalDensity = Math.max(0, finiteNumber(
    cell.eyeLevelExtinctionCoefficientM1,
    cell.extinctionCoefficientM1 ?? cell.opticalDensity ?? cell.opticalDensityM1 ?? 0
  ));
  return {
    smokeDensity,
    opticalDensity,
    coPpm: Math.max(0, finiteNumber(cell.eyeLevelCoPpm, cell.coPpm ?? cell.co ?? 0)),
    visibilityMeters: Math.max(0, finiteNumber(cell.visibilityMeters ?? cell.visibilityM, 30)),
    visibility: clamp(finiteNumber(cell.visibility, 1), 0, 1),
    upperLayerSmokeDensity: Math.max(0, finiteNumber(cell.smokeDensity, cell.smoke || 0)),
    upperLayerOpticalDensity: Math.max(0, finiteNumber(
      cell.upperLayerExtinctionCoefficientM1,
      cell.extinctionCoefficientM1 ?? cell.opticalDensityM1 ?? 0
    )),
    upperLayerCoPpm: Math.max(0, finiteNumber(cell.upperLayerCoPpm, cell.coPpm || 0)),
    upperLayerVisibilityMeters: Math.max(0, finiteNumber(
      cell.upperLayerVisibilityMeters,
      cell.visibilityMeters ?? cell.visibilityM ?? 30
    )),
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
