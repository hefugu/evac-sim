import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFireAvoidanceMasks,
  buildNearestFireDistanceFields,
  moveApproachesFire,
  fireDistanceAt,
  isFireAvoidanceBlocked,
  isDoorPassableForEvacuation,
  isEvacuationExitUsable,
  extendPotentialIntoFireAvoidanceZone,
  chooseFireSafeExitField,
  routeChoiceForExit
} from "../sim/js/simulation/routing.js";

test("fire avoidance converts a metre radius separately on each floor", () => {
  const floors = [0.5, 0.42].map(cellSizeMeters => ({
    cellSizeMeters,
    grid: [Array.from({ length: 12 }, (_, x) => ({ fire: x === 0 }))]
  }));
  const masks = buildFireAvoidanceMasks(floors, 12, 1, floor => 2.2 / floor.cellSizeMeters);
  assert.equal(masks[0][4], 1);
  assert.equal(masks[0][5], 0);
  assert.equal(masks[1][5], 1);
  assert.equal(masks[1][6], 0);
});

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


test("nearest-fire distance marks moves toward fire as unsafe", () => {
  const grid = [[
    { fire: false },
    { fire: false },
    { fire: false },
    { fire: true }
  ]];
  const fields = buildNearestFireDistanceFields([{ grid }], 4, 1);

  assert.equal(fireDistanceAt(fields, 0, 3, 0, 4), 0);
  assert.ok(fireDistanceAt(fields, 0, 0, 0, 4) > fireDistanceAt(fields, 0, 1, 0, 4));
  assert.equal(moveApproachesFire(fields, 0, 0, 0, 0, 1, 0, 4), true);
  assert.equal(moveApproachesFire(fields, 0, 1, 0, 0, 0, 0, 4), false);
});

test("fire-safe policy refuses an unsafe shortcut when every safe route is absent", () => {
  const safeFields = [fieldAt(Infinity), fieldAt(Infinity)];
  const ordinaryFields = [fieldAt(1), fieldAt(8)];

  const strict = chooseFireSafeExitField(
    safeFields, ordinaryFields, 0, 0, 0,
    { allowUnsafeFallback: false }
  );
  assert.equal(strict.idx, -1);
  assert.equal(strict.field, null);
  assert.equal(strict.usesFireFallback, false);

  // Retaining a previously committed exit must not restore its hazardous field.
  const retained = routeChoiceForExit(
    0, safeFields, ordinaryFields, 0, 0, 0,
    { allowUnsafeFallback: false }
  );
  assert.equal(retained.idx, -1);
  assert.equal(retained.field, null);
});

test("safe exit beats nearby exit on the burning side", () => {
  const grid = [[
    { walkable: true, fire: false },
    { walkable: true, fire: false },
    { walkable: true, fire: false },
    { walkable: false, fire: true },
    { walkable: true, fire: false }
  ]];
  const floors = [{ grid }];
  const masks = buildFireAvoidanceMasks(floors, 5, 1, 1);

  assert.equal(isEvacuationExitUsable({ floor: 0, cx: 2, cy: 0 }, floors, masks, 5), false);
  assert.equal(isEvacuationExitUsable({ floor: 0, cx: 0, cy: 0 }, floors, masks, 5), true);

  const choice = chooseFireSafeExitField(
    [fieldAt(Infinity), fieldAt(10)],
    [fieldAt(1), fieldAt(10)],
    0, 0, 0,
    { allowUnsafeFallback: false }
  );
  assert.equal(choice.idx, 1);
  assert.equal(choice.usesFireFallback, false);
});

test("explicitly impassable fire doors are blocked, ordinary closed doors remain openable", () => {
  const closed = { walkable: true, door: true, doorState: "closed", fire: false };
  const sealed = { ...closed, doorState: "sealed" };
  const stuck = { ...closed, doorPassable: false };
  assert.equal(isDoorPassableForEvacuation(closed), true);
  assert.equal(isDoorPassableForEvacuation(sealed), false);
  assert.equal(isDoorPassableForEvacuation(stuck), false);

  const floors = [{ grid: [[closed, sealed, stuck]] }];
  const masks = buildFireAvoidanceMasks(floors, 3, 1, 0);
  assert.equal(isEvacuationExitUsable({ floor: 0, cx: 0, cy: 0 }, floors, masks, 3), true);
  assert.equal(isEvacuationExitUsable({ floor: 0, cx: 1, cy: 0 }, floors, masks, 3), false);
  assert.equal(isEvacuationExitUsable({ floor: 0, cx: 2, cy: 0 }, floors, masks, 3), false);
});

test("a newly burning or critically smoky exit cannot report evacuation", () => {
  const cell = { walkable: true, fire: false };
  const floors = [{ grid: [[cell]] }];
  // Represents the prior snapshot before fire spread or a new FDS frame.
  const staleMask = buildFireAvoidanceMasks(floors, 1, 1, 1);
  const exit = { floor: 0, cx: 0, cy: 0 };

  assert.equal(isEvacuationExitUsable(exit, floors, staleMask, 1), true);
  assert.equal(isEvacuationExitUsable(exit, floors, staleMask, 1, () => ({ hard: true })), false);
  assert.equal(isEvacuationExitUsable(exit, floors, staleMask, 1, () => ({ blocked: true })), false);
  cell.fire = true;
  assert.equal(isEvacuationExitUsable(exit, floors, staleMask, 1), false);
});
