/* ===== 旋转目标检测：多边形/SAM分割 → 最小外接矩形 → rbox 标注 ===== */

// ---- 状态 ----
let rotTool = "polygon";
let rotImgW = 0, rotImgH = 0;
let rotBaseImg = null;
let rotAnnotations = [];
let rotNextId = 1;
let rotCurrentPolygon = [];
let rotSelectedIdx = -1;
let rotDragging = false, rotDragStart = null, rotDragMoved = false;
let rotVertexDragging = false, rotVertexIdx = -1;
let rotScale = 1, rotOffsetX = 0, rotOffsetY = 0;
let rotPanning = false, rotPanStart = null;
let rotMouseImgX = -1, rotMouseImgY = -1;
let rotUndoStack = [];
const ROT_UNDO_MAX = 50;
let rotFiles = [], rotFileIdx = -1;
let rotOutputDir = "C:\\Users\\BTW\\Desktop\\DB250ml已标注";
let rotAnnotatedFiles = new Set();
let rotBusy = false;
const ROT_COLORS = ["#d946ef", "#a855f7", "#ec4899", "#8b5cf6", "#f472b6", "#c084fc", "#e879f9", "#9333ea"];

// SAM 提示状态
let rotSamPoints = [];
let rotSamBox = null;
let rotSamBoxStart = null;
let rotSamDrawing = false;
let rotSamOverlayImg = null;

// LA 检测结果（临时存储，用于逐框分割）
let rotLaBoxes = [];

// 批量处理
let rotBatchRunning = false;

const rotCanvas = document.getElementById("rot-canvas");
const rotCtx = rotCanvas.getContext("2d");

// ---- 工具 ----
function rotCanvasToImage(e) {
  const r = rotCanvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) * (rotCanvas.width / r.width);
  const cy = (e.clientY - r.top) * (rotCanvas.height / r.height);
  return { x: Math.round((cx - rotOffsetX) / rotScale), y: Math.round((cy - rotOffsetY) / rotScale) };
}

function rotRboxToCorners(rbox) {
  const [cx, cy, w, h, angle] = rbox;
  const rad = angle * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = w / 2, dy = h / 2;
  const offsets = [[-dx, -dy], [dx, -dy], [dx, dy], [-dx, dy]];
  return offsets.map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
}

function rotPointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function rotHitTest(ann, x, y) {
  if (ann.data.corners && ann.data.corners.length === 4) {
    return rotPointInPolygon([x, y], ann.data.corners);
  }
  if (ann.data.points && ann.data.points.length >= 3) {
    return rotPointInPolygon([x, y], ann.data.points);
  }
  return false;
}

function rotCenter(ann) {
  if (ann.data.rbox) return [ann.data.rbox[0], ann.data.rbox[1]];
  if (ann.data.points && ann.data.points.length) {
    let sx = 0, sy = 0;
    ann.data.points.forEach(p => { sx += p[0]; sy += p[1]; });
    return [sx / ann.data.points.length, sy / ann.data.points.length];
  }
  return [rotImgW / 2, rotImgH / 2];
}

// ---- 撤销 ----
function rotPushUndo() {
  const snap = rotAnnotations.map(a => ({
    id: a.id, type: a.type, label: a.label,
    data: JSON.parse(JSON.stringify(a.data)),
  }));
  rotUndoStack.push(snap);
  if (rotUndoStack.length > ROT_UNDO_MAX) rotUndoStack.shift();
}

function rotUndo() {
  if (!rotUndoStack.length) { toast("无可撤销操作", "info"); return; }
  const prev = rotUndoStack.pop();
  rotAnnotations = prev.map(a => ({ id: a.id, type: a.type, label: a.label, data: { ...a.data } }));
  rotSelectedIdx = -1;
  rotRenderTargets();
  rotRender();
  toast("已撤销", "info");
}

