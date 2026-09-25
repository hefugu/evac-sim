import { test, expect } from "@playwright/test";

// Small image uploads exercise the actual map loader and UI marker handlers.
// No test-only simulation entry point or independent physics clock is used.
async function loadRoom(page) {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 80, 48);
    ctx.fillStyle = "white";
    ctx.fillRect(4, 4, 72, 40);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#mapFile").setInputFiles({
    name: "runtime-test-room.png", mimeType: "image/png", buffer: Buffer.from(png, "base64")
  });
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    return !!state.map.floorStates[state.map.currentFloor]?.baseImage;
  })).toBe(true);
}

async function loadScitech3F(page) {
  // The default browser fixture is a small synthetic room. Reload first so
  // the real 600x800 map is not correctly rejected as a mismatched floor size.
  await page.goto("/sim/");
  await page.locator("details").evaluateAll(elements => {
    for (const element of elements) element.open = true;
  });
  const base64 = await page.evaluate(async () => {
    const response = await fetch("/sim/assets/maps/scitech_3f_walkable.png.base64");
    if (!response.ok) throw new Error(`3F fixture fetch failed: ${response.status}`);
    return (await response.text()).trim();
  });
  await page.locator("#mapFile").setInputFiles({
    name: "3F.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64")
  });
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    const floor = state.map.floorStates[state.map.currentFloor];
    return floor?.mapProfile || null;
  })).toBe("scitech-3f");
}

async function marker(page, mode, cx, cy) {
  await page.evaluate(async ({ mode, cx, cy }) => {
    const { state } = await import("/sim/js/state.js");
    const canvas = document.querySelector("#simCanvas");
    const rect = canvas.getBoundingClientRect();
    const image = state.map.floorStates[state.map.currentFloor].baseImage;
    const scale = Math.min(rect.width / image.width, rect.height / image.height);
    const offsetX = (rect.width - image.width * scale) / 2;
    const offsetY = (rect.height - image.height * scale) / 2;
    document.getElementById(mode).click();
    canvas.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, button: 0, pointerId: 1,
      clientX: rect.left + offsetX + (cx + 0.5) * 4 * scale,
      clientY: rect.top + offsetY + (cy + 0.5) * 4 * scale
    }));
  }, { mode, cx, cy });
}

async function configureAgent(page, speed = "1.2") {
  await page.locator("#numAgents").fill("1");
  await page.locator("#speed").fill(speed);
  await page.locator("#speedVar").fill("0");
  await page.locator("#startRule").selectOption("simultaneous");
  await page.locator("#agentPreset").selectOption("custom");
  for (const id of ["ratioChild", "ratioElderly", "ratioPanic", "ratioLeader", "ratioTeacher", "ratioStudent"]) {
    await page.locator(`#${id}`).fill("0");
  }
}

test.beforeEach(async ({ page }) => {
  // Reproducible movement noise while retaining the actual model's RNG calls.
  await page.addInitScript(() => {
    let seed = 13579;
    Math.random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  });
  await page.clock.install();
  await page.goto("/sim/");
  await loadRoom(page);
  await page.locator("details").evaluateAll(elements => {
    for (const element of elements) element.open = true;
  });
});


test("real 3F map loads with calibrated topology and scale", async ({ page }) => {
  await loadScitech3F(page);

  const topology = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    const floor = state.map.floorStates[state.map.currentFloor];
    let walkable = 0;
    let stairs = 0;
    for (const row of floor.grid) {
      for (const cell of row) {
        if (cell.walkable) walkable++;
        if (cell.stair) stairs++;
      }
    }
    return {
      profile: floor.mapProfile,
      width: floor.gridWidth,
      height: floor.gridHeight,
      cellSizeMeters: floor.cellSizeMeters,
      walkable,
      stairs,
      imageWidth: floor.baseImage?.width,
      imageHeight: floor.baseImage?.height
    };
  });

  expect(topology).toEqual({
    profile: "scitech-3f",
    width: 150,
    height: 200,
    cellSizeMeters: 0.42,
    walkable: 2889,
    stairs: 640,
    imageWidth: 600,
    imageHeight: 800
  });
});

