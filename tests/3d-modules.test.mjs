import test from "node:test";
import assert from "node:assert/strict";

import {
  createFloor3D,
  gridToWorld,
  validateFloor3D
} from "../sim/js/simulation/floors3d.js";
import {
  createStairLink,
  createStairTrafficState,
  enqueueStairTransition,
  stepStairTraffic
} from "../sim/js/simulation/stairs3d.js";
import {
  stepFire3D,
  applyFire3DResultToLegacyFloors
} from "../sim/js/simulation/fire3d.js";
import {
  clearLegacySmokePhysicsCell,
  markLegacySmokeCellForDerivation,
  normalizeFdsSmokeRecord,
  smokeRiskAt3D,
  stepSmoke3D,
  transferLegacySmokeThroughStairs
} from "../sim/js/simulation/smoke3d.js";
import {
  deriveAgentBehaviorState,
  chooseClearAirStep,
  normalizeAgent3D
} from "../sim/js/simulation/agents3d-sync.js";
import {
  classifyColorMapPixel,
  extractScitech3FGridFromImageData,
  isLikelyScitech3FExtraction,
  MAP_CELL_CLASS
} from "../sim/js/scitech3f-map3d.js";
import { groupStairCells3D } from "../sim/js/renderer3d.js";
import {
  createGeometrySnapshot3D,
  createDynamicSnapshot3D,
  apply3DBridgeMessage
} from "../sim/js/state-bridge3d.js";

function legacyCell(overrides = {}) {
  return {
    walkable: true,
    wall: false,
    stair: false,
    fire: false,
    fireIntensity: 0,
    temperatureC: 20,
    heatFluxKwM2: 0,
    ...overrides
  };
}

function assertNearlyEqual(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

test("2.5D floor schema and exact grid-to-world conversion", () => {
  const floor = createFloor3D({
    floorIndex: 2,
    grid: [[legacyCell(), legacyCell()]],
    cellSizeMeters: 0.42,
    floorHeightMeters: 3.5
  });
  assert.deepEqual(validateFloor3D(floor), { valid: true, errors: [] });
  assert.deepEqual(
    gridToWorld({ floorIndex: 2, cx: 10, cy: 3 }, { cellSizeMeters: 0.42, floorHeightMeters: 3.5 }),
    { worldX: 4.2, worldY: 7, worldZ: 1.26 }
  );
});

test("stair traffic observes FIFO, capacity and travel time", () => {
  const link = createStairLink({
    id: "stairs-a",
    from: { floorIndex: 0, cx: 1, cy: 1 },
    to: { floorIndex: 1, cx: 2, cy: 2 },
    congestionCapacity: 2,
    travelCostSec: 4
  });
  const agents = [0, 1, 2].map(id => ({ id, floor: 0, x: 1, y: 1, behaviorState: "normal" }));
  let traffic = createStairTrafficState([link]);
  for (const agent of agents) {
    traffic = enqueueStairTransition(traffic, link, agent, link.from).state;
  }
  let step = stepStairTraffic(traffic, [link], agents, 0);
  assert.equal(step.trafficState.byLink[link.id].inTransit.length, 2);
  assert.equal(step.trafficState.byLink[link.id].queue.length, 1);
  step = stepStairTraffic(step.trafficState, [link], step.agents, 4);
  assert.deepEqual(step.completed.map(item => item.agentId), [0, 1]);
  assert.equal(step.trafficState.byLink[link.id].inTransit[0].agentId, 2);
  assert.equal(step.agents[0].floor, 1);
});

test("legacy smoke rises through an indoor stair without replacing maps", () => {
  const lowerMap = [[3]];
  const upperMap = [[0]];
  const floors = [
    { floorIndex: 0, zMeters: 0, grid: [[legacyCell({ stair: true })]], smokeMap: lowerMap },
    { floorIndex: 1, zMeters: 3.5, grid: [[legacyCell({ stair: true })]], smokeMap: upperMap }
  ];
  const link = createStairLink({
    id: "smoke-stair",
    type: "indoor",
    from: { floorIndex: 0, cx: 0, cy: 0 },
    to: { floorIndex: 1, cx: 0, cy: 0 },
    verticalSmokeTransfer: 0.35
  });
  const transfers = transferLegacySmokeThroughStairs(floors, [link], 1, { syncCellFields: true });
  assert.equal(floors[0].smokeMap, lowerMap);
  assert.equal(floors[1].smokeMap, upperMap);
  assert.ok(transfers[0].amount > 0);
  assert.ok(lowerMap[0][0] < 3);
  assert.ok(upperMap[0][0] > 0);
  assert.equal(floors[1].grid[0][0].smokeDensity, upperMap[0][0]);
});

test("reduced-order smoke accounts for generated soot and CO", () => {
  const hrrKw = 445;
  const durationSec = 2;
  const options = {
    heatOfCombustionKJPerKg: 44500,
    sootYieldKgPerKg: 0.015,
    coYieldKgPerKg: 0.008,
    sourceMultiplier: 1,
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0,
    maxSubstepSec: 0.1
  };
  const floor = createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell({ fire: true, fireIntensity: 1, hrrKw })]]
  });

  const result = stepSmoke3D([floor], [], durationSec, options);
  const expectedFuelKg = hrrKw / options.heatOfCombustionKJPerKg * durationSec;
  const expectedSootKg = expectedFuelKg * options.sootYieldKgPerKg;
  const expectedCoKg = expectedFuelKg * options.coYieldKgPerKg;
  const physics = result.floors[0].smokePhysics;

  assertNearlyEqual(physics.generatedSootKg, expectedSootKg);
  assertNearlyEqual(physics.generatedCoKg, expectedCoKg);
  assertNearlyEqual(result.totalSootKg + physics.ventedSootKg, expectedSootKg);
  assertNearlyEqual(result.totalCoKg + physics.ventedCoKg, expectedCoKg);
  assert.equal(physics.ventedSootKg, 0);
  assert.equal(physics.ventedCoKg, 0);
});

