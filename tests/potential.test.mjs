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


test("potential field can reject forward moves that approach fire", () => {
  const grid = [[cell(true), cell(true), cell(true)]];
  const floorStates = [{ grid }];
  const ctx = {
    grid,
    floorStates,
    floorCount: 1,
    gridW: 3,
    gridH: 1,
    currentFloor: 0,
    isAgentTraversableCell(floor, cx, cy) {
      return !!floorStates[floor]?.grid?.[cy]?.[cx]?.walkable;
    },
    getLinkedStairDestinations() {
      return [];
    },
    // Forward moves to the right are "toward fire" and therefore forbidden.
    canTraverseEdge(_fromFloor, fromCx, _fromCy, _toFloor, toCx) {
      return toCx <= fromCx;
    }
  };

  const potential = computePotentialFieldFromSeedsModule(
    [{ floor: 0, cx: 2, cy: 0 }],
    ctx
  );

  assert.equal(potential[0][0][2], 0);
  assert.equal(potential[0][0][1], Infinity);
  assert.equal(potential[0][0][0], Infinity);
});

test("mixed floor route distances use physical length and a shared stair cost", () => {
  const floorStates = [0.5, 1].map(cellSizeMeters => ({ cellSizeMeters,
    grid: [[cell(), cell(), { ...cell(), stair: true }]] }));
  const field = computePotentialFieldFromSeedsModule([{ floor: 0, cx: 0, cy: 0 }], {
    grid: floorStates[0].grid, floorStates, floorCount: 2, gridW: 3, gridH: 1, currentFloor: 1,
    isAgentTraversableCell: (floor, x, y) => !!floorStates[floor]?.grid?.[y]?.[x]?.walkable,
    getLinkedStairDestinations: floor => [{ floor: 1 - floor, cx: 2, cy: 0, travelCostSec: 2 }],
    horizontalCost: floor => floorStates[floor].cellSizeMeters / 0.5,
    stairCost: () => 4.8
  });
  assert.equal(field[0][0][2], 2);
  assert.equal(field[1][0][2], 6.8);
  assert.equal(field[1][0][0], 10.8);
});
