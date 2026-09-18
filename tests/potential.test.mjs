import test from "node:test";
import assert from "node:assert/strict";
import { computePotentialFieldFromSeedsModule } from "../sim/js/simulation/potential.js";

function cell(walkable = true) {
  return { walkable, wall: !walkable, fire: false, stair: false };
}

test("potential field cannot cut diagonally through blocked corners", () => {
  const grid = [
    [cell(true), cell(false)],
    [cell(false), cell(true)]
  ];
  const floorStates = [{ grid }];
  const ctx = {
    grid,
    floorStates,
    floorCount: 1,
    gridW: 2,
    gridH: 2,
    currentFloor: 0,
    isAgentTraversableCell(floor, cx, cy) {
      return !!floorStates[floor]?.grid?.[cy]?.[cx]?.walkable;
    },
    getLinkedStairDestinations() {
      return [];
    }
  };

  const potential = computePotentialFieldFromSeedsModule(
    [{ floor: 0, cx: 0, cy: 0 }],
    ctx
  );

  assert.equal(potential[0][1][1], Infinity);
});
