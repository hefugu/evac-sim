import { readFile } from 'node:fs/promises';
import { instrumentSource } from './instrumentation.mjs';

// この乱数制御は既存browser testsと同じく試験専用。本製品のseed実装ではない。
export async function preparePage(page, { seed = 13579, nativeRandom = false, realtime = false, instrument = true } = {}) {
  if (instrument) {
    for (const [file, name] of [['core.js', 'core'], ['pedestrian-dynamics.js', 'pedestrian']]) {
      const source = await readFile(new URL(`../sim/js/simulation/${file}`, import.meta.url), 'utf8');
      await page.route(`**/sim/js/simulation/${file}`, route => route.fulfill({
        contentType: 'text/javascript', body: instrumentSource(source, name)
      }));
    }
  }
  await page.addInitScript(({ seed, nativeRandom, realtime }) => {
    let randomState = seed >>> 0;
    const originalRAF = window.requestAnimationFrame.bind(window);
    const originalCancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map();
    let nextId = 0;
    const compact = a => ({ id: a.id, x: a.x, y: a.y, floor: a.floor, floorIndex: a.floorIndex,
      vxMps: a.vxMps, vyMps: a.vyMps, finished: a.finished, dead: a.dead,
      radiusM: a.radiusM, stairTransition: a.stairTransition ? { ...a.stairTransition } : null });
    const bench = window.__evacBench = {
      enabled: false, state: null, samples: [], timing: {}, rafIntervalsMs: [], now: 0,
      frame: null, lastTime: 0, snapshotMs: 0, lastRAF: null,
      resetRandom() { randomState = seed >>> 0; },
      record(label, ms) { if (this.enabled) (this.timing[label] ??= []).push(ms); },
      capture() {
        if (!this.enabled || !this.state || this.state.sim.time <= this.lastTime + 1e-9) return;
        const start = performance.now();
        this.samples.push({ time: this.state.sim.time, agents: this.state.agents.map(compact),
          stairCongestion: this.state.sim.stairCongestion.map(s => ({ ...s })) });
        this.lastTime = this.state.sim.time;
        this.snapshotMs += performance.now() - start;
      },
      begin(state) {
        this.state = state; this.timing = {}; this.samples = [{ time: 0, agents: state.agents.map(compact),
          stairCongestion: state.sim.stairCongestion.map(s => ({ ...s })) }];
        this.lastTime = 0; this.now = performance.now(); this.enabled = true; this.snapshotMs = 0;
      },
      pump() {
        this.now += 100; // productionの共有0.1秒clockに1回分のRAFを与える。
        const ids = [...pending.keys()];
        for (const id of ids) {
          const callback = pending.get(id);
          if (!callback) continue;
          pending.delete(id);
          callback(this.now);
        }
      }
    };
    if (!nativeRandom) Math.random = () => ((randomState = (1664525 * randomState + 1013904223) >>> 0) / 4294967296);
    window.requestAnimationFrame = callback => {
      const wrapped = now => {
        const before = bench.state?.sim.time;
        const start = performance.now();
        callback(now);
        if (bench.enabled && bench.state?.sim.time > before) {
          bench.record('physicsFrameIncludingRender', performance.now() - start);
          if (bench.lastRAF != null) bench.rafIntervalsMs.push(now - bench.lastRAF);
          bench.lastRAF = now;
          bench.capture();
        }
      };
      if (realtime) return originalRAF(wrapped);
      const id = ++nextId; pending.set(id, wrapped); return id;
    };
    window.cancelAnimationFrame = id => realtime ? originalCancel(id) : pending.delete(id);
  }, { seed, nativeRandom, realtime });
}

