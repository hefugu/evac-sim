from pathlib import Path
import re

core_path = Path('sim/js/simulation/core.js')
ui_path = Path('sim/js/ui.js')
index_path = Path('sim/index.html')
docs_path = Path('docs/fire_engineering_model_basis.md')
sample_path = Path('docs/fds_risk_sample.csv')

for p in [core_path, ui_path, index_path]:
    if not p.exists():
        raise SystemExit(f'{p} not found')

core = core_path.read_text(encoding='utf-8-sig')
ui = ui_path.read_text(encoding='utf-8-sig')
index = index_path.read_text(encoding='utf-8-sig')

changed = False

def require(cond, msg):
    if not cond:
        raise SystemExit(msg)

def replace_once(src, old, new, label):
    count = src.count(old)
    require(count == 1, f'{label}: expected 1 match, got {count}')
    return src.replace(old, new, 1)

# index.html UI
if 'id="fdsCsvFile"' not in index:
    old = '''      <button id="btnApplyFloors" type="button" hidden aria-hidden="true">フロア設定反映</button>
    </div>'''
    new = '''      <button id="btnApplyFloors" type="button" hidden aria-hidden="true">フロア設定反映</button>
    </div>

    <div class="block">
      <div class="sectionTitle">FDS / 火災工学データ <span class="badge">CSV</span></div>
      <div class="row">
        <label>FDS CSV</label>
        <input type="file" id="fdsCsvFile" accept=".csv,text/csv">
      </div>
      <div class="simButtons">
        <button id="btnClearFdsCsv" type="button">FDS解除</button>
      </div>
      <div id="fdsCsvStatus" class="hint">未読込。列: time_s,floor,cx,cy,heat_flux_kw_m2,optical_density_m_1,co_ppm,visibility_m</div>
    </div>'''
    index = replace_once(index, old, new, 'insert FDS UI')
    changed = True

# ui refs
if 'fdsCsvFileInput' not in ui:
    old = '''    btnApplyFloors: byId("btnApplyFloors"),'''
    new = '''    btnApplyFloors: byId("btnApplyFloors"),
    fdsCsvFileInput: byId("fdsCsvFile"),
    btnClearFdsCsv: byId("btnClearFdsCsv"),
    fdsCsvStatus: byId("fdsCsvStatus"),'''
    ui = replace_once(ui, old, new, 'insert FDS ui refs')
    changed = True

# core constants
if 'const FDS_HEAT_FLUX_SOFT_KW_M2' not in core:
    old = '''  const SMOKE_AVOID_WEIGHT = 1.1;
  const FIRE_AVOID_WEIGHT = 2.5;'''
    new = '''  const SMOKE_AVOID_WEIGHT = 1.1;
  const FIRE_AVOID_WEIGHT = 2.5;
  // Fire engineering layer. FDS/CFD CSV takes priority; t-squared fire is only fallback.
  const FDS_HEAT_FLUX_SOFT_KW_M2 = 2.5;
  const FDS_HEAT_FLUX_HARD_KW_M2 = 10.0;
  const FDS_CO_SOFT_PPM = 200;
  const FDS_CO_HARD_PPM = 1200;
  const FDS_OPTICAL_DENSITY_SOFT = 0.15;
  const FDS_OPTICAL_DENSITY_HARD = 1.0;
  const FDS_ROUTE_HEAT_WEIGHT = 13.0;
  const FDS_ROUTE_OD_WEIGHT = 18.0;
  const FDS_ROUTE_CO_WEIGHT = 0.035;
  const FDS_ROUTE_VISIBILITY_WEIGHT = 18.0;
  const CO_DOSE_FATAL_PPM_MIN = 30000;
  const HEAT_FLUX_DOSE_FATAL = 120;
  const T2_FIRE_ALPHA = 0.0469;
  const T2_FIRE_MAX_HRR_KW = 3000;'''
    core = replace_once(core, old, new, 'insert FDS constants')
    changed = True

