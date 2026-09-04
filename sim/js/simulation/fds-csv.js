// External samples are observations at a height above the local floor [m].
// They do not specify the mean concentration of an entire upper layer.
export const DEFAULT_FDS_EYE_HEIGHT_METERS = 1.6;
export const FDS_FIELDS = Object.freeze(["heatFluxKwM2", "opticalDensityM1", "coPpm", "visibilityM", "temperatureC"]);

export function fdsSampleHeight(record) {
  const raw = record?.sampleHeightMeters ?? record?.sample_height_m;
  return raw == null || raw === "" ? DEFAULT_FDS_EYE_HEIGHT_METERS : Number(raw);
}

export function isFdsSampleAtHeight(record, heightMeters = DEFAULT_FDS_EYE_HEIGHT_METERS) {
  return !!record && Math.abs(fdsSampleHeight(record) - heightMeters) <= 0.001;
}

function mergeFiniteFdsFields(previous, next) {
  const result = { ...previous, ...next };
  for (const key of FDS_FIELDS) if (!Number.isFinite(next[key])) result[key] = previous[key];
  return result;
}

/** Linear interpolation in height, independently by field; no extrapolation.
 * Exact-height samples (1 mm tolerance) override only supplied fields. This
 * interpolation is an adapter approximation, not a reconstruction of FDS CFD.
 * Missing bracketing samples leave the reduced-order eye-height fallback intact.
 */
export function sampleFdsAtHeight(records, heightMeters = DEFAULT_FDS_EYE_HEIGHT_METERS) {
  if (!Array.isArray(records) || !records.length) return null;
  const sorted = records.map(r => ({ ...r, sampleHeightMeters: r.sampleHeightMeters ?? 1.6 }))
    .sort((a, b) => a.sampleHeightMeters - b.sampleHeightMeters);
  const result = { floor: sorted[0].floor, cx: sorted[0].cx, cy: sorted[0].cy,
    sampleHeightMeters: heightMeters, source: "fds_csv", interpolatedFields: [] };
  for (const field of FDS_FIELDS) {
    const available = sorted.filter(r => Number.isFinite(r[field]));
    const exact = available.find(r => Math.abs(r.sampleHeightMeters - heightMeters) <= 0.001);
    if (exact) { result[field] = exact[field]; continue; }
    const lower = available.filter(r => r.sampleHeightMeters < heightMeters).at(-1);
    const upper = available.find(r => r.sampleHeightMeters > heightMeters);
    if (lower && upper) {
      const fraction = (heightMeters - lower.sampleHeightMeters) / (upper.sampleHeightMeters - lower.sampleHeightMeters);
      result[field] = lower[field] + fraction * (upper[field] - lower[field]);
      result.interpolatedFields.push(field);
    }
  }
  return FDS_FIELDS.some(field => Number.isFinite(result[field])) ? result : null;
}