test("zero smoke-source multiplier creates no hidden hot layer", () => {
  const floor = createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell({ fire: true, fireIntensity: 1, hrrKw: 445 })]]
  });
  const result = stepSmoke3D([floor], [], 1, {
    sourceMultiplier: 0,
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0
  });
  const physics = result.floors[0].smokePhysics;

  assert.equal(result.totalHotGasVolumeM3, 0);
  assert.equal(result.totalSootKg, 0);
  assert.equal(result.totalCoKg, 0);
  assert.equal(physics.excessHeatKJ[0], 0);
});

test("soot deposition is reported separately from ventilation", () => {
  const seeded = stepSmoke3D([createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell({ smokeDensity: 1, smokeLayerDepthMeters: 0.5 })]],
    smokeMap: [[1]]
  })], [], 0, {
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0
  });
  const initialSoot = seeded.totalSootKg;
  const result = stepSmoke3D(seeded.floors, [], 1, {
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0.4,
    heatLossRatePerSec: 0
  });
  const physics = result.floors[0].smokePhysics;

  assert.ok(physics.depositedSootKg > 0);
  assert.equal(physics.ventedSootKg, 0);
  assertNearlyEqual(result.totalSootKg + physics.depositedSootKg, initialSoot);
});

test("cell ventilation is a single first-order removal rate", () => {
  const removalRatePerSec = 0.4;
  const seeded = stepSmoke3D([createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell({
      ventilation: removalRatePerSec,
      smokeDensity: 1,
      coPpm: 260,
      smokeLayerDepthMeters: 0.5
    })]],
    smokeMap: [[1]]
  })], [], 0, {
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0
  });
  const initialVolume = seeded.totalHotGasVolumeM3;
  const initialSoot = seeded.totalSootKg;
  const result = stepSmoke3D(seeded.floors, [], 1, {
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0
  });
  const expectedFractionRemaining = Math.exp(-removalRatePerSec);

  assertNearlyEqual(result.totalHotGasVolumeM3 / initialVolume, expectedFractionRemaining);
  assertNearlyEqual(result.totalSootKg / initialSoot, expectedFractionRemaining);
});