if 'const LETHAL_FIRE_CELL_BLOCK' not in core:
    old = '''  const FIRE_AVOID_WEIGHT = 2.5;'''
    new = '''  const FIRE_AVOID_WEIGHT = 2.5;
  const LETHAL_FIRE_CELL_BLOCK = true;
  const FIRE_HARD_AVOID_HEAT = 0.85;
  const FIRE_SOFT_AVOID_HEAT = 0.25;
  const SMOKE_HARD_AVOID_LEVEL = 2.25;
  const SMOKE_SOFT_AVOID_LEVEL = 0.75;
  const FIRE_BLOCK_SCORE = 1e6;
  const FIRE_NEAR_BLOCK_SCORE = 160;
  const HIGH_SMOKE_BLOCK_SCORE = 85;
  const SMOKE_ROUTE_WEIGHT = 7.5;
  const SMOKE_ROUTE_QUADRATIC_WEIGHT = 5.0;
  const FIRE_ROUTE_WEIGHT = 22.0;
  const FIRE_LETHAL_ROUTE_WEIGHT = 120.0;'''
    core = replace_once(core, old, new, 'insert route constants')
    changed = True

if 'let importedFdsRisk' not in core:
    old = '''  let smokeMap = null; 
  let smokeCeil = null; '''
    new = '''  let smokeMap = null; 
  let smokeCeil = null; 
  let importedFdsRisk = { active: false, name: null, rows: 0, frames: [], times: [] }; '''
    core = replace_once(core, old, new, 'insert FDS state')
    changed = True

# smoke fallback stronger
for a, b in [
    ('    const MAX_SMOKE = 3.0;', '    const MAX_SMOKE = 4.0;'),
    ('    const FIRE_SOURCE_PER_SEC = 2.4;', '    const FIRE_SOURCE_PER_SEC = 3.4;'),
    ('    const DIFFUSE_PER_SEC = 1.7 / cellMeters;', '    const DIFFUSE_PER_SEC = 2.05 / cellMeters;'),
    ('    const BASE_DECAY_PER_SEC = 0.012;', '    const BASE_DECAY_PER_SEC = 0.008;')
]:
    if a in core:
        core = core.replace(a, b, 1)
        changed = True

# UI local refs in core
if 'const fdsCsvFileInput = ui.fdsCsvFileInput;' not in core:
    old = '''  const btnApplyFloors = ui.btnApplyFloors;'''
    new = '''  const btnApplyFloors = ui.btnApplyFloors;
  const fdsCsvFileInput = ui.fdsCsvFileInput;
  const btnClearFdsCsv = ui.btnClearFdsCsv;
  const fdsCsvStatus = ui.fdsCsvStatus;'''
    core = replace_once(core, old, new, 'insert FDS local refs')
    changed = True

# agent doses
if 'coDosePpmMin' not in core:
    old = '''        smokeDose: 0,
        heatDose: 0,'''
    new = '''        smokeDose: 0,
        heatDose: 0,
        coDosePpmMin: 0,
        heatFluxDose: 0,'''
    core = replace_once(core, old, new, 'insert agent FDS dose fields')
    changed = True

