import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { resolve, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { listScenarios, buildScenario } from './scenarios.mjs';
import { summarizeRun, toCsv, compareRuns } from './metrics.mjs';
import { preparePage, loadScenario, beginRun, advanceRun, finishRun } from './browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const has = key => args.includes(`--${key}`);
const arg = (key, fallback) => {
  const index = args.indexOf(`--${key}`);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`--${key} の値が必要です`);
  return args[index + 1];
};
const positive = (value, name) => { const n = Number(value); if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} は正の整数です`); return n; };
const known = ['smoke', 'scenarios', 'populations', 'repeats', 'seconds', 'seed', 'native-random', 'realtime', 'no-instrumentation', 'out', 'compare', 'save-agents', 'help'];
for (const token of args.filter(a => a.startsWith('--'))) if (!known.includes(token.slice(2))) throw new Error(`未知のオプション: ${token}`);
if (has('help')) {
  console.log('node benchmarks/run.mjs [--smoke] [--scenarios B01,B02|all] [--populations 100,400,1000] [--seconds 60] [--repeats 3] [--seed 13579|文字列] [--native-random] [--realtime] [--no-instrumentation] [--out benchmarks/results/run] [--compare baseline.json] [--save-agents]');
  process.exit(0);
}
const scenarioIds = arg('scenarios', has('smoke') ? 'B01,B05,B06,B07,B10,B12' : 'all');
const ids = scenarioIds === 'all' ? listScenarios().map(s => typeof s === 'string' ? s : s.id) : scenarioIds.split(',');
const populations = arg('populations', has('smoke') ? '6' : '100,400,1000').split(',').map(n => positive(n, 'population'));
const repeats = positive(arg('repeats', has('smoke') ? '2' : '1'), 'repeats');
const secondsArg = arg('seconds', has('smoke') ? '2' : null);
const seconds = secondsArg == null ? null : Number(secondsArg);
if (seconds != null && (!(seconds > 0) || !Number.isFinite(seconds) || Math.abs(seconds * 10 - Math.round(seconds * 10)) > 1e-8)) throw new Error('seconds は正の0.1秒刻みです');
const seedText = arg('seed', '13579');
const seed = /^\d+$/.test(seedText) ? Number(seedText) >>> 0 : createHash('sha256').update(seedText).digest().readUInt32LE(0);
const realtime = has('realtime'), instrument = !has('no-instrumentation'), nativeRandom = has('native-random');
const out = resolve(root, arg('out', 'benchmarks/results/latest'));
const json = value => JSON.stringify(value, (_, v) => typeof v === 'number' && !Number.isFinite(v) ? String(v) : v, 2) + '\n';
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const sha256 = value => createHash('sha256').update(value).digest('hex');
function stats(values = []) {
  if (!values.length) return { count: 0, totalMs: null, meanMs: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b), total = values.reduce((s, v) => s + v, 0);
  return { count: values.length, totalMs: total, meanMs: total / values.length, p95Ms: sorted[Math.ceil(values.length * 0.95) - 1] };
}
async function serve() {
  const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = resolve(root, `.${pathname}`);
      const rel = relative(root, file);
      if (rel.startsWith('..') || rel.split(/[\\/]/).some(p => p.startsWith('.'))) { res.writeHead(403).end(); return; }
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'text/plain', 'Cache-Control': 'no-store' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, baseURL: `http://127.0.0.1:${server.address().port}` };
}