test("full fire cell redistributes plume volume without timestep loss", () => {
  const options = {
    turbulentDiffusivityM2Sec: 0,
    ceilingJetVelocityMultiplier: 0,
    gravityMps2: 0,
    exitDischargeCoefficient: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0,
    maxSubstepSec: 0.1
  };
  const makeFloor = () => createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[
      legacyCell({
        fire: true,
        hrrKw: 300,
        smokeDensity: 1,
        coPpm: 260,
        smokeLayerDepthMeters: 3
      }),
      legacyCell()
    ]],
    smokeMap: [[1, 0]]
  });
  const seed = stepSmoke3D([makeFloor()], [], 0, options);
  const single = stepSmoke3D(seed.floors, [], 0.1, options);
  let split = seed;
  for (let index = 0; index < 10; index++) {
    split = stepSmoke3D(split.floors, [], 0.01, options);
  }

  assertNearlyEqual(single.totalHotGasVolumeM3, split.totalHotGasVolumeM3, 1e-10);
  assertNearlyEqual(single.totalSootKg, split.totalSootKg, 1e-12);
  assertNearlyEqual(single.totalCoKg, split.totalCoKg, 1e-12);
  assert.ok(single.floors[0].smokePhysics.hotGasVolumeM3[1] > 0);
});

test("runtime legacy smoke reseed overrides stale zero aliases", () => {
  const floor = createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell()]],
    smokeMap: [[0]]
  });
  const cleared = stepSmoke3D([floor], [], 0);
  const reseededFloor = cleared.floors[0];
  reseededFloor.smokeMap[0][0] = 1;
  reseededFloor.grid[0][0].smokeDensity = 1;
  const reseeded = stepSmoke3D([reseededFloor], [], 0);

  assert.ok(reseeded.floors[0].smokePhysics.sootMassKg[0] > 0);
  assert.ok(reseeded.floors[0].smokePhysics.coMassKg[0] > 0);
  assert.ok(reseeded.floors[0].smokeMap[0][0] > 0);
});

test("external FDS cell can restore without becoming a legacy seed", () => {
  const floor = createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell()]],
    smokeMap: [[0]]
  });
  const initialized = stepSmoke3D([floor], [], 0).floors[0];
  initialized.smokeMap[0][0] = 1;
  Object.assign(initialized.grid[0][0], {
    smokeDensity: 1,
    opticalDensityM1: 0.32,
    hazardDataSource: "fds_csv",
    smokeDataSource: "fds_csv"
  });
  markLegacySmokeCellForDerivation(initialized, 0, 0);
  const restored = stepSmoke3D([initialized], [], 0);

  assert.equal(restored.floors[0].smokeMap[0][0], 0);
  assert.equal(restored.floors[0].smokePhysics.sootMassKg[0], 0);
  assert.equal(restored.floors[0].grid[0][0].smokeDataSource, "reduced_order_nist");
});

test("clearing one smoke cell also clears all derived render fields", () => {
  const floor = stepSmoke3D([createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell({ smokeDensity: 1, smokeLayerDepthMeters: 2 })]],
    smokeMap: [[1]],
    smokeCeil: [[true]]
  })], [], 0).floors[0];

  clearLegacySmokePhysicsCell(floor, 0, 0, { clearDerivedFields: true });

  assert.equal(floor.smokeMap[0][0], 0);
  assert.equal(floor.smokeCeil[0][0], false);
  assert.equal(floor.grid[0][0].upperLayerExtinctionCoefficientM1, 0);
  assert.equal(floor.grid[0][0].sootConcentrationKgM3, 0);
  assert.equal(floor.grid[0][0].smokeLayerDepthMeters, 0);
});

