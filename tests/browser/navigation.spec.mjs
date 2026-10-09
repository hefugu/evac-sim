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
  await page.locator("details").evaluateAll(items => items.forEach(item => { item.open = true; }));
  await loadRoom(page);
});

test("a distant fire does not prevent reaching an exit outside its buffer", async ({ page }) => {
  await configureAgent(page);
  await marker(page, "modeSpawn", 2, 2);
  await marker(page, "modeExit", 10, 2);
  await marker(page, "modeFire", 17, 9);
  await page.evaluate(() => { Math.random = () => 0.5; });
  await page.locator("#btnStart").click();
  await page.clock.runFor(15_000);
  const result = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    const a = state.agents[0];
    return { finished: a.finished, x: a.x, y: a.y, fallback: a.routeUsesFireFallback };
  });
  expect(result.fallback).toBe(false);
  expect(result.finished).toBe(true);
});

test("walkers take a smoke-free detour instead of stopping at a smoky corridor", async ({ page }) => {
  await configureAgent(page);
  await marker(page, "modeSpawn", 2, 5);
  await marker(page, "modeExit", 17, 5);
  const rows = ["time_s,floor,cx,cy,co_ppm,temperature_c"];
  for (let x=7;x<=11;x++) for(let y=3;y<=7;y++) rows.push(`0,1,${x},${y},1100,110`);
  await page.locator("#fdsCsvFile").setInputFiles({name:"smoke-detour.csv",mimeType:"text/csv",buffer:Buffer.from(rows.join("\n"))});
  await page.locator("#btnStart").click();
  await page.clock.runFor(25_000);
  const a = await page.evaluate(async () => (await import("/sim/js/state.js")).state.agents[0]);
  expect(a.finished).toBe(true);
  expect(a.trail.some(p => Math.round(p.x)>=7 && Math.round(p.x)<=11 && Math.round(p.y)>=3 && Math.round(p.y)<=7)).toBe(false);
});

async function loadCells(page, cells) {
  const png = await page.evaluate(cells => {
    const c = document.createElement("canvas"); c.width=80; c.height=48;
    const g = c.getContext("2d"); g.fillStyle="black"; g.fillRect(0,0,80,48);
    g.fillStyle="white"; for(const [x,y] of cells) g.fillRect(x*4,y*4,4,4);
    return c.toDataURL("image/png").split(",")[1];
  }, cells);
  await page.locator("#mapFile").setInputFiles({name:"corridor.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")});
  await expect.poll(() => page.evaluate(() => document.querySelector("#mapFile").value)).toBe("");
}

test("an agent rounds narrow wall corners without diagonal shortcuts", async ({page}) => {
  test.setTimeout(60_000);
  await configureAgent(page);
  // 1 m clearance accommodates an adult body. The old point-particle fixture
  // was only 0.5 m wide, below the mean adult diameter of 0.51 m.
  await page.locator("#cellSizeMeters").fill("1");
  const cells=[];
  for(let x=2;x<=12;x++) cells.push([x,2]);
  for(let y=2;y<=8;y++) cells.push([12,y]);
  for(let x=4;x<=12;x++) cells.push([x,8]);
  await loadCells(page,cells);
  await marker(page,"modeSpawn",2,2); await marker(page,"modeExit",4,8);
  await page.locator("#btnStart").click();
  await page.evaluate(async () => {
    const {state}=await import("/sim/js/state.js");
    window.walkSamples=[];
    setInterval(() => { const a=state.agents[0]; if(a) window.walkSamples.push({x:a.x,y:a.y}); }, 20);
  });
  await page.clock.runFor(40_000);
  const result=await page.evaluate(async()=>({finished:(await import("/sim/js/state.js")).state.agents[0].finished,samples:window.walkSamples}));
  expect(result.finished).toBe(true);
  const open=new Set(cells.map(([x,y])=>`${x}:${y}`));
  const violations=[];
  for(let i=1;i<result.samples.length;i++) {
    const a=result.samples[i-1], b=result.samples[i];
    for(let j=0;j<=20;j++) if(!open.has(`${Math.round(a.x+(b.x-a.x)*j/20)}:${Math.round(a.y+(b.y-a.y)*j/20)}`)) violations.push({a,b});
    const ax=Math.round(a.x), ay=Math.round(a.y), bx=Math.round(b.x), by=Math.round(b.y);
    if(ax!==bx && ay!==by && (!open.has(`${ax}:${by}`) || !open.has(`${bx}:${ay}`))) violations.push({a,b});
  }
  expect(violations).toEqual([]);
});