// ---- 渲染 ----
function rotRender() {
  if (!rotBaseImg) return;
  rotCtx.clearRect(0, 0, rotCanvas.width, rotCanvas.height);
  rotCtx.save();
  rotCtx.translate(rotOffsetX, rotOffsetY);
  rotCtx.scale(rotScale, rotScale);
  rotCtx.drawImage(rotBaseImg, 0, 0);

  // SAM overlay 预览
  if (rotSamOverlayImg) {
    rotCtx.save();
    rotCtx.globalAlpha = 0.6;
    rotCtx.drawImage(rotSamOverlayImg, 0, 0, rotImgW, rotImgH);
    rotCtx.restore();
  }

  // 已保存标注
  rotAnnotations.forEach((ann, i) => {
    const color = ROT_COLORS[i % ROT_COLORS.length];
    const isSel = i === rotSelectedIdx;
    const alpha = isSel ? "60" : "30";
    const lw = isSel ? 3 : 2;

    // 多边形半透明填充
    if (ann.data.points && ann.data.points.length > 0) {
      const pts = ann.data.points;
      rotCtx.beginPath();
      rotCtx.moveTo(pts[0][0], pts[0][1]);
      for (let j = 1; j < pts.length; j++) rotCtx.lineTo(pts[j][0], pts[j][1]);
      rotCtx.closePath();
      rotCtx.fillStyle = color + "18";
      rotCtx.fill();
    }

    // 旋转矩形
    if (ann.data.corners && ann.data.corners.length === 4) {
      const c = ann.data.corners;
      rotCtx.beginPath();
      rotCtx.moveTo(c[0][0], c[0][1]);
      for (let j = 1; j < 4; j++) rotCtx.lineTo(c[j][0], c[j][1]);
      rotCtx.closePath();
      rotCtx.fillStyle = color + alpha;
      rotCtx.fill();
      rotCtx.strokeStyle = color;
      rotCtx.lineWidth = lw / rotScale;
      rotCtx.stroke();

      // 中心点
      if (ann.data.rbox) {
        const [cx, cy] = [ann.data.rbox[0], ann.data.rbox[1]];
        rotCtx.fillStyle = "#fff";
        rotCtx.fillRect(cx - 3, cy - 3, 6, 6);
        rotCtx.strokeStyle = color;
        rotCtx.lineWidth = 1.5 / rotScale;
        rotCtx.strokeRect(cx - 3, cy - 3, 6, 6);

        // 角度文字
        rotCtx.save();
        rotCtx.scale(1 / rotScale, 1 / rotScale);
        rotCtx.fillStyle = color;
        rotCtx.font = "bold 12px Consolas, monospace";
        rotCtx.fillText(`${ann.data.rbox[4]}° ${ann.label}`, (cx + 8) * rotScale, (cy - 8) * rotScale);
        rotCtx.restore();
      }

      // 选中时画角点
      if (isSel) {
        for (const pt of c) {
          rotCtx.fillStyle = "#fff";
          rotCtx.fillRect(pt[0] - 4, pt[1] - 4, 8, 8);
          rotCtx.strokeStyle = color;
          rotCtx.lineWidth = 1.5 / rotScale;
          rotCtx.strokeRect(pt[0] - 4, pt[1] - 4, 8, 8);
        }
      }
    }
  });

  // SAM 提示点
  rotSamPoints.forEach(p => {
    rotCtx.beginPath();
    rotCtx.arc(p.x, p.y, 6 / rotScale, 0, Math.PI * 2);
    rotCtx.fillStyle = p.label === 1 ? "#00d084" : "#ff4d4f";
    rotCtx.fill();
    rotCtx.strokeStyle = "#fff";
    rotCtx.lineWidth = 2 / rotScale;
    rotCtx.stroke();
  });

  // SAM 框
  if (rotSamBox) {
    rotCtx.strokeStyle = "#ff9500";
    rotCtx.lineWidth = 2 / rotScale;
    rotCtx.setLineDash([6 / rotScale, 3 / rotScale]);
    rotCtx.strokeRect(rotSamBox[0], rotSamBox[1], rotSamBox[2] - rotSamBox[0], rotSamBox[3] - rotSamBox[1]);
    rotCtx.setLineDash([]);
  }

  // 当前多边形（含鼠标位置预览虚线）
  if (rotCurrentPolygon.length > 0) {
    // 已有顶点连线
    rotCtx.beginPath();
    rotCtx.moveTo(rotCurrentPolygon[0][0], rotCurrentPolygon[0][1]);
    for (let j = 1; j < rotCurrentPolygon.length; j++) rotCtx.lineTo(rotCurrentPolygon[j][0], rotCurrentPolygon[j][1]);
    // 鼠标位置预览线
    if (rotMouseImgX >= 0 && rotMouseImgY >= 0) rotCtx.lineTo(rotMouseImgX, rotMouseImgY);
    rotCtx.strokeStyle = "#d946ef";
    rotCtx.lineWidth = 2 / rotScale;
    rotCtx.setLineDash([4 / rotScale, 3 / rotScale]);
    rotCtx.stroke();
    rotCtx.setLineDash([]);
    // 鼠标到第一个点的闭合预览虚线
    if (rotCurrentPolygon.length >= 2 && rotMouseImgX >= 0) {
      rotCtx.beginPath();
      rotCtx.moveTo(rotMouseImgX, rotMouseImgY);
      rotCtx.lineTo(rotCurrentPolygon[0][0], rotCurrentPolygon[0][1]);
      rotCtx.strokeStyle = "rgba(217,70,239,0.35)";
      rotCtx.setLineDash([3 / rotScale, 2 / rotScale]);
      rotCtx.stroke();
      rotCtx.setLineDash([]);
    }
    // 顶点
    for (let j = 0; j < rotCurrentPolygon.length; j++) {
      const pt = rotCurrentPolygon[j];
      rotCtx.beginPath();
      rotCtx.arc(pt[0], pt[1], 3.5 / rotScale, 0, Math.PI * 2);
      rotCtx.fillStyle = j === 0 ? "#fff" : "#d946ef";
      rotCtx.fill();
      rotCtx.strokeStyle = "#d946ef";
      rotCtx.lineWidth = 1.2 / rotScale;
      rotCtx.stroke();
    }
    // 鼠标十字标记
    if (rotMouseImgX >= 0) {
      rotCtx.strokeStyle = "rgba(217,70,239,0.6)";
      rotCtx.lineWidth = 1 / rotScale;
      rotCtx.setLineDash([3 / rotScale, 3 / rotScale]);
      rotCtx.beginPath();
      rotCtx.moveTo(rotMouseImgX - 8 / rotScale, rotMouseImgY); rotCtx.lineTo(rotMouseImgX + 8 / rotScale, rotMouseImgY);
      rotCtx.moveTo(rotMouseImgX, rotMouseImgY - 8 / rotScale); rotCtx.lineTo(rotMouseImgX, rotMouseImgY + 8 / rotScale);
      rotCtx.stroke();
      rotCtx.setLineDash([]);
    }
  }

  rotCtx.restore();
}

function rotRenderTargets() {
  $("rot-count").textContent = rotAnnotations.length;
  const box = $("rot-targets");
  if (!rotAnnotations.length) { box.innerHTML = `<div class="empty-state">无目标</div>`; return; }
  box.innerHTML = rotAnnotations.map((a, i) => {
    const color = ROT_COLORS[i % ROT_COLORS.length];
    const isSel = i === rotSelectedIdx;
    const angle = a.data.rbox ? a.data.rbox[4] + "°" : "";
    return `<div class="ann-target-item ${isSel ? "selected" : ""}" data-idx="${i}" onclick="rotSelectTarget(${i})" ondblclick="rotFocusTarget(${i})">
      <span class="ann-color-dot" style="background:${color}"></span>
      <span class="type-tag">${angle}</span>
      <input class="ann-label-input" value="${esc(a.label || "object")}" data-idx="${i}" onclick="event.stopPropagation()" ondblclick="event.stopPropagation()" onchange="rotRenameTarget(${i}, this.value)" onfocus="this.select()">
      <button class="locate-btn" onclick="event.stopPropagation(); rotFocusTarget(${i})" title="定位"><i class="fa fa-crosshairs"></i></button>
      <button class="del-btn" onclick="event.stopPropagation(); rotDeleteTarget(${i})" title="删除"><i class="fa fa-times"></i></button>
    </div>`;
  }).join("");
}

function rotFitCanvas() {
  if (!rotImgW || !rotBaseImg) return;
  const container = $("rot-canvas-wrap");
  if (!container) return;
  const cw = container.clientWidth - 8;
  const ch = container.clientHeight - 30;
  if (cw <= 0 || ch <= 0) return;
  rotCanvas.width = cw;
  rotCanvas.height = ch;
  rotCanvas.style.width = cw + "px";
  rotCanvas.style.height = ch + "px";
  const s = Math.min(cw / rotImgW, ch / rotImgH);
  rotScale = s;
  rotOffsetX = (cw - rotImgW * s) / 2;
  rotOffsetY = (ch - rotImgH * s) / 2;
  rotRender();
}

