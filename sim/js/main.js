import { initUI } from "./ui.js";
import { initSimulation } from "./simulation/core.js";
import { setupSample3FLoader } from "./sample3f-loader.js";

initUI();
initSimulation();
setupSample3FLoader();

// 3D is an optional view over the already-running 2D state. Keeping this as a
// guarded dynamic import ensures a 3D/canvas failure cannot prevent 2D startup.
import("./view3d.js")
  .then(({ init3DView }) => init3DView())
  .catch((error) => console.warn("3D view is unavailable; 2D remains active.", error));
