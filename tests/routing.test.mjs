import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFireAvoidanceMasks,
  isFireAvoidanceBlocked,
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