test("reduced-order smoke cannot cross a diagonally sealed wall corner", () => {
  const wall = legacyCell({ walkable: false, wall: true });
  const floor = createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [
      [legacyCell({ smokeDensity: 2, coPpm: 520, smokeLayerDepthMeters: 0.5 }), wall],
      [wall, legacyCell()]
    ],
    smokeMap: [[2, 0], [0, 0]]
  });

  const result = stepSmoke3D([floor], [], 2, {
    turbulentDiffusivityM2Sec: 1,
    diagonalMix: 1,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0,
    maxSubstepSec: 0.05
  });
  const nextFloor = result.floors[0];
  const diagonalIndex = nextFloor.smokePhysics.width + 1;

  assert.ok(nextFloor.grid[0][0].smokeDensity > 0);
  assert.equal(nextFloor.grid[0][1].smokeDensity, 0);
  assert.equal(nextFloor.grid[1][0].smokeDensity, 0);
  assert.equal(nextFloor.grid[1][1].smokeDensity, 0);
  assert.equal(nextFloor.smokePhysics.hotGasVolumeM3[diagonalIndex], 0);
  assert.equal(nextFloor.smokePhysics.sootMassKg[diagonalIndex], 0);
  assert.equal(nextFloor.smokePhysics.coMassKg[diagonalIndex], 0);
});

test("eye-height exposure remains clear until the upper layer descends", () => {
  const makeLayerFloor = (floorIndex, smokeLayerDepthMeters) => createFloor3D({
    floorIndex,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell({
      smokeDensity: 1,
      opticalDensity: 0.32,
      coPpm: 260,
      smokeLayerDepthMeters
    })]],
    smokeMap: [[1]]
  });
  const result = stepSmoke3D(
    [makeLayerFloor(0, 0.5), makeLayerFloor(1, 2)],
    [],
    0,
    { eyeHeightMeters: 1.6, layerTransitionMeters: 0.2 }
  );
  const shallow = result.floors[0].grid[0][0];
  const deep = result.floors[1].grid[0][0];

  assertNearlyEqual(shallow.smokeLayerInterfaceHeightMeters, 2.5);
  assert.ok(shallow.upperLayerExtinctionCoefficientM1 > 0);
  assert.equal(shallow.eyeLevelExtinctionCoefficientM1, 0);
  assert.equal(shallow.eyeLevelCoPpm, 0);
  assert.equal(shallow.visibilityMeters, 30);
  const shallowRisk = smokeRiskAt3D(result.floors, { floorIndex: 0, cx: 0, cy: 0 });
  assert.equal(shallowRisk.smokeDensity, 0);
  assert.equal(shallowRisk.opticalDensity, 0);
  assert.equal(shallowRisk.coPpm, 0);
  assert.ok(shallowRisk.upperLayerSmokeDensity > 0);

  assertNearlyEqual(deep.smokeLayerInterfaceHeightMeters, 1);
  assertNearlyEqual(deep.eyeLevelExtinctionCoefficientM1, deep.upperLayerExtinctionCoefficientM1);
  assertNearlyEqual(deep.eyeLevelCoPpm, deep.upperLayerCoPpm);
  assert.ok(deep.visibilityMeters < shallow.visibilityMeters);
});

test("metric geometry changes preserve smoke quantities and update layer depth", () => {
  const seeded = stepSmoke3D([createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell({ smokeDensity: 1, smokeLayerDepthMeters: 0.5 })]],
    smokeMap: [[1]]
  })], [], 0);
  const floor = seeded.floors[0];
  const volumeBefore = floor.smokePhysics.hotGasVolumeM3[0];
  const sootBefore = floor.smokePhysics.sootMassKg[0];
  floor.cellSizeMeters = 1;
  const resized = stepSmoke3D([floor], [], 0);
  const resizedFloor = resized.floors[0];

  assert.equal(resizedFloor.smokePhysics.cellSizeMeters, 1);
  assertNearlyEqual(resizedFloor.smokePhysics.hotGasVolumeM3[0], volumeBefore);
  assertNearlyEqual(resizedFloor.smokePhysics.sootMassKg[0], sootBefore);
  assertNearlyEqual(resizedFloor.grid[0][0].smokeLayerDepthMeters, volumeBefore);
});

