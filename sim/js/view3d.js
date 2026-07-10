import { state } from "./state.js";
import { createRenderer3D } from "./renderer3d.js";
import { create3DStatePublisher } from "./state-bridge3d.js";

let controller = null;

function byId(id) {
  return document.getElementById(id);
}

export function init3DView() {
  if (controller) return controller;
  const canvas = byId("simCanvas3d");
  const mainArea = byId("mainArea");
  if (!canvas || !mainArea) return null;

  const status = byId("view3dStatus");
  const buttons = {
    "2d": byId("btnView2D"),
    "3d": byId("btnView3D"),
    split: byId("btnViewSplit")
  };
  const renderer = createRenderer3D({
    canvas,
    state,
    options: {
      autoStart: false,
      cellSizeMeters: state.spatial.cellSizeMeters,
      floorHeightMeters: state.spatial.floorHeightMeters,
      wallHeightMeters: state.spatial.wallHeightMeters,
      geometryVersion: () => state.render.geometryRevision || 0
    }
  });
  const publisher = create3DStatePublisher(state);
  let mode = "2d";

  function updateStatus() {
    if (!status) return;
    const loadedFloors = (state.map.floorStates || []).filter(floor => floor?.baseImage || floor?.grid?.some(row => row?.some(cell => cell?.walkable))).length;
    status.textContent = loadedFloors
      ? `${loadedFloors}フロア / agent ${state.agents.length} / ドラッグ: 回転 / Shift+ドラッグ: 移動 / ホイール: ズーム`
      : "2D側でマップを読み込むと、同じ状態をここへ表示します。";
  }

  function setMode(nextMode) {
    mode = ["2d", "3d", "split"].includes(nextMode) ? nextMode : "2d";
    mainArea.classList.remove("view-mode-2d", "view-mode-3d", "view-mode-split");
    mainArea.classList.add(`view-mode-${mode}`);
    Object.entries(buttons).forEach(([name, button]) => button?.classList.toggle("viewActive", name === mode));
    state.render.viewMode = mode;
    if (mode === "2d") {
      renderer.stop();
    } else {
      renderer.resize();
      renderer.start();
      updateStatus();
    }
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      if (mode !== "2d") renderer.resize();
    });
    return mode;
  }

  buttons["2d"]?.addEventListener("click", () => setMode("2d"));
  buttons["3d"]?.addEventListener("click", () => setMode("3d"));
  buttons.split?.addEventListener("click", () => setMode("split"));
  byId("btnReset3DCamera")?.addEventListener("click", () => renderer.resetCamera());
  byId("btnOpen3D")?.addEventListener("click", () => {
    publisher.publishNow(true);
    window.open(new URL("../3d.html?live=1", import.meta.url), "evac-sim-3d", "noopener=false");
  });

  const layerControls = {
    view3dFire: "fire",
    view3dSmoke: "smoke",
    view3dAgents: "agents",
    view3dWalls: "walls"
  };
  Object.entries(layerControls).forEach(([id, layer]) => {
    const input = byId(id);
    input?.addEventListener("change", () => renderer.setLayerVisibility(layer, !!input.checked));
  });

  const destroy = () => {
    renderer.destroy();
    publisher.destroy();
    controller = null;
  };
  window.addEventListener("beforeunload", destroy, { once: true });
  state.render.renderer3d = renderer;
  controller = { renderer, publisher, setMode, destroy, get mode() { return mode; } };
  setMode("2d");
  return controller;
}