test("real 3F map evacuates a small crowd through a corridor exit without stragglers", async ({ page }) => {
  await loadScitech3F(page);
  await configureAgent(page, "1.2");
  await page.locator("#numAgents").fill("12");
  await page.locator("#agentPreset").selectOption("default");

  // Lower-right horizontal corridor: 20 cells ~= 8.4 m at the calibrated scale.
  await marker(page, "modeSpawn", 118, 153);
  await marker(page, "modeSpawn", 118, 154);
  await marker(page, "modeSpawn", 118, 155);
  await marker(page, "modeExit", 138, 154);

  await page.locator("#btnStart").click();
  await page.clock.runFor(30_000);

  const result = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    return {
      running: state.sim.running,
      evacuated: state.agents.filter(a => a.finished).length,
      active: state.agents.filter(a => !a.finished && !a.dead).map(a => ({
        id: a.id,
        x: a.x,
        y: a.y,
        type: a.type,
        targetExitIndex: a.targetExitIndex
      })),
      dead: state.agents.filter(a => a.dead).length
    };
  });

  expect(result.dead).toBe(0);
  expect(result.active).toEqual([]);
  expect(result.evacuated).toBe(12);
});

test("real 3F map completes a long route with turns without wandering", async ({ page }) => {
  await loadScitech3F(page);
  await configureAgent(page, "1.2");

  // From the upper corridor to the lower-right corridor. This crosses the
  // long central connection and exercises potential guidance + Social Force.
  await marker(page, "modeSpawn", 100, 62);
  await marker(page, "modeExit", 138, 154);

  await page.locator("#btnStart").click();
  await page.clock.runFor(75_000);

  const result = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    const agent = state.agents[0];
    return {
      running: state.sim.running,
      finished: !!agent?.finished,
      dead: !!agent?.dead,
      finishTime: agent?.finishTime ?? null,
      x: agent?.x ?? null,
      y: agent?.y ?? null,
      stuckCount: agent?.stuckCount ?? 0
    };
  });

  expect(result.dead).toBe(false);
  expect(result.finished).toBe(true);
  expect(result.finishTime).not.toBeNull();
  expect(result.finishTime).toBeLessThan(75);
});

test("manual fire source is neutral before combustion and red after ignition", async ({ page }) => {
  await configureAgent(page, "0.8");
  await marker(page, "modeSpawn", 2, 2);
  await marker(page, "modeExit", 17, 2);
  await marker(page, "modeFire", 12, 8);

  const sampleFireMarker = () => page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    const floor = state.map.floorStates[state.map.currentFloor];
    const canvas = document.querySelector("#simCanvas");
    const rect = canvas.getBoundingClientRect();
    const image = floor.baseImage;
    const scale = Math.min(rect.width / image.width, rect.height / image.height);
    const offsetX = (rect.width - image.width * scale) / 2;
    const offsetY = (rect.height - image.height * scale) / 2;
    const cssX = offsetX + (12.5 * 4 * scale);
    const cssY = offsetY + (8.5 * 4 * scale);
    const dprX = canvas.width / rect.width;
    const dprY = canvas.height / rect.height;
    const ctx = canvas.getContext("2d");
    const sample = ctx.getImageData(
      Math.max(0, Math.round(cssX * dprX) - 3),
      Math.max(0, Math.round(cssY * dprY) - 3),
      7,
      7
    ).data;

    let redDominantPixels = 0;
    let neutralMarkerPixels = 0;
    for (let i = 0; i < sample.length; i += 4) {
      const r = sample[i];
      const g = sample[i + 1];
      const b = sample[i + 2];
      if (r > g + 35 && r > b + 35) redDominantPixels++;
      if (Math.max(r,g,b) - Math.min(r,g,b) < 18 && r >= 90 && r <= 190) neutralMarkerPixels++;
    }

    return {
      fire: !!floor.grid?.[8]?.[12]?.fire,
      source: floor.grid?.[8]?.[12]?.fireSource,
      hrrKw: Number(floor.grid?.[8]?.[12]?.hrrKw) || 0,
      redDominantPixels,
      neutralMarkerPixels
    };
  });

  const before = await sampleFireMarker();
  expect(before.fire).toBe(true);
  expect(before.source).toBe("manual");
  expect(before.hrrKw).toBe(0);
  expect(before.redDominantPixels).toBe(0);
  expect(before.neutralMarkerPixels).toBeGreaterThan(0);

  await page.locator("#btnStart").click();
  await page.clock.runFor(1000);
  await page.locator("#btnStop").click();

  const after = await sampleFireMarker();
  expect(after.hrrKw).toBeGreaterThan(0);
  expect(after.redDominantPixels).toBeGreaterThan(0);
});


