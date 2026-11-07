import { canWalkSegment } from "../sim/js/simulation/grid-movement.js";

const finite = value => typeof value === "number" && Number.isFinite(value);
const present = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const floorOf = agent => agent.floor ?? agent.floorIndex;
const alive = agent => !agent.dead && !agent.finished;
const onFloor = agent => agent.stairTransition?.status !== "in_transit";
const horizontal = agent => alive(agent) && !agent.stairTransition;
const EXPOSURE_FIELDS = ["durationSeconds", "visibilityMSeconds", "visibilityDeficitSeconds",
  "lowVisibilitySeconds", "coPpmMin", "heatFluxKwM2Seconds", "temperatureCSeconds",
  "temperatureAboveAmbientCSeconds", "extinctionM1Seconds", "smokeDensitySeconds"];
const STATIONARY_THRESHOLD_MPS = 0.05;
const NONNEGATIVE_EXPOSURE_FIELDS = new Set(EXPOSURE_FIELDS.filter(key => key !== "temperatureCSeconds"));

/** 完了者だけの母集団標準偏差。分位点は線形補間（R-7）を用いる。 */
function distribution(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, mean: null, median: null, p90: null, p95: null,
    p99: null, std: null, min: null, max: null };
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const quantile = p => {
    const pos = (n - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  return { count: n, mean, median: quantile(0.5), p90: quantile(0.9), p95: quantile(0.95),
    p99: quantile(0.99), std: Math.sqrt(sorted.reduce((sum, t) => sum + (t - mean) ** 2, 0) / n),
    min: sorted[0], max: sorted[n - 1] };
}

function gridFor(floors, floor) {
  const entry = floors?.[floor];
  return entry?.grid ?? entry?.rows ?? (Array.isArray(entry) ? entry : null);
}

function cellKind(cell) {
  if (typeof cell === "string") return cell === "#" ? "wall" : "open";
  if (typeof cell === "boolean") return cell ? "open" : "wall";
  if (cell && typeof cell === "object") {
    if (cell.stair || cell.walkable === true) return "open";
    if (cell.wall === true || cell.walkable === false) return "wall";
  }
  return "unknown";
}

function segmentEntry(x0, y0, x1, y1, exit, half) {
  let lo = 0, hi = 1;
  for (const [start, delta, center] of [[x0, x1 - x0, exit.cx], [y0, y1 - y0, exit.cy]]) {
    if (Math.abs(delta) < 1e-12) {
      if (start < center - half || start > center + half) return null;
    } else {
      let a = (center - half - start) / delta, b = (center + half - start) / delta;
      if (a > b) [a, b] = [b, a];
      lo = Math.max(lo, a); hi = Math.min(hi, b);
      if (lo > hi) return null;
    }
  }
  return lo;
}

/** 実際の終端座標と直前の軌跡で出口を推定。選択先 targetExitIndex は使わない。 */
function attributeExit(agent, previous, exits, floors) {
  if (![agent.x, agent.y, floorOf(agent), agent.radiusM].every(finite)) {
    return { index: null, reason: "arrival_position_or_radius_missing" };
  }
  const floor = floorOf(agent), meters = floors?.[floor]?.cellSizeMeters;
  if (!finite(meters) || meters <= 0) return { index: null, reason: "floor_cell_size_missing" };
  const grid = gridFor(floors, floor);
  if (!grid) return { index: null, reason: "floor_geometry_missing" };
  const half = 0.5 + Math.max(0.22, agent.radiusM || 0.255) / Math.max(0.05, meters);
  const from = previous && floorOf(previous) === floor && finite(previous.x) && finite(previous.y)
    ? previous : agent;
  const candidates = [];
  exits.forEach((exit, index) => {
    if (exit.floor !== floor) return;
    const t = segmentEntry(from.x, from.y, agent.x, agent.y, exit, half);
    if (t === null || !canWalkSegment(agent.x, agent.y, exit.cx, exit.cy,
      (x, y) => cellKind(grid[y]?.[x]) === "open")) return;
    candidates.push({ index, t, distance: Math.hypot(agent.x - exit.cx, agent.y - exit.cy) });
  });
  if (!candidates.length) return { index: null, reason: "no_exit_matches_actual_arrival" };
  // 同一歩内に複数の領域を通過した場合は最初の交差を優先する。
  candidates.sort((a, b) => a.t - b.t || a.distance - b.distance);
  if (candidates.length > 1 && Math.abs(candidates[0].t - candidates[1].t) < 1e-9 &&
      Math.abs(candidates[0].distance - candidates[1].distance) < 1e-9) {
    return { index: null, reason: "ambiguous_overlapping_exit_capture_regions" };
  }
  return { index: candidates[0].index, reason: null };
}

/** 身体円の重なりは未校正の診断値。空間バケットで組を一度だけ調べる。 */
function bodyOverlap(agents, floors) {
  const eligible = agents.filter(a => !a.dead && !a.finished && onFloor(a));
  if (!eligible.every(a => finite(a.radiusM) && a.radiusM > 0 && finite(a.x) &&
      finite(a.y) && finite(floors?.[floorOf(a)]?.cellSizeMeters))) return null;
  const size = Math.max(0.01, ...eligible.map(a => a.radiusM * 2));
  const buckets = new Map();
  let pairs = 0, maxPenetrationM = 0;
  for (const a of eligible) {
    const floor = floorOf(a), meters = floors[floor].cellSizeMeters;
    const x = a.x * meters, y = a.y * meters;
    const bx = Math.floor(x / size), by = Math.floor(y / size);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const b of buckets.get(`${floor}:${bx + dx}:${by + dy}`) || []) {
        const penetration = a.radiusM + b.radiusM - Math.hypot(x - b.x, y - b.y);
        if (penetration > 1e-9) { pairs++; maxPenetrationM = Math.max(maxPenetrationM, penetration); }
      }
    }
    const key = `${floor}:${bx}:${by}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ x, y, radiusM: a.radiusM });
  }
  return { pairs, maxPenetrationM };
}

/**
 * production状態のスナップショットを集計する。欠測は null と理由を保持する。
 * samplesは時刻0から各物理stepの状態。区間左端保持で速度・待機を積分する。
 * 時間分布は完了者のみ。未完了者に観測上限を避難時間として代入しない。
 * 壁検査は中心点と隣接sample間の直線に限定。身体半径の壁接触・step内の曲線軌跡は範囲外。
 * 階段容量はsample.stairCongestionのinTransit/capacityから検査。FIFOは入退場履歴が必要で未測定。
 */
export function summarizeRun({ initialAgents = [], agents = [], simTime, requestedPopulation,
  exits = [], floors = [], stairCongestion, summary, samples, performance } = {}) {
  const unavailableReasons = {};
  const missing = (key, reason) => { unavailableReasons[key] = reason; return null; };
  const violationMap = new Map();
  const violate = (code, example) => {
    if (!violationMap.has(code)) violationMap.set(code, { code, occurrences: 0, examples: [] });
    const v = violationMap.get(code); v.occurrences++;
    if (v.examples.length < 5) v.examples.push(example);
  };
  const requested = Number.isInteger(requestedPopulation) && requestedPopulation >= 0
    ? requestedPopulation : missing("population.requested", "requested_population_not_supplied");
  if (requested !== null && requested !== initialAgents.length) {
    violate("requested_population_mismatch", { requested, initial: initialAgents.length });
  }
  const expectedIds = new Set(initialAgents.map(a => a.id));
  if (expectedIds.size !== initialAgents.length) violate("duplicate_initial_agent_ids", {});
  const completed = agents.filter(a => a.finished && !a.dead);
  const dead = agents.filter(a => a.dead);
  const unresolved = agents.filter(alive);
  const times = completed.map(a => finite(a.finishTime) && finite(a.startTime)
    ? a.finishTime - a.startTime : null).filter(t => finite(t) && t >= 0);
  const completedOnlyTimeSec = distribution(times);
  if (times.length !== completed.length) {
    missing("completedOnlyTimeSec", "some_completed_agents_lack_valid_start_or_finish_time");
    violate("invalid_completed_time", { completed: completed.length, validTimes: times.length });
  }
  if (!times.length) missing("completedOnlyTimeSec", "no_completed_time_observations");
  const allCompleted = requested !== null && requested > 0 && initialAgents.length === requested &&
    agents.length === requested && completed.length === requested && times.length === requested;
  const startTimes = initialAgents.map(a => a.startTime);
  const validStartTimes = startTimes.length > 0 && startTimes.every(finite);
  const completionTimeSec = allCompleted && validStartTimes
    ? Math.max(...completed.map(a => a.finishTime)) - Math.min(...startTimes)
    : missing("completionTimeSec", allCompleted ? "initial_start_times_missing" : "not_every_requested_agent_completed");
  const initialPotentials = initialAgents.map(a => present(a, "initialPotential0") ? a.initialPotential0 : a.potential0);
  const initialUnreachableCount = initialPotentials.length && initialPotentials.every(p => typeof p === "number")
    ? initialPotentials.filter(p => !Number.isFinite(p)).length
    : missing("initialUnreachableCount", "initial_potential_not_available_for_all_agents");

  const rawSamples = Array.isArray(samples) ? samples : [];
  const validSamples = rawSamples.filter(s => finite(s?.time) && Array.isArray(s.agents));
  if (validSamples.length !== rawSamples.length) violate("invalid_sample", { invalidCount: rawSamples.length - validSamples.length });
  if (!finite(simTime) || simTime < 0) violate("invalid_simulation_time", { simTime });
  for (const s of validSamples) if (s.time < 0 || (finite(simTime) && s.time > simTime + 1e-7)) {
    violate("sample_outside_observation_window", { time: s.time, simTime });
  }
  for (let i = 1; i < validSamples.length; i++) {
    if (validSamples[i].time <= validSamples[i - 1].time) {
      violate("non_increasing_sample_time", { before: validSamples[i - 1].time, after: validSamples[i].time });
    }
  }
  const samplesUsable = validSamples.length >= 2 && validSamples.every((s, i) => i === 0 || s.time > validSamples[i - 1].time);
  const sampled = samplesUsable ? validSamples : [];
  const previousAtCompletion = new Map();
  for (let i = 1; i < sampled.length; i++) {
    const before = new Map(sampled[i - 1].agents.map(a => [a.id, a]));
    for (const a of sampled[i].agents) if (a.finished && !before.get(a.id)?.finished) {
      previousAtCompletion.set(a.id, before.get(a.id));
    }
  }
  const checkSnapshot = (list, time, phase) => {
    const ids = new Set();
    for (const a of list) {
      if (a.id == null) violate("missing_agent_id", { time, phase });
      if (ids.has(a.id)) violate("duplicate_agent_id", { id: a.id, time, phase });
      ids.add(a.id);
      if (!expectedIds.has(a.id)) violate("unexpected_agent_id", { id: a.id, time, phase });
      for (const key of ["x", "y", "vxMps", "vyMps"]) {
        if (!finite(a[key])) violate("non_finite_agent_state", { id: a.id, field: key, time, phase });
      }
      for (const key of ["radiusM", "startTime", "finishTime", "deathTime"]) {
        if (a[key] != null && !finite(a[key])) violate("non_finite_agent_state", { id: a.id, field: key, time, phase });
      }
      for (const [field, value] of Object.entries(flatten(a.exposure || {}))) {
        if (typeof value === "number" && !finite(value)) violate("non_finite_exposure", { id: a.id, field, time, phase });
        if (finite(value) && value < 0 && (NONNEGATIVE_EXPOSURE_FIELDS.has(field) ||
            field.startsWith("gasPpmMin.") || field.startsWith("tenabilitySeconds."))) {
          violate("negative_exposure_integral", { id: a.id, field, value, time, phase });
        }
      }
      if (a.finished && a.dead) violate("contradictory_terminal_state", { id: a.id, time, phase });
      const floor = floorOf(a), grid = gridFor(floors, floor);
      if (!Number.isInteger(floor) || floor < 0 || (floors.length && floor >= floors.length)) {
        violate("invalid_floor", { id: a.id, floor, time, phase });
      }
      if (!a.dead && onFloor(a) && grid && finite(a.x) && finite(a.y)) {
        const x = Math.round(a.x), y = Math.round(a.y);
        if (y < 0 || y >= grid.length || x < 0 || x >= (grid[y]?.length || 0)) {
          violate("center_outside_floor", { id: a.id, x, y, floor, time, phase });
        } else if (cellKind(grid[y][x]) === "wall") {
          violate("center_in_wall", { id: a.id, x, y, floor, time, phase });
        }
      }
    }
    if (ids.size !== expectedIds.size || [...expectedIds].some(id => !ids.has(id))) {
      violate("agent_population_not_conserved", { time, phase, expected: expectedIds.size, actual: ids.size });
    }
  };
  checkSnapshot(initialAgents, 0, "initial");
  sampled.forEach(s => checkSnapshot(s.agents, s.time, "sample"));
  checkSnapshot(agents, simTime, "final");
  let checkedSegments = 0, skippedSegments = 0;
  for (let i = 1; i < sampled.length; i++) {
    const before = new Map(sampled[i - 1].agents.map(a => [a.id, a]));
    for (const a of sampled[i].agents) {
      const b = before.get(a.id), floor = floorOf(a), grid = gridFor(floors, floor);
      if (!b || floorOf(b) !== floor || !onFloor(a) || !onFloor(b)) continue;
      if (!grid || ![a.x, a.y, b.x, b.y].every(finite)) { skippedSegments++; continue; }
      let unknownGeometry = false;
      const traversable = (x, y) => {
        const cell = grid[y]?.[x];
        if (cell === undefined) return false;
        const kind = cellKind(cell);
        if (kind === "unknown") unknownGeometry = true;
        return kind === "open";
      };
      const clear = canWalkSegment(b.x, b.y, a.x, a.y, traversable);
      if (unknownGeometry) { skippedSegments++; continue; }
      checkedSegments++;
      if (!clear) violate("segment_crosses_wall", { id: a.id, floor,
        from: { x: b.x, y: b.y, time: sampled[i - 1].time },
        to: { x: a.x, y: a.y, time: sampled[i].time } });
    }
  }
  let stairCapacitySamples = 0, stairCapacityLinksChecked = 0, stairCapacityLinksMissing = 0;
  for (const s of sampled) if (Array.isArray(s.stairCongestion)) {
    stairCapacitySamples++;
    for (const link of s.stairCongestion) {
      if (!finite(link.inTransit) || !finite(link.capacity) || link.inTransit < 0 || link.capacity < 0) {
        stairCapacityLinksMissing++;
        if (typeof link.inTransit === "number" && !finite(link.inTransit) ||
            typeof link.capacity === "number" && !finite(link.capacity)) {
          violate("non_finite_stair_capacity_state", { linkId: link.id ?? link.stairId, time: s.time });
        }
        continue;
      }
      stairCapacityLinksChecked++;
      if (link.inTransit > link.capacity) violate("stair_capacity_exceeded", {
        linkId: link.id ?? link.stairId, time: s.time, inTransit: link.inTransit, capacity: link.capacity
      });
    }
  }
  if (!floors.length || floors.some((_, i) => !gridFor(floors, i))) {
    missing("invariants.geometry", "some_floor_geometry_missing");
  }

  const binWidthSec = 10;
  const binCount = finite(simTime) && simTime >= 0 ? Math.max(1, Math.ceil(simTime / binWidthSec)) : null;
  const usage = exits.map((exit, exitIndex) => ({ exitIndex, ...exit, completed: 0, attributedCompleted: 0,
    flowBins: binCount === null ? null : Array.from({ length: binCount }, (_, i) => ({
      startSec: i * binWidthSec, endSec: Math.min((i + 1) * binWidthSec, simTime),
      count: 0, attributedCount: 0, personsPerSecond: null
    })) }));
  const totalFlowBins = binCount === null ? null : Array.from({ length: binCount }, (_, i) => ({
    startSec: i * binWidthSec, endSec: Math.min((i + 1) * binWidthSec, simTime),
    count: 0, observedCount: 0, personsPerSecond: null
  }));
  const hasMissingFinishTimes = completed.some(a => !finite(a.finishTime) || a.finishTime < 0 || a.finishTime > simTime);
  for (const a of completed) if (totalFlowBins && finite(a.finishTime) && a.finishTime >= 0 && a.finishTime <= simTime) {
    totalFlowBins[Math.min(totalFlowBins.length - 1, Math.floor(a.finishTime / binWidthSec))].observedCount++;
  }
  for (const bin of totalFlowBins || []) {
    bin.count = hasMissingFinishTimes ? null : bin.observedCount;
    bin.personsPerSecond = bin.count !== null && bin.endSec > bin.startSec
      ? bin.count / (bin.endSec - bin.startSec) : null;
  }
  if (hasMissingFinishTimes) missing("exits.totalFlowBins", "some_completed_agents_lack_finish_time_within_observation");
  const unassigned = [];
  for (const agent of completed) {
    const attributed = attributeExit(agent, previousAtCompletion.get(agent.id), exits, floors);
    if (attributed.index === null) { unassigned.push({ agentId: agent.id, reason: attributed.reason }); continue; }
    const exit = usage[attributed.index]; exit.completed++; exit.attributedCompleted++;
    if (exit.flowBins && finite(agent.finishTime) && agent.finishTime >= 0 && agent.finishTime <= simTime) {
      const bin = Math.min(exit.flowBins.length - 1, Math.floor(agent.finishTime / binWidthSec));
      exit.flowBins[bin].count++; exit.flowBins[bin].attributedCount++;
    } else {
      exit.flowTimingMissing = true;
      missing("exits.flowBins", "some_attributed_agents_lack_finish_time_within_observation");
    }
  }
  for (const exit of usage) for (const bin of exit.flowBins || []) {
    if (unassigned.length || exit.flowTimingMissing) bin.count = null;
    bin.personsPerSecond = bin.count !== null && bin.endSec > bin.startSec
      ? bin.count / (bin.endSec - bin.startSec) : null;
  }
  if (unassigned.length) usage.forEach(exit => { exit.completed = null; });
  if (unassigned.length) missing("exits.usage", "some_completed_agents_cannot_be_attributed_to_actual_exit");

  let weightedSpeed = 0, horizontalSeconds = 0, movingWeighted = 0, movingSeconds = 0;
  let velocityMissingSeconds = 0, queueSeconds = 0, queueUnassignedLinkPersonSeconds = 0;
  const dwellByAgent = new Map(), queueByAgent = new Map(), queueByLink = new Map();
  for (let i = 0; i < sampled.length - 1; i++) {
    const dt = sampled[i + 1].time - sampled[i].time;
    for (const a of sampled[i].agents) {
      if (alive(a) && a.stairTransition?.status === "queued") {
        queueSeconds += dt;
        queueByAgent.set(a.id, (queueByAgent.get(a.id) || 0) + dt);
        const link = a.stairTransition.linkId;
        if (link != null) queueByLink.set(link, (queueByLink.get(link) || 0) + dt);
        else queueUnassignedLinkPersonSeconds += dt;
      }
      if (!horizontal(a)) continue;
      if (!finite(a.vxMps) || !finite(a.vyMps)) { velocityMissingSeconds += dt; continue; }
      const speed = Math.hypot(a.vxMps, a.vyMps);
      horizontalSeconds += dt; weightedSpeed += speed * dt;
      if (speed <= STATIONARY_THRESHOLD_MPS) dwellByAgent.set(a.id, (dwellByAgent.get(a.id) || 0) + dt);
      else { movingSeconds += dt; movingWeighted += speed * dt; }
    }
  }
  const samplingReason = samplesUsable ? null : "at_least_two_monotonic_physics_samples_required";
  const observedStart = sampled[0]?.time ?? null;
  const observedEnd = sampled.at(-1)?.time ?? null;
  const samplingComplete = samplesUsable && observedStart === 0 && finite(simTime) && Math.abs(observedEnd - simTime) < 1e-7;
  if (samplesUsable && !samplingComplete) missing("sampleCoverage", "sample_intervals_do_not_cover_whole_run");
  if (!samplesUsable || skippedSegments) missing("invariants.segmentWallCrossing", !samplesUsable
    ? "adjacent_physics_samples_required" : "some_segments_lack_positions_or_known_geometry");
  if (stairCapacitySamples !== sampled.length || !sampled.length || stairCapacityLinksMissing) {
    missing("invariants.stairCapacity", "stair_congestion_with_finite_inTransit_and_capacity_required_at_each_sample");
  }
  missing("invariants.fifo", "stair_enqueue_start_and_completion_event_history_not_supplied");
  const walkingSpeedMps = {
    mean: !samplesUsable || !horizontalSeconds || velocityMissingSeconds > 0
      ? missing("walkingSpeedMps.mean", samplingReason || (velocityMissingSeconds > 0 ? "velocity_samples_missing" : "no_horizontal_active_time"))
      : weightedSpeed / horizontalSeconds,
    movingOnlyMean: movingSeconds && !velocityMissingSeconds ? movingWeighted / movingSeconds
      : missing("walkingSpeedMps.movingOnlyMean", samplingReason || (velocityMissingSeconds ? "velocity_samples_missing" : "no_time_above_stationary_threshold")),
    observedPersonSeconds: samplesUsable ? horizontalSeconds : null,
    missingVelocityPersonSeconds: samplesUsable ? velocityMissingSeconds : null,
    definition: "time-weighted horizontal speed of alive unfinished agents without stair transition; pre-movement and stationary time included",
    integration: "left_endpoint_piecewise_constant"
  };
  const stationaryDwellSec = {
    thresholdMps: STATIONARY_THRESHOLD_MPS,
    comparison: "speed <= threshold",
    totalPersonSeconds: samplesUsable && !velocityMissingSeconds
      ? [...dwellByAgent.values()].reduce((a, b) => a + b, 0)
      : missing("stationaryDwellSec.totalPersonSeconds", samplingReason || "velocity_samples_missing"),
    byAgent: samplesUsable && !velocityMissingSeconds
      ? initialAgents.map(a => ({ agentId: a.id, seconds: dwellByAgent.get(a.id) || 0 })) : null,
    definition: "alive unfinished on-floor agents without stair transition; includes pre-movement"
  };
  const congestion = Array.isArray(stairCongestion) ? stairCongestion : null;
  const transitionCounts = agents.map(a => a.stairTransitionCount);
  const totalTransitions = transitionCounts.every(v => finite(v) && v >= 0)
    ? transitionCounts.reduce((a, b) => a + b, 0)
    : congestion && congestion.every(s => finite(s.completed))
      ? congestion.reduce((sum, s) => sum + s.completed, 0)
      : missing("stairs.completedTransitions", "completed_stair_counts_not_supplied");
  const stairs = { completedTransitions: totalTransitions,
    byLink: congestion ? congestion.map(s => ({ linkId: s.id ?? s.stairId,
      completed: finite(s.completed) ? s.completed : null,
      maxQueue: finite(s.maxQueue) ? s.maxQueue : null,
      queueWaitPersonSeconds: samplesUsable && !queueUnassignedLinkPersonSeconds
        ? queueByLink.get(s.id ?? s.stairId) || 0 : null }))
      : missing("stairs.byLink", "stair_congestion_not_supplied"),
    queueWaitSec: { totalPersonSeconds: samplesUsable ? queueSeconds : missing("stairs.queueWaitSec", samplingReason),
      unassignedLinkPersonSeconds: samplesUsable ? queueUnassignedLinkPersonSeconds : null,
      byAgent: samplesUsable ? initialAgents.map(a => ({ agentId: a.id, seconds: queueByAgent.get(a.id) || 0 })) : null,
      integration: "left_endpoint_piecewise_constant_of_stairTransition.status_queued" }
  };
  if (queueUnassignedLinkPersonSeconds) missing("stairs.byLink.queueWaitPersonSeconds", "some_queued_samples_lack_link_id");
  const exposureTotals = {};
  for (const key of EXPOSURE_FIELDS) {
    exposureTotals[key] = agents.length && agents.every(a => finite(a.exposure?.[key]))
      ? agents.reduce((sum, a) => sum + a.exposure[key], 0)
      : finite(summary?.exposureTotals?.[key]) ? summary.exposureTotals[key]
        : missing(`exposureTotals.${key}`, "agent_exposure_and_summary_total_missing");
  }
  exposureTotals.fed = missing("exposureTotals.fed", "physiological_fed_model_not_available");
  const initialOverlap = bodyOverlap(initialAgents, floors), finalOverlap = bodyOverlap(agents, floors);
  let maxSamplePairs = null, maxSamplePenetrationM = null;
  for (const s of sampled) {
    const overlap = bodyOverlap(s.agents, floors);
    if (!overlap) continue;
    maxSamplePairs = Math.max(maxSamplePairs ?? 0, overlap.pairs);
    maxSamplePenetrationM = Math.max(maxSamplePenetrationM ?? 0, overlap.maxPenetrationM);
  }
  if (initialOverlap === null || finalOverlap === null) missing("invariants.diagnostics.bodyOverlap", "positions_radii_or_floor_scale_missing");
  const violations = [...violationMap.values()];
  return {
    schemaVersion: 1,
    population: { requested, initial: initialAgents.length, final: agents.length,
      completed: completed.length, dead: dead.length, unresolved: unresolved.length,
      censored: unresolved.length, completionRate: requested > 0 ? completed.length / requested
        : missing("population.completionRate", "positive_requested_population_required") },
    observationTimeSec: finite(simTime) ? simTime : missing("observationTimeSec", "finite_simulation_time_required"),
    completionTimeSec, completedOnlyTimeSec,
    terminationReason: typeof summary?.completionReason === "string" ? summary.completionReason
      : allCompleted ? "all_completed" : missing("terminationReason", "driver_or_production_completion_reason_required"),
    initialUnreachableCount,
    exits: { attribution: "actual_terminal_position_and_preceding_sample_segment; production_capture_extent; no_target_exit_selection",
      binWidthSec, totalFlowBins, usage, unassignedCompleted: unassigned.length, unassigned },
    stairs, walkingSpeedMps, stationaryDwellSec, exposureTotals,
    sampleCoverage: { startSec: observedStart, endSec: observedEnd, sampleCount: sampled.length,
      suppliedSampleCount: rawSamples.length, complete: samplingComplete },
    invariants: { passed: violations.length === 0,
      geometryChecked: floors.length > 0 && floors.every((_, i) => !!gridFor(floors, i)), violations,
      validationCoverage: {
        sampleStateChecks: sampled.length,
        segmentWallCrossing: { checkedSegments, skippedSegments,
          complete: samplingComplete && skippedSegments === 0, path: "straight_line_between_adjacent_physics_samples" },
        stairCapacity: { checkedSamples: stairCapacitySamples, checkedLinks: stairCapacityLinksChecked,
          linksWithMissingFields: stairCapacityLinksMissing,
          complete: samplingComplete && stairCapacitySamples === sampled.length && stairCapacityLinksMissing === 0 },
        fifo: { status: "unmeasured", reason: "enqueue_start_and_completion_event_history_required" },
        bodyRadiusWallContact: { status: "out_of_scope", reason: "center_point_and_center_segment_only" },
        curvedPathSweep: { status: "out_of_scope", reason: "within_step_curved_trajectory_not_available" }
      },
      diagnostics: { bodyOverlap: { calibrated: false, hardFailure: false,
        initial: initialOverlap, final: finalOverlap, maxSamplePairs, maxSamplePenetrationM,
        definition: "same-floor alive unfinished body-circle overlap; initial overlap reported separately" } } },
    performance: performance ?? missing("performance", "cpu_performance_measurements_not_supplied"),
    unavailableReasons
  };
}

function flatten(value, prefix = "", result = {}) {
  for (const [key, child] of Object.entries(value || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) flatten(child, path, result);
    else result[path] = child;
  }
  return result;
}

/** ネストした指標を列に展開し、配列はJSONで保持するRFC4180互換CSV。 */
export function toCsv(rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  const flat = rows.map(row => flatten(row));
  const columns = [...new Set(flat.flatMap(row => Object.keys(row)))];
  const quote = value => {
    const str = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };
  return [columns.map(quote).join(","), ...flat.map(row => columns.map(key => quote(row[key])).join(","))].join("\r\n") + "\r\n";
}

/** 数値差は記述統計に限定する。未校正の許容幅や合否を自動で作らない。 */
export function compareRuns(baseline, current) {
  const before = flatten(baseline), after = flatten(current);
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields.filter(key => finite(before[key]) || finite(after[key])).map(metric => ({ metric,
    baseline: finite(before[metric]) ? before[metric] : null,
    current: finite(after[metric]) ? after[metric] : null,
    delta: finite(before[metric]) && finite(after[metric]) ? after[metric] - before[metric] : null,
    relativeChange: finite(before[metric]) && finite(after[metric]) && before[metric] !== 0
      ? (after[metric] - before[metric]) / Math.abs(before[metric]) : null
  }));
}