# parser functions before map loading
if 'function parseFdsRiskCsv(' not in core:
    marker = '  // ==== Map Loading and Grid Build ===='
    helper = r'''  function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        out.push(cur.trim()); cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function normalizeCsvKey(key) {
    return String(key || "").trim().toLowerCase().replace(/[\s\-]+/g, "_").replace(/[()\[\]/]/g, "");
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

  function parseFdsRiskCsv(text, fileName = "fds.csv") {
    const rawLines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    if (rawLines.length < 2) throw new Error("CSVにヘッダーとデータ行が必要です。");
    const headers = splitCsvLine(rawLines[0]).map(normalizeCsvKey);
    const frames = new Map();
    let rows = 0;
    for (let i = 1; i < rawLines.length; i++) {
      const cols = splitCsvLine(rawLines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = cols[idx] ?? ""; });
      const time = csvNumber(row, ["time_s", "time", "t", "sec", "seconds"], 0);
      const rawFloor = csvNumber(row, ["floor", "floor_index", "f"], 1);
      const floor = Math.max(0, Math.floor(rawFloor) - 1);
      const cx = Math.floor(csvNumber(row, ["cx", "cell_x", "grid_x", "x"], NaN));
      const cy = Math.floor(csvNumber(row, ["cy", "cell_y", "grid_y", "y"], NaN));
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const record = {
        floor, cx, cy,
        heatFluxKwM2: csvNumber(row, ["heat_flux_kw_m2", "heat_flux", "q_rad", "q_total", "flux_kw_m2"], 0),
        opticalDensityM1: csvNumber(row, ["optical_density_m_1", "optical_density", "od", "extinction_coefficient", "k_m_1"], 0),
        coPpm: csvNumber(row, ["co_ppm", "carbon_monoxide_ppm", "co"], 0),
        visibilityM: csvNumber(row, ["visibility_m", "visibility", "vis_m"], NaN),
        temperatureC: csvNumber(row, ["temperature_c", "temp_c", "temperature"], NaN)
      };
      if (!frames.has(time)) frames.set(time, new Map());
      frames.get(time).set(`${floor}:${cx}:${cy}`, record);
      rows++;
    }
    const times = [...frames.keys()].sort((a, b) => a - b);
    if (!times.length || rows === 0) throw new Error("有効なFDS行がありません。");
    return { active: true, name: fileName, rows, times, frames: times.map(time => ({ time, cells: frames.get(time) })) };
  }

  function getNearestFdsFrame(time) {
    if (!importedFdsRisk.active || !importedFdsRisk.frames.length) return null;
    let best = importedFdsRisk.frames[0];
    let bestDt = Math.abs((best.time || 0) - time);
    for (let i = 1; i < importedFdsRisk.frames.length; i++) {
      const frame = importedFdsRisk.frames[i];
      const dt = Math.abs((frame.time || 0) - time);
      if (dt < bestDt) { best = frame; bestDt = dt; }
    }
    return best;
  }

  function getFdsRiskAt(floor, cx, cy, time = simTime) {
    const frame = getNearestFdsFrame(time);
    if (!frame) return null;
    return frame.cells.get(`${Math.max(0, floor)}:${cx}:${cy}`) || null;
  }

  function t2FireHrrKw(timeSec) {
    const t = Math.max(0, Number(timeSec) || 0);
    return Math.min(T2_FIRE_MAX_HRR_KW, T2_FIRE_ALPHA * t * t);
  }

'''
    core = replace_once(core, marker, helper + marker, 'insert parser helpers')
    changed = True

# FDS file listeners after mapFileInput change block
if 'fdsCsvFileInput?.addEventListener' not in core:
    marker = '''  function extractWalkableTemplateFromImage(image) {'''
    listeners = '''  fdsCsvFileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      importedFdsRisk = parseFdsRiskCsv(text, file.name);
      const msg = `FDS CSV読込: ${file.name} / ${importedFdsRisk.rows}行 / ${importedFdsRisk.times.length}時刻`;
      if (fdsCsvStatus) fdsCsvStatus.textContent = msg;
      log(msg);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      alert(`FDS CSVの読込に失敗しました: ${reason}`);
    } finally {
      fdsCsvFileInput.value = "";
    }
  });

  btnClearFdsCsv?.addEventListener("click", () => {
    importedFdsRisk = { active: false, name: null, rows: 0, frames: [], times: [] };
    if (fdsCsvStatus) fdsCsvStatus.textContent = "未読込。FDS/CFD値は使わず、簡易t²火災フォールバックを使います。";
    log("FDS CSVを解除しました。");
  });

'''
    core = replace_once(core, marker, listeners + marker, 'insert FDS listeners')
    changed = True