test("unreachable agents remain in the population and are reported unfinished", async ({page}) => {
  await configureAgent(page);
  const cells=[];
  for(let x=1;x<=18;x++) for(let y=1;y<=10;y++) if(x!==9) cells.push([x,y]);
  await loadCells(page,cells);
  await marker(page,"modeSpawn",2,5); await marker(page,"modeExit",17,5);
  await page.evaluate(async()=>{(await import("/sim/js/state.js")).state.hazards.tenabilityOptions={maxSimulationTimeSec:2};});
  await page.locator("#btnStart").click(); await page.clock.runFor(3_000);
  const result=await page.evaluate(async()=>{const {state}=await import("/sim/js/state.js");return {count:state.agents.length,summary:state.sim.lastSummary};});
  expect(result.count).toBe(1);
  expect(result.summary.evacuated).toBe(0);
  expect(result.summary.censored).toBe(1);
});

test("a crowd uses both connected stairways and finishes on the exit floor", async ({page}) => {
  test.setTimeout(60_000);
  await configureAgent(page);
  await page.locator("#numAgents").fill("24");
  await page.locator("#floorCount").fill("2"); await page.locator("#btnApplyFloors").click();
  for(const x of [4,15]) await marker(page,"modeStair",x,5);
  await marker(page,"modeExit",10,2);
  await page.locator("#currentFloor").selectOption("1"); await loadRoom(page);
  for(const x of [4,15]) await marker(page,"modeStair",x,5);
  await marker(page,"modeSpawn",10,8);
  await page.locator("#stairTravelCost").fill("2");
  for(const x of [4,15]) {
    await page.locator("#currentFloor").selectOption("1"); await marker(page,"modeStairLink",x,5);
    await page.locator("#currentFloor").selectOption("0"); await marker(page,"modeStairLink",x,5);
  }
  await page.locator("#btnStart").click();
  await page.clock.runFor(60_000);
  const result=await page.evaluate(async()=>{const {state}=await import("/sim/js/state.js");return {stairs:state.sim.stairCongestion,summary:state.sim.lastSummary,agents:state.agents.map(a=>({x:a.x,y:a.y,floor:a.floor,finished:a.finished,stuck:a.stuckTime}))};});
  expect(result.stairs).toHaveLength(2);
  for(const stair of result.stairs) expect(stair.completed).toBeGreaterThan(0);
  expect(result.agents.filter(a=>a.finished)).toHaveLength(24);
  expect(result.summary.evacuated).toBe(24);
});

 test("risk along a short exit route makes an agent choose a farther clean exit", async ({page}) => {
  await configureAgent(page);
  await marker(page,"modeSpawn",8,5);
  await marker(page,"modeExit",11,5);
  await marker(page,"modeExit",2,5);
  const rows=["time_s,floor,cx,cy,co_ppm,temperature_c"];
  for(let x=10;x<=12;x++) for(let y=4;y<=6;y++) rows.push(`0,1,${x},${y},1100,110`);
  await page.locator("#fdsCsvFile").setInputFiles({name:"unsafe-exit.csv",mimeType:"text/csv",buffer:Buffer.from(rows.join("\n"))});
  await page.locator("#btnStart").click(); await page.clock.runFor(12_000);
  const a=await page.evaluate(async()=>(await import("/sim/js/state.js")).state.agents[0]);
  expect(a.targetExitIndex).toBe(1); expect(a.finished).toBe(true);
  expect(Math.abs(a.x - 2)).toBeLessThan(1.2);
});


