import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFireAvoidanceMasks,
  isFireAvoidanceBlocked,
  extendPotentialIntoFireAvoidanceZone,
  chooseFireSafeExitField,
  routeChoiceForExit
} from "../sim/js/simulation/routing.js";

function fieldAt(score) {
  return [[[score]]];
}

test("fire avoidance mask blocks the configured radius around active fire", () => {
  const grid = Array.from({ length: 7 }, () =>
    Array.from({ length: 7 }, () => ({ fire: false }))
  );
  grid[3][3].fire = true;

  const masks = buildFireAvoidanceMasks([{ grid }], 7, 7, 2);

  assert.equal(isFireAvoidanceBlocked(masks, 0, 3, 3, 7), true);
  assert.equal(isFireAvoidanceBlocked(masks, 0, 5, 3, 7), true);
  assert.equal(isFireAvoidanceBlocked(masks, 0, 5, 5, 7), false);
});

test("safe exit always wins over a shorter unsafe exit", () => {
  const safeFields = [
    fieldAt(Infinity),
    fieldAt(12)
  ];
  const fallbackFields = [
    fieldAt(2),
    fieldAt(12)
  ];

  const choice = chooseFireSafeExitField(
    safeFields,
    fallbackFields,
    0,
    0,
    0
  );

  assert.equal(choice.idx, 1);
  assert.equal(choice.score, 12);
  assert.equal(choice.usesFireFallback, false);
});

test("unsafe route is used only when no safe exit is reachable", () => {
  const safeFields = [
    fieldAt(Infinity),
    fieldAt(Infinity)
  ];
  const fallbackFields = [
    fieldAt(7),
    fieldAt(3)
  ];

  const choice = chooseFireSafeExitField(
    safeFields,
    fallbackFields,
    0,
    0,
    0
  );

  assert.equal(choice.idx, 1);
  assert.equal(choice.score, 3);
  assert.equal(choice.usesFireFallback, true);
});

test("route choice for one exit refreshes between safe and fallback fields", () => {
  const safeFields = [fieldAt(9)];
  const fallbackFields = [fieldAt(4)];

  const safe = routeChoiceForExit(0, safeFields, fallbackFields, 0, 0, 0);
  assert.equal(safe.score, 9);
  assert.equal(safe.usesFireFallback, false);

  safeFields[0] = fieldAt(Infinity);
  const fallback = routeChoiceForExit(0, safeFields, fallbackFields, 0, 0, 0);
  assert.equal(fallback.score, 4);
  assert.equal(fallback.usesFireFallback, true);
});

test("agent already inside fire buffer can still escape toward a safe exit", () => {
  const width = 7;
  const height = 1;
  const grid = [Array.from({ length: width }, () => ({
    walkable: true,
    wall: false,
    fire: false
  }))];
  grid[0][4].fire = true;
  grid[0][4].walkable = false;

  const floors = [{ grid }];
  const masks = buildFireAvoidanceMasks(floors, width, height, 2);
  const traversable = (floor, cx, cy) =>
    !!floors[floor]?.grid?.[cy]?.[cx]?.walkable &&
    !floors[floor]?.grid?.[cy]?.[cx]?.fire;

  // Exit at x=0 is safe. Its hard-safe field stops at the buffer edge x=2.
  const safeField = [[[
    0, 1, 2, Infinity, Infinity, Infinity, Infinity
  ]]];
  const extended = extendPotentialIntoFireAvoidanceZone(
    safeField,
    floors,
    masks,
    width,
    height,
    traversable,
    50
  );

  // x=3 is inside the fire buffer, but receives an escape gradient back to x=2.
  assert.ok(Number.isFinite(extended[0][0][3]));
  assert.ok(extended[0][0][3] > extended[0][0][2]);
});

test("exit inside fire buffer remains unsafe instead of becoming safe through extension", () => {
  const safeFields = [fieldAt(Infinity), fieldAt(15)];
  const fallbackFields = [fieldAt(2), fieldAt(15)];

  const choice = chooseFireSafeExitField(
    safeFields,
    fallbackFields,
    0,
    0,
    0
  );

  assert.equal(choice.idx, 1);
  assert.equal(choice.usesFireFallback, false);
});