test("stair fan-out conserves hot gas, soot and CO", () => {
  const options = {
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0,
    maxSubstepSec: 1,
    minimumVentVelocityMps: 0.05
  };
  const stairCell = overrides => legacyCell({
    stair: true,
    stairType: "indoor",
    ...overrides
  });
  const floors = [
    createFloor3D({
      floorIndex: 0,
      zMeters: 0,
      cellSizeMeters: 0.5,
      wallHeightMeters: 3,
      grid: [[stairCell({
        smokeDensity: 1,
        coPpm: 260,
        smokeLayerDepthMeters: 0.5
      })]],
      smokeMap: [[1]]
    }),
    createFloor3D({
      floorIndex: 1,
      zMeters: 3.5,
      cellSizeMeters: 0.5,
      wallHeightMeters: 3,
      grid: [[stairCell()]],
      smokeMap: [[0]]
    }),
    createFloor3D({
      floorIndex: 2,
      zMeters: 7,
      cellSizeMeters: 0.5,
      wallHeightMeters: 3,
      grid: [[stairCell()]],
      smokeMap: [[0]]
    })
  ];
  const seeded = stepSmoke3D(floors, [], 0, options);
  const links = [1, 2].map(floorIndex => createStairLink({
    id: `fan-out-${floorIndex}`,
    type: "indoor",
    from: { floorIndex: 0, cx: 0, cy: 0 },
    to: { floorIndex, cx: 0, cy: 0 },
    widthMeters: 10,
    verticalSmokeTransfer: 10
  }));

  const result = stepSmoke3D(seeded.floors, links, 1, options);
  const lower = result.floors[0].smokePhysics;
  const upperVolumes = result.floors.slice(1).map(item => item.smokePhysics.hotGasVolumeM3[0]);

  assert.equal(result.verticalTransfers.length, 2);
  assert.ok(result.verticalTransfers.every(item => item.volumeM3 > 0));
  assert.ok(upperVolumes.every(volume => volume > 0));
  assert.ok(lower.hotGasVolumeM3[0] >= 0);
  assertNearlyEqual(result.totalHotGasVolumeM3, seeded.totalHotGasVolumeM3);
  assertNearlyEqual(result.totalSootKg, seeded.totalSootKg);
  assertNearlyEqual(result.totalCoKg, seeded.totalCoKg);
  assert.ok(
    result.verticalTransfers.reduce((sum, item) => sum + item.volumeM3, 0) <=
      seeded.totalHotGasVolumeM3 + 1e-12
  );
});

test("stair inflow respects receiving upper-layer capacity", () => {
  const cellSizeMeters = 0.5;
  const wallHeightMeters = 3;
  const cellVolume = cellSizeMeters * cellSizeMeters * wallHeightMeters;
  const makeFloor = (floorIndex, depth) => createFloor3D({
    floorIndex,
    zMeters: floorIndex * 3.5,
    cellSizeMeters,
    wallHeightMeters,
    grid: [[legacyCell({
      stair: true,
      stairType: "indoor",
      smokeDensity: 1,
      coPpm: 260,
      smokeLayerDepthMeters: depth
    })]],
    smokeMap: [[1]]
  });
  const seeded = stepSmoke3D([makeFloor(0, 3), makeFloor(1, 2.8)], [], 0, {
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0
  });
  const beforeVolume = seeded.totalHotGasVolumeM3;
  const link = createStairLink({
    id: "capacity-stair",
    type: "indoor",
    from: { floorIndex: 0, cx: 0, cy: 0 },
    to: { floorIndex: 1, cx: 0, cy: 0 },
    widthMeters: 10,
    verticalSmokeTransfer: 10
  });
  const moved = stepSmoke3D(seeded.floors, [link], 1, {
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0
  });
  const settled = stepSmoke3D(moved.floors, [], 0.1, {
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0
  });

  assert.ok(moved.floors[1].smokePhysics.hotGasVolumeM3[0] <= cellVolume + 1e-12);
  assertNearlyEqual(moved.totalHotGasVolumeM3, beforeVolume);
  assertNearlyEqual(settled.totalHotGasVolumeM3, beforeVolume);
});

