import { SCITECH_3F_PROFILE } from "./scitech3f-map3d.js";

export const SAMPLE_3F_BASE64_URL = new URL("../assets/maps/scitech_3f_walkable.png.base64", import.meta.url);

function base64ToBlob(base64Text, mimeType = "image/png") {
  const clean = String(base64Text || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export async function loadBase64ImageAsFile(url, fileName) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sample map fetch failed: ${res.status}`);
  const base64 = await res.text();
  const blob = base64ToBlob(base64, "image/png");
  return new File([blob], fileName, { type: "image/png" });
}

function dispatchMapFile(mapFileInput, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  mapFileInput.files = dt.files;
  mapFileInput.dispatchEvent(new Event("change", { bubbles: true }));
}

export function setupSample3FLoader() {
  const mapFileInput = document.getElementById("mapFile");
  const thrRange = document.getElementById("thrRange");
  const cellSizeMetersInput = document.getElementById("cellSizeMeters");
  const agentPresetInput = document.getElementById("agentPreset");
  const floorCountInput = document.getElementById("floorCount");
  const currentFloorSelect = document.getElementById("currentFloor");
  const btnApplyFloors = document.getElementById("btnApplyFloors");
  const statusBar = document.getElementById("statusBar");
  const mapBlock = mapFileInput?.closest(".block");
  if (!mapFileInput || !mapBlock || document.getElementById("btnLoadSample3F")) return;

  const row = document.createElement("div");
  row.className = "simButtons";
  row.style.marginTop = "6px";

  const btn = document.createElement("button");
  btn.id = "btnLoadSample3F";
  btn.type = "button";
  btn.textContent = "3Fサンプル読込";
  row.appendChild(btn);

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "全マップ共通: 白=通路、黒=壁、緑=階段、黄=出口として自動抽出します。この3Fサンプルには黄色出口がないため、出口・開始位置・火元は読込後に配置してください。";

  mapBlock.appendChild(row);
  mapBlock.appendChild(hint);

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = "読込中...";
    try {
      if (thrRange) thrRange.value = "200";
      if (cellSizeMetersInput) cellSizeMetersInput.value = String(SCITECH_3F_PROFILE.cellSizeMeters);
      if (agentPresetInput) {
        agentPresetInput.value = "teacher_student";
        agentPresetInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (floorCountInput) floorCountInput.value = "3";
      btnApplyFloors?.click();
      if (currentFloorSelect) {
        currentFloorSelect.value = String(SCITECH_3F_PROFILE.floorIndex);
        currentFloorSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const file = await loadBase64ImageAsFile(SAMPLE_3F_BASE64_URL, "scitech_3f_walkable.png");
      dispatchMapFile(mapFileInput, file);
      if (statusBar) statusBar.textContent = "3Fサンプルマップを読み込みました（0.42m/cell、緑=階段候補）。";
    } catch (err) {
      console.error(err);
      alert(`3Fサンプルマップの読み込みに失敗しました: ${err instanceof Error ? err.message : err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  });
}
