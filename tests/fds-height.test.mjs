import test from "node:test";
import assert from "node:assert/strict";
import { parseFdsRiskCsv, eyeHeightFdsFrame, sampleFdsAtHeight } from "../sim/js/simulation/fds-csv.js";
import { createDynamicSnapshot3D, createGeometrySnapshot3D, apply3DBridgeMessage } from "../sim/js/state-bridge3d.js";
import { stepSmoke3D, smokeConservationBalance } from "../sim/js/simulation/smoke3d.js";
import { smokeVisualizationSample } from "../sim/js/renderer3d.js";

test("legacy FDS CSV assumes 1.6 m explicitly and retains sparse fields", () => {
  const parsed = parseFdsRiskCsv("time_s,floor,cx,cy,co_ppm,temperature_c\n0,1,0,0,100,\n1,1,0,0,,80");
  assert.equal(parsed.assumedHeightRows, 2);
  assert.match(parsed.warnings.join(" "), /1.6m/);
  const sample = eyeHeightFdsFrame(parsed.frames[1]).cells.get("0:0:0");
  assert.equal(sample.sampleHeightMeters, 1.6);
  assert.equal(sample.coPpm, 100);
  assert.equal(sample.temperatureC, 80);
  assert.equal(sample.heatFluxKwM2, undefined);
});

test("FDS sample_height_m keeps heights separate and interpolates only bracketed fields", () => {
  const parsed = parseFdsRiskCsv("time_s,floor,cx,cy,sample_height_m,co_ppm,temperature_c\n0,1,0,0,1.2,100,\n0,1,0,0,2.0,300,80");
  assert.equal(parsed.frames[0].cells.size, 2);
  assert.equal(parsed.assumedHeightRows, 0);
  const sample = eyeHeightFdsFrame(parsed.frames[0]).cells.get("0:0:0");
  assert.ok(Math.abs(sample.coPpm - 200) < 1e-10);
  assert.equal(sample.temperatureC, undefined); // no unsubstantiated extrapolation
  assert.deepEqual(sample.interpolatedFields, ["coPpm"]);
  assert.equal(sampleFdsAtHeight([...parsed.frames[0].cells.values()], 0.8), null);
});

test("partial FDS rows at the same time/height and explicit zero are retained", () => {
  const parsed = parseFdsRiskCsv("time_s,floor,cx,cy,sample_height_m,co_ppm,temperature_c\n0,1,0,0,1.6,100,\n0,1,0,0,1.6,,80\n1,1,0,0,1.6,0,");
  const before = eyeHeightFdsFrame(parsed.frames[0]).cells.get("0:0:0");
  const after = eyeHeightFdsFrame(parsed.frames[1]).cells.get("0:0:0");
  assert.equal(before.coPpm, 100);
  assert.equal(before.temperatureC, 80);
  assert.equal(after.coPpm, 0);
  assert.equal(after.temperatureC, 80);
  assert.throws(() => parseFdsRiskCsv("time_s,floor,cx,cy,sample_height_m,co_ppm\n0,1,0,0,-1,10"), /sample_height_m/);
});