test("linked outdoor stair does not count the same vent twice", () => {
  const makeStairFloor = (floorIndex, smoky) => createFloor3D({
    floorIndex,
    zMeters: floorIndex * 3.5,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell({
      stair: true,
      stairType: "outdoor",
      smokeDensity: smoky ? 1 : 0,
      coPpm: smoky ? 260 : 0,
      smokeLayerDepthMeters: smoky ? 0.5 : 0
    })]],
    smokeMap: [[smoky ? 1 : 0]]
  });
  const options = {
    turbulentDiffusivityM2Sec: 0,
    leakageRatePerSec: 0,
    sootDepositionRatePerSec: 0,
    heatLossRatePerSec: 0,
    gravityMps2: 0,
    maxSubstepSec: 1
  };
  const seeded = stepSmoke3D([makeStairFloor(0, true), makeStairFloor(1, false)], [], 0, options);
  const link = createStairLink({
    id: "outdoor-no-double-vent",
    type: "outdoor",
    from: { floorIndex: 0, cx: 0, cy: 0 },
    to: { floorIndex: 1, cx: 0, cy: 0 },
    verticalSmokeTransfer: 0.5
  });
  const result = stepSmoke3D(seeded.floors, [link], 0.1, options);

  assert.equal(result.verticalTransfers.length, 1);
  assert.equal(result.verticalTransfers[0].ventedVolumeM3, 0);
  assert.ok(result.floors[0].smokePhysics.ventedSootKg > 0);
  assertNearlyEqual(
    result.totalSootKg + result.floors[0].smokePhysics.ventedSootKg,
    seeded.totalSootKg
  );
});

test("partial FDS smoke overlay replaces CO without erasing fallback fields", () => {
  const makeFloor = () => createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell({
      smokeDensity: 1,
      opticalDensity: 0.32,
      coPpm: 260,
      smokeLayerDepthMeters: 0.5
    })]],
    smokeMap: [[1]]
  });
  const fallback = stepSmoke3D([makeFloor()], [], 0).floors[0].grid[0][0];
  const overlayResult = stepSmoke3D([makeFloor()], [], 0, {
    fdsLookup: () => ({ co_ppm: 777 })
  });
  const overlaid = overlayResult.floors[0].grid[0][0];

  assert.equal(overlaid.smokeDataSource, "fds_csv");
  assert.equal(overlaid.hazardDataSource, "fds_csv");
  assertNearlyEqual(overlaid.smokeDensity, fallback.smokeDensity);
  assertNearlyEqual(overlaid.opticalDensityM1, fallback.opticalDensityM1);
  assertNearlyEqual(overlaid.visibilityMeters, fallback.visibilityMeters);
  assert.equal(overlaid.coPpm, 777);
  assertNearlyEqual(overlayResult.totalSmoke, fallback.smokeDensity);
});

test("FDS-only smoke contributes to public display metrics", () => {
  const floor = createFloor3D({
    floorIndex: 0,
    cellSizeMeters: 0.5,
    wallHeightMeters: 3,
    grid: [[legacyCell()]],
    smokeMap: [[0]]
  });
  const result = stepSmoke3D([floor], [], 0, {
    fdsLookup: () => ({ extinction_coefficient_m_1: 0.32 })
  });

  assertNearlyEqual(result.maxSmokeDensity, 1);
  assertNearlyEqual(result.totalSmoke, 1);
  assertNearlyEqual(result.floors[0].smokeMap[0][0], 1);
});

test("base-10 optical density input converts to natural-log extinction", () => {
  const record = normalizeFdsSmokeRecord({ optical_density_base10_m_1: 0.1 });
  assertNearlyEqual(record.opticalDensity, 0.1 * Math.LN10);
});

