import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CORRIDOR_OPTIONS,
  computeCorridorSmokeTransport,
  corridorFrontVelocityMps,
  identifyCorridorSegments
} from "../sim/js/simulation/corridor-smoke.js";
import {
  stepSmoke3D,
  resetLegacySmokePhysicsState
} from "../sim/js/simulation/smoke3d.js";

const near = (actual, expected, tolerance = 1e-12) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} +/- ${tolerance}`);

function corridor(width = 24, height = 1) {
  const floor = {
    floorIndex: 0, cellSizeMeters: 1,
    grid: Array.from({ length: height }, () => Array.from({ length: width }, () => ({ walkable: true, wall: false })))
  };
  const state = {
    width, height, roomHeightMeters: 3, topologyHash: 1,
    passableMask: new Uint8Array(width * height).fill(1),
    hotGasVolumeM3: new Float64Array(width * height),
    sootMassKg: new Float64Array(width * height),
    coMassKg: new Float64Array(width * height),
    excessHeatKJ: new Float64Array(width * height)
  };
  return { floor, state };
}

function seed(state, index, volume = 0.4, temperature = 180) {
  state.hotGasVolumeM3[index] = volume;
  state.sootMassKg[index] = volume * 0.001;
  state.coMassKg[index] = volume * 0.0002;
  state.excessHeatKJ[index] = volume * 1.2 * 1.005 * (temperature - 20);
}

function totals(state) {
  return ["hotGasVolumeM3", "sootMassKg", "coMassKg", "excessHeatKJ"]
    .map(key => state[key].reduce((sum, value) => sum + value, 0));
}

// Test-only stand-in for smoke3d's extensive flux accumulator. All requests
// read the same old contents and commit together; no concentration is injected.
function applyPlan(state, plan) {
  const keys = ["hotGasVolumeM3", "sootMassKg", "coMassKg", "excessHeatKJ"];
  const deltas = keys.map(() => new Float64Array(state.width * state.height));
  for (const request of plan.transfers) {
    const fraction = request.volumeM3 / state.hotGasVolumeM3[request.fromIndex];
    keys.forEach((key, offset) => {
      const value = state[key][request.fromIndex] * fraction;
      deltas[offset][request.fromIndex] -= value;
      deltas[offset][request.toIndex] += value;
    });
  }
  keys.forEach((key, offset) => state[key].forEach((value, index) => {
    state[key][index] = value + deltas[offset][index];
    assert.ok(state[key][index] >= -1e-12, `${key} became negative`);
  }));
}

test("corridor gravity velocity uses Kelvin, depth and explicit Froude number", () => {
  near(corridorFrontVelocityMps(0.5, 200), 0.7 * Math.sqrt(9.81 * (200 - 20) / (200 + 273.15) * 0.5));
  assert.equal(corridorFrontVelocityMps(1, 20), 0);
  assert.equal(corridorFrontVelocityMps(0, 200), 0);
  assert.ok(corridorFrontVelocityMps(0.5, 200) > corridorFrontVelocityMps(0.2, 200));
  assert.ok(corridorFrontVelocityMps(0.5, 200) > corridorFrontVelocityMps(0.5, 100));
  assert.equal(DEFAULT_CORRIDOR_OPTIONS.corridorFroudeNumber, 0.7);
});

test("auto detection accepts long multi-cell corridors and falls back for broad rooms", () => {
  const hall = identifyCorridorSegments(corridor(30, 3).floor);
  assert.equal(hall.segments.length, 1);
  assert.equal(hall.segments[0].axis, "x");
  assert.equal(hall.segments[0].widthMeters, 3);
  assert.equal(hall.membership.reduce((sum, value) => sum + value, 0), 90);
  assert.equal(identifyCorridorSegments(corridor(12, 12).floor).segments.length, 0);
  assert.equal(identifyCorridorSegments(corridor(3, 3).floor).segments.length, 0);
});

test("explicit corridor regions support short corridors and never include walls", () => {
  const { floor } = corridor(5);
  floor.grid[0][2] = { walkable: false, wall: true };
  floor.corridorRegions = [{ id: "hall", axis: "x", cells: Array.from({ length: 5 }, (_, cx) => ({ cx, cy: 0 })) }];
  const result = identifyCorridorSegments(floor, { corridorAutoDetect: false });
  assert.equal(result.segments.length, 2);
  assert.equal(result.membership[2], 0);
  assert.deepEqual([...result.membership], [1, 1, 0, 1, 1]);
});

test("corridor front transports smoke while conserving volume, soot, CO and heat", () => {
  const { floor, state } = corridor();
  seed(state, 1, 0.8);
  const before = totals(state);
  for (let step = 0; step < 180; step++) applyPlan(state, computeCorridorSmokeTransport(floor, state, 0.1));
  const after = totals(state);
  before.forEach((value, index) => near(after[index], value, 1e-10));
  assert.ok(state.sootMassKg[4] > 0, "gravity closure must move actual smoke downstream");
  const segment = computeCorridorSmokeTransport(floor, state, 0).segments[0];
  assert.ok(segment.frontPositionMeters > 2);
  assert.ok(segment.frontVelocityMps > 0);
  assert.ok(segment.upperLayerDepthMeters > 0);
  near(segment.upperLayerTemperatureC, 180, 1e-10);
});

test("corridor smoke front cannot cross a structural wall after repeated steps", () => {
  const { floor, state } = corridor();
  floor.grid[0][10] = { walkable: false, wall: true };
  state.passableMask[10] = 0;
  seed(state, 8);
  for (let step = 0; step < 300; step++) {
    const plan = computeCorridorSmokeTransport(floor, state, 0.1);
    assert.ok(plan.transfers.every(item => item.toIndex !== 10 && item.fromIndex !== 10));
    applyPlan(state, plan);
  }
  assert.equal(state.sootMassKg.slice(10).reduce((a, b) => a + b, 0), 0);
  near(totals(state)[1], 0.0004);
});

test("closed doors stop fronts, reopening restores passage, and unannotated doors stay compatible", () => {
  const { floor, state } = corridor();
  floor.grid[0][10] = { walkable: true, door: true, doorOpen: false };
  state.passableMask[10] = 0;
  seed(state, 9);
  for (let step = 0; step < 30; step++) applyPlan(state, computeCorridorSmokeTransport(floor, state, 0.1));
  assert.equal(state.sootMassKg[10], 0);
  floor.grid[0][10].doorOpen = true;
  state.passableMask[10] = 1;
  state.topologyHash++;
  applyPlan(state, computeCorridorSmokeTransport(floor, state, 0.1));
  assert.ok(state.sootMassKg[10] > 0);
  delete floor.grid[0][10].doorOpen;
  assert.equal(identifyCorridorSegments(floor).membership[10], 1);
});

test("open side doors couple corridor smoke to ordinary room cells", () => {
  const { floor, state } = corridor(14, 3);
  floor.grid[0].forEach((_, cx) => floor.grid[0][cx] = { wall: true });
  floor.grid[2].forEach((_, cx) => floor.grid[2][cx] = { wall: true });
  floor.grid[0][7] = { walkable: true, door: true };
  floor.corridorRegions = [{ id: "hall", axis: "x", cells: Array.from({ length: 14 }, (_, cx) => ({ cx, cy: 1 })) }];
  seed(state, 14 + 7);
  const plan = computeCorridorSmokeTransport(floor, state, 0.1, { corridorAutoDetect: false });
  assert.ok(plan.transfers.some(item => item.toIndex === 7), "open side door receives an extensive flux");
  const before = totals(state);
  applyPlan(state, plan);
  before.forEach((value, index) => near(totals(state)[index], value));
});

test("stair-delivered smoke seeds a corridor without a local fire or duplicate source", () => {
  const { floor, state } = corridor();
  floor.grid[0][5].stair = true;
  seed(state, 5); // Represents contents already delivered by shared stair transfer.
  const initial = totals(state);
  const plan = computeCorridorSmokeTransport(floor, state, 0.1);
  assert.ok(plan.segments[0].active);
  assert.ok(plan.transfers.some(item => item.fromIndex === 5));
  applyPlan(state, plan);
  initial.forEach((value, index) => near(totals(state)[index], value));
});

test("corridor fan-out uses one bounded donor budget and is symmetric", () => {
  const { floor, state } = corridor(25);
  seed(state, 12, 1);
  const plan = computeCorridorSmokeTransport(floor, state, 50);
  const outgoing = plan.transfers.filter(item => item.fromIndex === 12);
  assert.equal(outgoing.length, 2);
  near(outgoing[0].volumeM3, outgoing[1].volumeM3);
  near(outgoing.reduce((sum, item) => sum + item.volumeM3, 0), 0.3);
  for (let step = 0; step < 80; step++) applyPlan(state, computeCorridorSmokeTransport(floor, state, 0.1));
  for (let index = 0; index < 12; index++) near(state.sootMassKg[index], state.sootMassKg[24 - index]);
});

test("disabled corridor model supplies no advection ownership or transfers", () => {
  const { floor, state } = corridor();
  seed(state, 1);
  const result = computeCorridorSmokeTransport(floor, state, 0.1, { corridorModelEnabled: false });
  assert.equal(result.membership.reduce((a, b) => a + b, 0), 0);
  assert.deepEqual(result.transfers, []);
  assert.deepEqual(result.segments, []);
});

test("corridor dt=0.1 and dt=0.05 have similar physical fields", () => {
  const run = dt => {
    const { floor, state } = corridor();
    seed(state, 2, 1);
    for (let step = 0; step < Math.round(6 / dt); step++) applyPlan(state, computeCorridorSmokeTransport(floor, state, dt));
    return [...state.sootMassKg];
  };
  const coarse = run(0.1), fine = run(0.05);
  const error = coarse.reduce((sum, value, index) => sum + Math.abs(value - fine[index]), 0);
  assert.ok(error / 0.001 < 0.025, `relative soot L1 difference ${error / 0.001}`);
});

test("shared smoke solver uses corridor gravity transport and conserves produced species", () => {
  const create = () => {
    const { floor } = corridor(20);
    floor.grid[0][1] = { walkable: true, wall: false, fire: true, hrrKw: 20 };
    return [floor];
  };
  const run = enabled => {
    let floors = create();
    for (let step = 0; step < 20; step++) floors = stepSmoke3D(floors, [], 0.1, {
      corridorModelEnabled: enabled, turbulentDiffusivityM2Sec: 0,
      leakageRatePerSec: 0, sootDepositionRatePerSec: 0, heatLossRatePerSec: 0,
      timeSec: (step + 1) * 0.1
    }).floors;
    return floors[0];
  };
  const current = run(true), generic = run(false);
  assert.ok(current.corridorSmoke.segments.some(segment => segment.active));
  assert.notEqual(current.smokePhysics.sootMassKg[2], generic.smokePhysics.sootMassKg[2]);
  near(current.smokePhysics.sootMassKg.reduce((a, b) => a + b, 0), current.smokePhysics.generatedSootKg, 1e-10);
  near(current.smokePhysics.coMassKg.reduce((a, b) => a + b, 0), current.smokePhysics.generatedCoKg, 1e-10);
  resetLegacySmokePhysicsState([current]);
  assert.equal(current.corridorSmoke, null);
});

test("shared solver corridor smoke cannot pass a wall or explicit closed door", () => {
  for (const barrier of [{ walkable: false, wall: true }, { walkable: true, door: true, doorOpen: false }]) {
    const { floor } = corridor(24);
    floor.grid[0][8] = { walkable: true, wall: false, fire: true, hrrKw: 20 };
    floor.grid[0][10] = barrier;
    let floors = [floor];
    for (let step = 0; step < 40; step++) floors = stepSmoke3D(floors, [], 0.1, { timeSec: step * 0.1 }).floors;
    assert.equal(floors[0].smokePhysics.sootMassKg.slice(10).reduce((a, b) => a + b, 0), 0);
    assert.equal(floors[0].smokePhysics.coMassKg.slice(10).reduce((a, b) => a + b, 0), 0);
  }
});