// ---- 工具切换 ----
function rotSetTool(tool) {
  rotTool = tool;
  if (tool !== "select") rotSelectedIdx = -1;
  if (rotCurrentPolygon.length > 0 && tool !== "polygon") rotCurrentPolygon = [];
  if (tool !== "box" && tool !== "pos" && tool !== "neg") {
    rotSamDrawing = false;
  }
  document.querySelectorAll(".rot-tool-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
  const cursors = { polygon: "crosshair", select: "default", pos: "crosshair", neg: "crosshair", box: "crosshair" };
  rotCanvas.style.cursor = cursors[tool] || "default";
  rotRender();
  rotRenderTargets();
}

// ---- 重新计算选中标注的外接矩形（修改顶点/角点后） ----
async function rotRecalcSelected() {
  if (rotSelectedIdx < 0 || rotSelectedIdx >= rotAnnotations.length) return false;
  const ann = rotAnnotations[rotSelectedIdx];
  // 优先用 corners（拖动修改的是 corners），其次用 points
  let pts = ann.data.corners && ann.data.corners.length >= 3 ? ann.data.corners : ann.data.points;
  if (!pts || pts.length < 3) { toast("该标注无多边形/角点数据", "error"); return false; }
  rotBusy = true;
  $("rot-status").textContent = "重新计算外接矩形...";
  try {
    const d = await fetchJSON("/api/rotated/min_area_rect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: pts }),
    });
    if (!d.ok) { toast(d.error || "计算失败", "error"); return false; }
    // 同步 points 和 corners
    ann.data.points = pts.map(p => [p[0], p[1]]);
    ann.data.rbox = d.rbox;
    ann.data.corners = d.corners;
    rotRender();
    rotRenderTargets();
    toast(`已重新计算 (角度 ${d.rbox[4]}°)`, "success");
    return true;
  } catch (e) {
    toast("计算异常: " + e.message, "error");
    return false;
  } finally {
    rotBusy = false;
    $("rot-status").textContent = "就绪";
  }
}

// ---- 完成当前多边形标注 ----
async function rotFinishCurrent() {
  if (rotCurrentPolygon.length < 3) {
    toast("多边形至少需要3个点", "error");
    return false;
  }
  rotBusy = true;
  try {
    const d = await fetchJSON("/api/rotated/min_area_rect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: rotCurrentPolygon }),
    });
    if (!d.ok) { toast(d.error || "计算失败", "error"); return false; }
    rotPushUndo();
    rotAnnotations.push({
      id: rotNextId++, type: "rbox",
      label: ($("rot-label").value || "object").trim(),
      data: { points: rotCurrentPolygon.slice(), rbox: d.rbox, corners: d.corners },
    });
    rotCurrentPolygon = [];
    rotRenderTargets();
    rotRender();
    toast(`已添加旋转框 (角度 ${d.rbox[4]}°)`, "success");
    return true;
  } catch (e) {
    toast("计算异常: " + e.message, "error");
    return false;
  } finally {
    rotBusy = false;
  }
}

// ---- SAM 分割预测 ----
async function rotSamPredictCore() {
  if (!(await rotEnsureSamImage())) return;
  const body = {
    points: rotSamPoints.map(p => [p.x, p.y]),
    labels: rotSamPoints.map(p => p.label),
    box: rotSamBox,
    multimask: rotSamPoints.length + (rotSamBox ? 1 : 0) <= 1,
  };
  try {
    const d = await fetchJSON("/api/sam3/predict", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!d.ok) { toast(d.error || "预测失败", "error"); return; }
    if (d.masks && d.masks.length > 0) {
      const best = d.masks[d.best_index];
      rotSamOverlayImg = new Image();
      rotSamOverlayImg.onload = () => rotRender();
      rotSamOverlayImg.src = "data:image/png;base64," + best.overlay;
    }
  } catch (e) {
    toast("预测异常: " + e.message, "error");
  }
}

async function rotSamPredict() {
  if (rotBusy) return;
  rotBusy = true;
  $("rot-status").textContent = "SAM 分割中...";
  await rotSamPredictCore();
  rotBusy = false;
  $("rot-status").textContent = "就绪";
  if (rotSamOverlayImg) toast(`分割完成，点「完成」计算rbox`, "success");
}

// ---- 从 SAM mask 完成 rbox 标注 ----
async function rotSamFinishMask() {
  if (!rotSamOverlayImg) { toast("无 SAM 分割结果，请先分割", "error"); return false; }
  rotBusy = true;
  $("rot-status").textContent = "计算最小外接矩形...";
  try {
    const tmp = document.createElement("canvas");
    tmp.width = rotImgW; tmp.height = rotImgH;
    tmp.getContext("2d").drawImage(rotSamOverlayImg, 0, 0, rotImgW, rotImgH);
    const maskB64 = tmp.toDataURL("image/png");
    const d = await fetchJSON("/api/rotated/mask_to_rbox", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mask: maskB64 }),
    });
    if (!d.ok) { toast(d.error || "rbox 计算失败", "error"); return false; }
    rotPushUndo();
    rotAnnotations.push({
      id: rotNextId++, type: "rbox",
      label: ($("rot-label").value || "object").trim(),
      data: { points: [], rbox: d.rbox, corners: d.corners },
    });
    rotSamOverlayImg = null;
    rotSamClear();
    rotRenderTargets();
    rotRender();
    toast(`已从 mask 生成旋转框 (角度 ${d.rbox[4]}°)`, "success");
    return true;
  } catch (e) {
    toast("异常: " + e.message, "error");
    return false;
  } finally {
    rotBusy = false;
    $("rot-status").textContent = "就绪";
  }
}

function rotSamClear() {
  rotSamPoints = [];
  rotSamBox = null;
  rotSamOverlayImg = null;
  rotSamDrawing = false;
  rotRender();
  fetchJSON("/api/sam3/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
}

// ---- SAM 文本查询 (Grounding) → 逐个 mask 转 rbox ----
async function rotSamGround() {
  if (!rotBaseImg || !rotFiles.length || rotFileIdx < 0) { toast("请先载入图片", "error"); return; }
  if (rotBusy) return;
  const text = ($("rot-sam-text").value || "").trim();
  if (!text) { toast("请输入查询文字", "error"); return; }
  if (!(await rotEnsureSamImage())) return;
  rotBusy = true;
  $("rot-status").textContent = "SAM 文本查询中...";
  const t0 = Date.now();
  try {
    const d = await fetchJSON("/api/sam3/ground", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, boxes: [] }),
    });
    if (!d.ok) { toast(d.error || "查询失败", "error"); return; }
    const objs = d.objects || [];
    if (!objs.length) { toast("未找到匹配物体", "info"); return; }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    toast(`找到 ${objs.length} 个物体 (${elapsed}s)，正在计算rbox...`, "success");
    rotPushUndo();
    let saved = 0;
    for (let i = 0; i < objs.length; i++) {
      const obj = objs[i];
      $("rot-status").textContent = `计算 rbox ${i + 1}/${objs.length}`;
      // 加载 overlay mask
      const overlayImg = new Image();
      await new Promise((resolve) => {
        overlayImg.onload = resolve;
        overlayImg.onerror = resolve;
        overlayImg.src = "data:image/png;base64," + obj.overlay;
      });
      // 转 mask → rbox
      try {
        const tmp = document.createElement("canvas");
        tmp.width = rotImgW; tmp.height = rotImgH;
        tmp.getContext("2d").drawImage(overlayImg, 0, 0, rotImgW, rotImgH);
        const maskB64 = tmp.toDataURL("image/png");
        const rd = await fetchJSON("/api/rotated/mask_to_rbox", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mask: maskB64 }),
        });
        if (rd.ok) {
          rotAnnotations.push({
            id: rotNextId++, type: "rbox",
            label: text,
            data: { points: [], rbox: rd.rbox, corners: rd.corners },
          });
          saved++;
        }
      } catch (e) { console.error("mask_to_rbox 失败:", e); }
    }
    rotRenderTargets();
    rotRender();
    toast(`SAM 文本查询: ${saved}/${objs.length} 个已保存为rbox`, "success");
  } catch (e) {
    toast("查询异常: " + e.message, "error");
  } finally {
    rotBusy = false;
    $("rot-status").textContent = "就绪";
  }
}

