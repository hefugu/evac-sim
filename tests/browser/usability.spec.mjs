import { test, expect } from "@playwright/test";

test("basic labelled controls run an adult scenario and export its result", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { Math.random = () => 0.5; });
  await page.clock.install();
  await page.goto("/sim/");
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 96; c.height = 64;
    const g = c.getContext("2d"); g.fillStyle = "black"; g.fillRect(0, 0, 96, 64);
    g.fillStyle = "white"; g.fillRect(4, 4, 88, 56);
    return c.toDataURL().split(",")[1];
  });
  await page.getByLabel("図面画像", { exact: true }).setInputFiles({
    name: "basic-room.png", mimeType: "image/png", buffer: Buffer.from(png, "base64")
  });
  await expect.poll(() => page.evaluate(async () =>
    !!(await import("/sim/js/state.js")).state.map.baseImage)).toBe(true);
  await page.getByLabel("避難者数 [人]", { exact: true }).fill("1");
  await expect(page.getByLabel("避難開始", { exact: true })).toHaveValue("simultaneous");
  // Click through the displayed tools and real canvas, with no test simulation entry point.
  for (const [name, cx, cy] of [["開始位置", 3, 7], ["出口", 19, 7]]) {
    await page.getByRole("button", { name, exact: true }).click();
    const point = await page.evaluate(async ({ cx, cy }) => {
      const { state } = await import("/sim/js/state.js");
      const rect = document.getElementById("simCanvas").getBoundingClientRect();
      const image = state.map.baseImage;
      const scale = Math.min(rect.width / image.width, rect.height / image.height);
      return { x: rect.x + (rect.width - image.width * scale) / 2 + (cx + .5) * 4 * scale,
        y: rect.y + (rect.height - image.height * scale) / 2 + (cy + .5) * 4 * scale };
    }, { cx, cy });
    await page.mouse.click(point.x, point.y);
  }
  // Execution stays available when the setup panel is scrolled to its bottom.
  await page.locator("#leftPanel").evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
  await page.getByRole("button", { name: "実行", exact: true }).click();
  await page.clock.runFor(20_000);
  const result = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    return { types: state.agents.map(a => a.type), summary: state.sim.lastSummary };
  });
  expect(result.types).toEqual(["adult"]);
  expect(result.summary.evacuated).toBe(1);
  await page.getByText("4. 結果・レポート", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "結果をCSVで保存", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  await page.getByRole("button", { name: "リセット", exact: true }).click();
  expect(await page.evaluate(async () => (await import("/sim/js/state.js")).state.sim.time)).toBe(0);
  expect(errors).toEqual([]);
});

test("display settings remain operable on a narrow screen and in the standalone 3D page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sim/");
  await page.locator(".viewSettings > summary").click();
  await page.getByLabel("煙表示", { exact: true }).selectOption("analysis");
  expect(await page.evaluate(async () =>
    (await import("/sim/js/state.js")).state.viz.hazardDisplay.smokeDisplayMode)).toBe("analysis");
  await page.getByLabel("煙表示", { exact: true }).selectOption("physical");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto("/sim/3d.html");
  await page.locator(".viewSettings > summary").click();
  await page.getByLabel("3D煙表示モード").selectOption("visibility");
  await expect(page.getByLabel("3D煙表示モード")).toHaveValue("visibility");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
