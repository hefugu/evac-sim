export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function buildCsvReport(context) {
  const {
    lastSummary,
    congestionHistory,
    bottleneckReport,
    currentFloor,
    agents,
    allExitPoints,
    TYPE_META,
    paramHistory
  } = context;

  if (!lastSummary) {
    return null;
  }

  const lines = [];
  lines.push("section,key,value");
  lines.push(`summary,agents,${lastSummary.agents}`);
  lines.push(`summary,evacuated,${lastSummary.evacuated}`);
  lines.push(`summary,dead,${lastSummary.dead}`);
  lines.push(`summary,unresolved,${lastSummary.unresolved || 0}`);
  lines.push(`summary,censored,${lastSummary.censored || 0}`);
  lines.push(`summary,completion_reason,${csvEscape(lastSummary.completionReason || "")}`);
  lines.push(`summary,observation_time_s,${Number(lastSummary.observationTimeSec || 0).toFixed(3)}`);
  lines.push(`summary,evacuation_time_sample_count,${lastSummary.evacuationTimeSampleCount || 0}`);
  lines.push("summary,full_fed_available,0");
  lines.push(`summary,tenability_policy_id,${csvEscape(lastSummary.tenabilityOptions?.policyId || "")}`);
  ["tenable", "degraded", "critical"].forEach(level => {
    lines.push(`summary,current_${level},${lastSummary.tenabilityCounts?.[level] || 0}`);
    lines.push(`summary,worst_${level},${lastSummary.worstTenabilityCounts?.[level] || 0}`);
  });
  lines.push(`summary,avg_time_s,${lastSummary.avgTime.toFixed(3)}`);
  lines.push(`summary,max_time_s,${lastSummary.maxTime.toFixed(3)}`);
  lines.push(`summary,smoke_exposure,${Number(lastSummary.smokeExposure || 0).toFixed(3)}`);
  lines.push(`summary,co_exposure_ppm_min,${Number(lastSummary.coExposurePpmMin || 0).toFixed(3)}`);
  lines.push(`summary,heat_exposure,${Number(lastSummary.heatExposure || 0).toFixed(3)}`);
  lines.push(`summary,visibility_exposure_m_s,${Number(lastSummary.exposureTotals?.visibilityMSeconds || 0).toFixed(3)}`);
  lines.push(`summary,visibility_deficit_exposure_s,${Number(lastSummary.exposureTotals?.visibilityDeficitSeconds || 0).toFixed(3)}`);
  lines.push(`summary,co_exposure_ppm_min_v1,${Number(lastSummary.exposureTotals?.coPpmMin || 0).toFixed(3)}`);
  lines.push(`summary,heat_flux_exposure_kw_m2_s,${Number(lastSummary.exposureTotals?.heatFluxKwM2Seconds || 0).toFixed(3)}`);
  lines.push(`summary,temperature_exposure_c_s,${Number(lastSummary.exposureTotals?.temperatureCSeconds || 0).toFixed(3)}`);
  lines.push(`summary,temperature_above_ambient_exposure_c_s,${Number(lastSummary.exposureTotals?.temperatureAboveAmbientCSeconds || 0).toFixed(3)}`);
  lines.push(`summary,extinction_exposure_m_1_s,${Number(lastSummary.exposureTotals?.extinctionM1Seconds || 0).toFixed(3)}`);
  lines.push(`summary,stuck_events,${lastSummary.stuckEvents || 0}`);
  lines.push(`summary,teacher_follow_rate,${Number(lastSummary.teacherFollowRate || 0).toFixed(4)}`);
  lines.push(`summary,panic_escape_events,${lastSummary.panicEscapeEvents || 0}`);
  lines.push(`summary,active_fire_cells,${lastSummary.activeFireCount || 0}`);
  lines.push(`summary,total_hrr_kw,${Number(lastSummary.totalFireHrrKw || 0).toFixed(3)}`);

  lines.push("");
  lines.push("section,floor,current_occupancy,peak_occupancy");
  const floorKeys = new Set([
    ...Object.keys(lastSummary.floorOccupancy || {}),
    ...Object.keys(lastSummary.floorPeakOccupancy || {})
  ]);
  [...floorKeys].sort((a, b) => Number(a) - Number(b)).forEach((floor) => {
    lines.push(
      `floor,${Number(floor) + 1},${lastSummary.floorOccupancy?.[floor] || 0},${lastSummary.floorPeakOccupancy?.[floor] || 0}`
    );
  });

  lines.push("");
  lines.push("section,stair_id,type,queued,in_transit,capacity,max_queue,completed");
  (lastSummary.stairCongestion || []).forEach((stair) => {
    lines.push([
      "stair",
      csvEscape(stair.id || stair.stairId || ""),
      csvEscape(stair.type || ""),
      stair.queued || 0,
      stair.inTransit || 0,
      stair.capacity || 0,
      stair.maxQueue || 0,
      stair.completed || 0
    ].join(","));
  });

  lines.push("");
  lines.push("section,time_s,avg_density,max_occ,active_agents");
  congestionHistory.forEach((r) => {
    lines.push(`congestion,${r.time.toFixed(2)},${r.avgDensity.toFixed(4)},${r.maxOcc},${r.active}`);
  });

  lines.push("");
  lines.push("section,floor,rank,cx,cy,pass_count,est_saved_s");
  bottleneckReport.forEach((b, i) => {
    lines.push(`bottleneck,${currentFloor + 1},${i + 1},${b.cx},${b.cy},${b.passCount},${b.estimatedSavedSec.toFixed(2)}`);
  });

  lines.push("");
  lines.push("section,id,type,floor,behavior_state,target_exit,target_exit_floor,target_stair,start_s,finish_s,dead,death_cause,tenability,worst_tenability,tenability_reasons,first_critical_time_s,exposure_duration_s,visibility_exposure_m_s,visibility_deficit_exposure_s,low_visibility_s,co_exposure_ppm_min,heat_flux_exposure_kw_m2_s,temperature_exposure_c_s,temperature_above_ambient_exposure_c_s,extinction_exposure_m_1_s,smoke_extinction_proxy_exposure_s,full_fed_available,smoke_dose_legacy,heat_dose_legacy,stuck_count,panic_escape_count");
  agents.forEach((a) => {
    const exit = allExitPoints[a.targetExitIndex] || null;
    lines.push(
      [
        "agent",
        a.id,
        csvEscape(TYPE_META[a.type]?.label || a.type || "Unknown"),
        (a.floor ?? 0) + 1,
        csvEscape(a.behaviorState || "normal"),
        a.targetExitIndex ?? "",
        exit ? exit.floor + 1 : "",
        csvEscape(a.targetStair || ""),
        Number.isFinite(a.startTime) ? a.startTime.toFixed(3) : "",
        Number.isFinite(a.finishTime) ? a.finishTime.toFixed(3) : "",
        a.dead ? 1 : 0,
        a.deathCause || "",
        csvEscape(a.tenability || "tenable"),
        csvEscape(a.worstTenability || "tenable"),
        csvEscape((a.tenabilityReasons || []).join("|")),
        Number.isFinite(a.firstCriticalTimeSec) ? Number(a.firstCriticalTimeSec).toFixed(3) : "",
        Number(a.exposure?.durationSeconds || 0).toFixed(4),
        Number(a.exposure?.visibilityMSeconds || 0).toFixed(4),
        Number(a.exposure?.visibilityDeficitSeconds || 0).toFixed(4),
        Number(a.exposure?.lowVisibilitySeconds || 0).toFixed(4),
        Number(a.exposure?.coPpmMin || 0).toFixed(4),
        Number(a.exposure?.heatFluxKwM2Seconds || 0).toFixed(4),
        Number(a.exposure?.temperatureCSeconds || 0).toFixed(4),
        Number(a.exposure?.temperatureAboveAmbientCSeconds || 0).toFixed(4),
        Number(a.exposure?.extinctionM1Seconds || 0).toFixed(4),
        Number(a.exposure?.smokeDensitySeconds || 0).toFixed(4),
        0,
        Number(a.smokeDose || 0).toFixed(4),
        Number(a.heatDose || 0).toFixed(4),
        a.stuckCount || 0,
        a.panicEscapeCount || 0
      ].join(",")
    );
  });

  lines.push("");
  lines.push("section,at,floor_count,current_floor,num_agents,speed,speed_var,start_rule,preset,optimize_reverse");
  paramHistory.forEach((h) => {
    lines.push(
      [
        "params",
        csvEscape(h.at),
        h.floorCount ?? "",
        Number.isFinite(h.currentFloor) ? h.currentFloor + 1 : "",
        h.numAgents,
        h.speed,
        h.speedVar,
        csvEscape(h.startRule),
        csvEscape(h.agentPreset),
        h.optimizeReverse ? 1 : 0
      ].join(",")
    );
  });

  return lines.join("\n");
}

export function downloadCsvReport(context) {
  const csv = buildCsvReport(context);
  if (csv == null) {
    alert("CSV出力できる集計結果がありません。先にシミュレーションを完了してください。");
    return;
  }
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);

  a.href = url;
  a.download = `evac_report_${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  context.log(`CSV出力完了: ${a.download}`);
}
