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
import { transferLegacySmokeThroughStairs } from "../sim/js/simulation/smoke3d.js";
import {
  deriveAgentBehaviorState,
  chooseClearAirStep,
  normalizeAgent3D
} from "../sim/js/simulation/agents3d-sync.js";
import { extractScitech3FGridFromImageData } from "../sim/js/scitech3f-map3d.js";
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

test("3F image extraction keeps the main white/green component and drops text", () => {
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
  paintCell(0, 1, [255, 255, 255]);
  paintCell(1, 1, [255, 255, 255]);
  paintCell(2, 1, [0, 255, 0]);
  paintCell(5, 0, [255, 255, 255]); // isolated label
  const parsed = extractScitech3FGridFromImageData({ data }, width, height, { cellPixels: 2 });
  assert.equal(parsed.walkableCells, 3);
  assert.equal(parsed.stairCells, 1);
  assert.equal(parsed.walkableTemplate[0][5], false);
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
  assert.equal(target.agents[0].id, 7);
  assert.equal(target.sim.time, 12);
});