// ---- LocateAnything 检测 ----
async function rotLaDetect() {
  if (!rotBaseImg || !rotFiles.length || rotFileIdx < 0) { toast("请先载入图片", "error"); return; }
  if (rotBusy) return;
  const mode = $("rot-la-mode").value;
  const query = ($("rot-la-query").value || "").trim();
  if (!query) { toast("请输入查询内容", "error"); return; }
  const imagePath = rotFiles[rotFileIdx].path;
  rotBusy = true;
  $("rot-status").textContent = "LocateAnything 检测中...";
  const t0 = Date.now();
  try {
    let endpoint, body;
    if (mode === "detect") {
      endpoint = "/api/la/detect";
      body = { image_path: imagePath, categories: query.split(",").map(s => s.trim()).filter(Boolean) };
    } else {
      endpoint = "/api/la/ground";
      body = { image_path: imagePath, phrase: query, mode: "multi" };
    }
    const d = await fetchJSON(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    if (!d.ok) { toast(d.error || "检测失败", "error"); return; }
    const boxes = d.boxes || [];
    if (!boxes.length) { toast("未检测到物体 (" + elapsed + "s)", "info"); return; }
    rotLaBoxes = boxes.map(b => ({
      x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
      label: b.label || query.split(",")[0].trim(),
    }));
    toast(`检测到 ${rotLaBoxes.length} 个物体 (${elapsed}s)，点「逐框分割」计算rbox`, "success");
  } catch (e) {
    toast("检测异常: " + e.message, "error");
  } finally {
    rotBusy = false;
    $("rot-status").textContent = "就绪";
  }
}

// ---- 逐框 SAM 分割 + 计算 rbox ----
async function rotLaToSam() {
  if (!rotLaBoxes.length) { toast("请先执行 LA 检测", "error"); return; }
  if (rotBusy) return;
  if (!rotFiles.length || rotFileIdx < 0) { toast("请先选择图片", "error"); return; }
  rotBusy = true;
  $("rot-status").textContent = "逐框分割中...";
  rotPushUndo();
  let saved = 0;
  for (let i = 0; i < rotLaBoxes.length; i++) {
    const b = rotLaBoxes[i];
    $("rot-status").textContent = `分割 ${i + 1}/${rotLaBoxes.length}: ${b.label}`;
    rotSamPoints = [];
    rotSamBox = [b.x1, b.y1, b.x2, b.y2];
    rotRender();
    await rotSamPredictCore();
    await new Promise(r => setTimeout(r, 200));
    if (rotSamOverlayImg) {
      try {
        const tmp = document.createElement("canvas");
        tmp.width = rotImgW; tmp.height = rotImgH;
        tmp.getContext("2d").drawImage(rotSamOverlayImg, 0, 0, rotImgW, rotImgH);
        const maskB64 = tmp.toDataURL("image/png");
        const d = await fetchJSON("/api/rotated/mask_to_rbox", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mask: maskB64 }),
        });
        if (d.ok) {
          rotAnnotations.push({
            id: rotNextId++, type: "rbox",
            label: b.label,
            data: { points: [], rbox: d.rbox, corners: d.corners },
          });
          saved++;
        }
      } catch (e) { console.error("mask_to_rbox 失败:", e); }
    }
    rotSamOverlayImg = null;
    rotSamBox = null;
    rotRender();
    await new Promise(r => setTimeout(r, 150));
  }
  rotLaBoxes = [];
  rotRenderTargets();
  rotRender();
  toast(`逐框分割完成: ${saved}/${rotLaBoxes.length || saved} 个`, "success");
  rotBusy = false;
  $("rot-status").textContent = "就绪";
}

// ---- 批量处理整个文件夹 ----
async function rotBatch() {
  if (rotBusy) return;
  if (!rotFiles.length) { toast("请先加载文件列表", "error"); return; }
  const query = ($("rot-la-query").value || "").trim();
  if (!query) { toast("请输入查询内容", "error"); return; }
  const mode = $("rot-la-mode").value;
  rotBatchRunning = true;
  $("rot-batch-bar").classList.remove("hidden");
  $("rot-batch-progress").style.width = "0%";
  $("rot-batch-text").textContent = `0/${rotFiles.length}`;
  rotBusy = true;
  let totalSaved = 0;
  const t0 = Date.now();
  for (let fi = 0; fi < rotFiles.length; fi++) {
    if (!rotBatchRunning) break;
    $("rot-batch-text").textContent = `${fi + 1}/${rotFiles.length}`;
    $("rot-batch-progress").style.width = ((fi + 1) / rotFiles.length * 100) + "%";
    $("rot-status").textContent = `批量处理 ${fi + 1}/${rotFiles.length}: ${rotFiles[fi].name}`;
    await rotOpenFile(fi);
    await new Promise(r => setTimeout(r, 300));
    if (!rotBaseImg) continue;
    // LA 检测
    let endpoint, body;
    if (mode === "detect") {
      endpoint = "/api/la/detect";
      body = { image_path: rotFiles[fi].path, categories: query.split(",").map(s => s.trim()).filter(Boolean) };
    } else {
      endpoint = "/api/la/ground";
      body = { image_path: rotFiles[fi].path, phrase: query, mode: "multi" };
    }
    let boxes = [];
    try {
      const d = await fetchJSON(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (d.ok) boxes = d.boxes || [];
    } catch (e) { console.error("LA 失败:", e); }
    if (!boxes.length) continue;
    // 逐框分割
    for (let i = 0; i < boxes.length; i++) {
      if (!rotBatchRunning) break;
      const b = boxes[i];
      rotSamPoints = [];
      rotSamBox = [b.x1, b.y1, b.x2, b.y2];
      await rotSamPredictCore();
      await new Promise(r => setTimeout(r, 150));
      if (rotSamOverlayImg) {
        try {
          const tmp = document.createElement("canvas");
          tmp.width = rotImgW; tmp.height = rotImgH;
          tmp.getContext("2d").drawImage(rotSamOverlayImg, 0, 0, rotImgW, rotImgH);
          const maskB64 = tmp.toDataURL("image/png");
          const d = await fetchJSON("/api/rotated/mask_to_rbox", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mask: maskB64 }),
          });
          if (d.ok) {
            rotAnnotations.push({
              id: rotNextId++, type: "rbox",
              label: b.label || query.split(",")[0].trim(),
              data: { points: [], rbox: d.rbox, corners: d.corners },
            });
            totalSaved++;
          }
        } catch (e) { console.error("mask_to_rbox 失败:", e); }
      }
      rotSamOverlayImg = null;
      rotSamBox = null;
      await new Promise(r => setTimeout(r, 100));
    }
    // 保存该图结果
    if (rotAnnotations.length) {
      await rotSave();
    }
    rotSamClear();
  }
  rotBatchRunning = false;
  $("rot-batch-bar").classList.add("hidden");
  rotBusy = false;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  $("rot-status").textContent = "就绪";
  toast(`批量完成: ${totalSaved} 个标注 (${elapsed}s)`, "success");
}

