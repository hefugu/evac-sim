import { DEFAULT_HAZARD_DISPLAY, computeSmokeDisplayOpacity, displayMetricValue, displayMetricColor,
  displayLegend, createFireDisplayData, isFireSpreadFront, resolveHazardDisplaySource,
  sourceOverlayMatches, SOURCE_COLORS } from './visualization/hazard-display.js';

export function derive2DCellDisplay(cell, options = {}) {
  const settings = {...DEFAULT_HAZARD_DISPLAY,...options};
  const source = resolveHazardDisplaySource(cell);
  const K = displayMetricValue(cell,'extinction') || 0;
  // L is one cell width [m] at eye height, not a full horizontal ray integral.
  // FDS may measure smoke below a fallback layer: display that eye reading, not a fictitious upper layer.
  const fdsEye = cell?.fdsFields?.includes('opticalDensityM1') || (!cell?.fdsFields && /fds/i.test(cell?.eyeLevelDataSource || cell?.smokeDataSource || ''));
  const layerAbsent = cell?.smokeLayerDepthMeters === 0 && !fdsEye;
  const opacity = computeSmokeDisplayOpacity(K, layerAbsent ? 0 : (options.cellSizeMeters || .5),
    {mode:settings.smokeDisplayMode,gamma:settings.analysisGamma});
  return {opacity,source,color:displayMetricColor(settings.smokeMetric, settings.smokeMetric === 'source' ? source : displayMetricValue(cell,settings.smokeMetric)),
    fire:createFireDisplayData(cell,{metric:settings.fireMetric,isFront:options.isFront})};
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
  function drawGrid(scene) {
    const {
      layout, baseImage, grid, gridW, gridH, stairLinks, pendingStairLink, currentFloor,
      vizPotential, potentialViewMode, potentialExitIndex, potentialByExit, combinedPotential,
      potentialLegendMax
    } = scene;
    const { scale, ox, oy } = layout;

    if (baseImage) {
      ctx.drawImage(baseImage, ox, oy, baseImage.width * scale, baseImage.height * scale);
    } else {
      const rect = cvs.getBoundingClientRect();
      ctx.strokeStyle = "#330011";
      ctx.strokeRect(20, 20, rect.width - 40, rect.height - 40);
      ctx.fillStyle = "#501020";
      ctx.fillText("マップ画像を読み込んでください", 40, 50);
      return false;
    }

    if (!grid) return true;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    ctx.strokeStyle = "rgba(80,0,40,0.25)";
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

    ctx.fillStyle = "rgba(80,220,255,0.42)";
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (grid[y][x].stair) ctx.fillRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
      }
    }

    if (stairLinks.length) {
      ctx.strokeStyle = "rgba(120,255,220,0.95)";
      ctx.fillStyle = "rgba(200,255,245,0.95)";
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
              { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
              { dx: 1, dy: 1 }, { dx: -1, dy: 1 }, { dx: 1, dy: -1 }, { dx: -1, dy: -1 }
            ];
            for (let i = 0; i < dirs.length; i++) {
              const d = dirs[i];
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
              drawArrow(ctx, px, py, best.dx * 1.2, best.dy * 1.2, "rgba(180,255,255,0.7)", 0.3);
            }
          }
        }
      }
    }
    return true;
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
    scene.grid.forEach((row,y)=>row.forEach((cell,x)=>{
      const view = derive2DCellDisplay(cell,{...scene.hazardDisplay,cellSizeMeters:scene.cellSizeMeters});
      if (!(view.opacity > 0)) return;
      ctx.save(); ctx.globalAlpha = view.opacity; ctx.fillStyle = view.color;
      ctx.fillRect(x*cellSizePx,y*cellSizePx,cellSizePx,cellSizePx); ctx.restore();
    }));
  }

  function drawFireAndSources(scene) {
    const settings = {...DEFAULT_HAZARD_DISPLAY,...scene.hazardDisplay};
    scene.grid.forEach((row,y)=>row.forEach((cell,x)=>{
      const view = derive2DCellDisplay(cell,{...settings,isFront:isFireSpreadFront(scene.grid,x,y)});
      const px=(x+.5)*cellSizePx, py=(y+.5)*cellSizePx;
      if (view.fire.active) {
        // Glyph radius grows with state HRR. The floor cell is not uniformly painted as flame.
        const radius=cellSizePx*(.18+.3*Math.min(1,view.fire.flameHeightMeters/2.32));
        const glow=ctx.createRadialGradient(px,py,0,px,py,radius);
        glow.addColorStop(0,'rgba(255,245,190,.95)');
        glow.addColorStop(.35,view.fire.color); glow.addColorStop(1,'rgba(255,80,20,0)');
        ctx.save(); ctx.globalAlpha=.3+.7*view.fire.strength; ctx.fillStyle=glow;
        ctx.fillRect(px-radius,py-radius,radius*2,radius*2); ctx.restore();
        ctx.strokeStyle=view.fire.origin==='spread'?'#ffad55':'#fff0b0'; ctx.lineWidth=.4;
        if (view.fire.origin==='source') ctx.strokeRect(px-.6,py-.6,1.2,1.2);
        else {ctx.beginPath();ctx.arc(px,py,.65,0,Math.PI*2);ctx.stroke();}
        if(settings.fireMetric==='spread_front' && view.fire.isFront) {
          ctx.strokeStyle='#ff503d';ctx.lineWidth=.8;ctx.strokeRect(x*cellSizePx,y*cellSizePx,cellSizePx,cellSizePx);
        }
      }
      if (sourceOverlayMatches(settings.dataSourceOverlay,view.source)) {
        ctx.strokeStyle=SOURCE_COLORS[view.source];ctx.lineWidth=.45;
        ctx.strokeRect(x*cellSizePx+.2,y*cellSizePx+.2,cellSizePx-.4,cellSizePx-.4);
      }
      if(cell.fdsSamples?.length) {
        ctx.strokeStyle=SOURCE_COLORS.fds;ctx.lineWidth=.4;ctx.beginPath();ctx.arc(px,py,cellSizePx*.25,0,Math.PI*2);ctx.stroke();
      }
    }));
    for(const transfer of scene.verticalSmokeTransfers || []) {
      if (!(transfer.volumeM3>0 || transfer.sootMassKg>0 || transfer.amount>0)) continue;
      const endpoint=(transfer.from?.floorIndex ?? transfer.from?.floor)===scene.currentFloor ? transfer.from :
        (transfer.to?.floorIndex ?? transfer.to?.floor)===scene.currentFloor ? transfer.to : null;
      if(!endpoint) continue;
      drawArrow(ctx,(endpoint.cx+.5)*cellSizePx,(endpoint.cy+.5)*cellSizePx,0,-cellSizePx*.9,'#ffbd67',.65);
    }
  }

  function drawAgents(scene) {
    const { exits, spawns, allExitPoints, currentFloor, vizTrails, agents, vizFlow, flowField, gridW, gridH } = scene;
    ctx.fillStyle = "#ffdd33";
    exits.forEach((p, idx) => {
      const px = (p.cx + 0.5) * cellSizePx;
      const py = (p.cy + 0.5) * cellSizePx;
      ctx.beginPath();
      ctx.arc(px, py, cellSizePx * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#3b2200";
      ctx.font = `${Math.max(6, cellSizePx * 0.8)}px Consolas`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const globalIndex = allExitPoints.findIndex((e) => e.floor === currentFloor && e.cx === p.cx && e.cy === p.cy);
      ctx.fillText(String((globalIndex >= 0 ? globalIndex : idx) + 1), px, py);
      ctx.fillStyle = "#ffdd33";
    });

    ctx.fillStyle = "#33ffaa";
    spawns.forEach((p) => {
      const px = (p.cx + 0.5) * cellSizePx;
      const py = (p.cy + 0.5) * cellSizePx;
      ctx.beginPath();
      ctx.arc(px, py, cellSizePx * 0.6, 0, Math.PI * 2);
      ctx.fill();
    });

    if (vizTrails && agents.length) {
      agents.forEach((a) => {
        if (!a.trail || a.trail.length < 2 || a.dead) return;
        const baseColor = typeMeta[a.type]?.color || "#ff3366";
        ctx.strokeStyle = baseColor;
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 0.45;
        let drawing = false;
        for (let i = 0; i < a.trail.length; i++) {
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
      });
    }

    if (vizFlow && flowField) {
      const stride = 4;
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
      const pulse = 0.5 + 0.5 * Math.sin(scene.simTime * 4);
      ctx.strokeStyle = `rgba(255,120,0,${pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, cellSizePx * (1.2 + pulse), 0, Math.PI * 2);
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
    ctx.fillStyle='rgba(5,13,18,.88)';ctx.fillRect(5,top-5,Math.min(rect.width-10,800),wrapped.length*16+8);
    ctx.fillStyle='#d9eef5';wrapped.forEach((line,i)=>ctx.fillText(line,12,top+i*16));
    ctx.restore();
  }

  function render(scene) {
    const rect = cvs.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    const canContinue = drawGrid(scene);
    if (!canContinue || !scene.grid) return;
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

  return {
    render,
    drawGrid,
    drawAgents,
    drawSmoke,
    drawRiskOverlay,
    drawHeatmap,
    drawHUD
  };
}

export function initRenderer() {}
