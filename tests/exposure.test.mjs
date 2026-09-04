import test from "node:test";
import assert from "node:assert/strict";

import {
  accumulateAgentExposure,
  assessTenability,
  createAgentExposure,
  simulationObservationComplete,
  summarizeExposureMetrics
} from "../sim/js/simulation/exposure.js";
import { applyAgentHazardExposure } from "../sim/js/simulation/agents3d-sync.js";
import { buildCsvReport } from "../sim/js/export/csv.js";

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test("exposure channels accumulate independently with documented units", () => {
  const result = accumulateAgentExposure({ exposure: createAgentExposure() }, {
    visibilityM: 4,
    coPpm: 600,
    heatFluxKwM2: 3,
    temperatureC: 80,
    opticalDensityM1: 0.75,
    smokeDensity: 0.4
  }, 30, {}, 10);
  close(result.exposure.visibilityMSeconds, 120);
  close(result.exposure.visibilityDeficitSeconds, 18);
  close(result.exposure.coPpmMin, 300);
  close(result.exposure.heatFluxKwM2Seconds, 90);
  close(result.exposure.temperatureCSeconds, 2400);
  close(result.exposure.temperatureAboveAmbientCSeconds, 1800);
  close(result.exposure.extinctionM1Seconds, 22.5);
  close(result.exposure.smokeDensitySeconds, 12);
  assert.equal(result.exposure.fed, null);
  assert.equal(result.tenability, "critical");
  assert.equal(result.worstTenability, "critical");
  assert.deepEqual(result.tenabilityReasons, ["visibility", "extinction", "co", "heat_flux", "temperature"]);
  assert.equal(result.firstCriticalTimeSec, 10);
  assert.equal(result.dead, undefined, "critical screening must not cause death");
});

test("tenability bands remain independent and critical is reversible", () => {
  const degraded = accumulateAgentExposure({}, { visibilityM: 8 }, 1, {}, 0);
  assert.deepEqual(assessTenability({ coPpm: 201 }).tenability, "degraded");
  const critical = accumulateAgentExposure(degraded, { coPpm: 1200 }, 1, {}, 1);
  const recovered = accumulateAgentExposure(critical, {
    visibilityM: 30, coPpm: 0, heatFluxKwM2: 0, temperatureC: 20
  }, 1, {}, 2);
  assert.equal(recovered.tenability, "tenable");
  assert.equal(recovered.worstTenability, "critical");
  assert.equal(recovered.exposure.tenabilitySeconds.degraded, 1);
  assert.equal(recovered.exposure.tenabilitySeconds.critical, 1);
  assert.equal(recovered.exposure.tenabilitySeconds.tenable, 1);
});

test("constant exposure is invariant to timestep subdivision", () => {
  const hazard = {
    visibilityM: 7, coPpm: 350, heatFluxKwM2: 1.7,
    temperatureC: 72, extinctionCoefficientM1: 0.41, smokeDensity: 0.3
  };
  const integrate = dt => {
    let agent = {};
    for (let time = 0; time < 10 - 1e-12; time += dt) {
      agent = accumulateAgentExposure(agent, hazard, dt, {}, time);
    }
    return agent;
  };
  const coarse = integrate(0.1).exposure;
  const fine = integrate(0.05).exposure;
  for (const field of [
    "durationSeconds", "visibilityMSeconds", "visibilityDeficitSeconds", "coPpmMin",
    "heatFluxKwM2Seconds", "temperatureCSeconds", "temperatureAboveAmbientCSeconds",
    "extinctionM1Seconds", "smokeDensitySeconds"
  ]) close(coarse[field], fine[field], 1e-8);
});

test("summaries expose current and worst tenability separately", () => {
  const metrics = summarizeExposureMetrics([
    accumulateAgentExposure({}, { visibilityM: 3 }, 2),
    accumulateAgentExposure({}, { visibilityM: 8 }, 3),
    accumulateAgentExposure({}, { visibilityM: 30 }, 4)
  ]);
  assert.deepEqual(metrics.tenabilityCounts, { tenable: 1, degraded: 1, critical: 1 });
  assert.deepEqual(metrics.worstTenabilityCounts, { tenable: 1, degraded: 1, critical: 1 });
  assert.equal(metrics.exposureTotals.durationSeconds, 9);
});

test("observation cutoff censors unfinished agents without mutating them", () => {
  const agents = [{ finished: false, dead: false }];
  assert.equal(simulationObservationComplete(agents, 4.9, { maxSimulationTimeSec: 5 }), null);
  assert.equal(simulationObservationComplete(agents, 5, { maxSimulationTimeSec: 5 }), "observation_window");
  assert.deepEqual(agents, [{ finished: false, dead: false }]);
  assert.equal(simulationObservationComplete([{ finished: true }], 1, { maxSimulationTimeSec: 5 }), "resolved");
});

test("custom policy is explicit and does not convert screening to FED", () => {
  const assessment = assessTenability({ temperatureC: 51 }, {
    policyId: "sensitivity-low-temp",
    temperatureDegradedC: 50,
    temperatureCriticalC: 55
  });
  assert.equal(assessment.tenability, "degraded");
  assert.equal(assessment.policyId, "sensitivity-low-temp");
  assert.equal(createAgentExposure().fed, null);
});

test("3D compatibility exposure uses the same independent channels", () => {
  const hazard = { smokeDensity: 0.2, coPpm: 100, heatFluxKwM2: 2, temperatureC: 75, visibilityMeters: 8 };
  const direct = accumulateAgentExposure({}, hazard, 3);
  const wrapper = applyAgentHazardExposure({}, hazard, 3);
  assert.deepEqual(wrapper.exposure, direct.exposure);
  assert.equal(wrapper.tenability, direct.tenability);
});

test("CSV research columns contain physical exposure units and censoring", () => {
  const agent = accumulateAgentExposure({ id: 1 }, { coPpm: 600, heatFluxKwM2: 3 }, 30);
  const metrics = summarizeExposureMetrics([agent]);
  const csv = buildCsvReport({
    lastSummary: {
      agents: 1, evacuated: 0, dead: 0, avgTime: 0, maxTime: 0,
      ...metrics, censored: 1, unresolved: 1, completionReason: "observation_window"
    },
    agents: [agent], allExitPoints: [], TYPE_META: {},
    congestionHistory: [], bottleneckReport: [], paramHistory: []
  });
  assert.match(csv, /summary,censored,1/);
  assert.match(csv, /summary,full_fed_available,0/);
  const lines = csv.split("\n");
  const header = lines.find(line => line.startsWith("section,id,type")).split(",");
  const record = lines.find(line => line.startsWith("agent,")).split(",");
  assert.equal(header.length, record.length);
  assert.equal(record[header.indexOf("co_exposure_ppm_min")], "300.0000");
  assert.equal(record[header.indexOf("heat_flux_exposure_kw_m2_s")], "90.0000");
  assert.equal(record[header.indexOf("worst_tenability")], "critical");
});
