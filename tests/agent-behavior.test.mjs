import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResponseOptions, samplePreMovement, departureState,
  hasLineOfSight, canPerceiveGuide, selectVisibleGuide } from "../sim/js/simulation/agent-behavior.js";
import { normalizeAgent3D } from "../sim/js/simulation/agents3d-sync.js";

test("triangular response distribution has specified support, mode and mean", () => {
  const options = { detectionSec: 3, minSec: 2, modeSec: 5, maxSec: 11 };
  assert.equal(samplePreMovement(options, () => 0).reactionSec, 2);
  assert.equal(samplePreMovement(options, () => 1).reactionSec, 11);
  assert.ok(Math.abs(samplePreMovement(options, () => 1 / 3).reactionSec - 5) < 1e-12);
  const n = 10000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const result = samplePreMovement(options, () => (i + 0.5) / n);
    assert.equal(result.preMovementSec, 3 + result.reactionSec);
    sum += result.reactionSec;
  }
  assert.ok(Math.abs(sum / n - 6) < 0.001);
});

test("fixed/zero response avoids random consumption and invalid settings are normalized", () => {
  const fail = () => assert.fail("fixed response should not draw randomness");
  assert.equal(samplePreMovement({}, fail).preMovementSec, 0);
  assert.equal(samplePreMovement({ minSec: 7, maxSec: 7 }, fail).reactionSec, 7);
  assert.deepEqual(normalizeResponseOptions({ detectionSec: -1, minSec: 3, modeSec: 20, maxSec: 1 }),
    { detectionSec: 0, minSec: 3, modeSec: 3, maxSec: 3 });
});

test("departure phases use absolute simulation time and survive renderer normalization", () => {
  const agent = { startTime: 10, detectionSec: 2, evacDelay: 5 };
  assert.equal(departureState(agent, 11.9), "unaware");
  assert.equal(departureState(agent, 12), "pre_movement");
  assert.equal(departureState(agent, 14.9), "pre_movement");
  assert.equal(departureState(agent, 15), "normal");
  for (const behaviorState of ["unaware", "pre_movement", "evacuated"]) {
    assert.equal(normalizeAgent3D({ ...agent, behaviorState }).behaviorState, behaviorState);
  }
});

test("line of sight respects walls, corner occlusion and reverse/subcell rays", () => {
  const clear = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
  const wall = (x, y) => clear(x, y) && x !== 3;
  const a = { x: 1.2, y: 1 }, b = { x: 5, y: 2.3 };
  assert.equal(hasLineOfSight(a, b, clear), true);
  assert.equal(hasLineOfSight(a, b, wall), false);
  assert.equal(hasLineOfSight(b, a, wall), false);
  assert.equal(hasLineOfSight({ x: 1, y: 1 }, { x: 2, y: 2 }, (x, y) => !(x === 2 && y === 1)), false);
  assert.equal(hasLineOfSight(a, a, clear), true);
  assert.equal(hasLineOfSight({ x: 1, y: 1 }, { x: 0.5, y: 1.5 }, clear), true);
  assert.equal(hasLineOfSight({ x: 0.5, y: 1.5 }, { x: 1, y: 1 }, clear), true);
  assert.equal(hasLineOfSight({ x: NaN, y: 1 }, b, clear), false);
});

const follower = { id: 1, floor: 0, x: 1, y: 1 };
const guide = { id: 2, type: "teacher", floor: 0, x: 7, y: 1, startTime: 0, evacDelay: 0 };
const context = {
  timeSec: 5, maxRangeMeters: 4,
  cellSizeMetersForFloor: () => 0.5,
  isWalkable: () => true, visibilityMetersAt: () => 30
};

test("guide recognition uses metres and excludes other floors and unavailable guides", () => {
  assert.equal(canPerceiveGuide(follower, guide, context), true);
  assert.equal(canPerceiveGuide(follower, guide, { ...context, cellSizeMetersForFloor: () => 1 }), false);
  for (const changes of [{ floor: 1 }, { dead: true }, { finished: true }, { fallen: true },
    { stairTransition: {} }, { evacDelay: 10 }, { type: "adult" }]) {
    assert.equal(canPerceiveGuide(follower, { ...guide, ...changes }, context), false);
  }
});

test("smoke between people and walls hide guides even if endpoints are clear", () => {
  assert.equal(canPerceiveGuide(follower, guide, { ...context,
    isWalkable: (_f, x) => x !== 4 }), false);
  assert.equal(canPerceiveGuide(follower, guide, { ...context,
    visibilityMetersAt: (_f, x) => x === 4 ? 1 : 30 }), false);
});

test("followers retain a visible guide, reacquire another, or fall back to own route", () => {
  const closer = { ...guide, id: 3, x: 2 };
  const assigned = { ...follower, leaderId: guide.id };
  assert.equal(selectVisibleGuide(assigned, [closer, guide], context).id, guide.id);
  assert.equal(selectVisibleGuide(assigned, [closer, { ...guide, finished: true }], context).id, closer.id);
  assert.equal(selectVisibleGuide(assigned, [guide], { ...context, visibilityMetersAt: () => 0.1 }), null);
});
