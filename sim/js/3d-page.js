import { state } from "./state.js";
import { createRenderer3D } from "./renderer3d.js";
import { create3DStateReceiver } from "./state-bridge3d.js";
import { loadBase64ImageAsFile, SAMPLE_3F_BASE64_URL } from "./sample3f-loader.js";
import { extractScitech3FGrid, SCITECH_3F_PROFILE } from "./scitech3f-map3d.js";

function byId(id) {
  return document.getElementById(id);
}

function decodeImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("sample image decode failed"));
    };
    image.src = url;
  });
}

function sampleFloorFromImage(image) {
  const parsed = extractScitech3FGrid(image, {
    cellPixels: SCITECH_3F_PROFILE.gridCellPixels,
    whiteThreshold: SCITECH_3F_PROFILE.whiteThreshold
  });
  const grid = parsed.walkableTemplate.map((row, cy) => row.map((walkable, cx) => {
    const stair = !!parsed.stairTemplate[cy][cx];
    return {
      walkable: !!walkable || stair,
      wall: !walkable && !stair,
      stair,
      stairType: stair && cx >= 124 && cy >= 154 ? "outdoor" : (stair ? "indoor" : null),
      fire: false,
      fireIntensity: 0,
      temperatureC: 20,
      heatFluxKwM2: 0,
      smokeDensity: 0,
      opticalDensity: 0,
      coPpm: 0,
      visibilityMeters: 30
    };
  }));
  const stairs = [];
  grid.forEach((row, cy) => row.forEach((cell, cx) => {
    if (cell.stair) stairs.push({ cx, cy, type: cell.stairType });
  }));
  return {
    floorIndex: SCITECH_3F_PROFILE.floorIndex,
    name: SCITECH_3F_PROFILE.floorName,
    zMeters: SCITECH_3F_PROFILE.floorIndex * SCITECH_3F_PROFILE.floorHeightMeters,
    elevationMeters: SCITECH_3F_PROFILE.floorIndex * SCITECH_3F_PROFILE.floorHeightMeters,
    floorHeightMeters: SCITECH_3F_PROFILE.floorHeightMeters,
    wallHeightMeters: SCITECH_3F_PROFILE.wallHeightMeters,
    cellSizeMeters: SCITECH_3F_PROFILE.cellSizeMeters,
    gridWidth: parsed.gridWidth,
    gridHeight: parsed.gridHeight,
    baseImage: image,
    walkableTemplate: parsed.walkableTemplate,
    stairTemplate: parsed.stairTemplate,
    grid,
    smokeMap: parsed.walkableTemplate.map(row => row.map(() => 0)),
    smokeCeil: parsed.walkableTemplate.map(row => row.map(() => false)),
    stairs,
    exits: [],
    spawns: []
  };
}

const canvas = byId("simCanvas3d");
const status = byId("view3dStatus");
const connection = byId("standaloneConnection");
const renderer = createRenderer3D({
  canvas,
  state,
  options: {
    autoStart: true,
    geometryVersion: () => state.render.geometryRevision || 0
  }
});

async function loadStandaloneSample() {
  if (status) status.textContent = "科学技術高校3Fを読み込んでいます…";
  try {
    const file = await loadBase64ImageAsFile(SAMPLE_3F_BASE64_URL, "scitech_3f_walkable.png");
    const image = await decodeImageFile(file);
    const floor = sampleFloorFromImage(image);
    state.map.floorStates = [floor];
    state.floors = state.map.floorStates;
    state.map.floorCount = 1;
    state.map.currentFloor = floor.floorIndex;
    state.spatial = {
      ...state.spatial,
      cellSizeMeters: floor.cellSizeMeters,
      floorHeightMeters: floor.floorHeightMeters,
      wallHeightMeters: floor.wallHeightMeters,
      activeMapProfile: SCITECH_3F_PROFILE.id
    };
    state.render.geometryRevision = (state.render.geometryRevision || 0) + 1;
    renderer.resetCamera();
    if (status) status.textContent = "3Fサンプル表示 / 2Dページを開くとライブ状態へ自動同期します。";
  } catch (error) {
    console.warn("Standalone 3F sample could not be loaded.", error);
    if (status) status.textContent = `3Fサンプル読込失敗: ${error instanceof Error ? error.message : error}`;
  }
}

const receiver = create3DStateReceiver(state, {
  onUpdate(message) {
    if (connection) connection.textContent = "2D状態と同期中";
    if (status && message.type === "dynamic") {
      status.textContent = `ライブ表示 / ${Number(message.simTime || 0).toFixed(1)}s / agent ${message.agents?.length || 0}`;
    }
  }
});

byId("btnStandaloneSample")?.addEventListener("click", loadStandaloneSample);
byId("btnStandaloneResetCamera")?.addEventListener("click", () => renderer.resetCamera());
[
  ["standaloneFire", "fire"],
  ["standaloneSmoke", "smoke"],
  ["standaloneAgents", "agents"],
  ["standaloneWalls", "walls"]
].forEach(([id, layer]) => {
  const input = byId(id);
  input?.addEventListener("change", () => renderer.setLayerVisibility(layer, !!input.checked));
});

setTimeout(() => {
  if (!receiver.connected && !(state.map.floorStates || []).length) loadStandaloneSample();
}, 900);

window.addEventListener("beforeunload", () => {
  receiver.destroy();
  renderer.destroy();
}, { once: true });