test('display controls and 2D/3D clicks inspect the same state without advancing hazards', async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await configureAgent(page,'0.2');
  await marker(page,'modeSpawn',2,2);await marker(page,'modeExit',17,2);await marker(page,'modeFire',12,8);
  await page.locator('#btnStart').click();await page.clock.runFor(2000);await page.locator('#btnStop').click();
  const numericalState=()=>page.evaluate(async()=>{
    const {state}=await import('/sim/js/state.js');
    return JSON.stringify({time:state.sim.time,grids:state.map.floorStates.map(f=>f.grid),agents:state.agents,
      inventories:state.map.floorStates.map(f=>f.smokePhysics),transfers:state.sim.verticalSmokeTransfers});
  });
  const before=await numericalState();
  await marker(page,'modeInspect',12,8);
  await expect(page.locator('[data-inspector-location]')).toContainText('X=12, Y=8');
  await expect(page.locator('[data-field="hrrKw"]')).toContainText('kW');
  await expect(page.locator('[data-field="fireAgeSec"]')).not.toContainText('未取得');
  await page.getByRole('button',{name:'地点分析を閉じる'}).click();
  for(const mode of ['physical','analysis']) {
    await page.locator('#smokeDisplayMode').selectOption(mode);
    for(const metric of ['density','extinction','visibility','co','temperature']) await page.locator('#view3dSmokeMode').selectOption(metric);
    for(const metric of ['intensity','hrr','age','heat_flux','spread_front']) await page.locator('#fireMetric').selectOption(metric);
    for(const source of ['fds','fallback','mixed','none'])await page.locator('#dataSourceOverlay').selectOption(source);
  }
  for(const mode of ['density','temperature','layer_depth','heat_flux','optical_density','co','visibility','source','hrr','age','spread_front','none']) {
    await page.locator('#riskViewMode').selectOption(mode);
  }
  await page.locator('#btnView3D').click();await page.clock.runFor(50);
  const projected=await page.evaluate(async()=>{
    const {state}=await import('/sim/js/state.js');state.render.renderer3d.renderOnce();
    return state.render.renderer3d.projectCell({floorIndex:0,cx:12,cy:8});
  });
  const box=await page.locator('#simCanvas3d').boundingBox();
  await page.mouse.click(box.x+projected.x,box.y+projected.y);
  await expect(page.locator('[data-inspector-location]')).toContainText('X=12, Y=8');
  await expect(page.locator('[data-field="hrrKw"]')).toContainText('簡易モデル');
  expect(await numericalState()).toBe(before);
  expect(errors).toEqual([]);
});

test('inspector keeps FDS provenance per field and live standalone view returns to fallback', async ({page,context}) => {
  const csv='time_s,floor,cx,cy,sample_height_m,co_ppm,temperature_c\n0,1,5,5,1.6,600,85\n0,1,5,5,2.6,900,160';
  await page.locator('#fdsCsvFile').setInputFiles({name:'inspect.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
  await marker(page,'modeInspect',5,5);
  await expect(page.locator('[data-field="coPpm"]')).toContainText('600 ppm');
  await expect(page.locator('[data-field="coPpm"]')).toContainText('FDS');
  await expect(page.locator('[data-field="eyeLevelTemperatureC"]')).toContainText('85 °C');
  await expect(page.locator('[data-field="upperLayerCoPpm"]')).toContainText('簡易モデル');
  const standalone=await context.newPage();await standalone.goto('/sim/3d.html?live=1');
  await page.evaluate(async()=>(await import('/sim/js/view3d.js')).init3DView().publisher.publishNow(true));
  await expect(standalone.locator('#standaloneConnection')).toContainText('同期中');
  const transferred=await standalone.evaluate(async()=>{
    const {state}=await import('/sim/js/state.js');return state.map.floorStates[0].grid[5][5];
  });
  expect(transferred.coPpm).toBe(600);expect(transferred.eyeLevelTemperatureC).toBe(85);
  expect(transferred.fdsFields).toContain('coPpm');expect(transferred.fdsSamples).toHaveLength(2);
  await page.locator('#btnClearFdsCsv').click();
  await expect(page.locator('[data-field="coPpm"]')).toContainText('簡易モデル');
  await page.evaluate(async()=>(await import('/sim/js/view3d.js')).init3DView().publisher.publishNow());
  await expect.poll(()=>standalone.evaluate(async()=> (await import('/sim/js/state.js')).state.map.floorStates[0].grid[5][5].fdsFields ?? null)).toBeNull();
  await standalone.close();
});

test("Monte Carlo completes 100 runs and preserves censored exposure reports", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await configureAgent(page, "0.2");
  await marker(page, "modeSpawn", 2, 2);
  await marker(page, "modeExit", 17, 2);
  await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    state.hazards.tenabilityOptions = { maxSimulationTimeSec: 0.1, policyId: "ci-short-observation" };
  });
  await page.locator("#btnMonte").click();
  await page.clock.runFor(13_000);
  const result = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    return { running: state.mc.running, runs: state.mc.runs, results: state.mc.results, agents: state.agents };
  });
  expect(result.running).toBe(false);
  expect(result.runs).toBe(100);
  expect(result.results).toHaveLength(100);
  for (const run of result.results) {
    expect(run.completionReason).toBe("observation_window");
    expect(run.censored).toBe(1);
    expect(run.unresolved).toBe(1);
    expect(run.avg).toBeNull();
    expect(run.worstTenabilityCounts).toEqual({ tenable: 1, degraded: 0, critical: 0 });
    expect(run.exposureTotals.durationSeconds).toBeCloseTo(0.1, 10);
    expect(run.exposureTotals.coPpmMin).toBe(0);
  }
  expect(result.agents[0].dead).toBe(false);
  expect(result.agents[0].finished).toBe(false);
  expect(errors).toEqual([]);
});

