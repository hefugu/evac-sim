/**
 * Independent exposure integrals and configurable tenability screening.
 * This is NOT a FED, lethality or incapacitation model: HCN, O2, CO2,
 * respiratory response and occupant susceptibility are not available.
 * NIST HAZARD I separates visibility, gases and thermal exposure; see
 * https://nvlpubs.nist.gov/nistpubs/Legacy/hb/nisthandbook146v2.pdf
 * Default bands below are explicit comparison policy, not validated safety
 * limits. CO bands borrow NIOSH ceiling / IDLH concentrations (200 / 1200
 * ppm), whose occupational context does not establish fire survivability:
 * https://www.cdc.gov/niosh/idlh/630080.html
 * Thermal critical bands (120 degC, 2.5 kW/m2) borrow comparison benchmarks,
 * not absolute limits, from NIST IR 7120:
 * https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=861308
 * Equations, units and limitations: docs/exposure-model.md.
 */
export const TENABILITY_STATES = Object.freeze(["tenable", "degraded", "critical"]);

export const DEFAULT_TENABILITY_OPTIONS = Object.freeze({
  policyId: "comparison-screen-v1",
  visibilityDegradedMeters: 10,
  visibilityCriticalMeters: 5,
  extinctionDegradedM1: 0.3, // K = 3 / S, reflecting-sign approximation.
  extinctionCriticalM1: 0.6,
  coDegradedPpm: 200,
  coCriticalPpm: 1200,
  heatFluxDegradedKwM2: 1,
  heatFluxCriticalKwM2: 2.5,
  temperatureDegradedC: 60,
  temperatureCriticalC: 120,
  ambientTemperatureC: 20,
  // Finite observation window [s], not a survival deadline. Unfinished
  // trajectories are right-censored, and remain alive in compatibility UI.
  maxSimulationTimeSec: 600
});

const finite = (value, fallback = 0) => value != null && value !== "" && Number.isFinite(Number(value))
  ? Number(value) : fallback;
const positive = (value, fallback = 0) => Math.max(0, finite(value, fallback));

export function resolveTenabilityOptions(options = {}) {
  const resolved = { ...DEFAULT_TENABILITY_OPTIONS };
  Object.keys(resolved).forEach(key => {
    if (key === "policyId") {
      if (typeof options[key] === "string" && options[key]) resolved[key] = options[key];
    } else if (options[key] != null && Number.isFinite(Number(options[key]))) {
      resolved[key] = Math.max(0, Number(options[key]));
    }
  });
  // Zero or malformed observation windows must not create endless MC runs.
  if (resolved.maxSimulationTimeSec <= 0) resolved.maxSimulationTimeSec = DEFAULT_TENABILITY_OPTIONS.maxSimulationTimeSec;
  return resolved;
}

export function createAgentExposure() {
  return {
    schemaVersion: 1,
    durationSeconds: 0,
    visibilityMSeconds: 0,
    visibilityDeficitSeconds: 0,
    lowVisibilitySeconds: 0,
    coPpmMin: 0,
    heatFluxKwM2Seconds: 0,
    temperatureCSeconds: 0,
    temperatureAboveAmbientCSeconds: 0,
    extinctionM1Seconds: 0,
    smokeDensitySeconds: 0,
    tenabilitySeconds: { tenable: 0, degraded: 0, critical: 0 },
    // Future gas species can be stored here with explicit units before a
    // separately validated multigas physiological model is introduced.
    gasPpmMin: { co: 0 },
    fed: null
  };
}

export function assessTenability(hazard = {}, options = {}) {
  const config = resolveTenabilityOptions(options);
  const visibility = positive(hazard.visibilityM ?? hazard.visibilityMeters, 30);
  const extinction = positive(hazard.extinctionCoefficientM1 ?? hazard.opticalDensityM1);
  const tests = [
    ["visibility", visibility <= config.visibilityDegradedMeters, visibility <= config.visibilityCriticalMeters],
    ["extinction", extinction >= config.extinctionDegradedM1, extinction >= config.extinctionCriticalM1],
    ["co", positive(hazard.coPpm) >= config.coDegradedPpm, positive(hazard.coPpm) >= config.coCriticalPpm],
    ["heat_flux", positive(hazard.heatFluxKwM2) >= config.heatFluxDegradedKwM2, positive(hazard.heatFluxKwM2) >= config.heatFluxCriticalKwM2],
    ["temperature", finite(hazard.temperatureC, config.ambientTemperatureC) >= config.temperatureDegradedC,
      finite(hazard.temperatureC, config.ambientTemperatureC) >= config.temperatureCriticalC]
  ];
  const severity = tests.some(test => test[2]) ? 2 : (tests.some(test => test[1]) ? 1 : 0);
  return {
    tenability: TENABILITY_STATES[severity],
    reasons: tests.filter(test => test[1] || test[2]).map(test => test[0]),
    policyId: config.policyId
  };
}

/**
 * Left-rectangle time integration of the shared eye-height sample: E += x dt.
 * dt is seconds; CO uses dt / 60 to obtain ppm min. Flux is the complete
 * q'' integral [kW/m2 s], not an undocumented threshold-excess "fatal dose".
 * Temperature has both raw integral [degC s] and excess above ambient.
 * Visibility deficit = integral clamp(1 - S/S_ref, 0, 1) dt [s]. It is a
 * dimensionless impairment proxy integrated over time, not probability.
 * A constant sample integrates identically at any subdivision of dt.
 * The function cannot change dead/finished/movement, even in critical state.
 */