test("fire grows, spreads deterministically and applies in place", () => {
  const sourceCell = legacyCell({ fire: true, fireIntensity: 1, fireAgeSec: 10 });
  const targetCell = legacyCell();
  const legacyFloors = [{
    floorIndex: 0,
    grid: [[sourceCell, targetCell]],
    smokeMap: [[0, 0]],
    walkableTemplate: [[true, true]],
    cellSizeMeters: 0.5
  }];
  const result = stepFire3D(legacyFloors, 1, {
    random: () => 0,
    spreadRatePerSec: 100,
    timeSec: 11
  });
  const gridIdentity = legacyFloors[0].grid;
  const applied = applyFire3DResultToLegacyFloors(legacyFloors, result);
  assert.equal(legacyFloors[0].grid, gridIdentity);
  assert.equal(legacyFloors[0].grid[0][1], targetCell);
  assert.equal(targetCell.fire, true);
  assert.equal(applied.ignitedCells.length, 1);
  assert.ok(sourceCell.heatFluxKwM2 > 0);
});

test("agent behavior leaves a hazardous stuck cell toward clear air", () => {
  const grid = [[
    legacyCell({ smokeDensity: 0.05 }),
    legacyCell({ smokeDensity: 3, coPpm: 900 }),
    legacyCell({ smokeDensity: 0.1 })
  ]];
  const floors = [createFloor3D({ floorIndex: 0, grid, smokeMap: [[0.05, 3, 0.1]] })];
  const agent = { id: 1, floor: 0, x: 1, y: 0, type: "student", stuckTime: 2, visibility: 0.1 };
  assert.equal(deriveAgentBehaviorState(agent, { floors }), "seek_clear_air");
  const step = chooseClearAirStep(agent, floors);
  assert.equal(step.cx, 0);
  const normalized = normalizeAgent3D(agent, floors, { cellSizeMeters: 0.5 });
  assert.equal(normalized.worldX, 0.5);
  assert.equal(normalized.behaviorState, "normal");
});

test("color map extraction recognizes white, green and yellow while dropping text", () => {
  const width = 12;
  const height = 8;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  const paintCell = (cellX, cellY, color) => {
    for (let py = cellY * 2; py < cellY * 2 + 2; py++) {
      for (let px = cellX * 2; px < cellX * 2 + 2; px++) {
        const at = (py * width + px) * 4;
        [data[at], data[at + 1], data[at + 2]] = color;
      }
    }
  };
  paintCell(0, 1, [255, 221, 51]);
  paintCell(0, 2, [255, 255, 0]);
  paintCell(1, 1, [255, 255, 255]);
  paintCell(2, 1, [0, 255, 0]);
  paintCell(3, 1, [255, 255, 255]);
  paintCell(4, 1, [255, 221, 51]);
  paintCell(5, 0, [255, 255, 255]); // isolated label
  const parsed = extractScitech3FGridFromImageData({ data }, width, height, { cellPixels: 2 });
  assert.equal(parsed.walkableCells, 6);
  assert.equal(parsed.stairCells, 1);
  assert.equal(parsed.exitCells, 3);
  assert.deepEqual(parsed.exitPoints, [
    { cx: 0, cy: 1, cellCount: 2 },
    { cx: 4, cy: 1, cellCount: 1 }
  ]);
  assert.equal(parsed.exitTemplate[1][0], true);
  assert.equal(parsed.walkableTemplate[1][4], true);
  assert.equal(parsed.walkableTemplate[0][5], false);
  assert.equal(classifyColorMapPixel(255, 255, 255), MAP_CELL_CLASS.corridor);
  assert.equal(classifyColorMapPixel(13, 255, 0), MAP_CELL_CLASS.stair);
  assert.equal(classifyColorMapPixel(255, 221, 51), MAP_CELL_CLASS.exit);
  assert.equal(classifyColorMapPixel(255, 222, 89), MAP_CELL_CLASS.exit);
  assert.equal(classifyColorMapPixel(255, 165, 0), MAP_CELL_CLASS.wall);
  assert.equal(classifyColorMapPixel(150, 120, 70), MAP_CELL_CLASS.wall);
  assert.equal(classifyColorMapPixel(255, 0, 0), MAP_CELL_CLASS.wall);
  const coverageParsed = extractScitech3FGridFromImageData(
    { data },
    width,
    height,
    { cellPixels: 2, sampleMode: "coverage" }
  );
  assert.equal(coverageParsed.exitCells, 3);
  assert.equal(coverageParsed.exitPoints.length, 2);
});