test("reset clears smoke inventory, agent exposure and fire spread while keeping the source", async ({ page }) => {
  await configureAgent(page, "0.2");
  await marker(page, "modeSpawn", 2, 2);
  await marker(page, "modeExit", 17, 2);
  await marker(page, "modeFire", 12, 8);
  await page.locator("#btnStart").click();
  // Select the deterministic ignition branch to verify reset of actual spread
  // cells without relying on a rare random event or manually faking fire age.
  await page.evaluate(() => { Math.random = () => 0; });
  await page.clock.runFor(2_000);
  const before = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    const floor = state.map.floorStates[0];
    return {
      fireAge: floor.grid[8][12].fireAgeSec,
      spread: floor.grid.flat().filter(cell => cell.fireSource === "spread").length,
      soot: [...floor.smokePhysics.sootMassKg].reduce((sum, value) => sum + value, 0),
      co: [...floor.smokePhysics.coMassKg].reduce((sum, value) => sum + value, 0),
      exposure: state.agents[0].exposure.durationSeconds
    };
  });
  expect(before.fireAge).toBeGreaterThan(0);
  // Material-independent flame spread is disabled by default.
  expect(before.spread).toBe(0);
  expect(before.soot).toBeGreaterThan(0);
  expect(before.co).toBeGreaterThan(0);
  expect(before.exposure).toBeGreaterThan(0);
  await page.locator("#btnReset").click();
  const after = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    const floor = state.map.floorStates[0];
    return {
      time: state.sim.time, agents: state.agents.length,
      source: floor.grid[8][12].fire, sourceAge: floor.grid[8][12].fireAgeSec,
      sourceHrr: floor.grid[8][12].hrrKw,
      spread: floor.grid.flat().filter(cell => cell.fireSource === "spread").length,
      soot: [...(floor.smokePhysics?.sootMassKg || [])].reduce((sum, value) => sum + value, 0),
      co: [...(floor.smokePhysics?.coMassKg || [])].reduce((sum, value) => sum + value, 0),
      smoke: floor.smokeMap.flat().reduce((sum, value) => sum + value, 0),
      exposure: state.evaluation.exposureTotals.durationSeconds
    };
  });
  expect(after).toEqual({ time: 0, agents: 0, source: true, sourceAge: 0, sourceHrr: 0, spread: 0, soot: 0, co: 0, smoke: 0, exposure: 0 });
});