function rotBatchStop() {
  rotBatchRunning = false;
  toast("正在停止批量处理...", "info");
}

// ---- 文件列表 ----
async function rotLoadFileList() {
  const folder = ($("rot-folder").value || "").trim();
  if (!folder) { toast("请输入文件夹路径", "error"); return; }
  rotOutputDir = folder;
  try {
    const d = await fetchJSON(`/api/files/list?path=${encodeURIComponent(folder)}`);
    if (d.error) { toast(d.error, "error"); return; }
    rotFiles = d.files || [];
    rotFileIdx = -1;
    rotAnnotatedFiles = new Set();
    // 检查哪些文件已标注
    try {
      const labelFile = folder + "\\rotated_det_labels.txt";
      const resp = await fetchJSON(`/api/rotated/load?output_dir=${encodeURIComponent(folder)}&image_name=__check_all__`);
      if (resp.ok && resp.annotated_files) {
        resp.annotated_files.forEach(f => rotAnnotatedFiles.add(f));
      }
    } catch {}
    rotRenderFileList();
    toast(`找到 ${rotFiles.length} 张图片`, "success");
  } catch (e) {
    toast("加载失败: " + e.message, "error");
  }
}

function rotRenderFileList() {
  const box = $("rot-file-list");
  if (!rotFiles.length) { box.innerHTML = `<div class="empty-state">无图片</div>`; return; }
  box.innerHTML = rotFiles.map((f, i) => {
    const flagged = rotAnnotatedFiles.has(f.name);
    return `<div class="ann-file-item ${i === rotFileIdx ? "active" : ""} ${flagged ? "flagged" : ""}" onclick="rotOpenFile(${i})" title="${esc(f.name)}">
      ${flagged ? '<i class="fa fa-flag ann-flag"></i>' : ''}
      <span class="ann-file-name">${esc(f.name)}</span>
    </div>`;
  }).join("");
}

async function rotOpenFile(idx) {
  if (idx < 0 || idx >= rotFiles.length) return;
  rotFileIdx = idx;
  rotRenderFileList();
  await rotLoadImage(rotFiles[idx].path);
}

function rotNext() { if (rotFileIdx < rotFiles.length - 1) rotOpenFile(rotFileIdx + 1); else toast("已是最后一张", "info"); }
function rotPrev() { if (rotFileIdx > 0) rotOpenFile(rotFileIdx - 1); else toast("已是第一张", "info"); }

let rotSamImageSet = false;
let rotSamImagePath = "";

async function rotEnsureSamImage() {
  if (rotSamImageSet && rotSamImagePath === rotFiles[rotFileIdx].path) return true;
  if (!rotFiles.length || rotFileIdx < 0) return false;
  const path = rotFiles[rotFileIdx].path;
  try {
    const d = await fetchJSON("/api/sam3/set_image", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_path: path }),
    });
    if (!d.ok) { toast("SAM3 载入失败: " + (d.error || ""), "error"); return false; }
    rotSamImageSet = true;
    rotSamImagePath = path;
    return true;
  } catch (e) {
    toast("SAM3 服务不可用，无法使用分割功能", "error");
    return false;
  }
}

async function rotLoadImage(path) {
  if (!path) { toast("请输入图片路径", "error"); return; }
  if (rotBusy && !rotBatchRunning) return;
  $("rot-current-name").textContent = path.split("\\").pop().split("/").pop();
  rotSelectedIdx = -1;
  rotUndoStack = [];
  rotSamPoints = [];
  rotSamBox = null;
  rotSamOverlayImg = null;
  rotSamImageSet = false;
  rotCurrentPolygon = [];
  rotAnnotations = [];
  rotBaseImg = new Image();
  return new Promise((resolve) => {
    rotBaseImg.onload = async () => {
      rotImgW = rotBaseImg.naturalWidth;
      rotImgH = rotBaseImg.naturalHeight;
      $("rot-empty").style.display = "none";
      requestAnimationFrame(() => requestAnimationFrame(rotFitCanvas));
      // 等待 canvas 适配后再加载标注
      await rotLoadAnnotations(path);
      rotRender();
      resolve();
    };
    rotBaseImg.onerror = () => { toast("图片加载失败: " + path, "error"); resolve(); };
    rotBaseImg.src = `/api/image?path=${encodeURIComponent(path)}`;
  });
}