# routeRiskAt and engineering risk inside step after fireRiskAt
if 'function routeRiskAt(floor, cx, cy)' not in core:
    marker = '''      return { heat, lethal };
    }

    const occupancyByFloor = new Array(floorCount).fill(null).map(() => makeScalarGrid(0));'''
    route = r'''      return { heat, lethal };
    }

    function fallbackEngineeringRisk(floor, cx, cy) {
      const smoke = smokeAt(floor, cx, cy);
      const fire = fireRiskAt(floor, cx, cy);
      const hrrScale = Math.min(1, t2FireHrrKw(simTime) / Math.max(1, T2_FIRE_MAX_HRR_KW));
      const heatFluxKwM2 = Math.max(0, fire.heat * 8.0 * (0.35 + 0.65 * hrrScale));
      const opticalDensityM1 = Math.max(0, smoke * 0.32);
      const coPpm = Math.max(0, smoke * 260 * (0.4 + 0.6 * hrrScale));
      const visibilityM = opticalDensityM1 > 0.001 ? Math.min(30, 3.0 / opticalDensityM1) : 30;
      return { heatFluxKwM2, opticalDensityM1, coPpm, visibilityM, source: "fallback_t2" };
    }

    function engineeringRiskAt(floor, cx, cy) {
      const fds = getFdsRiskAt(floor, cx, cy, simTime);
      if (fds) return { ...fds, source: "fds_csv" };
      return fallbackEngineeringRisk(floor, cx, cy);
    }

    function routeRiskAt(floor, cx, cy) {
      const fGrid = floorStates[floor]?.grid;
      if (!fGrid || !inBounds(cx, cy)) return { blocked: true, penalty: FIRE_BLOCK_SCORE, visibilityFactor: 1, risk: null };
      const cell = fGrid[cy][cx];
      const smoke = smokeAt(floor, cx, cy);
      const fire = fireRiskAt(floor, cx, cy);
      const er = engineeringRiskAt(floor, cx, cy);
      if (LETHAL_FIRE_CELL_BLOCK && cell.fire) return { blocked: true, penalty: FIRE_BLOCK_SCORE, visibilityFactor: 1, risk: er };
      if (fire.lethal || fire.heat >= FIRE_HARD_AVOID_HEAT) return { blocked: true, penalty: FIRE_NEAR_BLOCK_SCORE + fire.heat * FIRE_LETHAL_ROUTE_WEIGHT, visibilityFactor: 1, risk: er };
      const od = Math.max(0, er.opticalDensityM1 || 0);
      const co = Math.max(0, er.coPpm || 0);
      const hf = Math.max(0, er.heatFluxKwM2 || 0);
      const vis = Number.isFinite(er.visibilityM) ? Math.max(0, er.visibilityM) : 30;
      const visibilityFactor = Math.max(0, Math.min(1, vis / 10));
      const hard = smoke >= SMOKE_HARD_AVOID_LEVEL || od >= FDS_OPTICAL_DENSITY_HARD || co >= FDS_CO_HARD_PPM || hf >= FDS_HEAT_FLUX_HARD_KW_M2;
      const penalty =
        smoke * SMOKE_ROUTE_WEIGHT + smoke * smoke * SMOKE_ROUTE_QUADRATIC_WEIGHT +
        fire.heat * FIRE_ROUTE_WEIGHT +
        Math.max(0, hf - FDS_HEAT_FLUX_SOFT_KW_M2) * FDS_ROUTE_HEAT_WEIGHT +
        Math.max(0, od - FDS_OPTICAL_DENSITY_SOFT) * FDS_ROUTE_OD_WEIGHT +
        Math.max(0, co - FDS_CO_SOFT_PPM) * FDS_ROUTE_CO_WEIGHT +
        Math.max(0, 1 - visibilityFactor) * FDS_ROUTE_VISIBILITY_WEIGHT +
        (hard ? HIGH_SMOKE_BLOCK_SCORE : 0);
      return { blocked: false, penalty, visibilityFactor, risk: er };
    }

    const occupancyByFloor = new Array(floorCount).fill(null).map(() => makeScalarGrid(0));'''
    core = replace_once(core, marker, route, 'insert engineering route risk')
    changed = True

# add route risk in candidate loop
if 'const routeRisk = routeRiskAt(nf, nx, ny);' not in core:
    pattern = re.compile(r'(        const nf = c\.nf \?\? floor;\r?\n\s*if \(!isAgentTraversableCell\(nf, nx, ny\)\) continue;\r?\n)(        const nextPot = potentialField\?\.\[nf\]\?\.\[ny\]\?\.\[nx\];)')
    m = pattern.search(core)
    require(m, 'candidate insertion marker not found')
    core = core[:m.start()] + m.group(1) + '        const routeRisk = routeRiskAt(nf, nx, ny);\n        if (routeRisk.blocked) continue;\n' + m.group(2) + core[m.end():]
    changed = True

