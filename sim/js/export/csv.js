export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function downloadCsvReport(context) {
  const {
    lastSummary,
    congestionHistory,
    bottleneckReport,
    currentFloor,
    agents,
    allExitPoints,
    TYPE_META,
    paramHistory,
    log
  } = context;

  if (!lastSummary) {
    alert("CSV出力できる集計結果がありません。先にシミュレーションを完了してください。");
    return;
  }

  const lines = [];
  lines.push("section,key,value");
  lines.push(`summary,agents,${lastSummary.agents}`);
  lines.push(`summary,evacuated,${lastSummary.evacuated}`);
  lines.push(`summary,dead,${lastSummary.dead}`);
  lines.push(`summary,avg_time_s,${lastSummary.avgTime.toFixed(3)}`);
  lines.push(`summary,max_time_s,${lastSummary.maxTime.toFixed(3)}`);

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
  lines.push("section,id,type,floor,target_exit,target_exit_floor,start_s,finish_s,dead,death_cause");
  agents.forEach((a) => {
    const exit = allExitPoints[a.targetExitIndex] || null;
    lines.push(
      [
        "agent",
        a.id,
        csvEscape(TYPE_META[a.type]?.label || a.type || "Unknown"),
        (a.floor ?? 0) + 1,
        a.targetExitIndex ?? "",
        exit ? exit.floor + 1 : "",
        Number.isFinite(a.startTime) ? a.startTime.toFixed(3) : "",
        Number.isFinite(a.finishTime) ? a.finishTime.toFixed(3) : "",
        a.dead ? 1 : 0,
        a.deathCause || ""
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

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);

  a.href = url;
  a.download = `evac_report_${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  log(`CSV出力完了: ${a.download}`);
}