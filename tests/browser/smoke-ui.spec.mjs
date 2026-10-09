import { test, expect } from "@playwright/test";

test("3D controls wait for the delayed module and the first enabled click works", async ({ page }) => {
  let releaseModule;
  let reportModuleRequest;
  const moduleRequested = new Promise(resolve => { reportModuleRequest = resolve; });
  const release = new Promise(resolve => { releaseModule = resolve; });
  await page.route("**/js/view3d.js", async route => {
    reportModuleRequest();
    await release;
    await route.continue();
  });
  await page.goto("/sim/");
  await moduleRequested;
  try {
    for (const id of ["btnView3D", "btnViewSplit", "btnOpen3D", "btnReset3DCamera"]) {
      await expect(page.locator(`#${id}`)).toBeDisabled();
    }
    await expect(page.locator("#simCanvas")).toBeVisible();
    await expect(page.locator("#btnStart")).toBeEnabled();
  } finally {
    releaseModule();
  }
  await page.locator("#btnView3D").click();
  await expect(page.locator("#mainArea")).toHaveClass(/view-mode-3d/);
  const rendererReady = await page.evaluate(async () =>
    !!(await import("/sim/js/state.js")).state.render.renderer3d);
  expect(rendererReady).toBe(true);
});

test("2D and 3D views load over one shared state", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto("/sim/");
  await expect(page.locator("#simCanvas")).toBeVisible();
  await expect(page.locator("#simCanvas3d")).toBeAttached();
  await expect(page.locator("#fireAreaM2")).toHaveValue("1");
  await expect(page.locator("#mechanicalVentilationM3Sec")).toHaveValue("0");
  await page.locator("#btnView3D").click();
  await expect(page.locator("#mainArea")).toHaveClass(/view-mode-3d/);
  const shared = await page.evaluate(async () => {
    const { state } = await import("/sim/js/state.js");
    return state.render.renderer3d != null && state.render.viewMode === "3d";
  });
  expect(shared).toBe(true);
  expect(errors).toEqual([]);
});

test("standalone 3D page loads without starting a smoke solver", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto("/sim/3d.html");
  await expect(page.locator("#simCanvas3d")).toBeVisible();
  expect(errors).toEqual([]);
});