const runtimeFiles = ['sim/js/simulation/core.js', 'sim/js/simulation/pedestrian-dynamics.js', 'sim/js/simulation/smoke3d.js', 'sim/js/simulation/fire3d.js', 'sim/js/simulation/stairs3d.js'];
const manifest = {
  schemaVersion: 1, createdAt: new Date().toISOString(), commitSHA: git('rev-parse', 'HEAD'),
  harnessVersion: 'benchmark-v1', harnessHashes: {},
  runtimeDirtyFiles: git('diff', 'HEAD', '--name-only', '--', 'sim', 'server', 'client', 'admin').split('\n').filter(Boolean),
  modelVersion: '既存mainの実装（独立したモデル版番号は未導入）',
  environment: { platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version,
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  random: { scope: 'benchmark-harness-only', algorithm: nativeRandom ? 'native-Math.random-uncontrolled' : 'test-lcg32-v1', seed: nativeRandom ? null : seed, inputSeed: nativeRandom ? null : seedText,
    repeatPolicy: nativeRandom ? '独立な未固定乱数試行、同条件完全再現の保証なし' : '各repeatで同じ試験用乱数へ復元。製品seed機能の検証ではない' },
  driver: { mode: realtime ? 'native-browser-RAF' : 'controlled-production-RAF-100ms', physicsStepSec: 0.1, instrumentation: instrument,
    note: 'productionの共有clock/実行loopを使用。performance.nowは実時計。計測・snapshotの負荷を含む環境依存測定。' },
  sourceHashes: {}, scenarios: [], runs: [], comparison: null, completed: false, failure: null
};
for (const file of runtimeFiles) manifest.sourceHashes[file] = sha256(await readFile(resolve(root, file)));
for (const file of ['run.mjs', 'browser.mjs', 'instrumentation.mjs', 'metrics.mjs', 'scenarios.mjs'])
  manifest.harnessHashes[file] = sha256(await readFile(resolve(root, 'benchmarks', file)));
await mkdir(dirname(out), { recursive: true });
const { server, baseURL } = await serve();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  manifest.environment.browser = browser.version();
  for (const id of ids) for (const population of populations) {
    const scenario = buildScenario(id, population);
    if (seconds != null) scenario.observationTimeSec = seconds;
    manifest.scenarios.push(scenario);
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      page.on('dialog', async dialog => { errors.push(`dialog: ${dialog.message()}`); await dialog.dismiss(); });
      try {
        const setupStarted = performance.now();
        await preparePage(page, { seed, nativeRandom, realtime, instrument });
        await loadScenario(page, baseURL, scenario);
        const setupWallMs = performance.now() - setupStarted;
        const cdp = await context.newCDPSession(page);
        await cdp.send('Performance.enable');
        const startupStarted = performance.now();
        const initial = await beginRun(page);
        const startupWallMs = performance.now() - startupStarted;
        let maxJsHeapBytes = null, status, batches = 0;
        const started = performance.now();
        do {
          status = await advanceRun(page, { realtime });
          const metrics = await cdp.send('Performance.getMetrics');
          const heap = metrics.metrics.find(m => m.name === 'JSHeapUsedSize')?.value;
          if (Number.isFinite(heap)) maxJsHeapBytes = Math.max(maxJsHeapBytes ?? 0, heap);
          if (++batches > 100_000 || performance.now() - started > Math.max(300_000, scenario.observationTimeSec * 5000)) throw new Error('ベンチマークの実時間上限を超えました');
        } while (status.running);
        const executionWallMs = performance.now() - started;
        const final = await finishRun(page);
        const timing = Object.fromEntries(Object.entries(final.timing).map(([key, values]) => [key, stats(values)]));
        const perf = {
          timing, setupWallMs, startupWallMs, executionWallMs, msPerSimulationSecond: executionWallMs / final.simTime,
          wallTimeScope: 'setupWallMsはfixture読込、startupWallMsは人口生成/初期経路/index、executionWallMsは実行loop+snapshot+CDP採取+通信。後処理とファイル書込を除外。',
          physicsCpuMsPerSimulationSecond: instrument && timing.step ? timing.step.totalMs / final.simTime : null,
          snapshotCpuMs: final.snapshotMs, sampledMaxJsHeapBytes: maxJsHeapBytes,
          memoryScope: 'CDP JSHeapUsedSizeをbatchごとに採取した最大。ブラウザ全体RSS・真のpeakではない。',
          renderFps: realtime && timing.render ? timing.render.count * 1000 / executionWallMs : null,
          fpsScope: realtime ? 'native RAFで観測した2D render呼出し数/実時間。画面present/GPU FPSは未測定。' : '制御RAFのため表示FPSは未測定。合成時刻からFPSを生成しない。',
          unavailable: [...(instrument ? [] : ['関数別CPU時間（instrumentation無効）']),
            ...(maxJsHeapBytes == null ? ['CDP heap値なし'] : []), ...(!timing.step ? ['step CPU時間なし'] : [])],
          timingScope: 'stepはproduction stepSimulation全体（終了時に内包する描画を含む）。routing/歩行者/agentBlock/renderは包含関係があり合算不可。'
        };
        const result = summarizeRun({ initialAgents: initial.agents, agents: final.agents, simTime: final.simTime,
          requestedPopulation: population, exits: initial.exits, floors: initial.floors,
          stairCongestion: final.stairCongestion, summary: final.summary, samples: final.samples, performance: perf });
        if (errors.length) result.invariants.violations.push(...errors.map(error => ({ type: 'browser-error', message: error })));
        if (scenario.fdsCsv && (!final.fds.active || !(final.fds.rows > 0))) result.invariants.violations.push({ type: 'fds-not-applied', message: 'FDS fixtureが有効になっていません' });
        result.invariants.passed = result.invariants.violations.length === 0;
        const run = { scenarioId: id, population, repeat, observationTimeSec: scenario.observationTimeSec,
          result, initialStateDigest: sha256(json(initial.agents)),
          finalPhysicsDigest: sha256(json({ agents: final.agents, hazards: final.hazards })),
          modelSettings: final.modelSettings, fds: final.fds,
          coverage: { bidirectionalStairFlow: id === 'B09' ? '未保証。共有リンクの方向別OD指定が製品にない。既存stairs Node回帰を別途参照。' : null,
            sampling: realtime ? 'RAF末尾sample。1frame複数step時は中間状態を採取せず、速度/待機積分はframe間近似。' : '0.1秒production step後に採取。',
            bodyWallContact: '壁中心とstep端点間の線分を検査。身体外周・内部substepの曲線軌跡は未検証。' } };
        const previous = manifest.runs.find(r => r.scenarioId === id && r.population === population);
        if (previous && !nativeRandom) {
          run.repeatCheck = { initialEqual: previous.initialStateDigest === run.initialStateDigest,
            finalEqual: previous.finalPhysicsDigest === run.finalPhysicsDigest,
            scope: '同一ブラウザ・試験用LCG・同一観測窓。本製品seed/Reset/MC100の保証ではない。' };
          if (!run.repeatCheck.initialEqual || !run.repeatCheck.finalEqual) {
            result.invariants.violations.push({ type: 'harness-repeat-mismatch', message: '同一試験入力の状態digestが一致しません' });
            result.invariants.passed = false;
          }
        }
        if (has('save-agents')) { run.initialAgents = initial.agents; run.finalAgents = final.agents; }
        manifest.runs.push(run);
        // 重い手動試験の途中失敗でも、完了済みrunの測定値を残す。
        await writeFile(`${out}.partial.json`, json(manifest));
        console.log(`${id} population=${population} repeat=${repeat} sim=${final.simTime.toFixed(1)}s complete=${result.population.completed}/${population} wall=${executionWallMs.toFixed(0)}ms invariants=${result.invariants.passed ? 'PASS' : 'FAIL'}`);
      } finally { await context.close(); }
    }
  }
  if (has('compare')) {
    const compareFile = resolve(root, arg('compare'));
    const input = await readFile(compareFile);
    const baseline = JSON.parse(compareFile.endsWith('.gz') ? gunzipSync(input).toString('utf8') : input.toString('utf8'));
    manifest.comparison = manifest.runs.map(run => {
      const before = baseline.runs.find(b => b.scenarioId === run.scenarioId && b.population === run.population && b.repeat === run.repeat);
      const compatible = before && before.observationTimeSec === run.observationTimeSec && JSON.stringify(baseline.random) === JSON.stringify(manifest.random) && JSON.stringify(baseline.driver) === JSON.stringify(manifest.driver)
        && JSON.stringify(baseline.environment) === JSON.stringify(manifest.environment)
        && JSON.stringify(baseline.harnessHashes) === JSON.stringify(manifest.harnessHashes)
        && JSON.stringify(baseline.scenarios.find(s => s.id === run.scenarioId && s.population === run.population)) === JSON.stringify(manifest.scenarios.find(s => s.id === run.scenarioId && s.population === run.population));
      return { scenarioId: run.scenarioId, population: run.population, repeat: run.repeat,
        comparable: !!compatible, reason: compatible ? null : 'シナリオ/観測窓/乱数/driver/環境/harnessが一致するbaselineなし',
        delta: compatible ? compareRuns(before.result, run.result) : null };
    });
  }
  manifest.completed = true;
  await writeFile(`${out}.json`, json(manifest));
  await writeFile(`${out}.csv`, toCsv(manifest.runs.map(run => ({ commitSHA: manifest.commitSHA, modelVersion: manifest.modelVersion,
    createdAt: manifest.createdAt, environment: manifest.environment, random: manifest.random,
    ...run }))));
  const fmt = value => value == null ? '未測定' : Number(value).toFixed(2);
  const report = ['# evac-sim 標準ベンチマーク', '', `取得日時: ${manifest.createdAt} / commit: ${manifest.commitSHA}`, '',
    `環境: ${manifest.environment.cpu} / ${manifest.environment.platform} / Node ${process.version} / Chromium ${manifest.environment.browser}`, '',
    `乱数: ${manifest.random.algorithm} / seed: ${manifest.random.seed ?? '未固定'} / driver: ${manifest.driver.mode}`, '',
    'これは改修比較の基盤です。製品精度・安全認証・実機画面FPSの検証結果ではありません。未完了試行の完了時間はnull、平均/P95は完了者だけで計算します。', '',
    '| ID | 人数 | 試行 | 完了 | 打切り | 全員完了秒 | 完了者平均秒 | P95秒 | step平均ms | step P95ms | 実時間ms | 不変条件 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...manifest.runs.map(r => `| ${r.scenarioId} | ${r.population} | ${r.repeat} | ${r.result.population.completed} | ${r.result.population.censored} | ${fmt(r.result.completionTimeSec)} | ${fmt(r.result.completedOnlyTimeSec.mean)} | ${fmt(r.result.completedOnlyTimeSec.p95)} | ${fmt(r.result.performance.timing.step?.meanMs)} | ${fmt(r.result.performance.timing.step?.p95Ms)} | ${fmt(r.result.performance.executionWallMs)} | ${r.result.invariants.passed ? 'PASS' : 'FAIL'} |`), '',
    '詳細は同名JSON/CSVに保存。stepは終了時描画を含み、各成分は包含関係があるため合算不可。heapはbatch採取最大、制御RAFの表示FPSは未測定。初期配置は候補点から復元抽出され、初期重複は診断として別記。', '',
    '同じ試験seedの再実行は本製品のseed/Reset/MC100の完全再現性を保証しません。B09の双方向流発生は未保証です。商用製品との数値比較は未実施です。', '',
    ...(manifest.comparison ? ['比較差分はJSONのcomparisonを参照。同条件の数値差であり、単一試行から性能改善や精度向上を認定しません。', ''] : [])].join('\n');
  await writeFile(`${out}.md`, report);
  await unlink(`${out}.partial.json`).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (manifest.runs.some(run => !run.result.invariants.passed)) process.exitCode = 1;
} catch (error) {
  manifest.failure = { message: String(error), at: new Date().toISOString() };
  await writeFile(`${out}.partial.json`, json(manifest));
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
