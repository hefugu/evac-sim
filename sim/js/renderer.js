import { DEFAULT_HAZARD_DISPLAY, computeSmokeDisplayOpacity, displayMetricValue, displayMetricColor,
  displayLegend, createFireDisplayData, isFireSpreadFront, resolveHazardDisplaySource,
  sourceOverlayMatches, SOURCE_COLORS } from './visualization/hazard-display.js';

export function derive2DCellDisplay(cell, options = {}) {
  const settings = {...DEFAULT_HAZARD_DISPLAY,...options};
  const source = resolveHazardDisplaySource(cell);

  const eyeK = displayMetricValue(cell,'extinction') || 0;
  const upperK = displayMetricValue(cell,'extinction',{upper:true}) || 0;
  const layerDepth = Math.max(0, Number(cell?.smokeLayerDepthMeters) || 0);

  // A top-down map should still show the footprint of an upper smoke layer
  // even when that layer has not descended to the 1.6 m eye plane yet.
  // FDS eye-height readings remain authoritative and are never converted into
  // a fictitious upper layer.
  const fdsEye = cell?.fdsFields?.includes('opticalDensityM1') ||
    (!cell?.fdsFields && /fds/i.test(cell?.eyeLevelDataSource || cell?.smokeDataSource || ''));
  const useUpperLayer = !fdsEye && layerDepth > 0 && upperK > eyeK;
  const K = useUpperLayer ? upperK : eyeK;
  const layerAbsent = layerDepth === 0 && !fdsEye;
  const opacity = computeSmokeDisplayOpacity(
    K,
    layerAbsent ? 0 : (options.cellSizeMeters || .5),
    {mode:settings.smokeDisplayMode,gamma:settings.analysisGamma}
  );

  const metricValue = settings.smokeMetric === 'source'
    ? source
    : displayMetricValue(cell,settings.smokeMetric,{upper:useUpperLayer});

  return {
    opacity,
    source,
    color:displayMetricColor(settings.smokeMetric, metricValue),
    smokeUsesUpperLayer: useUpperLayer,
    fire:createFireDisplayData(cell,{metric:settings.fireMetric,isFront:options.isFront})
  };
}

function drawArrow(ctx, px, py, vx, vy, color, width = 0.35) {
  const len = Math.hypot(vx, vy);
  if (len < 0.001) return;
  const ux = vx / len;
  const uy = vy / len;
  const head = 0.8;
  const tipX = px + vx;
  const tipY = py + vy;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ux * head - uy * 0.4, tipY - uy * head + ux * 0.4);
  ctx.lineTo(tipX - ux * head + uy * 0.4, tipY - uy * head - ux * 0.4);
  ctx.closePath();
  ctx.fill();
}