// ---- 保存/加载 ----
async function rotSave(force = false) {
  if (!rotFiles.length || rotFileIdx < 0) { toast("请先选择图片", "error"); return; }
  const imageName = rotFiles[rotFileIdx].name;
  // 空标注时删除该图记录
  if (!rotAnnotations.length) {
    if (!force) { toast("无标注可保存", "error"); return; }
    try {
      const d = await fetchJSON("/api/rotated/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ output_dir: rotOutputDir, image_name: imageName }),
      });
      if (d.ok) {
        rotAnnotatedFiles.delete(imageName);
        rotRenderFileList();
        toast("已删除该图所有标注记录", "info");
      } else toast(d.error || "删除失败", "error");
    } catch (e) { toast("删除异常: " + e.message, "error"); }
    return;
  }
  const annsData = rotAnnotations.map(a => ({ label: a.label, rbox: a.data.rbox }));
  try {
    const d = await fetchJSON("/api/rotated/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        output_dir: rotOutputDir,
        image_name: imageName,
        width: rotImgW,
        height: rotImgH,
        annotations: annsData,
      }),
    });
    if (d.ok) {
      toast(`已保存 ${annsData.length} 个标注`, "success");
      rotAnnotatedFiles.add(imageName);
      rotRenderFileList();
    } else toast(d.error || "保存失败", "error");
  } catch (e) {
    toast("保存异常: " + e.message, "error");
  }
}

async function rotLoadAnnotations(path) {
  const imageName = path.split("\\").pop().split("/").pop();
  try {
    const d = await fetchJSON(`/api/rotated/load?output_dir=${encodeURIComponent(rotOutputDir)}&image_name=${encodeURIComponent(imageName)}`);
    if (d.ok && d.annotations && d.annotations.length) {
      rotAnnotations = d.annotations.map(a => {
        const corners = a.corners || rotRboxToCorners(a.rbox);
        return {
          id: rotNextId++,
          type: "rbox",
          label: a.label || "object",
          data: { points: [], rbox: a.rbox, corners },
        };
      });
      rotRenderTargets();
      rotRender();
    }
  } catch (e) { console.error("加载标注失败:", e); }
}

function rotExport() {
  if (!rotAnnotations.length) { toast("无标注可导出", "error"); return; }
  const data = {
    image: rotFiles.length > 0 && rotFileIdx >= 0 ? rotFiles[rotFileIdx].name : "unknown",
    width: rotImgW,
    height: rotImgH,
    annotations: rotAnnotations.map(a => ({ label: a.label, rbox: a.data.rbox })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const name = rotFiles.length > 0 && rotFileIdx >= 0
    ? rotFiles[rotFileIdx].name.replace(/\.[^.]+$/, "") + "_rbox.json"
    : "rbox_export.json";
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("已导出 " + rotAnnotations.length + " 个标注", "success");
}

// ---- 模型自动标注 ----
async function rotLoadModels() {
  try {
    const d = await fetchJSON("/api/algo/models");
    if (d.ok && d.models) {
      const sel = $("rot-model-select");
      if (!sel) return;
      sel.innerHTML = '<option value="">选择模型</option>' +
        d.models.map(m => `<option value="${esc(m.path)}">${esc(m.name)}</option>`).join("");
    }
  } catch {}
}

async function rotPredictCurrent() {
  if (!rotBaseImg || rotFileIdx < 0) { toast("请先载入图片", "error"); return; }
  const modelPath = $("rot-model-select").value;
  if (!modelPath) { toast("请选择模型", "error"); return; }
  if (!rotFiles[rotFileIdx] || !rotFiles[rotFileIdx].path) { toast("图片路径无效", "error"); return; }
  const imgPath = rotFiles[rotFileIdx].path;
  rotBusy = true;
  $("rot-status").textContent = "模型推理中...";
  try {
    const d = await fetchJSON("/api/algo/rotated/predict", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_path: modelPath, image_path: imgPath })
    });
    if (!d.ok) { toast(d.error || "推理失败", "error"); return; }
    rotPushUndo();
    rotAnnotations = [];
    for (const pred of (d.predictions || [])) {
      const corners = pred.corners && pred.corners.length === 4 ? pred.corners : rotRboxToCorners(pred.rbox);
      rotAnnotations.push({
        id: rotNextId++, type: "rbox",
        label: "object",
        data: {
          points: corners.map(p => [p[0], p[1]]),
          rbox: pred.rbox,
          corners: corners,
        },
      });
    }
    rotSelectedIdx = -1;
    rotRenderTargets();
    rotRender();
    // 自动保存到文件
    if (rotAnnotations.length > 0) {
      await rotSave(true);
    } else {
      toast("模型未检测到目标（可能训练不足或置信度过低）", "info");
    }
  } catch (e) {
    toast("推理异常: " + e.message, "error");
  } finally {
    rotBusy = false;
    $("rot-status").textContent = "就绪";
  }
}

async function rotPredictBatch() {
  if (!rotFiles.length) { toast("请先加载文件列表", "error"); return; }
  const modelPath = $("rot-model-select").value;
  if (!modelPath) { toast("请选择模型", "error"); return; }
  if (!confirm(`将对 ${rotFiles.length} 张图片批量预测并覆盖标注，确认？`)) return;
  rotBusy = true;
  $("rot-status").textContent = "批量推理中...";
  try {
    const d = await fetchJSON("/api/algo/rotated/predict_batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_path: modelPath, folder: rotOutputDir, output_dir: rotOutputDir })
    });
    if (!d.ok) { toast(d.error || "批量推理失败", "error"); return; }
    toast(`批量预测完成 ${d.count} 张`, "success");
    await rotLoadFileList();
  } catch (e) {
    toast("批量推理异常: " + e.message, "error");
  } finally {
    rotBusy = false;
    $("rot-status").textContent = "就绪";
  }
}

// ---- 训练功能（页面内） ----
let rotTrainPollTimer = null;

function rotToggleTrainPanel() {
  const panel = $("rot-train-panel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) {
    // 如果训练正在进行，恢复轮询
    fetchJSON("/api/algo/rotated/train_status").then(d => {
      if (d.ok && d.running && !rotTrainPollTimer) {
        rotTrainPollTimer = setInterval(rotPollTrainStatus, 1000);
      }
    }).catch(() => {});
  }
}

async function rotStartTrain() {
  const data_dir = rotOutputDir || ($("rot-folder").value || "").trim();
  if (!data_dir) { toast("请先打开标注文件夹", "error"); return; }
  const epochs = parseInt($("rot-train-epochs").value) || 100;
  const imgsz = parseInt($("rot-train-imgsz").value) || 640;
  const batch = parseInt($("rot-train-batch").value) || 8;

  $("rot-train-btn").disabled = true;
  $("rot-train-btn").innerHTML = '<i class="fa fa-cog fa-spin mr-1"></i>训练中';
  $("rot-train-progress-wrap").classList.remove("hidden");
  $("rot-train-log").classList.remove("hidden");
  $("rot-train-log").innerHTML = "";
  $("rot-train-status-text").textContent = "启动中...";

  try {
    const d = await fetchJSON("/api/algo/rotated/train", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data_dir, epochs, imgsz, batch })
    });
    if (!d.ok) {
      toast(d.message || d.error || "启动训练失败", "error");
      $("rot-train-btn").disabled = false;
      $("rot-train-btn").innerHTML = '<i class="fa fa-play mr-1"></i>开始训练';
      $("rot-train-status-text").textContent = "失败";
      return;
    }
    toast("训练已启动（后台运行，可继续标注）", "success");
    if (rotTrainPollTimer) clearInterval(rotTrainPollTimer);
    rotTrainPollTimer = setInterval(rotPollTrainStatus, 1000);
  } catch (e) {
    toast("请求失败: " + e.message, "error");
    $("rot-train-btn").disabled = false;
    $("rot-train-btn").innerHTML = '<i class="fa fa-play mr-1"></i>开始训练';
    $("rot-train-status-text").textContent = "失败";
  }
}

