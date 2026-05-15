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

  function drawSmoke(scene) {
    const { grid, gridW, gridH, smokeMap } = scene;
    if (!grid) return;
    ctx.fillStyle = "rgba(255,40,40,0.5)";
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (grid[y][x].fire) ctx.fillRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
      }
    }
    if (!smokeMap) return;
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const s = smokeMap[y][x];
        if (s <= 0.02) continue;
        const v = Math.min(s / 2.0, 1.0);
        let gray = 180;
        let alpha = 0.35;
        if (v >= 0.66) {
          gray = 40;
          alpha = 0.9;
        } else if (v >= 0.33) {
          gray = 110;
          alpha = 0.65;
        }
        ctx.fillStyle = `rgba(${gray},${gray},${gray},${alpha})`;
        ctx.fillRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
        if (v > 0.66) {
          ctx.fillStyle = "rgba(0,0,0,0.25)";
          ctx.fillRect(x * cellSizePx, y * cellSizePx, cellSizePx, cellSizePx);
        }
      }
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
    ctx.fillStyle = "rgba(255,220,150,0.9)";
    ctx.font = "10px Consolas";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`フロア ${scene.currentFloor + 1}/${scene.floorCount}`, 4, 4);
  }

  function render(scene) {
    const rect = cvs.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    const canContinue = drawGrid(scene);
    if (!canContinue || !scene.grid) return;
    drawSmoke(scene);
    drawAgents(scene);
    drawHeatmap(scene);
    drawHUD(scene);
    ctx.restore();
  }

  return {
    render,
    drawGrid,
    drawAgents,
    drawSmoke,
    drawHeatmap,
    drawHUD
  };
}

export function initRenderer() {}
