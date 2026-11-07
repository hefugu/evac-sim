/**
 * PR-A の固定ベンチマーク入力。物理モデルの係数は変更しない。
 * 座標は0始まり、CSVの階番号だけは既存取込仕様に従って1始まり。
 * spawns は本体が復元抽出する候補セルであり、避難者ごとの固定実配置ではない。
 */

const CELL_SIZE_METERS = 0.5;
const WIDTH = 96;
const HEIGHT = 58;
const COMMON_INVARIANTS = [
  "生成人数 = 避難済み人数 + 未避難人数を保持する",
  "歩行者の位置・速度・曝露量にNaNやInfinityを生じない",
  "壁を通過せず、設定された出口への到達でのみ避難済みとする",
  "観測打切り時の未完了者を避難完了時間の成功標本へ混ぜない"
];
const COMMON_METRICS = [
  "evacuationCompletionRate", "evacuationCompletionTimeSec", "meanEvacuationTimeSec",
  "p95EvacuationTimeSec", "remainingCount", "unreachableCount", "exitUseCounts",
  "exitFlowPeoplePerSec", "meanWalkingSpeedMps", "stepDurationMs", "p95StepDurationMs",
  "wallTimePerSimulationSecondMs", "peakMemoryBytes", "renderFps"
];

function point(cx, cy) { return { cx, cy }; }

function floor(width = WIDTH, height = HEIGHT, initiallyOpen = true) {
  const cells = Array.from({ length: height }, (_, cy) => Array.from({ length: width }, (_, cx) =>
    initiallyOpen && cx > 0 && cy > 0 && cx < width - 1 && cy < height - 1 ? "." : "#"));
  return { cells, exits: [], spawns: [], fires: [], stairs: [] };
}

function rectangle(f, x0, y0, x1, y1, value = ".") {
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) f.cells[cy][cx] = value;
  }
}

// Each eligible cell is retained, rather than concentrating a large population
// onto a handful of coincident markers. Production still samples with replacement.
function spawnRectangle(f, x0, y0, x1, y1) {
  const occupiedMarkers = new Set([...f.exits, ...f.fires, ...f.stairs].map(p => `${p.cx}:${p.cy}`));
  const existing = new Set(f.spawns.map(p => `${p.cx}:${p.cy}`));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const key = `${cx}:${cy}`;
      if (f.cells[cy][cx] === "." && !occupiedMarkers.has(key) && !existing.has(key)) {
        f.spawns.push(point(cx, cy));
        existing.add(key);
      }
    }
  }
}

function link(floors, a, b) {
  for (const endpoint of [a, b]) {
    const f = floors[endpoint.floor];
    if (!f.stairs.some(p => p.cx === endpoint.cx && p.cy === endpoint.cy)) {
      f.stairs.push(point(endpoint.cx, endpoint.cy));
    }
  }
  return { a: { ...a }, b: { ...b }, travelCostSec: 2, congestionCapacity: 2 };
}

const DEFINITIONS = [
  { id: "B01", name: "直線廊下", purpose: "基本歩行速度・避難時間" },
  { id: "B02", name: "狭い出口", purpose: "滞留・通過流量" },
  { id: "B03", name: "曲がり角", purpose: "壁抜け・経路追従" },
  { id: "B04", name: "複数出口", purpose: "負荷分散・経路選択" },
  { id: "B05", name: "複数階段", purpose: "FIFO・階段混雑" },
  { id: "B06", name: "火災・煙", purpose: "危険回避・曝露" },
  { id: "B07", name: "到達不能領域", purpose: "人数保持・未避難判定" },
  { id: "B08", name: "大規模建物", purpose: "性能・メモリ使用量" },
  { id: "B09", name: "双方向階段", purpose: "方向別交通・対向流の観測範囲" },
  { id: "B10", name: "FDS連携", purpose: "外部データの反映" },
  { id: "B11", name: "高密度群衆", purpose: "身体接触・衝突・流動" },
  { id: "B12", name: "複数階避難", purpose: "階段と出口の連続性" }
];