test("FDS eye observations do not overwrite the upper layer or conserved soot/CO", () => {
  const floors = [{ floorIndex: 0, cellSizeMeters: 1, wallHeightMeters: 3,
    grid: [[{ walkable: true, fire: true, hrrKw: 100 }]], smokeMap: [[0]] }];
  const baseline = stepSmoke3D(floors, [], 0.1).floors;
  const upper = baseline[0].grid[0][0];
  const overlaid = stepSmoke3D(baseline, [], 0, { fdsLookup: () => ({ sample_height_m: 1.6, co_ppm: 700,
    extinction_coefficient_m_1: 2, visibility_m: 1.5 }) }).floors;
  const cell = overlaid[0].grid[0][0];
  assert.equal(cell.eyeLevelCoPpm, 700);
  assert.equal(cell.upperLayerCoPpm, upper.upperLayerCoPpm);
  assert.equal(cell.upperLayerExtinctionCoefficientM1, upper.upperLayerExtinctionCoefficientM1);
  assert.equal(cell.upperLayerVisibilityMeters, upper.upperLayerVisibilityMeters);
  assert.equal(smokeConservationBalance(overlaid).soot.remaining, smokeConservationBalance(baseline).soot.remaining);
  const removed = stepSmoke3D(overlaid, [], 0).floors[0].grid[0][0];
  assert.equal(removed.eyeLevelCoPpm, upper.eyeLevelCoPpm);
  assert.equal(removed.smokeDataSource, "reduced_order_nist");
  const highOnly = stepSmoke3D(baseline, [], 0, { fdsLookup: () => ({ sample_height_m: 2.7, co_ppm: 5000 }) }).floors[0].grid[0][0];
  assert.equal(highOnly.eyeLevelCoPpm, upper.eyeLevelCoPpm);
  assert.equal(highOnly.upperLayerCoPpm, upper.upperLayerCoPpm);
});

test("3D bridge carries physical layer and FDS samples without advancing simulation", () => {
  const cell = { walkable: true, smokeDensity: 1, smokeLayerDepthMeters: 0.8,
    smokeLayerInterfaceHeightMeters: 2, upperLayerExtinctionCoefficientM1: 0.7,
    upperLayerCoPpm: 150, upperLayerTemperatureC: 90, eyeLevelCoPpm: 12,
    fdsSamples: [{ sampleHeightMeters: 1.6, coPpm: 12 }] };
  const source = { map: { floorStates: [{ floorIndex: 0, grid: [[cell]], smokeMap: [[1]], wallHeightMeters: 2.8 }] },
    agents: [{ id: 1, tenability: "degraded", exposure: { coPpmMin: 4 } }], sim: { time: 3 } };
  const viewer = {};
  apply3DBridgeMessage(viewer, createGeometrySnapshot3D(source));
  apply3DBridgeMessage(viewer, createDynamicSnapshot3D(source));
  const rendered = viewer.map.floorStates[0].grid[0][0];
  assert.equal(rendered.smokeLayerInterfaceHeightMeters, 2);
  assert.equal(rendered.smokeLayerDepthMeters, 0.8);
  assert.equal(rendered.upperLayerCoPpm, 150);
  assert.equal(rendered.eyeLevelCoPpm, 12);
  assert.equal(rendered.upperLayerTemperatureC, 90);
  assert.equal(viewer.agents[0].tenability, "degraded");
  assert.equal(source.sim.time, 3);
  source.map.floorStates[0].grid = [[{ walkable: true }]];
  source.map.floorStates[0].smokeMap = [[0]];
  apply3DBridgeMessage(viewer, createDynamicSnapshot3D(source));
  assert.equal(rendered.smokeLayerDepthMeters, undefined);
  assert.equal(rendered.fdsSamples, undefined);
});

test("FDS-only observations cannot become a fictitious full layer across the 3D bridge", () => {
  const source = { map: { floorStates: [{ floorIndex: 0, wallHeightMeters: 2.8,
    smokeMap: [[0]], grid: [[{ walkable: true, smokeLayerDepthMeters: 0,
      smokeLayerInterfaceHeightMeters: null, upperLayerExtinctionCoefficientM1: 0,
      fdsSamples: [{ sampleHeightMeters: 2.6, coPpm: 100 }] }]] }] } };
  const target = {};
  apply3DBridgeMessage(target, createGeometrySnapshot3D(source));
  apply3DBridgeMessage(target, createDynamicSnapshot3D(source));
  const sample = smokeVisualizationSample(target.map.floorStates[0].grid[0][0], 2.8);
  assert.equal(sample.layer, null);
  assert.equal(sample.density, 0);
  assert.equal(sample.pointSamples[0].sampleHeightMeters, 2.6);
});
