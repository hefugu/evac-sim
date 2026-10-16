import test from "node:test";
import assert from "node:assert/strict";
import { summarizeRun, toCsv, compareRuns } from "./metrics.mjs";
import { createAgentExposure } from "../sim/js/simulation/exposure.js";

const floors = [{ cellSizeMeters: 0.5, rows: ["############", "#..........#", "#..........#", "############"] }];
const exits = [{ floor: 0, cx: 9, cy: 1 }, { floor: 0, cx: 2, cy: 2 }];
const agent = (id, props = {}) => ({ id, floor: 0, x: 5, y: 1, vxMps: 1, vyMps: 0,
  radiusM: 0.25, startTime: 0, finishTime: null, potential0: 4, finished: false,
  dead: false, stairTransition: null, stairTransitionCount: 0, exposure: createAgentExposure(), ...props });
const run = overrides => {
  const initialAgents = [agent(0)];
  return summarizeRun({ initialAgents, agents: initialAgents, simTime: 20, requestedPopulation: 1,
    floors, exits, summary: { completionReason: "observation_window" }, stairCongestion: [], ...overrides });
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("completed-only percentiles do not impute censored completion times", () => {
  const initialAgents = Array.from({ length: 5 }, (_, id) => agent(id));
  const agents = initialAgents.map((a, i) => i < 4
    ? { ...a, finished: true, finishTime: (i + 1) * 2, x: 9 } : a);
  const metrics = run({ initialAgents, agents, requestedPopulation: 5 });
  assert.equal(metrics.population.completed, 4);
  assert.equal(metrics.population.censored, 1);
  assert.equal(metrics.population.completionRate, 0.8);
  assert.equal(metrics.completionTimeSec, null);
  assert.equal(metrics.terminationReason, "observation_window");
  const d = metrics.completedOnlyTimeSec;
  assert.equal(d.count, 4); assert.equal(d.mean, 5); assert.equal(d.median, 5);
  near(d.p90, 7.4); near(d.p95, 7.7); near(d.p99, 7.94); near(d.std, Math.sqrt(5));
  assert.equal(d.min, 2); assert.equal(d.max, 8);
});

test("total completion time exists only after every requested person succeeds", () => {
  const initialAgents = [agent(0, { startTime: 3 }), agent(1, { startTime: 3 })];
  const agents = initialAgents.map((a, i) => ({ ...a, x: 9, finished: true, finishTime: i ? 13 : 9 }));
  assert.equal(run({ initialAgents, agents, requestedPopulation: 2 }).completionTimeSec, 10);
  assert.equal(run({ initialAgents, agents, requestedPopulation: 3 }).completionTimeSec, null);
  const dead = [{ ...agents[0] }, { ...agents[1], finished: false, dead: true }];
  const result = run({ initialAgents, agents: dead, requestedPopulation: 2 });
  assert.equal(result.completionTimeSec, null);
  assert.equal(result.population.censored, 0);
  assert.equal(result.population.dead, 1);
});

test("no completions and missing fields stay null with reasons", () => {
  const a = agent(0); delete a.potential0; delete a.exposure; delete a.stairTransitionCount;
  const metrics = run({ initialAgents: [a], agents: [a] });
  assert.equal(metrics.completedOnlyTimeSec.mean, null);
  assert.equal(metrics.initialUnreachableCount, null);
  assert.equal(metrics.exposureTotals.coPpmMin, null);
  assert.equal(metrics.walkingSpeedMps.mean, null);
  assert.equal(metrics.stationaryDwellSec.totalPersonSeconds, null);
  assert.equal(metrics.stairs.queueWaitSec.totalPersonSeconds, null);
  assert.equal(metrics.stairs.completedTransitions, 0); // 明示的な空の階段集計から取得。
  assert.equal(metrics.performance, null);
  assert.ok(metrics.unavailableReasons["exposureTotals.coPpmMin"]);
  assert.ok(metrics.unavailableReasons["walkingSpeedMps.mean"]);
  assert.equal(run({ initialAgents: [a], agents: [a], stairCongestion: undefined }).stairs.completedTransitions, null);
});

test("initial reachability uses original potential, preserving nonfinite observations", () => {
  const initialAgents = [agent(0, { potential0: Infinity }), agent(1, { initialPotential0: NaN }), agent(2)];
  const result = run({ initialAgents, agents: initialAgents, requestedPopulation: 3 });
  assert.equal(result.initialUnreachableCount, 2);
  assert.equal(result.invariants.violations.some(v => v.code === "non_finite_agent_state"), false);
});

test("exit counts and ten-second flows use physical arrivals rather than selected targets", () => {
  const initialAgents = [agent(0), agent(1)];
  const agents = [agent(0, { x: 9, y: 1, finished: true, finishTime: 4, targetExitIndex: 1 }),
    agent(1, { x: 2, y: 2, finished: true, finishTime: 14, targetExitIndex: 0 })];
  const result = run({ initialAgents, agents, requestedPopulation: 2 });
  assert.deepEqual(result.exits.usage.map(e => e.completed), [1, 1]);
  assert.deepEqual(result.exits.usage.map(e => e.flowBins.map(b => b.count)), [[1, 0], [0, 1]]);
  assert.deepEqual(result.exits.totalFlowBins.map(b => b.count), [1, 1]);
  near(result.exits.usage[0].flowBins[0].personsPerSecond, 0.1);
});

test("swept crossing attributes an exit when terminal point overshoots capture", () => {
  const a0 = agent(0, { x: 5 });
  const a1 = agent(0, { x: 10.3, finished: true, finishTime: 1 });
  const result = run({ initialAgents: [a0], agents: [a1], simTime: 1,
    samples: [{ time: 0, agents: [a0] }, { time: 1, agents: [a1] }] });
  assert.equal(result.exits.usage[0].completed, 1);
  assert.equal(result.exits.unassignedCompleted, 0);
});

test("ambiguous or unobservable exit use remains null, with observed lower bounds", () => {
  const a = agent(0, { x: 5, finished: true, finishTime: 2, targetExitIndex: 0 });
  const result = run({ agents: [a] });
  assert.equal(result.exits.unassignedCompleted, 1);
  assert.equal(result.exits.usage[0].completed, null);
  assert.equal(result.exits.usage[0].attributedCompleted, 0);
  assert.equal(result.exits.usage[0].flowBins[0].count, null);
  assert.equal(result.exits.usage[0].flowBins[0].attributedCount, 0);
  assert.equal(result.exits.totalFlowBins[0].count, 1); // 出口未特定でも完了時刻は観測済み。
  const duplicate = run({ agents: [agent(0, { x: 9, finished: true, finishTime: 2 })], exits: [exits[0], exits[0]] });
  assert.equal(duplicate.exits.unassigned[0].reason, "ambiguous_overlapping_exit_capture_regions");
});

test("per-floor metres and blocked segments are respected during exit attribution", () => {
  const mixed = [{ cellSizeMeters: 0.5, rows: ["......"] }, { cellSizeMeters: 1, rows: ["......"] }];
  const initialAgents = [agent(0, { floor: 1, x: 1, y: 0 })];
  const a = agent(0, { floor: 1, x: 2, y: 0, finished: true, finishTime: 2 });
  const result = run({ initialAgents, agents: [a], floors: mixed, exits: [{ floor: 1, cx: 3, cy: 0 }] });
  assert.equal(result.exits.unassignedCompleted, 1); // 半幅0.75 cell。0.5m階の1cell幅を流用しない。
  const wall = run({ agents: [agent(0, { x: 2, y: 0, finished: true, finishTime: 2 })],
    floors: [{ cellSizeMeters: 0.1, rows: ["..#..."] }], exits: [{ floor: 0, cx: 3, cy: 0 }] });
  assert.equal(wall.exits.unassignedCompleted, 1);
});

test("nonuniform sample durations weight speed, stationary dwell and queued stair time", () => {
  const a0 = agent(0, { vxMps: 0 }), b0 = agent(1, { vxMps: 0,
    stairTransition: { status: "queued", linkId: "stair-A" } });
  const a1 = agent(0, { vxMps: 2 }), b1 = agent(1, { vxMps: 0,
    stairTransition: { status: "in_transit", linkId: "stair-A" } });
  const a4 = agent(0, { vxMps: 2 }), b4 = agent(1, { stairTransitionCount: 1 });
  const result = run({ initialAgents: [a0, b0], agents: [a4, b4], requestedPopulation: 2, simTime: 4,
    samples: [{ time: 0, agents: [a0, b0] }, { time: 1, agents: [a1, b1] }, { time: 4, agents: [a4, b4] }],
    stairCongestion: [{ id: "stair-A", completed: 1, maxQueue: 1 }] });
  near(result.walkingSpeedMps.mean, 1.5);
  near(result.walkingSpeedMps.movingOnlyMean, 2);
  assert.equal(result.walkingSpeedMps.observedPersonSeconds, 4);
  assert.equal(result.stationaryDwellSec.totalPersonSeconds, 1);
  assert.equal(result.stationaryDwellSec.thresholdMps, 0.05);
  assert.equal(result.stairs.completedTransitions, 1);
  assert.equal(result.stairs.queueWaitSec.totalPersonSeconds, 1);
  assert.equal(result.stairs.byLink[0].queueWaitPersonSeconds, 1);
  assert.equal(result.sampleCoverage.complete, true);
});

test("missing velocity samples cannot fabricate zero dwell or speed", () => {
  const first = agent(0); delete first.vxMps;
  const result = run({ initialAgents: [first], samples: [{ time: 0, agents: [first] }, { time: 20, agents: [agent(0)] }] });
  assert.equal(result.walkingSpeedMps.mean, null);
  assert.equal(result.walkingSpeedMps.movingOnlyMean, null);
  assert.equal(result.stationaryDwellSec.totalPersonSeconds, null);
  assert.equal(result.stationaryDwellSec.byAgent, null);
});

test("sample order and observation coverage failures remain visible", () => {
  const a = agent(0);
  const unordered = run({ samples: [{ time: 0, agents: [a] }, { time: 0, agents: [a] }] });
  assert.equal(unordered.walkingSpeedMps.mean, null);
  assert.ok(unordered.invariants.violations.some(v => v.code === "non_increasing_sample_time"));
  const partial = run({ samples: [{ time: 1, agents: [a] }, { time: 3, agents: [a] }] });
  assert.equal(partial.sampleCoverage.complete, false);
  assert.equal(partial.walkingSpeedMps.observedPersonSeconds, 2);
  assert.equal(partial.unavailableReasons.sampleCoverage, "sample_intervals_do_not_cover_whole_run");
  const invalidTime = run({ simTime: NaN });
  assert.ok(invalidTime.invariants.violations.some(v => v.code === "invalid_simulation_time"));
});

test("exposure sums retain units and unsupported FED remains unavailable", () => {
  const a = agent(0), b = agent(1);
  a.exposure.coPpmMin = 5; b.exposure.coPpmMin = 3;
  a.exposure.heatFluxKwM2Seconds = 10; b.exposure.heatFluxKwM2Seconds = 2;
  const result = run({ initialAgents: [a, b], agents: [a, b], requestedPopulation: 2 });
  assert.equal(result.exposureTotals.coPpmMin, 8);
  assert.equal(result.exposureTotals.heatFluxKwM2Seconds, 12);
  assert.equal(result.exposureTotals.durationSeconds, 0);
  assert.equal(result.exposureTotals.fed, null);
});

test("population loss, NaN, wall intrusion and invalid floor become explicit violations", () => {
  const initialAgents = [agent(0), agent(1), agent(2)];
  const agents = [agent(0, { x: NaN }), agent(1, { x: 0, y: 0 }), agent(7, { floor: 3 })];
  const result = run({ initialAgents, agents, requestedPopulation: 4 });
  const codes = result.invariants.violations.map(v => v.code);
  for (const code of ["requested_population_mismatch", "agent_population_not_conserved", "non_finite_agent_state",
    "center_in_wall", "invalid_floor", "unexpected_agent_id"]) assert.ok(codes.includes(code), code);
  assert.equal(result.invariants.passed, false);
});

test("body overlap remains a diagnostic, separate from initial placement overlap", () => {
  const initialAgents = [agent(0, { x: 5 }), agent(1, { x: 5 })];
  const agents = [agent(0, { x: 4 }), agent(1, { x: 7 })];
  const result = run({ initialAgents, agents, requestedPopulation: 2 });
  const overlap = result.invariants.diagnostics.bodyOverlap;
  assert.equal(overlap.initial.pairs, 1); near(overlap.initial.maxPenetrationM, 0.5);
  assert.equal(overlap.final.pairs, 0);
  assert.equal(overlap.hardFailure, false);
  assert.equal(result.invariants.passed, true);
});

test("adjacent samples detect wall tunnelling despite both centers ending on open cells", () => {
  const initial = agent(0, { x: 1, y: 0 }), final = agent(0, { x: 3, y: 0 });
  const result = run({ initialAgents: [initial], agents: [final], simTime: 1,
    floors: [{ cellSizeMeters: 0.5, rows: ["..#.."] }],
    samples: [{ time: 0, agents: [initial] }, { time: 1, agents: [final] }] });
  assert.ok(result.invariants.violations.some(v => v.code === "segment_crosses_wall"));
  assert.ok(!result.invariants.violations.some(v => v.code === "center_in_wall"));
  assert.equal(result.invariants.validationCoverage.segmentWallCrossing.checkedSegments, 1);
  assert.equal(result.invariants.validationCoverage.segmentWallCrossing.complete, true);
});

test("diagonal corner cutting fails the production segment rule while stair transit is excluded", () => {
  const initial = agent(0, { x: 0, y: 0 }), final = agent(0, { x: 1, y: 1 });
  const args = { initialAgents: [initial], agents: [final], simTime: 1,
    floors: [{ cellSizeMeters: 0.5, rows: [".#", "#."] }],
    samples: [{ time: 0, agents: [initial] }, { time: 1, agents: [final] }] };
  assert.ok(run(args).invariants.violations.some(v => v.code === "segment_crosses_wall"));
  args.samples[0].agents = [{ ...initial, stairTransition: { status: "in_transit" } }];
  const transit = run(args);
  assert.ok(!transit.invariants.violations.some(v => v.code === "segment_crosses_wall"));
  assert.equal(transit.invariants.validationCoverage.segmentWallCrossing.checkedSegments, 0);
});

test("sampled stair capacity is checked and FIFO remains explicitly unmeasured", () => {
  const a = agent(0);
  const result = run({ simTime: 1, samples: [
    { time: 0, agents: [a], stairCongestion: [{ id: "A", inTransit: 2, capacity: 2 }] },
    { time: 1, agents: [a], stairCongestion: [{ id: "A", inTransit: 3, capacity: 2 }] }
  ] });
  assert.ok(result.invariants.violations.some(v => v.code === "stair_capacity_exceeded"));
  assert.equal(result.invariants.validationCoverage.stairCapacity.checkedLinks, 2);
  assert.equal(result.invariants.validationCoverage.stairCapacity.complete, true);
  assert.equal(result.invariants.validationCoverage.fifo.status, "unmeasured");
  assert.ok(result.unavailableReasons["invariants.fifo"]);
  assert.equal(result.invariants.validationCoverage.bodyRadiusWallContact.status, "out_of_scope");
  const unobserved = run({ simTime: 1, samples: [{ time: 0, agents: [a] }, { time: 1, agents: [a] }] });
  assert.equal(unobserved.invariants.validationCoverage.stairCapacity.complete, false);
});

test("negative cumulative doses fail without treating Celsius temperature integrals as nonnegative", () => {
  const a = agent(0);
  a.exposure.coPpmMin = -2;
  a.exposure.temperatureCSeconds = -5;
  a.exposure.gasPpmMin.co = NaN;
  const result = run({ initialAgents: [a], agents: [a] });
  const negatives = result.invariants.violations.filter(v => v.code === "negative_exposure_integral");
  assert.equal(negatives.length, 1);
  assert.equal(negatives[0].examples[0].field, "coPpmMin");
  assert.ok(result.invariants.violations.some(v => v.code === "non_finite_exposure"));
});

test("CSV preserves commas, quotes, newlines, nulls and structured array fields", () => {
  const csv = toCsv([{ name: 'a,"b"\nc', value: null, nested: { speed: 1 }, items: [{ a: 2 }] }]);
  assert.ok(csv.startsWith("name,value,nested.speed,items\r\n"));
  assert.ok(csv.includes('"a,""b""\nc",,1,"[{""a"":2}]"'));
  assert.equal(toCsv([]), "");
});

test("comparison reports numeric deltas without assigning uncalibrated pass thresholds", () => {
  const changes = compareRuns({ time: 10, ratio: 0, nested: { missing: null } }, { time: 8, ratio: 2, nested: { missing: 1 } });
  assert.deepEqual(changes.find(c => c.metric === "time"), { metric: "time", baseline: 10, current: 8, delta: -2, relativeChange: -0.2 });
  assert.equal(changes.find(c => c.metric === "ratio").relativeChange, null);
  assert.equal(changes.find(c => c.metric === "nested.missing").delta, null);
});