/** Return fresh metadata so callers cannot mutate the scenario catalog. */
export function listScenarios() {
  return DEFINITIONS.map(definition => ({ ...definition }));
}

/**
 * Build a JSON-serializable experiment input. Standard populations are 100,
 * 400 and 1000; smaller positive integers are useful for CI setup smoke tests.
 * Geometry is identical across populations except B11's declared spawn support.
 */
export function buildScenario(id, population = 100) {
  const definition = DEFINITIONS.find(candidate => candidate.id === String(id).toUpperCase());
  if (!definition) throw new RangeError(`不明なシナリオID: ${id}`);
  if (!Number.isInteger(population) || population < 1 || population > 1000) {
    throw new RangeError("population は1以上1000以下の整数を指定してください（標準: 100/400/1000）。");
  }

  let floors = [];
  let stairLinks = [];
  let fdsCsv = null;
  const invariants = [...COMMON_INVARIANTS];
  const metrics = [...COMMON_METRICS];
  const notes = [];
  const settings = {
    speed: 1.2,
    speedVar: 0,
    startRule: "simultaneous",
    agentPreset: "default",
    ratios: { adult: 100, child: 0, elderly: 0, panic: 0, leader: 0, teacher: 0, student: 0 },
    optimizeReverse: false,
    responseTime: { detectionSec: 0, minSec: 0, modeSec: 0, maxSec: 0 },
    fireGrowthRate: "medium",
    fireMaxHrrKw: 3000,
    fireAreaM2: 1
  };

  switch (definition.id) {
    case "B01": {
      const f = floor(WIDTH, 28);
      f.exits.push(point(94, 14));
      spawnRectangle(f, 2, 2, 92, 25);
      floors = [f];
      notes.push("1000人時の支持領域平均密度を2人/m²以下に保つため、直線廊下の内法幅は13m。低密度の1人歩行速度校正ケースではない。");
      break;
    }
    case "B02": {
      const f = floor();
      rectangle(f, 70, 1, 70, 56, "#");
      rectangle(f, 70, 28, 70, 29); // 1 m doorway in the partition.
      f.exits.push(point(93, 29));
      spawnRectangle(f, 2, 2, 67, 55);
      floors = [f];
      metrics.push("bottleneckQueueTimeSec", "doorwayFlowPeoplePerSec");
      notes.push("幅1mの隔壁開口を通って出口代表点へ進む。出口marker自体の幅を新たにモデル化したものではない。");
      break;
    }
    case "B03": {
      const f = floor(WIDTH, HEIGHT, false);
      rectangle(f, 1, 1, 94, 28);
      rectangle(f, 67, 1, 94, 56);
      f.exits.push(point(81, 55));
      spawnRectangle(f, 2, 2, 80, 27);
      floors = [f];
      invariants.push("L字廊下の内側の壁角を横切らない");
      metrics.push("wallPenetrationCount", "stagnationTimeSec");
      break;
    }
    case "B04": {
      const f = floor();
      f.exits.push(point(2, 14), point(93, 43));
      spawnRectangle(f, 8, 4, 87, 53);
      floors = [f];
      metrics.push("exitUseFractions", "routeChanges");
      notes.push("出口利用の均等分散を合格条件にはしない。経路長と現在の出口選択結果を記録する。");
      break;
    }
    case "B05": {
      floors = [floor(), floor()];
      floors[0].exits.push(point(2, 29), point(93, 29));
      stairLinks = [
        link(floors, { floor: 0, cx: 12, cy: 29 }, { floor: 1, cx: 12, cy: 29 }),
        link(floors, { floor: 0, cx: 83, cy: 29 }, { floor: 1, cx: 83, cy: 29 })
      ];
      spawnRectangle(floors[1], 2, 2, 93, 55);
      metrics.push("stairPassageCounts", "stairWaitingTimeSec", "stairCapacityViolations", "stairFifoViolations");
      invariants.push("上階からの避難は明示された2本の階段リンクを通る", "各階段の同時利用数は設定容量2以下");
      break;
    }
    case "B06": {
      const f = floor();
      f.exits.push(point(2, 29), point(93, 29));
      f.fires.push(point(48, 29));
      spawnRectangle(f, 12, 4, 83, 53);
      floors = [f];
      metrics.push("coExposurePpmMin", "heatFluxExposureKwSecM2", "lowVisibilityTimeSec", "temperatureExposure", "tenabilityCounts");
      invariants.push("煙・CO・熱曝露が有限で非負である", "criticalを死亡人数に読み替えない");
      notes.push("内部の簡易火災・煙モデルを使用する。実測への校正や安全認証の精度検証を意味しない。");
      break;
    }
    case "B07": {
      const f = floor();
      rectangle(f, 48, 1, 48, 56, "#");
      f.exits.push(point(2, 29));
      spawnRectangle(f, 3, 2, 45, 55);
      spawnRectangle(f, 50, 2, 92, 55);
      floors = [f];
      invariants.push("閉鎖された右領域の歩行者を生成人数から除外しない", "右領域から壁を通り抜けて出口へ到達しない");
      metrics.push("initialUnreachableCount", "unreachableRemainingCount");
      notes.push("左右に同数の開始候補があるが、復元抽出のため到達不能者数は人口の厳密な半数には固定されない。");
      break;
    }
    case "B08": {
      const f = floor();
      for (const [cx, gapY] of [[24, 8], [48, 42], [72, 8]]) {
        rectangle(f, cx, 1, cx, 56, "#");
        rectangle(f, cx, gapY, cx, gapY + 7);
      }
      f.exits.push(point(2, 29), point(93, 29));
      spawnRectangle(f, 2, 2, 93, 55);
      floors = [f];
      metrics.push("pedestrianDurationMs", "routingDurationMs", "smokeDurationMs", "fireDurationMs", "renderDurationMs");
      notes.push("96×58セルの複数区画で人口負荷を比較する。廊下の開口は交互の位置にあり、単純な直線距離ではない。");
      break;
    }
    case "B09": {
      floors = [floor(), floor()];
      floors[0].exits.push(point(2, 29));
      floors[1].exits.push(point(93, 29));
      stairLinks = [link(floors, { floor: 0, cx: 48, cy: 29 }, { floor: 1, cx: 48, cy: 29 })];
      for (const f of floors) spawnRectangle(f, 2, 2, 93, 55);
      invariants.push("階段リンク以外で階を移動しない", "共有階段の同時利用数は設定容量2以下", "双方向の実通過がない場合は対向流のcoverage未達と記録する");
      metrics.push("stairPassagesByDirection", "bidirectionalTrafficObserved", "stairWaitingTimeSec", "stairDeadlockCandidates");
      notes.push("両階に開始候補と出口を置くが、既存の目的出口選択のまま同一リンクの双方向通過は強制できない。fixtureの存在だけで対向流・デッドロックを検証済みとしない。");
      break;
    }
    case "B10": {
      const f = floor();
      f.exits.push(point(2, 29), point(93, 29));
      spawnRectangle(f, 2, 2, 93, 55);
      floors = [f];
      fdsCsv = [
        "time_s,floor,cx,cy,sample_height_m,heat_flux_kw_m2,extinction_coefficient_m_1,co_ppm,visibility_m,temperature_c",
        "0,1,48,29,1.2,0,0,0,30,20",
        "0,1,48,29,2.0,0,0,0,30,20",
        "10,1,48,29,1.2,1,0.1,100,25,35",
        "10,1,48,29,2.0,3,0.3,300,10,65",
        "10,1,49,29,1.6,2,0.2,150,15,45",
        "20,1,48,29,1.2,0,0,0,30,20",
        "20,1,48,29,2.0,0,0,0,30,20",
        "30,1,49,29,1.6,,,0,,"
      ].join("\n") + "\n";
      metrics.push("fdsActive", "fdsAppliedTimesSec", "fdsEyeHeightValues", "fdsExplicitZeroPreserved", "fdsDataSourceCounts");
      invariants.push("採取高さ1.2/2.0mを別レコードとして保持する", "明示的0を欠損値として扱わない", "FDSの観測値を内部煙層の保存量と混同しない");
      notes.push("CSVは取込試験用の人工データでありFDSを実行した解析結果ではない。1.6mの高さ補間、複数時刻、明示的0と疎な更新を含む。");
      break;
    }
    case "B11": {
      const f = floor();
      rectangle(f, 58, 1, 58, 56, "#");
      rectangle(f, 58, 28, 58, 29);
      f.exits.push(point(93, 29));
      // Keep a nominal initial support density close to 4 people/m² at every
      // standard population; only this declared support region changes with N.
      const supportWidth = Math.ceil(Math.sqrt(2 * population));
      const supportHeight = Math.ceil(population / supportWidth);
      spawnRectangle(f, 4, 4, 3 + supportWidth, 3 + supportHeight);
      floors = [f];
      metrics.push("bodyOverlapDepthM", "contactCount", "peakLocalDensityPeoplePerM2", "bottleneckQueueTimeSec");
      invariants.push("高密度条件でも人数を保持し、非有限値や異常な壁侵入を検出する");
      notes.push("初期候補の支持領域平均は約4人/m²で、通常シナリオの2人/m²上限の明示的例外。復元抽出による同一点への生成を身体接触の初期条件と混同せず記録する。");
      break;
    }
    case "B12": {
      floors = [floor(), floor(), floor()];
      floors[0].exits.push(point(2, 29), point(93, 29));
      stairLinks = [
        link(floors, { floor: 0, cx: 12, cy: 29 }, { floor: 1, cx: 12, cy: 29 }),
        link(floors, { floor: 1, cx: 83, cy: 29 }, { floor: 2, cx: 83, cy: 29 })
      ];
      spawnRectangle(floors[2], 2, 2, 93, 55);
      metrics.push("stairPassageCounts", "stairWaitingTimeSec", "floorOccupancy", "crossFloorContinuityViolations");
      invariants.push("3Fからの避難は3F→2F→1Fの2本の明示リンクを順に通る", "階段移動中も人数集計から消失しない");
      notes.push("上階だけに開始候補を置く。中間階の離れた着地点を歩いて次の階段に到達する必要がある。");
      break;
    }
  }

  const serializedFloors = floors.map(f => ({
    rows: f.cells.map(row => row.join("")),
    exits: f.exits,
    spawns: f.spawns,
    fires: f.fires,
    stairs: f.stairs
  }));
  const walkableCells = serializedFloors.reduce((sum, f) => sum + f.rows.reduce((s, row) =>
    s + [...row].filter(cell => cell === ".").length, 0), 0);
  const floorCandidateCounts = floors.map(f => f.spawns.length);
  const candidateCount = floorCandidateCounts.reduce((sum, count) => sum + count, 0);
  const cellAreaM2 = CELL_SIZE_METERS ** 2;

  return {
    schemaVersion: 1,
    ...definition,
    cellSizeMeters: CELL_SIZE_METERS,
    floors: serializedFloors,
    stairLinks,
    fdsCsv,
    settings,
    invariants,
    metrics,
    population,
    observationTimeSec: 60,
    seed: null,
    initialPlacement: {
      sampling: "with-replacement",
      candidateCount,
      floorCandidateCounts,
      supportAreaM2: candidateCount * cellAreaM2,
      nominalSupportDensityPeoplePerM2: population / (candidateCount * cellAreaM2),
      note: "spawnsは全候補セルであり避難者ごとの固定実配置ではない。本体は候補を復元抽出するため同一点への複数生成があり、実際の初期位置と重なりは各実行結果に保存する。"
    },
    geometry: {
      walkableCells,
      walkableAreaM2: walkableCells * cellAreaM2,
      nominalDensityPeoplePerM2: population / (walkableCells * cellAreaM2)
    },
    notes: [
      "seed導入前の本体Math.randomを使用する。speedVar=0でも本体の身体属性・希望速度分布の乱数は残る。",
      "60秒は固定観測窓であり、未完了試行の避難完了時間を60秒と見なさない。",
      ...notes
    ]
  };
}