export function groupFdsFrameByCell(frame) {
  const cells = new Map();
  frame?.cells?.forEach(record => {
    const key = `${record.floor}:${record.cx}:${record.cy}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(record);
  });
  return cells;
}

export function eyeHeightFdsFrame(frame, heightMeters = DEFAULT_FDS_EYE_HEIGHT_METERS) {
  const cells = new Map();
  groupFdsFrameByCell(frame).forEach((records, key) => {
    const sampled = sampleFdsAtHeight(records, heightMeters);
    if (sampled) cells.set(key, sampled);
  });
  return { time: frame?.time, cells, samples: groupFdsFrameByCell(frame) };
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function normalizeCsvKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[()\[\]/]/g, "");
}

function csvNumber(row, names, fallback = 0) {
  for (const name of names) {
    const v = row[name];
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function parseFdsRiskCsv(text, fileName = "fds.csv") {
  const rawLines = String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
  if (rawLines.length < 2) throw new Error("CSVにヘッダーとデータ行が必要です。");

  const headers = splitCsvLine(rawLines[0]).map(normalizeCsvKey);
  const frames = new Map();
  let rows = 0;
  let assumedHeightRows = 0;

  for (let i = 1; i < rawLines.length; i++) {
    const cols = splitCsvLine(rawLines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? "";
    });

    const time = csvNumber(row, ["time_s", "time", "t", "sec", "seconds"], 0);
    const rawFloor = csvNumber(row, ["floor", "floor_index", "f"], 1);
    const floor = Math.max(0, Math.floor(rawFloor) - 1);
    const cx = Math.floor(csvNumber(row, ["cx", "cell_x", "grid_x", "x"], NaN));
    const cy = Math.floor(csvNumber(row, ["cy", "cell_y", "grid_y", "y"], NaN));
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;

    const extinctionCoefficient = csvNumber(row, [
      "extinction_coefficient_m_1", "extinction_coefficient", "k_m_1"
    ], NaN);
    const base10OpticalDensityPerMeter = csvNumber(row, [
      "optical_density_base10_m_1", "od_base10_m_1"
    ], NaN);
    const legacyOpticalDensityM1 = csvNumber(row, ["optical_density_m_1"], NaN);
    const rawHeight = csvNumber(row, ["sample_height_m", "sample_height_meters"], NaN);
    if (Number.isFinite(rawHeight) && rawHeight < 0) throw new Error("sample_height_m は0以上の床上高さ [m] です。");
    const sampleHeightMeters = Number.isFinite(rawHeight) ? rawHeight : DEFAULT_FDS_EYE_HEIGHT_METERS;
    if (!Number.isFinite(rawHeight)) assumedHeightRows++;
    const record = {
      sampleHeightMeters,
      sampleHeightAssumed: !Number.isFinite(rawHeight),
      floor,
      cx,
      cy,
      heatFluxKwM2: csvNumber(row, ["heat_flux_kw_m2", "heat_flux", "q_rad", "q_total", "flux_kw_m2"], NaN),
      opticalDensityM1: Number.isFinite(extinctionCoefficient)
        ? extinctionCoefficient
        : (Number.isFinite(base10OpticalDensityPerMeter)
            ? base10OpticalDensityPerMeter * Math.LN10
            : legacyOpticalDensityM1),
      coPpm: csvNumber(row, ["co_ppm", "carbon_monoxide_ppm", "co"], NaN),
      visibilityM: csvNumber(row, ["visibility_m", "visibility", "vis_m"], NaN),
      temperatureC: csvNumber(row, ["temperature_c", "temp_c", "temperature"], NaN)
    };

    if (![record.heatFluxKwM2, record.opticalDensityM1, record.coPpm,
      record.visibilityM, record.temperatureC].some(Number.isFinite)) continue;

    if (!frames.has(time)) frames.set(time, new Map());
    const key = `${floor}:${cx}:${cy}:${sampleHeightMeters}`;
    const prior = frames.get(time).get(key);
    // Sparse rows at the same time and height also merge per physical field.
    frames.get(time).set(key, prior ? mergeFiniteFdsFields(prior, record) : record);
    rows++;
  }

  const times = [...frames.keys()].sort((a, b) => a - b);
  if (!times.length || rows === 0) throw new Error("有効なFDS行がありません。");

  // Treat CSV rows as time-stamped updates. A sparse sensor/export file often
  // omits unchanged cells and fields; sample-and-hold them causally until a
  // later row explicitly supplies a replacement (including an explicit 0).
  const heldCells = new Map();
  const heldFrames = times.map(time => {
    frames.get(time).forEach((record, key) => {
      const previous = heldCells.get(key);
      const merged = previous
        ? { ...previous, floor: record.floor, cx: record.cx, cy: record.cy }
        : { ...record };
      [
        "heatFluxKwM2", "opticalDensityM1", "coPpm", "visibilityM", "temperatureC"
      ].forEach(field => {
        if (Number.isFinite(record[field])) merged[field] = record[field];
      });
      heldCells.set(key, merged);
    });
    return { time, cells: new Map(heldCells) };
  });

  const parsed = {
    active: true,
    name: fileName,
    rows,
    times,
    frames: heldFrames
  };
  parsed.warnings = [];
  parsed.assumedHeightRows = assumedHeightRows;
  if (assumedHeightRows) parsed.warnings.push(`${assumedHeightRows}行の高さが未指定のため、床上1.6m相当と仮定しました。`);
  if (headers.includes("optical_density_m_1")) {
    parsed.warnings.push(
      "optical_density_m_1 は旧互換として自然対数の減光係数 K [1/m] と解釈しました。" +
      "base-10値は optical_density_base10_m_1 を使用してください。"
    );
  }
  parsed.stats = summarizeFdsRiskCsv(parsed);
  return parsed;
}

function summarizeFdsRiskCsv(risk) {
  const stats = {
    rows: risk?.rows || 0,
    timeCount: risk?.times?.length || 0,
    maxHeatFluxKwM2: 0,
    maxOpticalDensityM1: 0,
    maxCoPpm: 0,
    minVisibilityM: Infinity,
    maxTemperatureC: -Infinity
  };
  if (!risk?.frames?.length) return stats;
  risk.frames.forEach(frame => {
    frame.cells.forEach(rec => {
      if (Number.isFinite(rec.heatFluxKwM2)) {
        stats.maxHeatFluxKwM2 = Math.max(stats.maxHeatFluxKwM2, rec.heatFluxKwM2);
      }
      if (Number.isFinite(rec.opticalDensityM1)) {
        stats.maxOpticalDensityM1 = Math.max(stats.maxOpticalDensityM1, rec.opticalDensityM1);
      }
      if (Number.isFinite(rec.coPpm)) stats.maxCoPpm = Math.max(stats.maxCoPpm, rec.coPpm);
      if (Number.isFinite(rec.visibilityM)) stats.minVisibilityM = Math.min(stats.minVisibilityM, rec.visibilityM);
      if (Number.isFinite(rec.temperatureC)) stats.maxTemperatureC = Math.max(stats.maxTemperatureC, rec.temperatureC);
    });
  });
  if (!Number.isFinite(stats.minVisibilityM)) stats.minVisibilityM = null;
  if (!Number.isFinite(stats.maxTemperatureC)) stats.maxTemperatureC = null;
  return stats;
}