export function createRenderer({ ctx, cvs, cellSizePx, typeMeta, clamp }) {
  let staticLayer = null;
  let staticLayerKey = "";

  function createLayerCanvas(width, height) {
    if (typeof OffscreenCanvas !== "undefined") {
      return new OffscreenCanvas(width, height);
    }
    if (typeof document !== "undefined" && document.createElement) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
    return null;
  }

  function drawStaticBase(scene) {
    const { baseImage, grid, gridW, gridH, currentFloor, geometryRevision = 0 } = scene;
    if (!baseImage) return false;
    const rect = cvs.getBoundingClientRect();
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const key = [
      geometryRevision,
      currentFloor,
      Math.round(rect.width * 10),
      Math.round(rect.height * 10),
      Math.round(scene.layout.scale * 10000),
      Math.round(scene.layout.ox * 10),
      Math.round(scene.layout.oy * 10),
      baseImage.width || 0,
      baseImage.height || 0
    ].join(":");

    if (!staticLayer || staticLayerKey !== key) {
      const layer = createLayerCanvas(
        Math.max(1, Math.round(rect.width * dpr)),
        Math.max(1, Math.round(rect.height * dpr))
      );
      const layerCtx = layer?.getContext?.("2d");
      if (!layer || !layerCtx) return false;

      layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layerCtx.clearRect(0, 0, rect.width, rect.height);
      const { scale, ox, oy } = scene.layout;
      layerCtx.drawImage(baseImage, ox, oy, baseImage.width * scale, baseImage.height * scale);

      if (grid) {
        layerCtx.save();
        layerCtx.translate(ox, oy);
        layerCtx.scale(scale, scale);

        layerCtx.strokeStyle = "rgba(120,126,132,0.22)";
        layerCtx.lineWidth = 0.2;
        for (let y = 0; y <= gridH; y++) {
          layerCtx.beginPath();
          layerCtx.moveTo(0, y * cellSizePx);
          layerCtx.lineTo(gridW * cellSizePx, y * cellSizePx);
          layerCtx.stroke();
        }
        for (let x = 0; x <= gridW; x++) {
          layerCtx.beginPath();
          layerCtx.moveTo(x * cellSizePx, 0);
          layerCtx.lineTo(x * cellSizePx, gridH * cellSizePx);
          layerCtx.stroke();
        }

        layerCtx.fillStyle = "rgba(120,130,140,0.28)";
        for (let y = 0; y < gridH; y++) {
          for (let x = 0; x < gridW; x++) {
            if (grid[y][x].stair) {
              layerCtx.fillRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
            }
          }
        }
        layerCtx.restore();
      }

      staticLayer = layer;
      staticLayerKey = key;
    }

    ctx.drawImage(
      staticLayer,
      0, 0, staticLayer.width, staticLayer.height,
      0, 0, rect.width, rect.height
    );
    return true;
  }

  function drawGrid(scene) {
    const {
      layout, baseImage, grid, gridW, gridH, stairLinks, pendingStairLink, currentFloor,
      vizPotential, potentialViewMode, potentialExitIndex, potentialByExit, combinedPotential,
      potentialLegendMax
    } = scene;
    const { scale, ox, oy } = layout;

    if (!baseImage) {
      const rect = cvs.getBoundingClientRect();
      ctx.strokeStyle = "#9da5ad";
      ctx.strokeRect(20, 20, rect.width - 40, rect.height - 40);
      ctx.fillStyle = "#4e565e";
      ctx.fillText("マップ画像を読み込んでください", 40, 50);
      return false;
    }

    const cachedStatic = drawStaticBase(scene);
    if (!cachedStatic) {
      ctx.drawImage(baseImage, ox, oy, baseImage.width * scale, baseImage.height * scale);
    }

    if (!grid) return true;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    if (!cachedStatic) {
      ctx.strokeStyle = "rgba(120,126,132,0.22)";
      ctx.lineWidth = 0.2;
      for (let y = 0; y <= gridH; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * cellSizePx);
        ctx.lineTo(gridW * cellSizePx, y * cellSizePx);
        ctx.stroke();
      }
      for (let x = 0; x <= gridW; x++) {
        ctx.beginPath();
        ctx.moveTo(x * cellSizePx, 0);
        ctx.lineTo(x * cellSizePx, gridH * cellSizePx);
        ctx.stroke();
      }

      ctx.fillStyle = "rgba(120,130,140,0.28)";
      for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
          if (grid[y][x].stair) ctx.fillRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
        }
      }
    }

    if (stairLinks.length) {
      ctx.strokeStyle = "rgba(70,80,90,0.9)";
      ctx.fillStyle = "rgba(45,50,55,0.95)";
      ctx.lineWidth = 0.45;
      ctx.font = `${Math.max(6, cellSizePx * 0.7)}px Consolas`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      stairLinks.forEach((link) => {
        if (!link?.a || !link?.b) return;
        const here = link.a.floor === currentFloor ? link.a : (link.b.floor === currentFloor ? link.b : null);
        if (!here) return;
        const other = here === link.a ? link.b : link.a;
        const px = (here.cx + 0.5) * cellSizePx;
        const py = (here.cy + 0.5) * cellSizePx;
        ctx.beginPath();
        ctx.arc(px, py, cellSizePx * 0.9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillText(`->${other.floor + 1}F`, px + cellSizePx * 0.65, py);
      });
    }

    if (pendingStairLink && pendingStairLink.floor === currentFloor) {
      const px = (pendingStairLink.cx + 0.5) * cellSizePx;
      const py = (pendingStairLink.cy + 0.5) * cellSizePx;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(px, py, cellSizePx * 1.15, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (vizPotential && (combinedPotential || potentialByExit.length)) {
      const showPerExit = potentialViewMode === "per_exit";
      const targetIdx = Math.max(0, potentialExitIndex - 1);
      const pMap = showPerExit ? potentialByExit[targetIdx] : combinedPotential;
      if (pMap) {
        const maxPot = Math.max(1, potentialLegendMax);
        for (let y = 0; y < gridH; y++) {
          for (let x = 0; x < gridW; x++) {
            if (!grid[y][x].walkable) continue;
            const p = pMap[y]?.[x];
            if (!isFinite(p)) continue;
            const t = clamp(1 - (p / maxPot), 0, 1);
            const r = Math.floor(30 + 210 * t);
            const g = Math.floor(70 + 120 * (1 - Math.abs(t - 0.5) * 2));
            const b = Math.floor(255 - 180 * t);
            ctx.fillStyle = `rgba(${r},${g},${b},0.22)`;
            ctx.fillRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
          }
        }
        const stride = 5;
        for (let y = 2; y < gridH - 2; y += stride) {
          for (let x = 2; x < gridW - 2; x += stride) {
            if (!grid[y][x].walkable) continue;
            const cur = pMap[y]?.[x];
            if (!isFinite(cur)) continue;
            let best = { dx: 0, dy: 0, gain: 0 };
            const dirs = [
              { dx: 1, dy: 0 }, { dx: -1,dy: 0 }, { dx: 0,dy: 1 }, { dx: 0,dy: -1 },
              { dx: 1,dy: 1 }, { dx: -1,dy: 1 }, { dx: 1,dy: -1 }, { dx: -1,dy: -1 }
            ];
            for (const d of dirs) {
              const nx = x + d.dx;
              const ny = y + d.dy;
              if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
              if (!grid[ny][nx].walkable) continue;
              const np = pMap[ny]?.[nx];
              if (!isFinite(np)) continue;
              const gain = cur - np;
              if (gain > best.gain) best = { dx: d.dx, dy: d.dy, gain };
            }
            if (best.gain > 0.01) {
              const px = (x + 0.5) * cellSizePx;
              const py = (y + 0.5) * cellSizePx;
              drawArrow(ctx, px, py, best.dx * 1.2, best.dy * 1.2, "rgba(60,90,120,0.7)", 0.3);
            }
          }
        }
      }
    }
    return true;
  }

  function drawFireAvoidanceMask(scene) {
    if (!Array.isArray(scene.fireAvoidanceIndices) || !scene.fireAvoidanceIndices.length) return;
    ctx.save();
    ctx.fillStyle = 'rgba(255,35,35,0.14)';
    for (const index of scene.fireAvoidanceIndices) {
      const x = index % scene.gridW;
      const y = Math.floor(index / scene.gridW);
      ctx.fillRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
    }
    ctx.restore();
  }

  function drawRiskOverlay(scene) {
    const { grid, gridW, gridH, riskOverlay } = scene;
    if (!grid || !riskOverlay?.cells) return;
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const cell = riskOverlay.cells[y]?.[x];
        if (!cell) continue;
        const t = clamp(cell.norm || 0, 0, 1);
        const r = Math.floor(40 + 215 * t);
        const g = Math.floor(220 - 190 * t);
        const b = Math.floor(70 - 50 * t);
        const alpha = 0.18 + 0.48 * t;
        ctx.save(); ctx.globalAlpha = alpha;
        ctx.fillStyle = cell.color || `rgb(${r},${g},${b})`;
        ctx.fillRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
        ctx.restore();
      }
    }
  }

  function drawSmoke(scene) {
    if (!scene.grid) return;

    const drawCell = (x, y) => {
      const cell = scene.grid?.[y]?.[x];
      if (!cell) return;
      const view = derive2DCellDisplay(cell,{...scene.hazardDisplay,cellSizeMeters:scene.cellSizeMeters});
      if (!(view.opacity > 0)) return;
      ctx.save(); ctx.globalAlpha = view.opacity; ctx.fillStyle = view.color;
      ctx.fillRect(x*cellSizePx,y*cellSizePx,cellSizePx,cellSizePx); ctx.restore();
    };

    if (Array.isArray(scene.smokeActiveIndices)) {
      for (const index of scene.smokeActiveIndices) {
        const x = index % scene.gridW;
        const y = Math.floor(index / scene.gridW);
        drawCell(x, y);
      }
      return;
    }

    scene.grid.forEach((row,y)=>row.forEach((_cell,x)=>drawCell(x,y)));
  }

  function drawFireAndSources(scene) {
    const settings = {...DEFAULT_HAZARD_DISPLAY,...scene.hazardDisplay};

    const drawCell = (cell, x, y) => {
      const view = derive2DCellDisplay(cell,{...settings,isFront:isFireSpreadFront(scene.grid,x,y)});
      const px=(x+.5)*cellSizePx, py=(y+.5)*cellSizePx;
      const isExplicitSource = !!cell?.fire && cell?.fireSource !== "spread";
      if (view.fire.active || isExplicitSource) {
        // Engineering display: burning area is a red cell overlay. A manually
        // defined source remains visible even while HRR is still zero.
        ctx.save();
        const visibleStrength = Math.max(0.18, Number(view.fire.strength) || 0);
        ctx.fillStyle = `rgba(190,36,36,${0.14 + 0.28 * visibleStrength})`;
        ctx.fillRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
        const isSource = isExplicitSource || view.fire.origin === 'source';
        ctx.strokeStyle = isSource ? '#9f1d1d' : '#c94b4b';
        ctx.lineWidth = Math.max(0.7, cellSizePx * 0.12);
        const markerInset = isSource ? 0.05 : 0.3;
        ctx.strokeRect(
          x * cellSizePx + markerInset,
          y * cellSizePx + markerInset,
          Math.max(0, cellSizePx - markerInset * 2),
          Math.max(0, cellSizePx - markerInset * 2)
        );
        if (isSource) {
          const r = Math.max(1.2, cellSizePx * 0.30);
          ctx.beginPath();
          ctx.moveTo(px - r, py);
          ctx.lineTo(px + r, py);
          ctx.moveTo(px, py - r);
          ctx.lineTo(px, py + r);
          ctx.stroke();
        }
        if (settings.fireMetric === 'spread_front' && view.fire.isFront) {
          ctx.strokeStyle = '#ff8a80';
          ctx.lineWidth = Math.max(1, cellSizePx * 0.16);
          ctx.strokeRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
        }
        ctx.restore();
      }
      if (sourceOverlayMatches(settings.dataSourceOverlay,view.source)) {
        ctx.strokeStyle=SOURCE_COLORS[view.source];ctx.lineWidth=.45;
        ctx.strokeRect(x*cellSizePx+.2,y*cellSizePx+.2,cellSizePx-.4,cellSizePx-.4);
      }
      if(cell.fdsSamples?.length) {
        ctx.strokeStyle=SOURCE_COLORS.fds;ctx.lineWidth=.4;ctx.beginPath();ctx.arc(px,py,cellSizePx*.25,0,Math.PI*2);ctx.stroke();
      }
    };

    const needsFullScan =
      settings.dataSourceOverlay !== 'none' ||
      !!scene.fdsStats ||
      !Array.isArray(scene.fireActiveIndices);

    if (needsFullScan) {
      scene.grid.forEach((row,y)=>row.forEach((cell,x)=>drawCell(cell,x,y)));
    } else {
      for (const index of scene.fireActiveIndices) {
        const x = index % scene.gridW;
        const y = Math.floor(index / scene.gridW);
        const cell = scene.grid?.[y]?.[x];
        if (cell) drawCell(cell, x, y);
      }
    }

    for(const transfer of scene.verticalSmokeTransfers || []) {
      if (!(transfer.volumeM3>0 || transfer.sootMassKg>0 || transfer.amount>0)) continue;
      const endpoint=(transfer.from?.floorIndex ?? transfer.from?.floor)===scene.currentFloor ? transfer.from :
        (transfer.to?.floorIndex ?? transfer.to?.floor)===scene.currentFloor ? transfer.to : null;
      if(!endpoint) continue;
      drawArrow(ctx,(endpoint.cx+.5)*cellSizePx,(endpoint.cy+.5)*cellSizePx,0,-cellSizePx*.9,'#66717b',.65);
    }
  }

  function drawAgents(scene) {
    const { exits, spawns, allExitPoints, currentFloor, vizTrails, agents, vizFlow, flowField, gridW, gridH } = scene;
    ctx.fillStyle = "#ffffff";
    exits.forEach((p, idx) => {
      const px = (p.cx + 0.5) * cellSizePx;
      const py = (p.cy + 0.5) * cellSizePx;
      ctx.beginPath();
      ctx.arc(px, py, cellSizePx * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#202428";
      ctx.lineWidth = Math.max(0.8, cellSizePx * 0.12);
      ctx.stroke();
      ctx.fillStyle = "#202428";
      ctx.font = `${Math.max(6, cellSizePx * 0.8)}px Consolas`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const globalIndex = allExitPoints.findIndex((e) => e.floor === currentFloor && e.cx === p.cx && e.cy === p.cy);
      ctx.fillText(String((globalIndex >= 0 ? globalIndex : idx) + 1), px, py);
      ctx.fillStyle = "#ffffff";
    });

    ctx.fillStyle = "#ffffff";
    spawns.forEach((p) => {
      const px = (p.cx + 0.5) * cellSizePx;
      const py = (p.cy + 0.5) * cellSizePx;
      ctx.beginPath();
      ctx.arc(px, py, cellSizePx * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#2f5f8f";
      ctx.lineWidth = Math.max(0.8, cellSizePx * 0.12);
      ctx.stroke();
    });

    if (vizTrails && agents.length) {
      const quality = scene.renderQuality || "full";
      const maxTrailAgents = quality === "performance" ? 120 : (quality === "balanced" ? 320 : Infinity);
      const agentStride = Number.isFinite(maxTrailAgents)
        ? Math.max(1, Math.ceil(agents.length / maxTrailAgents))
        : 1;
      const pointStride = quality === "performance" ? 3 : (quality === "balanced" ? 2 : 1);

      for (let ai = 0; ai < agents.length; ai += agentStride) {
        const a = agents[ai];
        if (!a.trail || a.trail.length < 2 || a.dead) continue;
        const baseColor = typeMeta[a.type]?.color || "#ff3366";
        ctx.strokeStyle = baseColor;
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 0.45;
        let drawing = false;
        for (let i = 0; i < a.trail.length; i += pointStride) {
          const t = a.trail[i];
          if ((t.floor ?? a.floor) !== currentFloor) {
            drawing = false;
            continue;
          }
          const tx = (t.x + 0.5) * cellSizePx;
          const ty = (t.y + 0.5) * cellSizePx;
          if (!drawing) {
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            drawing = true;
          } else {
            ctx.lineTo(tx, ty);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    if (vizFlow && flowField) {
      const quality = scene.renderQuality || "full";
      const stride = quality === "performance" ? 8 : (quality === "balanced" ? 6 : 4);
      for (let y = 1; y < gridH - 1; y += stride) {
        for (let x = 1; x < gridW - 1; x += stride) {
          const f = flowField[y][x];
          if (!f || f.n < 1) continue;
          const vx = (f.vx / f.n) * 2.1;
          const vy = (f.vy / f.n) * 2.1;
          const m = Math.hypot(vx, vy);
          if (m < 0.03) continue;
          const px = (x + 0.5) * cellSizePx;
          const py = (y + 0.5) * cellSizePx;
          const alpha = clamp(0.25 + m * 0.45, 0.25, 0.85);
          drawArrow(ctx, px, py, vx, vy, `rgba(120,230,255,${alpha})`, 0.28);
        }
      }
    }

    if (!agents.length) return;
    agents.forEach((a) => {
      if (a.floor !== currentFloor) return;
      const px = (a.x + 0.5) * cellSizePx;
      const py = (a.y + 0.5) * cellSizePx;
      if (a.dead) ctx.fillStyle = "#1a1a1a";
      else if (a.fallen) ctx.fillStyle = "#ff9900";
      else if (a.helpingId != null) ctx.fillStyle = "#33ccff";
      else if (a.finished) ctx.fillStyle = "#8888ff";
      else ctx.fillStyle = typeMeta[a.type]?.color || "#ff3366";
      ctx.globalAlpha = a.dead ? 0.95 : Math.max(0.25, a.visibility ?? 1);
      ctx.beginPath();
      ctx.arc(px, py, cellSizePx * 0.4, 0, Math.PI * 2);
      ctx.fill();
      if (!a.dead && (a.type === "teacher" || a.type === "leader")) {
        ctx.strokeStyle = "#d2fff2";
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.arc(px, py, cellSizePx * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (a.dead) {
        ctx.strokeStyle = "#660000";
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(px - cellSizePx * 0.35, py - cellSizePx * 0.35);
        ctx.lineTo(px + cellSizePx * 0.35, py + cellSizePx * 0.35);
        ctx.moveTo(px + cellSizePx * 0.35, py - cellSizePx * 0.35);
        ctx.lineTo(px - cellSizePx * 0.35, py + cellSizePx * 0.35);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  function drawHeatmap(scene) {
    if (!scene.simRunning && scene.maxHeatCell && scene.maxHeatValue > 5) {
      const px = (scene.maxHeatCell.x + 0.5) * cellSizePx;
      const py = (scene.maxHeatCell.y + 0.5) * cellSizePx;
      ctx.strokeStyle = 'rgba(126,166,199,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px, py, cellSizePx * 0.75, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawHUD(scene) {
    const settings={...DEFAULT_HAZARD_DISPLAY,...scene.hazardDisplay};
    const lines=[`${scene.currentFloor+1}F | ${settings.smokeDisplayMode} | alpha=1-exp(-K L)${settings.smokeDisplayMode==='analysis'?' ^ gamma=0.55':''}`,
      `Eye 1.6m / L=${Number(scene.cellSizeMeters || .5).toFixed(2)} m; ${displayLegend(settings.smokeMetric)}`,
      `${displayLegend(settings.fireMetric)}; source □ / spread ○`,
      'FDS cyan ○ / fallback gray / mixed purple; stair smoke amber →'];
    if(scene.riskOverlay) {
      lines.push(`2D map: ${scene.riskOverlay.legend}`);
      const {minValue,maxValue,unit}=scene.riskOverlay;
      lines.push(`Current range: ${minValue?.toFixed(2) ?? '--'}–${maxValue?.toFixed(2) ?? '--'} ${unit}`);
    }
    if(scene.profiler) {
      const p=scene.profiler;
      lines.push(
        `PERF ${Number(p.fps || 0).toFixed(1)} RAF / ${Number(p.renderFps || 0).toFixed(1)} draw FPS | frame ${Number(p.frameWorkMs || 0).toFixed(1)} ms | draw ${Number(p.renderMs || 0).toFixed(1)} ms | ${scene.renderQuality || "full"}`
      );
      lines.push(
        `Smoke ${Number(p.smokeMs || 0).toFixed(2)} ms/tick | substeps ${Number(p.smokeSubsteps || 0).toFixed(1)} | active ${p.activeSmokeCells || 0}/${p.totalGridCells || 0}`
      );
      lines.push(
        `Agents ${Number(p.agentMs || 0).toFixed(2)} ms/step | Fire ${Number(p.fireMs || 0).toFixed(2)} ms/tick`
      );
    }
    if(scene.routeDebug) {
      const r=scene.routeDebug;
      const exits=(r.byExit || []).map(([idx,count])=>`E${idx+1}:${count}`).join(' ');
      lines.push(
        `ROUTE ${exits || 'none'} | fallback ${r.fallback || 0}/${r.active || 0}`
      );
      const safe=(r.safeByExit || []).map(item =>
        `E${item.idx+1}:${item.reachable}${item.masked?'X':''}`
      ).join(' ');
      if(safe) lines.push(`SAFE ${safe} | X=exit inside fire mask`);
    }
    ctx.save(); ctx.font='11px Consolas, monospace';ctx.textAlign='left';ctx.textBaseline='top';
    const rect=cvs.getBoundingClientRect(), top=12, width=Math.max(50,rect.width-24);
    // Wrap instead of squeezing scientific units; the existing evacuation HUD occupies the bottom right.
    const wrapped=[];
    for(const line of lines) {
      let current='';
      for(const word of line.split(' ')) {
        const next=current ? current+' '+word : word;
        if(current && ctx.measureText(next).width>width) {wrapped.push(current);current=word;} else current=next;
      }
      wrapped.push(current);
    }
    ctx.fillStyle='rgba(255,255,255,.94)';
    ctx.fillRect(5,top-5,Math.min(rect.width-10,800),wrapped.length*16+8);
    ctx.strokeStyle='#b8bec4';
    ctx.lineWidth=1;
    ctx.strokeRect(5,top-5,Math.min(rect.width-10,800),wrapped.length*16+8);
    ctx.fillStyle='#30363b';
    wrapped.forEach((line,i)=>ctx.fillText(line,12,top+i*16));
    ctx.restore();
  }

  function render(scene) {
    const rect = cvs.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    const canContinue = drawGrid(scene);
    if (!canContinue || !scene.grid) return;
    // Fire-avoidance mask is retained as a debug helper but is not painted
    // during normal simulation; thousands of translucent cell fills are costly.
    drawSmoke(scene);
    drawRiskOverlay(scene);
    drawFireAndSources(scene);
    drawAgents(scene);
    drawHeatmap(scene);
    if(scene.selectedCell?.floorIndex===scene.currentFloor) {
      ctx.strokeStyle='#ffffff';ctx.lineWidth=.8;
      ctx.strokeRect(scene.selectedCell.cx*cellSizePx,scene.selectedCell.cy*cellSizePx,cellSizePx,cellSizePx);
    }
    ctx.restore();
    drawHUD(scene);
  }

  function setCellSizePx(value) {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0 || next === cellSizePx) return cellSizePx;
    cellSizePx = next;
    staticLayer = null;
    staticLayerKey = "";
    return cellSizePx;
  }

  return {
    render,
    setCellSizePx,
    drawGrid,
    drawAgents,
    drawSmoke,
    drawRiskOverlay,
    drawHeatmap,
    drawHUD
  };
}

export function initRenderer() {}
