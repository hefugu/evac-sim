import { test, expect } from "@playwright/test";

test("old/new FDS CSV, eye-height partial overlay and release restore fallback", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto("/sim/");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80; canvas.height = 48;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 80, 48);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#mapFile").setInputFiles({ name: "fds-room.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect.poll(() => page.evaluate(async () => (await import("/sim/js/state.js")).state.map.floorStates.length)).toBe(1);
  const cellData = () => page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    const cell = state.map.floorStates[0].grid[5][5];
    return { eyeCo: cell.eyeLevelCoPpm, upperCo: cell.upperLayerCoPpm,
      eyeTemperature: cell.eyeLevelTemperatureC, upperTemperature: cell.upperLayerTemperatureC,
      source: cell.smokeDataSource, samples: cell.fdsSamples, soot: state.map.floorStates[0].smokePhysics?.sootMassKg[105] ?? 0 };
  });
  const upload = async (text, name) => {
    await page.locator("#fdsCsvFile").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
    await expect(page.locator("#fdsCsvStatus")).toContainText(name);
  };
  const before = await cellData();
  await upload("time_s,floor,cx,cy,co_ppm,temperature_c\n0,1,5,5,300,85", "legacy.csv");
  await expect(page.locator("#fdsCsvStatus")).toContainText("1.6m");
  const legacy = await cellData();
  expect(legacy.eyeCo).toBe(300);
  expect(legacy.eyeTemperature).toBe(85);
  expect(legacy.upperCo).toBe(before.upperCo);
  expect(legacy.upperTemperature).toBe(before.upperTemperature);
  expect(legacy.soot).toBe(before.soot);
  await page.locator("#btnClearFdsCsv").click();
  const released = await cellData();
  expect(released.eyeCo).toBe(before.eyeCo);
  expect(released.eyeTemperature).toBe(before.eyeTemperature);
  expect(released.samples).toBeUndefined();
  expect(released.source).not.toBe("fds_csv");

  await upload("time_s,floor,cx,cy,sample_height_m,co_ppm,temperature_c\n0,1,5,5,2.6,1500,200", "high-only.csv");
  const high = await cellData();
  expect(high.eyeCo).toBe(before.eyeCo);
  expect(high.eyeTemperature).toBe(before.eyeTemperature);
  expect(high.samples[0].sampleHeightMeters).toBe(2.6);

  await upload("time_s,floor,cx,cy,sample_height_m,co_ppm,temperature_c\n0,1,5,5,1.2,100,\n0,1,5,5,2.0,300,200", "heights.csv");
  const interpolated = await cellData();
  expect(interpolated.eyeCo).toBeCloseTo(200, 10);
  expect(interpolated.eyeTemperature).toBe(before.eyeTemperature);
  expect(interpolated.upperCo).toBe(before.upperCo);
  expect(interpolated.samples).toHaveLength(2);
  await page.locator("#btnView3D").click();
  await page.locator("#view3dSmokeMode").selectOption("co");
  const renderStats = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    return state.render.renderer3d.renderOnce();
  });
  expect(renderStats.fdsSamples).toBe(2);
  expect(renderStats.smokeVisualizationMode).toBe("co");
  expect(renderStats.maxLayerDepthMeters).toBe(0);
  await page.locator("#btnClearFdsCsv").click();
  expect((await cellData()).eyeCo).toBe(before.eyeCo);
  expect(errors).toEqual([]);
});
