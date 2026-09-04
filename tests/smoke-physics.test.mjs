import test from "node:test";
import assert from "node:assert/strict";

import { createFloor3D } from "../sim/js/simulation/floors3d.js";
import { createStairLink } from "../sim/js/simulation/stairs3d.js";
import {
  firePlumeGeometry,
  naturalVentilationFlowM3Sec,
  plumeEntrainmentRateKgPerSec,
  resetLegacySmokePhysicsState,
  smokeConservationBalance,
  stepSmoke3D
} from "../sim/js/simulation/smoke3d.js";

const cell = (overrides = {}) => ({
  walkable: true, wall: false, stair: false, fire: false,
  temperatureC: 20, heatFluxKwM2: 0, ...overrides
});

function room(width = 9, height = width, overrides = {}) {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => cell()));
  return createFloor3D({ floorIndex: 0, cellSizeMeters: 1, wallHeightMeters: 3, grid, ...overrides });
}

function evolve(floors, stairLinks, totalSec, dt, options) {
  let state = { floors };
  for (let elapsed = 0; elapsed < totalSec - 1e-12; elapsed += dt) {
    state = stepSmoke3D(state.floors, stairLinks, Math.min(dt, totalSec - elapsed), options);
  }
  return state;
}

function near(actual, expected, tolerance = 1e-11) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
}

const lossless = {
  leakageRatePerSec: 0,
  mechanicalVentilationM3Sec: 0,
  sootDepositionRatePerSec: 0,
  heatLossRatePerSec: 0,
  exitActsAsOpenVent: false,
  turbulentDiffusivityM2Sec: 0.03,
  maxSubstepSec: 0.05
};

test("Heskestad source area controls equivalent diameter, virtual origin and entrainment", () => {
  const small = firePlumeGeometry(500, { fireAreaM2: 0.25 });
  const large = firePlumeGeometry(500, { fireAreaM2: 4 });
  near(small.fireDiameterMeters, Math.sqrt(1 / Math.PI));
  near(large.fireDiameterMeters, Math.sqrt(16 / Math.PI));
  assert.ok(large.virtualOriginMeters < small.virtualOriginMeters);
  assert.ok(plumeEntrainmentRateKgPerSec(500, 3, { fireAreaM2: 4 }) >
    plumeEntrainmentRateKgPerSec(500, 3, { fireAreaM2: 0.25 }));
  near(firePlumeGeometry(500, { fireAreaM2: 4, fireDiameterMeters: 0.8 }).fireDiameterMeters, 0.8);
  near(firePlumeGeometry(500, { virtualOriginMeters: -0.25 }).virtualOriginMeters, -0.25);
});

test("fire cells expose resolved source geometry while using dynamic current HRR", () => {
  const floor = room(3);
  floor.grid[1][1] = cell({ fire: true, hrrKw: 500, fireAreaM2: 2 });
  const result = stepSmoke3D([floor], [], 0.1, lossless);
  const fire = result.floors[0].grid[1][1];
  near(fire.resolvedFireAreaM2, 2);
  near(fire.resolvedFireDiameterMeters, Math.sqrt(8 / Math.PI));
  near(fire.plumeVirtualOriginMeters, -1.02 * Math.sqrt(8 / Math.PI) + 0.083 * Math.pow(500, 0.4));
});

test("zero buoyancy, wind and mechanical flow produces zero natural ventilation", () => {
  near(naturalVentilationFlowM3Sec(2, 2, 20, { ambientTemperatureC: 20, windVelocityMps: 0 }), 0);
  const floor = createFloor3D({
    floorIndex: 0, cellSizeMeters: 1, wallHeightMeters: 3,
    grid: [[cell({ smokeDensity: 1 })]], smokeMap: [[1]],
    exits: [{ cx: 0, cy: 0 }]
  });
  const seeded = stepSmoke3D([floor], [], 0, { ...lossless, exitActsAsOpenVent: true });
  const next = stepSmoke3D(seeded.floors, [], 1, {
    ...lossless, exitActsAsOpenVent: true, gravityMps2: 0, windVelocityMps: 0
  });
  near(next.totalSootKg, seeded.totalSootKg);
  near(next.floors[0].smokePhysics.ventedSootKg, 0);
});

test("leakage and mechanical exhaust retain distinct loss accounts", () => {
  const floor = createFloor3D({
    floorIndex: 0, cellSizeMeters: 1, wallHeightMeters: 3,
    grid: [[cell({ smokeDensity: 1 })]], smokeMap: [[1]]
  });
  const seeded = stepSmoke3D([floor], [], 0, lossless);
  const result = stepSmoke3D(seeded.floors, [], 0.5, {
    ...lossless, leakageRatePerSec: 0.1, mechanicalVentilationM3Sec: 0.02
  });
  const state = result.floors[0].smokePhysics;
  assert.ok(state.leakedSootKg > 0);
  assert.ok(state.mechanicalVentedSootKg > 0);
  near(state.naturalVentedSootKg, 0);
  near(smokeConservationBalance(result.floors).soot.error, 0);
});

test("soot, CO, hot-layer volume and heat close their reported budgets", () => {
  const floor = room(7);
  floor.grid[3][3] = cell({ fire: true, hrrKw: 250, fireAreaM2: 0.5 });
  const result = evolve([floor], [], 1, 0.05, {
    ...lossless, sootDepositionRatePerSec: 0.04, heatLossRatePerSec: 0.02,
    leakageRatePerSec: 0.03
  });
  const budget = smokeConservationBalance(result.floors);
  for (const quantity of ["soot", "co", "volume", "heat"]) {
    assert.ok(Math.abs(budget[quantity].relativeError) < 2e-12,
      `${quantity}: ${JSON.stringify(budget[quantity])}`);
  }
  assert.ok(budget.soot.otherLoss > 0);
  near(budget.co.otherLoss, 0);
});