if 'routeRiskPenalty: routeRisk.penalty' not in core:
    old = '''        evaluated.push({
          c, nx, ny, nf, occ, densityTarget, smokeTarget, heatPenalty,
          fireHeat: fireTarget.heat, potGain, uphill, isBacktrack
        });'''
    new = '''        evaluated.push({
          c, nx, ny, nf, occ, densityTarget, smokeTarget, heatPenalty,
          fireHeat: fireTarget.heat,
          routeRiskPenalty: routeRisk.penalty,
          routeVisibilityFactor: routeRisk.visibilityFactor,
          potGain, uphill, isBacktrack
        });'''
    core = replace_once(core, old, new, 'add route risk to evaluated')
    changed = True

if 'routeRiskPenalty, routeVisibilityFactor' not in core:
    old = '''      for (const e of evalPool) {
        const { c, nx, ny, nf, occ, densityTarget, smokeTarget, heatPenalty, fireHeat, potGain, uphill, isBacktrack } = e;
        let score = potGain * POTENTIAL_GAIN_WEIGHT;'''
    new = '''      for (const e of evalPool) {
        const { c, nx, ny, nf, occ, densityTarget, smokeTarget, heatPenalty, fireHeat, routeRiskPenalty, routeVisibilityFactor, potGain, uphill, isBacktrack } = e;
        let score = potGain * POTENTIAL_GAIN_WEIGHT;'''
    core = replace_once(core, old, new, 'destructure route risk')
    changed = True

if 'score -= routeRiskPenalty;' not in core:
    old = '''        score -= smokeTarget * SMOKE_AVOID_WEIGHT;
        score -= fireHeat * FIRE_AVOID_WEIGHT;
        score -= heatPenalty;'''
    new = '''        score -= smokeTarget * SMOKE_AVOID_WEIGHT;
        score -= fireHeat * FIRE_AVOID_WEIGHT;
        score -= routeRiskPenalty;
        if (routeVisibilityFactor < 0.35) score -= (0.35 - routeVisibilityFactor) * FDS_ROUTE_VISIBILITY_WEIGHT;
        score -= heatPenalty;'''
    core = replace_once(core, old, new, 'add route risk score')
    changed = True

# dose / visibility accumulation after localSmoke/fire
if 'const localEngineeringRisk = engineeringRiskAt(f, cx, cy);' not in core:
    old = '''      const smoke = smokeAt(f, cx, cy);
      const fire = fireRiskAt(f, cx, cy);
      a.visibility = Math.max(MIN_VISIBILITY, 1 - smoke * VISIBILITY_SMOKE_COEF);
      a.smokeDose += Math.max(0, smoke - 0.2) * Math.max(0, smoke - 0.2) * dt;
      a.heatDose += fire.heat * dt;'''
    new = '''      const smoke = smokeAt(f, cx, cy);
      const fire = fireRiskAt(f, cx, cy);
      const localEngineeringRisk = engineeringRiskAt(f, cx, cy);
      const riskVisibilityFactor = Number.isFinite(localEngineeringRisk.visibilityM)
        ? Math.max(MIN_VISIBILITY, Math.min(1, localEngineeringRisk.visibilityM / 10))
        : 1;
      a.visibility = Math.min(riskVisibilityFactor, Math.max(MIN_VISIBILITY, 1 - smoke * VISIBILITY_SMOKE_COEF));
      a.smokeDose += Math.max(0, smoke - 0.2) * Math.max(0, smoke - 0.2) * dt;
      a.heatDose += fire.heat * dt;
      a.coDosePpmMin = (a.coDosePpmMin || 0) + Math.max(0, localEngineeringRisk.coPpm || 0) * (dt / 60);
      a.heatFluxDose = (a.heatFluxDose || 0) + Math.max(0, (localEngineeringRisk.heatFluxKwM2 || 0) - FDS_HEAT_FLUX_SOFT_KW_M2) * dt;'''
    core = replace_once(core, old, new, 'add FDS dose accumulation')
    changed = True

