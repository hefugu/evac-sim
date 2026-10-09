import test from "node:test";
import assert from "node:assert/strict";
import { FIRE_GROWTH_RATES, tSquaredFireHrrKw, stepLegacyFireSpreadInPlace } from "../sim/js/simulation/fire3d.js";
import { buildCsvReport } from "../sim/js/export/csv.js";

test("prescribed slow, medium, fast and ultrafast fires follow alpha t squared and their HRR cap", () => {
  for (const alphaKwPerSec2 of Object.values(FIRE_GROWTH_RATES)) {
    assert.equal(tSquaredFireHrrKw(10, { alphaKwPerSec2, maxHrrKw: 500 }), alphaKwPerSec2 * 100);
    assert.equal(tSquaredFireHrrKw(10000, { alphaKwPerSec2, maxHrrKw: 500 }), 500);
    assert.equal(tSquaredFireHrrKw(-1, { alphaKwPerSec2 }), 0);
  }
  assert.equal(tSquaredFireHrrKw(10), 1.172);
});

test("selected fire growth reaches the live source and preserves imported eye-height values", () => {
  const source = { walkable: true, fire: true, fireIntensity: 0.05, fireAgeSec: 0 };
  const floors = [{ floorIndex: 0, grid: [[source]], smokeMap: [[0]], cellSizeMeters: 0.5 }];
  const result = stepLegacyFireSpreadInPlace(floors, 10, {
    alphaKwPerSec2: FIRE_GROWTH_RATES.ultrafast, maxHrrKw: 10,
    activeIndicesByFloor: [[0]], timeSec: 10,
    fdsLookup: () => ({ sample_height_m: 1.6, temperatureC: 75, heatFluxKwM2: 0.2 })
  });
  assert.equal(result.totalHrrKw, 10);
  assert.equal(source.hrrKw, 10);
  assert.equal(source.temperatureC, 75);
  assert.equal(source.heatFluxKwM2, 0.2);
  assert.equal(source.fireDataSource, "fds_csv");
});

test("the CSV records prescribed fire growth and maximum HRR for reproducibility", () => {
  const report = buildCsvReport({ lastSummary: {
    agents: 0, evacuated: 0, dead: 0, avgTime: 0, maxTime: 0,
    fireModel: { alphaKwPerSec2: FIRE_GROWTH_RATES.fast, maxHrrKw: 1200 }
  }, congestionHistory: [], bottleneckReport: [], currentFloor: 0,
  agents: [], allExitPoints: [], TYPE_META: {}, paramHistory: [] });
  assert.match(report, /summary,fire_growth_alpha_kw_s2,0.04690/);
  assert.match(report, /summary,fire_max_hrr_kw,1200.000/);
});