test("symmetric room produces an approximately symmetric hot layer", () => {
  const floor = room(9);
  floor.grid[4][4] = cell({ fire: true, hrrKw: 180 });
  const result = evolve([floor], [], 1.5, 0.05, lossless);
  const v = result.floors[0].smokePhysics.hotGasVolumeM3;
  const width = 9;
  let mirroredL1 = 0;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    mirroredL1 += Math.abs(v[y * width + x] - v[y * width + (8 - x)]);
    mirroredL1 += Math.abs(v[y * width + x] - v[(8 - y) * width + x]);
  }
  assert.ok(mirroredL1 / result.totalHotGasVolumeM3 < 1e-4);
});

test("fixed-substep solution is stable for caller dt 0.1 versus 0.05", () => {
  const build = () => {
    const floor = room(9);
    floor.grid[4][4] = cell({ fire: true, hrrKw: 200 });
    return floor;
  };
  // Distinct internal timesteps, rather than two callers using the same 0.05 s
  // substep. Spatial L1 permits first-order transport diffusion, totals do not.
  const coarse = evolve([build()], [], 5, 0.1, { ...lossless, maxSubstepSec: 0.1 });
  const fine = evolve([build()], [], 5, 0.05, { ...lossless, maxSubstepSec: 0.1 });
  near(coarse.totalSootKg, fine.totalSootKg, 2e-12);
  near(coarse.totalCoKg, fine.totalCoKg, 2e-12);
  const a = coarse.floors[0].smokePhysics.hotGasVolumeM3;
  const b = fine.floors[0].smokePhysics.hotGasVolumeM3;
  const l1 = a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0);
  assert.ok(l1 / Math.max(1e-12, fine.totalHotGasVolumeM3) < 0.05);
});

test("multiple stair fan-out cannot transfer more species than source inventory", () => {
  const makeFloor = (floorIndex, smoky) => createFloor3D({
    floorIndex, zMeters: floorIndex * 3.5, cellSizeMeters: 1, wallHeightMeters: 3,
    grid: [[cell({ stair: true, smokeDensity: smoky ? 2 : 0 })]], smokeMap: [[smoky ? 2 : 0]]
  });
  let result = stepSmoke3D([makeFloor(0, true), makeFloor(1, false), makeFloor(2, false)], [], 0, lossless);
  const initial = result.totalSootKg;
  const links = [1, 2].map(n => createStairLink({
    id: `fan-${n}`, type: "indoor", widthMeters: 5, verticalSmokeTransfer: 2,
    from: { floorIndex: 0, cx: 0, cy: 0 }, to: { floorIndex: n, cx: 0, cy: 0 }
  }));
  result = stepSmoke3D(result.floors, links, 2, { ...lossless, maxSubstepSec: 2 });
  assert.ok(result.verticalTransfers.reduce((sum, x) => sum + x.sootMassKg, 0) <= initial + 1e-12);
  near(result.totalSootKg + result.floors.reduce((sum, f) => sum + f.smokePhysics.ventedSootKg, 0), initial, 1e-12);
  near(smokeConservationBalance(result.floors).soot.error, 0, 1e-12);
  for (const floor of result.floors) {
    for (const quantity of Object.values(smokeConservationBalance(floor))) {
      near(quantity.error, 0, 1e-11);
    }
  }
});

test("smoke reset clears conserved buffers and corridor diagnostics before a fresh run", () => {
  const build = () => {
    const floor = room(20, 1);
    floor.grid[0][1] = cell({ fire: true, hrrKw: 80, fireSource: "manual" });
    return floor;
  };
  const result = evolve([build()], [], 0.5, 0.05, lossless);
  const floor = result.floors[0];
  assert.ok(floor.smokePhysics.generatedSootKg > 0);
  assert.ok(floor.corridorSmoke.segments.some(segment => segment.active));
  resetLegacySmokePhysicsState(floor, { clearDerivedFields: true });
  assert.equal(floor.smokePhysics, null);
  assert.equal(floor.corridorSmoke, null);
  assert.ok(floor.smokeMap.every(row => row.every(value => value === 0)));
  assert.ok(floor.grid[0].every(cell => cell.smokeLayerDepthMeters === 0 && cell.eyeLevelCoPpm === 0));

  const redrawn = stepSmoke3D([floor], [], 0, lossless);
  const physics = redrawn.floors[0].smokePhysics;
  for (const field of ["sootMassKg", "coMassKg", "excessHeatKJ", "hotGasVolumeM3"])
    assert.ok(physics[field].every(value => value === 0));
  near(physics.generatedSootKg, 0);
  near(physics.generatedCoKg, 0);
  near(physics.generatedHotGasVolumeM3, 0);
  near(physics.elapsedSec, 0);
  assert.ok(redrawn.floors[0].corridorSmoke.segments.every(segment => !segment.active && segment.frontPositionMeters === 0));
  // Manual fire specification survives a smoke reset; its first smoke step
  // must reproduce a fresh model. Core resets fire age/spread independently.
  const restarted = stepSmoke3D(redrawn.floors, [], 0.05, lossless);
  const fresh = stepSmoke3D([build()], [], 0.05, lossless);
  near(restarted.totalSootKg, fresh.totalSootKg);
  near(restarted.totalCoKg, fresh.totalCoKg);
  near(restarted.totalHotGasVolumeM3, fresh.totalHotGasVolumeM3);
});