async function rotPollTrainStatus() {
  try {
    const d = await fetchJSON("/api/algo/rotated/train_status");
    if (!d.ok) return;
    const pct = d.total_epochs ? (d.epoch / d.total_epochs * 100) : (d.progress || 0);
    $("rot-train-progress-bar").style.width = pct + "%";
    $("rot-train-progress-text").textContent = `${d.epoch} / ${d.total_epochs}`;
    $("rot-train-status-text").textContent = d.running ? "训练中" : (d.error ? "错误" : "完成");
    if (d.log && d.log.length) {
      $("rot-train-log").innerHTML = d.log.slice(-60).map(l => `<div>${esc(l)}</div>`).join("");
      $("rot-train-log").scrollTop = $("rot-train-log").scrollHeight;
    }
    if (!d.running) {
      clearInterval(rotTrainPollTimer); rotTrainPollTimer = null;
      $("rot-train-btn").disabled = false;
      $("rot-train-btn").innerHTML = '<i class="fa fa-play mr-1"></i>开始训练';
      if (d.error) toast("训练失败: " + d.error, "error");
      else {
        toast("训练完成，模型已保存", "success");
        rotLoadModels();  // 刷新模型下拉列表
      }
    }
  } catch (e) {}
}

// ---- 目标列表操作 ----
function rotSelectTarget(idx) {
  if (rotTool !== "select") rotSetTool("select");
  rotSelectedIdx = idx;
  rotRender();
  rotRenderTargets();
}

function rotFocusTarget(idx) {
  if (idx < 0 || idx >= rotAnnotations.length) return;
  rotSelectTarget(idx);
  const ann = rotAnnotations[idx];
  const [cx, cy] = rotCenter(ann);
  const container = $("rot-canvas-wrap");
  if (container) {
    const cw = container.clientWidth - 8;
    const ch = container.clientHeight - 30;
    const targetScale = Math.max(rotScale, Math.min(cw / 200, ch / 200, 8));
    rotScale = targetScale;
    rotOffsetX = cw / 2 - cx * rotScale;
    rotOffsetY = ch / 2 - cy * rotScale;
    rotRender();
  }
  toast(`已定位到 #${idx + 1}: ${ann.label}`, "info");
}

function rotRenameTarget(idx, name) {
  if (idx < 0 || idx >= rotAnnotations.length) return;
  const v = (name || "").trim() || "object";
  rotPushUndo();
  rotAnnotations[idx].label = v;
  toast(`已重命名为 ${v}`, "success");
}

function rotDeleteTarget(idx) {
  if (idx < 0 || idx >= rotAnnotations.length) return;
  rotPushUndo();
  if (idx === rotSelectedIdx) rotSelectedIdx = -1;
  else if (idx < rotSelectedIdx) rotSelectedIdx--;
  rotAnnotations.splice(idx, 1);
  rotRenderTargets();
  rotRender();
  toast("已删除", "info");
}

function rotDeleteSelected() {
  if (rotSelectedIdx >= 0 && rotSelectedIdx < rotAnnotations.length) {
    rotDeleteTarget(rotSelectedIdx);
    // 删除后自动保存（含空标注情况，force=true 时调用 delete 端点）
    rotSave(true);
  }
}

function rotToggleFilePanel() {
  const panel = $("rot-files-panel");
  const expandBtn = $("rot-expand-btn");
  const collapsed = panel.classList.toggle("collapsed");
  expandBtn.classList.toggle("hidden", !collapsed);
  setTimeout(rotFitCanvas, 250);
}

// ---- Canvas 事件 ----
rotCanvas.addEventListener("contextmenu", e => e.preventDefault());

rotCanvas.addEventListener("mousedown", e => {
  if (!rotBaseImg) return;
  if (e.button === 2 || e.button === 1) {
    e.preventDefault();
    rotPanning = true;
    rotPanStart = { x: e.clientX, y: e.clientY, ox: rotOffsetX, oy: rotOffsetY };
    rotCanvas.style.cursor = "grabbing";
    return;
  }
  if (e.button !== 0 || rotBusy) return;
  const p = rotCanvasToImage(e);

  if (rotTool === "select") {
    if (rotSelectedIdx >= 0 && rotAnnotations[rotSelectedIdx].data.corners) {
      const pts = rotAnnotations[rotSelectedIdx].data.corners;
      const hitR = 10 / rotScale;
      for (let v = 0; v < pts.length; v++) {
        const dx = p.x - pts[v][0], dy = p.y - pts[v][1];
        if (Math.sqrt(dx * dx + dy * dy) <= hitR) {
          rotVertexDragging = true;
          rotVertexIdx = v;
          rotPushUndo();
          return;
        }
      }
    }
    let hit = -1;
    for (let i = rotAnnotations.length - 1; i >= 0; i--) {
      if (rotHitTest(rotAnnotations[i], p.x, p.y)) { hit = i; break; }
    }
    if (hit >= 0) {
      rotSelectedIdx = hit;
      rotDragging = true;
      rotDragStart = { x: p.x, y: p.y };
      rotDragMoved = false;
      rotPushUndo();
      rotRenderTargets();
      rotRender();
    } else {
      rotSelectedIdx = -1;
      rotRenderTargets();
      rotRender();
    }
    return;
  }

  if (rotTool === "box") {
    rotSamDrawing = true;
    rotSamBoxStart = p;
    rotSamBox = [p.x, p.y, p.x, p.y];
    rotRender();
  }
});