test("crowd near a single exit does not leave stragglers wandering past it", async ({ page }) => {
  await configureAgent(page, "1.2");
  await page.locator("#numAgents").fill("12");
  await page.locator("#agentPreset").selectOption("default");
  await marker(page, "modeSpawn", 12, 1);
  await marker(page, "modeSpawn", 12, 2);
  await marker(page, "modeSpawn", 12, 3);
  await marker(page, "modeExit", 17, 2);

  await page.locator("#btnStart").click();
  await page.clock.runFor(12_000);

  const result = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    return {
      running: state.sim.running,
      active: state.agents.filter(a => !a.finished && !a.dead).map(a => ({
        id: a.id,
        x: a.x,
        y: a.y,
        type: a.type,
        targetExitIndex: a.targetExitIndex
      })),
      evacuated: state.agents.filter(a => a.finished).length,
      dead: state.agents.filter(a => a.dead).length
    };
  });

  expect(result.dead).toBe(0);
  expect(result.active).toEqual([]);
  expect(result.evacuated).toBe(12);
});

test("Start is enabled again after Stop and after normal completion", async ({ page }) => {
  await configureAgent(page, "0.8");
  await marker(page, "modeSpawn", 2, 2);
  await marker(page, "modeExit", 17, 2);

  const start = page.locator("#btnStart");
  await expect(start).toBeEnabled();

  await start.click();
  await page.clock.runFor(400);
  await page.locator("#btnStop").click();
  await expect(start).toBeEnabled();

  await start.click();
  await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    state.hazards.tenabilityOptions = {
      ...(state.hazards.tenabilityOptions || {}),
      maxSimulationTimeSec: 0.3
    };
  });
  await page.clock.runFor(1_000);
  await expect.poll(() => page.evaluate(async () => (await import("/sim/js/state.js")).state.sim.running)).toBe(false);
  await expect(start).toBeEnabled();
});

test("an agent uses the UI-created stair connection and evacuates on the other floor", async ({ page }) => {
  await configureAgent(page);
  await page.locator("#floorCount").fill("2");
  await page.locator("#btnApplyFloors").click();
  await marker(page, "modeStair", 4, 5);
  await marker(page, "modeExit", 6, 5);
  await page.locator("#currentFloor").selectOption("1");
  await loadRoom(page);
  await marker(page, "modeStair", 4, 5);
  await marker(page, "modeSpawn", 3, 5);
  await page.locator("#stairTravelCost").fill("0.5");
  await marker(page, "modeStairLink", 4, 5);
  await page.locator("#currentFloor").selectOption("0");
  await marker(page, "modeStairLink", 4, 5);
  expect(await page.evaluate(async () => (await import("/sim/js/state.js")).state.map.stairLinks.length)).toBe(1);
  await page.locator("#btnStart").click();
  await page.clock.runFor(12_000);
  const outcome = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    return {
      agent: state.agents[0], running: state.sim.running,
      completed: state.sim.stairCongestion[0].completed,
      evacuated: state.sim.lastSummary?.evacuated
    };
  });
  expect(outcome.agent.floor).toBe(0);
  expect(outcome.agent.finished).toBe(true);
  expect(outcome.agent.dead).toBe(false);
  expect(outcome.agent.stairTransitionCount).toBe(1);
  expect(outcome.completed).toBe(1);
  expect(outcome.evacuated).toBe(1);
  expect(outcome.running).toBe(false);
});

test("explicit Stop and Reset halt Monte Carlo without scheduling another trial", async ({ page }) => {
  await configureAgent(page, "0.2");
  await marker(page, "modeSpawn", 2, 2);
  await marker(page, "modeExit", 17, 2);
  await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    state.hazards.tenabilityOptions = { maxSimulationTimeSec: 1 };
  });
  await page.locator("#btnMonte").click();
  await page.clock.runFor(1_500);
  await page.locator("#btnStop").click();
  const snapshot = () => page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    return {
      running: state.sim.running, mcRunning: state.mc.running,
      time: state.sim.time, runs: state.mc.runs,
      results: state.mc.results, agents: state.agents.length
    };
  });
  const stopped = await snapshot();
  expect(stopped.running).toBe(false);
  expect(stopped.mcRunning).toBe(false);
  expect(stopped.results.length).toBeGreaterThan(0);
  expect(stopped.results).toHaveLength(stopped.runs);
  await page.clock.runFor(2_000);
  expect(await snapshot()).toEqual(stopped);

  await page.locator("#btnMonte").click();
  await page.clock.runFor(300);
  await page.locator("#btnReset").click();
  const reset = await snapshot();
  expect(reset.running).toBe(false);
  expect(reset.mcRunning).toBe(false);
  expect(reset.time).toBe(0);
  expect(reset.agents).toBe(0);
  await page.clock.runFor(2_000);
  expect(await snapshot()).toEqual(reset);
});