export async function loadScenario(page, baseURL, scenario) {
  await page.goto(`${baseURL}/sim/`);
  await page.locator('#mapFile').waitFor();
  await page.evaluate(({ population, settings, cellSizeMeters, count }) => {
    for (const detail of document.querySelectorAll('details')) detail.open = true;
    for (const [id, value] of Object.entries({ numAgents: population, speed: settings.speed,
      speedVar: settings.speedVar, cellSizeMeters, floorCount: count,
      startRule: settings.startRule, mapCellPixels: 4, mapSampleMode: 'center', agentPreset: settings.agentPreset,
      fireGrowthRate: settings.fireGrowthRate, fireMaxHrrKw: settings.fireMaxHrrKw, fireAreaM2: settings.fireAreaM2 })) {
      const input = document.getElementById(id);
      if (!input) throw new Error(`入力欄がありません: ${id}`);
      input.value = String(value); input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (const [type, ratio] of Object.entries(settings.ratios || {})) {
      if (type === 'adult') continue;
      const input = document.getElementById(`ratio${type[0].toUpperCase()}${type.slice(1)}`);
      if (input) input.value = String(ratio);
    }
    document.getElementById('optimizeReverse').checked = !!settings.optimizeReverse;
    for (const [id, value] of Object.entries({ detectionTimeSec: settings.responseTime.detectionSec,
      reactionMinSec: settings.responseTime.minSec, reactionModeSec: settings.responseTime.modeSec,
      reactionMaxSec: settings.responseTime.maxSec })) document.getElementById(id).value = String(value);
    document.getElementById('btnApplyFloors').click();
  }, { population: scenario.population, settings: scenario.settings,
    cellSizeMeters: scenario.cellSizeMeters, count: scenario.floors.length });
  for (let floor = 0; floor < scenario.floors.length; floor++) {
    await page.locator('#currentFloor').selectOption(String(floor));
    const png = await page.evaluate(rows => {
      const canvas = document.createElement('canvas');
      canvas.width = rows[0].length * 4; canvas.height = rows.length * 4;
      const ctx = canvas.getContext('2d');
      rows.forEach((row, y) => [...row].forEach((value, x) => {
        ctx.fillStyle = value === '#' ? 'black' : 'white'; ctx.fillRect(x * 4, y * 4, 4, 4);
      }));
      return canvas.toDataURL('image/png').split(',')[1];
    }, scenario.floors[floor].rows);
    await page.locator('#mapFile').setInputFiles({ name: `${scenario.id}-${floor}.png`, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.waitForFunction(async ({ floor, width, height }) => {
      const { state } = await import('/sim/js/state.js');
      const fs = state.map.floorStates[floor];
      return !!fs?.baseImage && fs.grid?.length === height && fs.grid[0]?.length === width;
    }, { floor, width: scenario.floors[floor].rows[0].length, height: scenario.floors[floor].rows.length }, { polling: 25 });
  }
  // 全階画像の読込後にmarkerを配置（最初の画像で他階が初期化される既存仕様）。
  await page.evaluate(async scenario => {
    const { state } = await import('/sim/js/state.js');
    function select(floor) {
      const input = document.getElementById('currentFloor'); input.value = String(floor);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function marker(floor, mode, point) {
      select(floor);
      const canvas = document.getElementById('simCanvas'), rect = canvas.getBoundingClientRect();
      const image = state.map.floorStates[floor].baseImage;
      const scale = Math.min(rect.width / image.width, rect.height / image.height);
      document.getElementById(mode).click();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1,
        clientX: rect.left + (rect.width - image.width * scale) / 2 + (point.cx + 0.5) * 4 * scale,
        clientY: rect.top + (rect.height - image.height * scale) / 2 + (point.cy + 0.5) * 4 * scale }));
    }
    for (let floor = 0; floor < scenario.floors.length; floor++) {
      const spec = scenario.floors[floor];
      // 候補点の直接設定はfixture準備のみ。人数生成と歩行は既存production code。
      const spawns = state.map.floorStates[floor].spawns;
      spawns.splice(0, spawns.length, ...spec.spawns.map(p => ({ ...p, r: 0 })));
      for (const p of spec.stairs) marker(floor, 'modeStair', p);
      for (const p of spec.fires) marker(floor, 'modeFire', p);
    }
    for (const link of scenario.stairLinks) {
      document.getElementById('stairTravelCost').value = String(link.travelCostSec);
      document.getElementById('stairCapacity').value = String(link.congestionCapacity);
      marker(link.a.floor, 'modeStairLink', link.a);
      marker(link.b.floor, 'modeStairLink', link.b);
    }
    for (let floor = 0; floor < scenario.floors.length; floor++)
      for (const p of scenario.floors[floor].exits) marker(floor, 'modeExit', p);
    select(0);
    state.hazards.tenabilityOptions = { ...state.hazards.tenabilityOptions,
      maxSimulationTimeSec: scenario.observationTimeSec, policyId: 'benchmark-observation-v1' };
    window.__evacBench.state = state;
    // 画像から取り込まれた実際の地形・markersを照合してfixtureの欠落を検出。
    scenario.floors.forEach((spec, index) => {
      const floor = state.map.floorStates[index];
      if (floor.cellSizeMeters !== scenario.cellSizeMeters || floor.spawns.length !== spec.spawns.length || floor.exits.length !== spec.exits.length)
        throw new Error(`fixtureのmarker/寸法が不一致: floor=${index}`);
      spec.rows.forEach((row, y) => [...row].forEach((value, x) => {
        if (!!floor.grid[y][x].wall !== (value === '#')) throw new Error(`fixtureの壁が不一致: ${index}/${x}/${y}`);
      }));
    });
    if (state.map.stairLinks.length !== scenario.stairLinks.length) throw new Error('階段リンク数が不一致');
  }, scenario);
  if (scenario.fdsCsv) {
    await page.locator('#fdsCsvFile').setInputFiles({ name: `${scenario.id}-fds.csv`, mimeType: 'text/csv', buffer: Buffer.from(scenario.fdsCsv) });
    await page.waitForFunction(async () => {
      const { state } = await import('/sim/js/state.js');
      return state.hazards.fds.active && state.hazards.fds.rows > 0;
    }, undefined, { polling: 25 });
  }
}

export async function beginRun(page) {
  return page.evaluate(async () => {
    const { state } = await import('/sim/js/state.js');
    const b = window.__evacBench;
    b.resetRandom();
    document.getElementById('btnStart').click();
    if (!state.sim.running || state.agents.length === 0) throw new Error('production simulationを開始できません');
    b.begin(state);
    const copyAgent = ({ potentialField, ...agent }) => agent;
    return { agents: state.agents.map(copyAgent), exits: state.map.allExitPoints,
      floors: state.map.floorStates.map(f => ({ cellSizeMeters: f.cellSizeMeters, rows: f.grid.map(row => row.map(c => c.wall ? '#' : '.').join('')) })) };
  });
}

export async function advanceRun(page, { realtime = false, batchSize = 50 } = {}) {
  if (realtime) await new Promise(resolve => setTimeout(resolve, 100));
  return page.evaluate(({ realtime, batchSize }) => {
    const b = window.__evacBench;
    if (!realtime) for (let i = 0; i < batchSize && b.state.sim.running; i++) b.pump();
    return { running: b.state.sim.running, time: b.state.sim.time };
  }, { realtime, batchSize });
}

export async function finishRun(page) {
  return page.evaluate(() => {
    const b = window.__evacBench, state = b.state;
    b.enabled = false;
    return {
      agents: state.agents.map(({ potentialField, ...agent }) => agent),
      simTime: state.sim.time, summary: state.sim.lastSummary,
      samples: b.samples, timing: b.timing, snapshotMs: b.snapshotMs,
      stairCongestion: state.sim.stairCongestion, rafIntervalsMs: b.rafIntervalsMs,
      // 最終物理状態のdigest用。描画状態と実行日時は含めない。
      hazards: state.map.floorStates.map(f => ({ grid: f.grid, smokeMap: f.smokeMap,
        soot: Array.from(f.smokePhysics?.sootMassKg || []), co: Array.from(f.smokePhysics?.coMassKg || []),
        heat: Array.from(f.smokePhysics?.excessHeatKJ || []), volume: Array.from(f.smokePhysics?.hotGasVolumeM3 || []) })),
      modelSettings: state.sim.lastSummary ? { fire: state.sim.lastSummary.fireModel,
        smoke: state.hazards.smokeModelOptions, tenability: state.sim.lastSummary.tenabilityOptions } : null,
      fds: { active: state.hazards.fds.active, rows: state.hazards.fds.rows }
    };
  });
}