if 'a.coDosePpmMin >= CO_DOSE_FATAL_PPM_MIN' not in core:
    old = '''      if (fire.lethal || acuteSmoke || a.smokeDose >= SMOKE_DEATH_DOSE || a.heatDose >= HEAT_DEATH_DOSE) {
        a.dead = true;
        a.deathTime = simTime;
        a.deathCause = fire.lethal ? "fire" : (acuteSmoke || a.smokeDose >= SMOKE_DEATH_DOSE ? "smoke" : "heat");'''
    new = '''      if (
        fire.lethal || acuteSmoke ||
        a.smokeDose >= SMOKE_DEATH_DOSE ||
        a.heatDose >= HEAT_DEATH_DOSE ||
        a.coDosePpmMin >= CO_DOSE_FATAL_PPM_MIN ||
        a.heatFluxDose >= HEAT_FLUX_DOSE_FATAL
      ) {
        a.dead = true;
        a.deathTime = simTime;
        a.deathCause = fire.lethal
          ? "fire"
          : (a.coDosePpmMin >= CO_DOSE_FATAL_PPM_MIN
            ? "co"
            : (acuteSmoke || a.smokeDose >= SMOKE_DEATH_DOSE
              ? "smoke"
              : (a.heatFluxDose >= HEAT_FLUX_DOSE_FATAL ? "heat_flux" : "heat")));'''
    core = replace_once(core, old, new, 'add FDS death causes')
    changed = True

# write docs and sample
basis = '''# 火災工学・FDS連携の根拠メモ

## 実装方針
このシミュレータ本体はブラウザ上の避難行動モデルであり、CFDソルバではない。火災・煙については、NIST FDS等で計算した時刻別・セル別のCSVを読み込み、避難者の経路選択、視界低下、CO曝露、熱流束曝露へ反映する。

## 採用したCSV列
- `time_s`: 時刻[s]
- `floor`: フロア番号。CSVでは1始まり、内部では0始まりへ変換する。
- `cx`, `cy`: シミュレータのグリッドセル座標。
- `heat_flux_kw_m2`: 熱流束[kW/m^2]
- `optical_density_m_1`: 光学濃度または煙減光係数[1/m]
- `co_ppm`: 一酸化炭素濃度[ppm]
- `visibility_m`: 視界距離[m]
- `temperature_c`: 温度[℃]。現段階では読込のみ。

## 根拠
- NIST FDSは、火災由来の低速流、煙、熱輸送を対象にしたLES系CFDコードである。
- FDS/Smokeviewにはユーザーガイド、技術参照、検証、妥当性確認ガイドが公開されている。
- 避難安全ではASET/RSETの考え方で、煙・熱・有毒ガス・視界を利用可能避難時間側の制約として扱う。
- 視界は煙の減光係数や光学濃度と強く関係し、避難経路の可用性に影響する。
- `t² fire` は火災成長を `Q = alpha t^2` として近似する代表的な工学モデルであり、本実装ではFDS CSVがない場合のフォールバックとしてのみ使う。

## 限界
- このリポジトリ単体ではNavier-Stokes方程式を解かない。
- FDS CSVがない場合の煙・CO・熱流束は簡易モデルであり、絶対値予測ではなく相対比較用。
- 死亡・行動不能判定の閾値は研究用の仮設定であり、最終発表では「危険度指標」として扱うのが安全。
'''

sample = '''time_s,floor,cx,cy,heat_flux_kw_m2,optical_density_m_1,co_ppm,visibility_m,temperature_c
0,1,10,10,0,0,0,30,20
30,1,10,10,3.0,0.20,250,12,45
60,1,10,10,8.5,0.70,800,4,90
90,1,10,10,14.0,1.20,1500,2,160
60,1,11,10,4.0,0.45,500,7,70
60,1,12,10,1.5,0.18,180,14,40
'''

docs_path.parent.mkdir(parents=True, exist_ok=True)
if not docs_path.exists() or docs_path.read_text(encoding='utf-8') != basis:
    docs_path.write_text(basis, encoding='utf-8')
    changed = True
if not sample_path.exists() or sample_path.read_text(encoding='utf-8') != sample:
    sample_path.write_text(sample, encoding='utf-8')
    changed = True

if index != index_path.read_text(encoding='utf-8-sig'):
    index_path.write_text(index, encoding='utf-8')
if ui != ui_path.read_text(encoding='utf-8-sig'):
    ui_path.write_text(ui, encoding='utf-8')
if core != core_path.read_text(encoding='utf-8-sig'):
    core_path.write_text(core, encoding='utf-8')

if changed:
    print('Applied fire engineering/FDS CSV feature patch.')
else:
    print('No changes needed.')