test("3F stair cells collapse into five exact render regions", () => {
  const rectangles = [
    [91, 102, 90, 104, "indoor"],
    [39, 51, 142, 151, "indoor"],
    [20, 28, 66, 79, "indoor"],
    [118, 125, 65, 79, "indoor"],
    [126, 131, 157, 170, "outdoor"]
  ];
  const cells = [];
  for (const [minCx, maxCx, minCy, maxCy, type] of rectangles) {
    for (let cy = minCy; cy <= maxCy; cy += 1) {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        cells.push({ floorIndex: 2, cx, cy, type });
      }
    }
  }
  const regions = groupStairCells3D(cells);
  assert.equal(cells.length, 640);
  assert.equal(regions.length, 5);
  assert.equal(regions.reduce((sum, region) => sum + region.cells.length, 0), 640);
  assert.ok(regions.every(region => region.runs.length === 1));
  assert.deepEqual(
    regions.map(region => [region.minCx, region.maxCx, region.minCy, region.maxCy, region.type]),
    [
      [118, 125, 65, 79, "indoor"],
      [20, 28, 66, 79, "indoor"],
      [91, 102, 90, 104, "indoor"],
      [39, 51, 142, 151, "indoor"],
      [126, 131, 157, 170, "outdoor"]
    ]
  );
  assert.equal(groupStairCells3D([
    { floorIndex: 0, cx: 0, cy: 0, type: "indoor" },
    { floorIndex: 0, cx: 1, cy: 0, type: "outdoor" }
  ]).length, 2);
});

test("renamed 3F profile detection rejects generic same-size images", () => {
  const sample = { gridWidth: 150, gridHeight: 200, walkableCells: 2889, stairCells: 640 };
  assert.equal(isLikelyScitech3FExtraction(sample, 600, 800), true);
  assert.equal(isLikelyScitech3FExtraction({ ...sample, stairCells: 0 }, 600, 800), false);
  assert.equal(
    isLikelyScitech3FExtraction({ ...sample, walkableCells: 2872 }, 600, 800),
    false
  );
  assert.equal(
    isLikelyScitech3FExtraction(
      { gridWidth: 150, gridHeight: 200, walkableCells: 30000, stairCells: 30000 },
      600,
      800
    ),
    false
  );
  assert.equal(isLikelyScitech3FExtraction(sample, 1200, 1600), false);
});

test("view-only bridge snapshots rebuild geometry and dynamic hazards", () => {
  const source = {
    agents: [{ id: 7, floor: 2, x: 1, y: 0, type: "teacher" }],
    map: {
      floorStates: [{
        floorIndex: 2,
        baseImage: {},
        grid: [[legacyCell(), legacyCell({ fire: true, fireIntensity: 0.5 })]],
        walkableTemplate: [[true, true]],
        smokeMap: [[0.2, 0.8]],
        exits: [{ cx: 1, cy: 0 }],
        spawns: [],
        stairs: []
      }],
      stairLinks: []
    },
    sim: { time: 12, running: true },
    render: { geometryRevision: 2, revision: 3 },
    spatial: { cellSizeMeters: 0.42, floorHeightMeters: 3.5, wallHeightMeters: 2.8 }
  };
  const target = { map: {}, sim: {}, render: {}, agents: [] };
  assert.equal(apply3DBridgeMessage(target, createGeometrySnapshot3D(source)), true);
  assert.equal(apply3DBridgeMessage(target, createDynamicSnapshot3D(source)), true);
  assert.equal(target.map.floorStates[0].floorIndex, 2);
  assert.equal(target.map.floorStates[0].grid[0][1].fire, true);
  assert.equal(target.map.floorStates[0].smokeMap[0][1], 0.8);
  assert.deepEqual(target.map.floorStates[0].exits, [{ cx: 1, cy: 0 }]);
  assert.equal(target.agents[0].id, 7);
  assert.equal(target.sim.time, 12);
});