export function accumulateAgentExposure(agent = {}, hazard = {}, dtSeconds = 0, options = {}, timeSeconds = null) {
  const config = resolveTenabilityOptions(options);
  const dt = positive(dtSeconds);
  const previous = agent.exposure || createAgentExposure();
  const exposure = {
    ...createAgentExposure(), ...previous,
    tenabilitySeconds: { tenable: 0, degraded: 0, critical: 0, ...previous.tenabilitySeconds },
    gasPpmMin: { ...previous.gasPpmMin },
    fed: null
  };
  const visibility = positive(hazard.visibilityM ?? hazard.visibilityMeters, 30);
  const co = positive(hazard.coPpm);
  const flux = positive(hazard.heatFluxKwM2);
  const temperature = finite(hazard.temperatureC, config.ambientTemperatureC);
  const extinction = positive(hazard.extinctionCoefficientM1 ?? hazard.opticalDensityM1);
  const smoke = positive(hazard.smokeDensity ?? hazard.smoke);
  exposure.durationSeconds += dt;
  exposure.visibilityMSeconds += visibility * dt;
  exposure.visibilityDeficitSeconds += Math.max(0, Math.min(1,
    1 - visibility / Math.max(0.001, config.visibilityDegradedMeters))) * dt;
  if (visibility <= config.visibilityDegradedMeters) exposure.lowVisibilitySeconds += dt;
  exposure.coPpmMin += co * dt / 60;
  exposure.heatFluxKwM2Seconds += flux * dt;
  exposure.temperatureCSeconds += temperature * dt;
  exposure.temperatureAboveAmbientCSeconds += Math.max(0, temperature - config.ambientTemperatureC) * dt;
  exposure.extinctionM1Seconds += extinction * dt;
  exposure.smokeDensitySeconds += smoke * dt;
  exposure.gasPpmMin.co = exposure.coPpmMin;

  const screening = assessTenability(hazard, config);
  exposure.tenabilitySeconds[screening.tenability] += dt;
  const priorSeverity = TENABILITY_STATES.indexOf(agent.worstTenability || "tenable");
  const severity = TENABILITY_STATES.indexOf(screening.tenability);
  const firstCriticalTimeSec = agent.firstCriticalTimeSec ??
    (severity === 2 && dt > 0 ? finite(timeSeconds, exposure.durationSeconds - dt) : null);
  return {
    ...agent,
    exposure,
    tenability: screening.tenability,
    worstTenability: TENABILITY_STATES[Math.max(0, priorSeverity, severity)],
    tenabilityReasons: screening.reasons,
    tenabilityPolicyId: screening.policyId,
    firstCriticalTimeSec,
    // Compatibility fields only. New exports give each physical channel a
    // name with units. smokeDose and heatDose retain legacy display meaning.
    coDosePpmMin: exposure.coPpmMin,
    coDose: exposure.coPpmMin,
    heatFluxDose: exposure.heatFluxKwM2Seconds,
    temperatureDoseCSeconds: exposure.temperatureCSeconds,
    smokeDose: positive(agent.smokeDose) + Math.max(0, smoke - 0.2) ** 2 * dt,
    heatDose: positive(agent.heatDose) + (positive(hazard.legacyHeat) +
      Math.max(0, temperature - config.temperatureDegradedC) /
      Math.max(1, config.temperatureCriticalC - config.temperatureDegradedC)) * dt
  };
}

export function summarizeExposureMetrics(agents = []) {
  const tenabilityCounts = { tenable: 0, degraded: 0, critical: 0 };
  const worstTenabilityCounts = { tenable: 0, degraded: 0, critical: 0 };
  const exposureTotals = createAgentExposure();
  const scalarFields = Object.keys(exposureTotals).filter(key =>
    typeof exposureTotals[key] === "number" && key !== "schemaVersion");
  for (const agent of agents) {
    tenabilityCounts[TENABILITY_STATES.includes(agent.tenability) ? agent.tenability : "tenable"]++;
    worstTenabilityCounts[TENABILITY_STATES.includes(agent.worstTenability) ? agent.worstTenability : "tenable"]++;
    for (const field of scalarFields) exposureTotals[field] += finite(agent.exposure?.[field]);
    for (const level of TENABILITY_STATES) {
      exposureTotals.tenabilitySeconds[level] += positive(agent.exposure?.tenabilitySeconds?.[level]);
    }
  }
  exposureTotals.gasPpmMin.co = exposureTotals.coPpmMin;
  return { tenabilityCounts, worstTenabilityCounts, exposureTotals };
}

/** Observation censoring has no death/physiology implication. */
export function simulationObservationComplete(agents, timeSeconds, options = {}) {
  if (agents.every(agent => agent.finished || agent.dead || agent.removed)) return "resolved";
  return finite(timeSeconds) + 1e-9 >= resolveTenabilityOptions(options).maxSimulationTimeSec
    ? "observation_window" : null;
}
