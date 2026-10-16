import test from "node:test";
import assert from "node:assert/strict";
import { buildScenario, listScenarios } from "./scenarios.mjs";
import { parseFdsRiskCsv, eyeHeightFdsFrame } from "../sim/js/simulation/fds-csv.js";

const STANDARD_POPULATIONS = [100, 400, 1000];
const key = (floor, cx, cy) => `${floor}:${cx}:${cy}`;
const walkable = (scenario, floor, cx, cy) => scenario.floors[floor]?.rows[cy]?.[cx] === ".";

/** The fixture geometry is tested independently of the production route finder. */
function reachableFromExits(scenario, useStairs = true, blocked = new Set()) {
  const queue = [];
  const reached = new Set();
  const add = (floor, cx, cy) => {
    const address = key(floor, cx, cy);
    if (walkable(scenario, floor, cx, cy) && !blocked.has(address) && !reached.has(address)) {
      reached.add(address);
      queue.push({ floor, cx, cy });
    }
  };
  scenario.floors.forEach((f, floor) => f.exits.forEach(p => add(floor, p.cx, p.cy)));
  const transfers = new Map();
  if (useStairs) for (const { a, b } of scenario.stairLinks) {
    transfers.set(key(a.floor, a.cx, a.cy), b);
    transfers.set(key(b.floor, b.cx, b.cy), a);
  }
  for (let i = 0; i < queue.length; i++) {
    const { floor, cx, cy } = queue[i];
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) add(floor, cx + dx, cy + dy);
    const destination = transfers.get(key(floor, cx, cy));
    if (destination) add(destination.floor, destination.cx, destination.cy);
  }
  return reached;
}

function countUnreachableCandidates(scenario, reached) {
  return scenario.floors.reduce((sum, f, floor) => sum + f.spawns.filter(p =>
    !reached.has(key(floor, p.cx, p.cy))).length, 0);
}

test("the catalog contains the twelve required Japanese standard scenarios", () => {
  const catalog = listScenarios();
  assert.deepEqual(catalog.map(scenario => scenario.id), Array.from({ length: 12 }, (_, i) =>
    `B${String(i + 1).padStart(2, "0")}`));
  assert.deepEqual(catalog.map(scenario => scenario.name), [
    "直線廊下", "狭い出口", "曲がり角", "複数出口", "複数階段", "火災・煙",
    "到達不能領域", "大規模建物", "双方向階段", "FDS連携", "高密度群衆", "複数階避難"
  ]);
  catalog[0].name = "mutated";
  assert.equal(buildScenario("B01").name, "直線廊下");
  assert.throws(() => buildScenario("B99"), RangeError);
  for (const population of [0, -1, 0.5, 1001, NaN, "100"]) {
    assert.throws(() => buildScenario("B01", population), RangeError);
  }
});

