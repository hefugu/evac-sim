import test from "node:test";
import assert from "node:assert/strict";
import {
  FDS_EVAC_PERSON_TYPES,
  SOCIAL_FORCE_DEFAULTS,
  sampleFdsEvacPerson,
  smokeAdjustedDesiredSpeed,
  buildAgentSpatialHash,
  queryNearbyAgentIndices,
  potentialDesiredDirection,
  stepPedestrianDynamics
} from "../sim/js/simulation/pedestrian-dynamics.js";

const nearly = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test("FDS+Evac person sampler reproduces distribution means at midpoint", () => {
  const midpoint = () => 0.5;
  for (const [type, profile] of Object.entries(FDS_EVAC_PERSON_TYPES)) {
    const person = sampleFdsEvacPerson(type, midpoint);
    nearly(person.radiusM, profile.radiusMeanM);
    nearly(person.desiredSpeedMps, profile.speedMeanMps);
    nearly(person.relaxationTimeS, 1.0);
  }
  nearly(sampleFdsEvacPerson("male", midpoint).massKg, 80);
});

test("behavioral school roles keep adult physical defaults", () => {
  const midpoint = () => 0.5;
  const teacher = sampleFdsEvacPerson("teacher", midpoint);
  const student = sampleFdsEvacPerson("student", midpoint);
  nearly(teacher.radiusM, FDS_EVAC_PERSON_TYPES.adult.radiusMeanM);
  nearly(student.desiredSpeedMps, FDS_EVAC_PERSON_TYPES.adult.speedMeanMps);
});

test("smoke speed reduction follows FDS+Evac correlation and minimum floor", () => {
  nearly(smokeAdjustedDesiredSpeed(1.25, 0), 1.25);
  const expected = 1.25 * (0.706 - 0.057 * 2) / 0.706;
  nearly(smokeAdjustedDesiredSpeed(1.25, 2), expected);
  nearly(smokeAdjustedDesiredSpeed(1.25, 100), 0.125);
});

test("spatial hash returns local same-floor buckets without global pair scan", () => {
  const agents = [
    { id: 0, floor: 0, x: 0, y: 0 },
    { id: 1, floor: 0, x: 1, y: 0 },
    { id: 2, floor: 0, x: 20, y: 20 },
    { id: 3, floor: 1, x: 0, y: 0 }
  ];
  const hash = buildAgentSpatialHash(agents, { bucketSizeM: 1, cellSizeMeters: 0.5 });
  const nearby = queryNearbyAgentIndices(hash, agents[0], 1);
  assert.ok(nearby.includes(0));
  assert.ok(nearby.includes(1));
  assert.ok(!nearby.includes(2));
  assert.ok(!nearby.includes(3));
});

test("potential gradient points toward decreasing potential", () => {
  const field = [[
    [4, 3, 2],
    [3, 2, 1],
    [4, 3, 2]
  ]];
  const dir = potentialDesiredDirection({ floor: 0, x: 1, y: 1 }, field);
  assert.ok(dir.x > 0.7);
  assert.ok(Math.abs(dir.y) < 0.2);
});

test("single pedestrian accelerates toward desired velocity", () => {
  const agents = [{
    id: 0,
    floor: 0,
    x: 1,
    y: 1,
    radiusM: 0.255,
    massKg: 80,
    baseDesiredSpeedMps: 1.25,
    desiredSpeedMps: 1.25,
    relaxationTimeS: 1,
    vxMps: 0,
    vyMps: 0
  }];
  const context = {
    cellSizeMeters: 0.5,
    isWalkable: () => true,
    desiredDirectionFor: () => ({ x: 1, y: 0 }),
    extinctionAt: () => 0,
    random: () => 0.5
  };
  stepPedestrianDynamics(agents, 0.1, context, {
    randomAccelerationStdMps2: 0,
    interactionRangeM: 1
  });
  assert.ok(agents[0].x > 1);
  assert.ok(agents[0].vxMps > 0);
  assert.ok(Math.abs(agents[0].vyMps) < 1e-12);
  assert.ok(agents[0].vxMps < agents[0].baseDesiredSpeedMps);
});

test("pedestrians repel instead of occupying exactly the same line", () => {
  const agents = [
    {
      id: 0, floor: 0, x: 2, y: 2,
      radiusM: 0.255, massKg: 80, baseDesiredSpeedMps: 1.25,
      relaxationTimeS: 1, vxMps: 0, vyMps: 0
    },
    {
      id: 1, floor: 0, x: 2.6, y: 2,
      radiusM: 0.255, massKg: 80, baseDesiredSpeedMps: 1.25,
      relaxationTimeS: 1, vxMps: 0, vyMps: 0
    }
  ];
  const before = (agents[1].x - agents[0].x) * 0.5;
  stepPedestrianDynamics(agents, 0.1, {
    cellSizeMeters: 0.5,
    isWalkable: () => true,
    desiredDirectionFor: () => ({ x: 0, y: 0 }),
    extinctionAt: () => 0,
    random: () => 0.5
  }, {
    randomAccelerationStdMps2: 0
  });
  const after = (agents[1].x - agents[0].x) * 0.5;
  assert.ok(after > before);
});

test("hard wall constraint prevents numerical penetration", () => {
  const agents = [{
    id: 0,
    floor: 0,
    x: 0,
    y: 0,
    radiusM: 0.255,
    massKg: 80,
    baseDesiredSpeedMps: 1.25,
    relaxationTimeS: 0.8,
    vxMps: 1,
    vyMps: 0
  }];
  const isWalkable = (_floor, cx, cy) => cx <= 0 && Math.abs(cy) <= 2;
  stepPedestrianDynamics(agents, 1, {
    cellSizeMeters: 0.5,
    isWalkable,
    desiredDirectionFor: () => ({ x: 1, y: 0 }),
    extinctionAt: () => 0,
    random: () => 0.5
  }, {
    randomAccelerationStdMps2: 0,
    maxAccelerationMps2: SOCIAL_FORCE_DEFAULTS.maxAccelerationMps2
  });
  assert.ok(Math.round(agents[0].x) <= 0);
});
