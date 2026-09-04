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
  await loadRoom(page);
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
  expect(before.spread).toBeGreaterThan(0);
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