for (const { id } of listScenarios()) {
  for (const population of STANDARD_POPULATIONS) {
    test(`${id}/${population}: legal geometry, placements, declared area and supported density`, () => {
      const scenario = buildScenario(id, population);
      assert.equal(scenario.schemaVersion, 1);
      assert.equal(scenario.population, population);
      assert.equal(scenario.cellSizeMeters, 0.5);
      assert.equal(scenario.observationTimeSec, 60);
      assert.equal(scenario.seed, null);
      assert.equal(scenario.settings.startRule, "simultaneous");
      assert.equal(scenario.settings.agentPreset, "default");
      assert.ok(scenario.invariants.length > 0);
      assert.ok(scenario.metrics.includes("remainingCount"));
      assert.equal(JSON.parse(JSON.stringify(scenario)).population, population);
      let walkableCells = 0;
      let candidateCount = 0;
      let exits = 0;
      const stairMarkers = new Set();

      scenario.floors.forEach((f, floor) => {
        assert.ok(f.rows.length <= 60, `${id}: avoid huge map heights for large populations`);
        assert.ok(f.rows[0].length <= 100, `${id}: avoid huge map widths for large populations`);
        assert.ok(f.rows.length > 2 && f.rows[0].length > 2);
        for (const row of f.rows) {
          assert.equal(row.length, f.rows[0].length);
          assert.match(row, /^[#.]+$/);
          assert.equal(row[0], "#");
          assert.equal(row.at(-1), "#");
          walkableCells += [...row].filter(cell => cell === ".").length;
        }
        assert.match(f.rows[0], /^#+$/);
        assert.match(f.rows.at(-1), /^#+$/);
        for (const kind of ["exits", "spawns", "fires", "stairs"]) {
          const unique = new Set();
          for (const p of f[kind]) {
            assert.ok(Number.isInteger(p.cx) && Number.isInteger(p.cy));
            assert.ok(walkable(scenario, floor, p.cx, p.cy), `${id}/${floor}/${kind}: marker on wall`);
            assert.ok(!unique.has(key(floor, p.cx, p.cy)), `${id}: duplicate candidate or marker`);
            unique.add(key(floor, p.cx, p.cy));
            if (kind === "stairs") stairMarkers.add(key(floor, p.cx, p.cy));
          }
        }
        const special = new Set([...f.exits, ...f.fires, ...f.stairs].map(p => key(floor, p.cx, p.cy)));
        assert.ok(f.spawns.every(p => !special.has(key(floor, p.cx, p.cy))));
        candidateCount += f.spawns.length;
        exits += f.exits.length;
      });

      assert.ok(exits > 0 && candidateCount > 0);
      const usedStairs = new Set();
      const links = new Set();
      for (const { a, b, travelCostSec, congestionCapacity } of scenario.stairLinks) {
        assert.notEqual(a.floor, b.floor);
        assert.ok(travelCostSec > 0 && Number.isFinite(travelCostSec));
        assert.ok(Number.isInteger(congestionCapacity) && congestionCapacity > 0);
        for (const p of [a, b]) {
          assert.ok(walkable(scenario, p.floor, p.cx, p.cy));
          assert.ok(stairMarkers.has(key(p.floor, p.cx, p.cy)));
          usedStairs.add(key(p.floor, p.cx, p.cy));
        }
        const hash = [key(a.floor, a.cx, a.cy), key(b.floor, b.cx, b.cy)].sort().join("|");
        assert.ok(!links.has(hash));
        links.add(hash);
      }
      assert.deepEqual(usedStairs, stairMarkers, `${id}: no unconnected or invented stair marker`);
      assert.equal(scenario.geometry.walkableCells, walkableCells);
      assert.equal(scenario.geometry.walkableAreaM2, walkableCells * 0.25);
      assert.equal(scenario.geometry.nominalDensityPeoplePerM2, population / (walkableCells * 0.25));
      assert.equal(scenario.initialPlacement.candidateCount, candidateCount);
      assert.equal(scenario.initialPlacement.supportAreaM2, candidateCount * 0.25);
      assert.equal(scenario.initialPlacement.sampling, "with-replacement");
      assert.match(scenario.initialPlacement.note, /固定実配置ではない/);
      assert.match(scenario.initialPlacement.note, /同一点/);
      assert.deepEqual(scenario.initialPlacement.floorCandidateCounts, scenario.floors.map(f => f.spawns.length));
      assert.equal(scenario.initialPlacement.nominalSupportDensityPeoplePerM2, population / (candidateCount * 0.25));
      if (id === "B11") {
        assert.ok(scenario.initialPlacement.nominalSupportDensityPeoplePerM2 >= 3.5);
        assert.ok(scenario.initialPlacement.nominalSupportDensityPeoplePerM2 <= 4);
        assert.match(scenario.notes.join(" "), /明示的例外/);
      } else {
        assert.ok(scenario.geometry.nominalDensityPeoplePerM2 <= 2, `${id}: building over capacity`);
        assert.ok(scenario.initialPlacement.nominalSupportDensityPeoplePerM2 <= 2, `${id}: spawn support over capacity`);
      }
      const unreachable = countUnreachableCandidates(scenario, reachableFromExits(scenario));
      if (id === "B07") assert.ok(unreachable > 0 && unreachable < candidateCount);
      else assert.equal(unreachable, 0, `${id}: an unintended isolated spawn support region`);
    });
  }
}

test("normal-scenario geometry and candidate support stay fixed across standard populations", () => {
  for (const { id } of listScenarios()) {
    if (id === "B11") continue;
    assert.deepEqual(buildScenario(id, 100).floors, buildScenario(id, 1000).floors);
    assert.deepEqual(buildScenario(id, 100).stairLinks, buildScenario(id, 1000).stairLinks);
  }
  const original = buildScenario("B05");
  original.floors[1].spawns[0].cx = -1;
  original.stairLinks[0].a.floor = 99;
  const fresh = buildScenario("B05");
  assert.ok(fresh.floors[1].spawns[0].cx >= 0);
  assert.equal(fresh.stairLinks[0].a.floor, 0);
});

test("B02 has a real 1 m bottleneck separating spawn support from its exit", () => {
  const scenario = buildScenario("B02", 1000);
  const blocked = new Set([key(0, 70, 28), key(0, 70, 29)]);
  assert.ok(scenario.floors[0].spawns.every(p => p.cx < 70));
  assert.ok(scenario.floors[0].exits.every(p => p.cx > 70));
  assert.equal(countUnreachableCandidates(scenario, reachableFromExits(scenario, true, blocked)),
    scenario.initialPlacement.candidateCount);
});

test("B07 keeps candidates in both the reachable and genuinely closed component", () => {
  const scenario = buildScenario("B07", 1000);
  const reachable = reachableFromExits(scenario);
  const f = scenario.floors[0];
  assert.ok(f.spawns.some(p => reachable.has(key(0, p.cx, p.cy))));
  const unreachable = f.spawns.filter(p => !reachable.has(key(0, p.cx, p.cy)));
  assert.ok(unreachable.every(p => p.cx > 48));
  assert.equal(unreachable.length * 2, f.spawns.length);
  assert.ok(f.rows.every(row => row[48] === "#"));
});

test("B05 and B12 require the declared floor transitions to reach an exit", () => {
  for (const id of ["B05", "B12"]) {
    const scenario = buildScenario(id, 400);
    assert.equal(countUnreachableCandidates(scenario, reachableFromExits(scenario, false)),
      scenario.initialPlacement.candidateCount);
    assert.equal(countUnreachableCandidates(scenario, reachableFromExits(scenario)), 0);
  }
  const threeFloor = buildScenario("B12");
  assert.equal(threeFloor.floors.length, 3);
  assert.ok(threeFloor.floors[2].spawns.length > 0);
  assert.ok(threeFloor.floors.slice(0, 2).every(f => f.spawns.length === 0));
  assert.deepEqual(threeFloor.stairLinks.map(({ a, b }) => [a.floor, b.floor]), [[0, 1], [1, 2]]);
});

test("B09 allows both directions but declares that actual opposing traffic needs observation", () => {
  const scenario = buildScenario("B09");
  assert.equal(scenario.floors.length, 2);
  assert.equal(scenario.stairLinks.length, 1);
  assert.ok(scenario.floors.every(f => f.exits.length > 0 && f.spawns.length > 0));
  assert.ok(scenario.metrics.includes("stairPassagesByDirection"));
  assert.ok(scenario.metrics.includes("bidirectionalTrafficObserved"));
  assert.match(scenario.notes.join(" "), /双方向通過は強制できない/);
  assert.match(scenario.invariants.join(" "), /coverage未達/);
});

test("B10 exercises production FDS parsing with heights, timestamps, explicit zero and sparse hold", () => {
  const scenario = buildScenario("B10");
  const parsed = parseFdsRiskCsv(scenario.fdsCsv, "B10-synthetic.csv");
  assert.deepEqual(parsed.times, [0, 10, 20, 30]);
  assert.equal(parsed.assumedHeightRows, 0);
  for (const frame of parsed.frames) {
    for (const record of frame.cells.values()) {
      assert.ok(walkable(scenario, record.floor, record.cx, record.cy));
    }
  }
  const at10 = eyeHeightFdsFrame(parsed.frames[1]).cells.get("0:48:29");
  assert.equal(at10.sampleHeightMeters, 1.6);
  assert.ok(Math.abs(at10.coPpm - 200) < 1e-10);
  assert.ok(Math.abs(at10.heatFluxKwM2 - 2) < 1e-10);
  assert.ok(Math.abs(at10.opticalDensityM1 - 0.2) < 1e-10);
  assert.ok(Math.abs(at10.visibilityM - 17.5) < 1e-10);
  assert.ok(Math.abs(at10.temperatureC - 50) < 1e-10);
  const at20 = eyeHeightFdsFrame(parsed.frames[2]).cells.get("0:48:29");
  assert.equal(at20.coPpm, 0);
  assert.equal(at20.heatFluxKwM2, 0);
  assert.equal(at20.opticalDensityM1, 0);
  const sparse = eyeHeightFdsFrame(parsed.frames[3]).cells.get("0:49:29");
  assert.equal(sparse.coPpm, 0);
  assert.equal(sparse.heatFluxKwM2, 2);
  assert.equal(sparse.visibilityM, 15);
  assert.equal(scenario.floors[0].fires.length, 0);
  assert.match(scenario.notes.join(" "), /人工データ/);
});