test("an agent already beside a flame can leave its blocked origin cell", async ({ page }) => {
  await configureAgent(page);
  await marker(page, "modeSpawn", 2, 2);
  await marker(page, "modeExit", 2, 9);
  await marker(page, "modeFire", 3, 2);
  await page.evaluate(() => { Math.random = () => 0.5; });
  await page.locator("#btnStart").click();
  await page.clock.runFor(2_000);
  const result = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    const a = state.agents[0];
    return { x: a.x, y: a.y, dead: a.dead, finished: a.finished, count: state.agents.length };
  });
  expect(result.count).toBe(1);
  expect(result.dead).toBe(false);
  expect(Math.hypot(result.x - 3, result.y - 2)).toBeGreaterThan(1.1);
  expect(result.y).toBeGreaterThan(2.5);
  await page.clock.runFor(18_000);
  expect(await page.evaluate(async () => (await import("/sim/js/state.js")).state.agents[0].finished)).toBe(true);
});

test("fire scenario settings survive presets, control source growth and appear in CSV", async ({ page }) => {
  await configureAgent(page);
  await page.locator("#fireGrowthRate").selectOption("ultrafast");
  await page.locator("#fireMaxHrrKw").fill("1");
  await page.locator("#presetName").fill("fire-regression");
  await page.locator("#btnSavePreset").click();
  await page.locator("#fireGrowthRate").selectOption("slow");
  await page.locator("#fireMaxHrrKw").fill("3000");
  await page.locator("#btnLoadPreset").click();
  await expect(page.locator("#fireGrowthRate")).toHaveValue("ultrafast");
  await expect(page.locator("#fireMaxHrrKw")).toHaveValue("1");
  await marker(page, "modeSpawn", 2, 2);
  await marker(page, "modeExit", 17, 2);
  await marker(page, "modeFire", 17, 9);
  await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    state.hazards.tenabilityOptions = { ...state.hazards.tenabilityOptions, maxSimulationTimeSec: 4 };
  });
  await page.locator("#btnStart").click();
  await page.clock.runFor(5_000);
  const result = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    const { buildCsvReport } = await import("/sim/js/export/csv.js");
    const source = state.map.floorStates[0].grid[9][17];
    return { hrr: source.hrrKw, age: source.fireAgeSec, summary: state.sim.lastSummary,
      report: buildCsvReport({ lastSummary: state.sim.lastSummary, agents: state.agents,
        allExitPoints: [], TYPE_META: {}, currentFloor: 0,
        paramHistory: [], congestionHistory: [], bottleneckReport: [] }) };
  });
  expect(result.hrr).toBeCloseTo(Math.min(1, 0.1876 * result.age ** 2), 8);
  expect(result.hrr).toBe(1);
  expect(result.summary.fireModel).toEqual({ alphaKwPerSec2: 0.1876, maxHrrKw: 1 });
  expect(result.report).toContain("summary,fire_growth_alpha_kw_s2,0.18760");
  expect(result.report).toContain("summary,fire_max_hrr_kw,1.000");
});

test("visibility-only FDS smoke reduces continuous desired walking speed", async ({ page }) => {
  const run = async visibility => {
    await page.goto("/sim/");
    await page.locator("details").evaluateAll(items => items.forEach(item => { item.open = true; }));
    await loadRoom(page);
    await configureAgent(page);
    await marker(page, "modeSpawn", 2, 5);
    await marker(page, "modeExit", 17, 5);
    if (visibility != null) {
      const rows = ["time_s,floor,cx,cy,visibility_m"];
      for (let x = 1; x <= 18; x++) for (let y = 1; y <= 10; y++) rows.push(`0,1,${x},${y},${visibility}`);
      await page.locator("#fdsCsvFile").setInputFiles({ name: "visibility-only.csv", mimeType: "text/csv", buffer: Buffer.from(rows.join("\n")) });
    }
    await page.locator("#btnStart").click();
    await page.clock.runFor(1_500);
    await page.locator("#btnStop").click();
    return page.evaluate(async () => {
      const { state } = await import("/sim/js/state.js");
      const a = state.agents[0];
      return { desired: a.desiredSpeedMps, base: a.baseDesiredSpeedMps, x: a.x };
    });
  };
  const clear = await run(null);
  const smoky = await run(0.3);
  expect(smoky.base).toBe(clear.base);
  expect(smoky.desired).toBeCloseTo(smoky.base * (0.706 - 0.057 * 10) / 0.706, 8);
  expect(smoky.desired).toBeLessThan(clear.desired * 0.25);
  expect(smoky.x).toBeLessThan(clear.x);
});