rotCanvas.addEventListener("mousemove", e => {
  const p = rotCanvasToImage(e);
  rotMouseImgX = p.x; rotMouseImgY = p.y;
  if (rotPanning) return;

  if (rotVertexDragging && rotSelectedIdx >= 0) {
    const corners = rotAnnotations[rotSelectedIdx].data.corners;
    if (corners && rotVertexIdx < corners.length) {
      corners[rotVertexIdx] = [p.x, p.y];
      rotRender();
    }
    return;
  }

  if (rotDragging && rotSelectedIdx >= 0) {
    const dx = p.x - rotDragStart.x, dy = p.y - rotDragStart.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) rotDragMoved = true;
    const ann = rotAnnotations[rotSelectedIdx];
    if (ann.data.corners) {
      ann.data.corners = ann.data.corners.map(pt => [pt[0] + dx, pt[1] + dy]);
    }
    if (ann.data.rbox) {
      ann.data.rbox[0] += dx;
      ann.data.rbox[1] += dy;
    }
    rotDragStart = { x: p.x, y: p.y };
    rotRender();
    return;
  }

  if (!rotSamDrawing) {
    if (rotTool === "polygon" && rotCurrentPolygon.length > 0) rotRender();
    return;
  }

  if (rotTool === "box" && rotSamBox) {
    rotSamBox = [rotSamBoxStart.x, rotSamBoxStart.y, p.x, p.y];
    rotRender();
  }
});

rotCanvas.addEventListener("mouseup", e => {
  if (rotPanning && (e.button === 2 || e.button === 1)) {
    rotPanning = false;
    rotCanvas.style.cursor = rotTool === "select" ? "default" : "crosshair";
    return;
  }
  if (rotVertexDragging) {
    rotVertexDragging = false;
    rotVertexIdx = -1;
    toast("角点已移动", "success");
    return;
  }
  if (rotDragging) {
    rotDragging = false;
    if (rotDragMoved) toast("已移动标注", "success");
    return;
  }
  if (!rotSamDrawing) return;
  rotSamDrawing = false;
  const p = rotCanvasToImage(e);
  if (rotTool === "box" && rotSamBox) {
    rotSamBox = [rotSamBoxStart.x, rotSamBoxStart.y, p.x, p.y];
    const w = Math.abs(rotSamBox[2] - rotSamBox[0]), h = Math.abs(rotSamBox[3] - rotSamBox[1]);
    if (w < 5 || h < 5) { rotSamBox = null; rotRender(); return; }
    rotSamPredict();
  }
});

document.addEventListener("mouseup", e => {
  if (rotPanning && (e.button === 2 || e.button === 1)) {
    rotPanning = false;
    rotCanvas.style.cursor = rotTool === "select" ? "default" : "crosshair";
  }
  if (rotVertexDragging) { rotVertexDragging = false; rotVertexIdx = -1; }
  if (rotDragging) { rotDragging = false; if (rotDragMoved) toast("已移动标注", "success"); }
});

document.addEventListener("mousemove", e => {
  if (!rotPanning) return;
  rotOffsetX = rotPanStart.ox + (e.clientX - rotPanStart.x);
  rotOffsetY = rotPanStart.oy + (e.clientY - rotPanStart.y);
  rotRender();
});

rotCanvas.addEventListener("click", e => {
  if (rotPanning || rotSamDrawing || !rotBaseImg || rotBusy) return;
  if (rotTool === "select" || rotTool === "box") return;
  const p = rotCanvasToImage(e);

  if (rotTool === "polygon") {
    if (rotCurrentPolygon.length >= 3) {
      const first = rotCurrentPolygon[0];
      const dx = p.x - first[0], dy = p.y - first[1];
      if (Math.sqrt(dx * dx + dy * dy) <= 8) { rotFinishCurrent(); return; }
    }
    rotCurrentPolygon.push([p.x, p.y]);
    rotRender();
  } else if (rotTool === "pos" || rotTool === "neg") {
    rotSamPoints.push({ x: p.x, y: p.y, label: rotTool === "pos" ? 1 : 0 });
    rotRender();
    rotSamPredict();
  }
});

rotCanvas.addEventListener("dblclick", () => {
  if (rotTool === "polygon" && rotCurrentPolygon.length >= 3) {
    rotFinishCurrent();
  } else if (rotSamOverlayImg) {
    rotSamFinishMask();
  }
});

rotCanvas.addEventListener("mouseleave", () => {
  rotMouseImgX = -1; rotMouseImgY = -1;
  if (rotTool === "polygon" && rotCurrentPolygon.length > 0) rotRender();
});

rotCanvas.addEventListener("wheel", e => {
  if (!rotBaseImg) return;
  e.preventDefault();
  const r = rotCanvas.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (rotCanvas.width / r.width);
  const my = (e.clientY - r.top) * (rotCanvas.height / r.height);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newScale = Math.max(0.05, Math.min(40, rotScale * factor));
  rotOffsetX = mx - (mx - rotOffsetX) * (newScale / rotScale);
  rotOffsetY = my - (my - rotOffsetY) * (newScale / rotScale);
  rotScale = newScale;
  rotRender();
}, { passive: false });

// ---- 键盘快捷键 ----
document.addEventListener("keydown", e => {
  if ($("module-rotated").classList.contains("hidden")) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    rotUndo();
    return;
  }
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "1") rotSetTool("polygon");
  else if (e.key === "2") rotSetTool("select");
  else if (e.key === "3") rotSetTool("pos");
  else if (e.key === "4") rotSetTool("neg");
  else if (e.key === "5" || e.key === "b" || e.key === "B") rotSetTool("box");
  else if (e.key === "Enter") {
    (async () => {
      let ok = false;
      if (rotCurrentPolygon.length >= 3) {
        ok = await rotFinishCurrent();
      } else if (rotSamOverlayImg) {
        ok = await rotSamFinishMask();
      } else if (rotSelectedIdx >= 0 && rotAnnotations[rotSelectedIdx]) {
        const sel = rotAnnotations[rotSelectedIdx];
        const hasPts = (sel.data.points && sel.data.points.length >= 3) || (sel.data.corners && sel.data.corners.length >= 3);
        if (hasPts) { ok = await rotRecalcSelected(); }
      }
      // 完成标注或重算后自动保存
      if (ok && rotAnnotations.length > 0) {
        await rotSave();
      }
    })();
  }
  else if (e.key === "Delete" || e.key === "Backspace") rotDeleteSelected();
  else if (e.key === "Escape") {
    rotCurrentPolygon = [];
    rotSamPoints = [];
    rotSamBox = null;
    rotSamOverlayImg = null;
    rotSelectedIdx = -1;
    rotRender();
    rotRenderTargets();
  }
  else if (e.key === "f" || e.key === "F") {
    if (rotSelectedIdx >= 0) rotFocusTarget(rotSelectedIdx);
    else rotFitCanvas();
  }
  else if (e.key === "ArrowLeft") rotPrev();
  else if (e.key === "ArrowRight") rotNext();
});

window.addEventListener("resize", () => {
  if (rotBaseImg && !$("module-rotated").classList.contains("hidden")) rotFitCanvas();
});
