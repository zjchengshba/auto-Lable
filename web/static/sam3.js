/* ===== 标注工具：SAM3 辅助 + 多边形/圆形/选择手动标注 ===== */

// ---- 状态 ----
let sam3Tool = "pos";
let sam3Points = [];
let sam3Box = null;
let sam3ImgW = 0, sam3ImgH = 0;
let sam3BaseImg = null;
let sam3OverlayImg = null;
let sam3GroundObjects = [];
let sam3GroundOverlays = [];
let sam3Drawing = false;
let sam3BoxStart = null;
let sam3Busy = false;

// 手动标注
let annotations = [];
let annNextId = 1;
let currentPolygon = [];
let currentCircle = null;     // {x1,y1,x2,y2} 左上→右下

// 选择/拖动
let selectedAnnIdx = -1;
let annDragging = false;       // 拖动整个标注
let annDragStart = null;
let annDragMoved = false;
let vertexDragging = false;    // 拖动多边形顶点
let vertexDragIdx = -1;

// 鼠标实时位置
let mouseImgX = -1, mouseImgY = -1;

// 缩放/平移
let annScale = 1, annOffsetX = 0, annOffsetY = 0;
let annPanning = false, annPanStart = null;

// 撤销栈
let undoStack = [];
const UNDO_MAX = 50;

// 文件列表
let annFiles = [];
let annFileIdx = -1;
let annOutputDir = "annotations_out";
let annAnnotatedFiles = new Set();

const canvas = document.getElementById("sam3-canvas");
const ctx = canvas.getContext("2d");
const ANN_COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"];

// ---- 撤销 ----
function pushUndo() {
  const snap = annotations.map(a => ({
    id: a.id, type: a.type, label: a.label,
    data: { ...a.data },
    _overlayImg: a.data.overlayImg,
    _hitCanvas: a._hitCanvas,
    _centroid: a._centroid,
  }));
  undoStack.push(snap);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

function undo() {
  if (!undoStack.length) { toast("无可撤销操作", "info"); return; }
  const prev = undoStack.pop();
  annotations = prev.map(a => {
    const ann = { id: a.id, type: a.type, label: a.label, data: { ...a.data } };
    if (a.type === "mask" && a._overlayImg) ann.data.overlayImg = a._overlayImg;
    ann._hitCanvas = a._hitCanvas;
    ann._centroid = a._centroid;
    return ann;
  });
  selectedAnnIdx = -1;
  annRenderTargets();
  sam3Render();
  toast("已撤销", "info");
}

// ---- 坐标转换 ----
function sam3CanvasToImage(e) {
  const r = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) * (canvas.width / r.width);
  const cy = (e.clientY - r.top) * (canvas.height / r.height);
  return {
    x: Math.round((cx - annOffsetX) / annScale),
    y: Math.round((cy - annOffsetY) / annScale),
  };
}

// ---- 计算标注中心点 ----
function annCenter(ann) {
  if (ann.type === "polygon" && ann.data.points && ann.data.points.length) {
    let sx = 0, sy = 0;
    ann.data.points.forEach(p => { sx += p[0]; sy += p[1]; });
    return [sx / ann.data.points.length, sy / ann.data.points.length];
  }
  if (ann.type === "circle") return [ann.data.center[0], ann.data.center[1]];
  if (ann.type === "mask") return maskCentroid(ann);
  return [sam3ImgW / 2, sam3ImgH / 2];
}

// ---- mask 质心计算（用于定位） ----
function maskCentroid(ann) {
  if (ann._centroid) return ann._centroid;
  if (!ann.data.overlayImg) return [sam3ImgW / 2, sam3ImgH / 2];
  ensureHitCanvas(ann);
  if (!ann._hitCanvas) return [sam3ImgW / 2, sam3ImgH / 2];
  try {
    const hctx = ann._hitCanvas.getContext("2d");
    const imgData = hctx.getImageData(0, 0, sam3ImgW, sam3ImgH);
    let sx = 0, sy = 0, count = 0;
    const step = Math.max(1, Math.floor(Math.min(sam3ImgW, sam3ImgH) / 150));
    for (let y = 0; y < sam3ImgH; y += step) {
      for (let x = 0; x < sam3ImgW; x += step) {
        const idx = (y * sam3ImgW + x) * 4;
        if (imgData.data[idx + 3] > 30) { sx += x; sy += y; count++; }
      }
    }
    if (count === 0) return [sam3ImgW / 2, sam3ImgH / 2];
    ann._centroid = [sx / count, sy / count];
    return ann._centroid;
  } catch { return [sam3ImgW / 2, sam3ImgH / 2]; }
}

// ---- 命中检测 ----
function ensureHitCanvas(ann) {
  if (ann._hitCanvas || !ann.data.overlayImg) return;
  ann._hitCanvas = document.createElement("canvas");
  ann._hitCanvas.width = sam3ImgW;
  ann._hitCanvas.height = sam3ImgH;
  ann._hitCanvas.getContext("2d").drawImage(ann.data.overlayImg, 0, 0, sam3ImgW, sam3ImgH);
}

function annHitTest(ann, x, y) {
  if (ann.type === "polygon") {
    return pointInPolygon([x, y], ann.data.points);
  } else if (ann.type === "circle") {
    const dx = x - ann.data.center[0], dy = y - ann.data.center[1];
    return Math.sqrt(dx * dx + dy * dy) <= ann.data.radius + 4;
  } else if (ann.type === "mask") {
    const ox = ann.data.offsetX || 0, oy = ann.data.offsetY || 0;
    ensureHitCanvas(ann);
    if (!ann._hitCanvas) return false;
    try {
      const px = Math.round(x - ox), py = Math.round(y - oy);
      if (px < 0 || px >= sam3ImgW || py < 0 || py >= sam3ImgH) return false;
      const d = ann._hitCanvas.getContext("2d").getImageData(px, py, 1, 1).data;
      return d[3] > 30;
    } catch { return false; }
  }
  return false;
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// ---- 渲染 ----
function sam3Render() {
  if (!sam3BaseImg) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(annOffsetX, annOffsetY);
  ctx.scale(annScale, annScale);
  ctx.drawImage(sam3BaseImg, 0, 0);

  // 已保存标注
  annotations.forEach((ann, i) => {
    const color = ANN_COLORS[i % ANN_COLORS.length];
    const isSel = i === selectedAnnIdx;
    const alpha = isSel ? "60" : "30";
    const lw = isSel ? 3 : 2;

    if (ann.type === "mask" && ann.data.overlayImg) {
      ctx.save();
      const ox = ann.data.offsetX || 0, oy = ann.data.offsetY || 0;
      if (ox || oy) ctx.translate(ox, oy);
      ctx.drawImage(ann.data.overlayImg, 0, 0, sam3ImgW, sam3ImgH);
      ctx.restore();
      if (isSel) {
        // 选中时画质心标记
        const [cx, cy] = maskCentroid(ann);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.arc(cx + ox, cy + oy, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#fff";
        ctx.fillRect(cx + ox - 3, cy + oy - 3, 6, 6);
      }
    } else if (ann.type === "polygon") {
      const pts = ann.data.points;
      if (pts && pts.length > 0) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
        ctx.closePath();
        ctx.fillStyle = color + alpha;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.stroke();
        if (isSel) {
          // 顶点小方块（可拖动）
          for (const pt of pts) {
            ctx.fillStyle = "#fff";
            ctx.fillRect(pt[0] - 4, pt[1] - 4, 8, 8);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(pt[0] - 4, pt[1] - 4, 8, 8);
          }
        }
      }
    } else if (ann.type === "circle") {
      ctx.beginPath();
      ctx.arc(ann.data.center[0], ann.data.center[1], ann.data.radius, 0, Math.PI * 2);
      ctx.fillStyle = color + alpha;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.stroke();
      if (isSel) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const cx = ann.data.center[0], cy = ann.data.center[1];
        ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
        ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
        ctx.stroke();
      }
    }
  });

  if (sam3OverlayImg) ctx.drawImage(sam3OverlayImg, 0, 0, sam3ImgW, sam3ImgH);
  for (const oi of sam3GroundOverlays) { if (oi) ctx.drawImage(oi, 0, 0, sam3ImgW, sam3ImgH); }

  // SAM3 点
  for (const p of sam3Points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = p.label === 1 ? "rgba(34,197,94,0.95)" : "rgba(239,68,68,0.95)";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    if (p.label === 0) {
      ctx.beginPath();
      ctx.moveTo(p.x - 2.5, p.y - 2.5); ctx.lineTo(p.x + 2.5, p.y + 2.5);
      ctx.moveTo(p.x + 2.5, p.y - 2.5); ctx.lineTo(p.x - 2.5, p.y + 2.5);
      ctx.stroke();
    }
  }

  if (sam3Box) {
    const [x1, y1, x2, y2] = sam3Box;
    ctx.strokeStyle = "#d946ef";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.setLineDash([]);
  }

  // 多边形预览：已点顶点连线 + 鼠标位置预览线
  if (currentPolygon.length > 0) {
    ctx.beginPath();
    ctx.moveTo(currentPolygon[0][0], currentPolygon[0][1]);
    for (let j = 1; j < currentPolygon.length; j++) ctx.lineTo(currentPolygon[j][0], currentPolygon[j][1]);
    if (mouseImgX >= 0 && mouseImgY >= 0) ctx.lineTo(mouseImgX, mouseImgY);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2;
    ctx.setLineDash(currentPolygon.length > 1 ? [] : [6, 4]);
    ctx.stroke();
    if (currentPolygon.length >= 2 && mouseImgX >= 0) {
      ctx.beginPath();
      ctx.moveTo(mouseImgX, mouseImgY);
      ctx.lineTo(currentPolygon[0][0], currentPolygon[0][1]);
      ctx.strokeStyle = "rgba(245,158,11,0.35)";
      ctx.setLineDash([4, 3]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (let j = 0; j < currentPolygon.length; j++) {
      const pt = currentPolygon[j];
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], 2.5, 0, Math.PI * 2);
      ctx.fillStyle = j === 0 ? "#fff" : "#f59e0b";
      ctx.fill();
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (mouseImgX >= 0) {
      ctx.strokeStyle = "rgba(245,158,11,0.6)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(mouseImgX - 8, mouseImgY); ctx.lineTo(mouseImgX + 8, mouseImgY);
      ctx.moveTo(mouseImgX, mouseImgY - 8); ctx.lineTo(mouseImgX, mouseImgY + 8);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 当前圆形预览（仅圆，无方框）
  if (currentCircle) {
    const x = Math.min(currentCircle.x1, currentCircle.x2);
    const y = Math.min(currentCircle.y1, currentCircle.y2);
    const w = Math.abs(currentCircle.x2 - currentCircle.x1);
    const h = Math.abs(currentCircle.y2 - currentCircle.y1);
    const r = Math.max(2, Math.min(w, h) / 2);
    const cx = x + w / 2, cy = y + h / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(6,182,212,0.2)";
    ctx.fill();
    ctx.strokeStyle = "#06b6d4";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    // 起点标记（左上角）
    ctx.fillStyle = "#06b6d4";
    ctx.fillRect(x - 3, y - 3, 6, 6);
  }

  ctx.restore();
}

// ---- 工具切换 ----
function sam3SetTool(tool) {
  sam3Tool = tool;
  if (tool !== "select") selectedAnnIdx = -1;
  if (currentPolygon.length > 0 && tool !== "polygon") currentPolygon = [];
  currentCircle = null;
  document.querySelectorAll(".tool-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
  const cursors = { pos: "crosshair", neg: "crosshair", box: "crosshair", polygon: "crosshair", circle: "crosshair", select: "default" };
  canvas.style.cursor = cursors[tool] || "default";
  sam3Render();
  annRenderTargets();
}

// ---- 画布自适应（填满容器，居中） ----
function sam3FitCanvas() {
  if (!sam3ImgW || !sam3BaseImg) return;
  const container = $("canvas-wrap");
  if (!container) return;
  const cw = container.clientWidth - 8;
  const ch = container.clientHeight - 30;
  if (cw <= 0 || ch <= 0) return;
  // canvas 内部分辨率 = 容器大小
  canvas.width = cw;
  canvas.height = ch;
  canvas.style.width = cw + "px";
  canvas.style.height = ch + "px";
  // 计算适配缩放
  const s = Math.min(cw / sam3ImgW, ch / sam3ImgH);
  annScale = s;
  annOffsetX = (cw - sam3ImgW * s) / 2;
  annOffsetY = (ch - sam3ImgH * s) / 2;
  sam3Render();
}

// ---- 载入图片 ----
async function sam3LoadImage(path) {
  if (!path) { toast("请输入图片路径", "error"); return; }
  if (sam3Busy) return;
  sam3Busy = true;
  $("ann-current-name") && ($("ann-current-name").textContent = path.split("\\").pop().split("/").pop());
  try {
    const d = await fetchJSON("/api/sam3/set_image", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_path: path }),
    });
    if (!d.ok) { toast(d.error || "载入失败", "error"); return; }
    sam3ImgW = d.width;
    sam3ImgH = d.height;
    selectedAnnIdx = -1;
    undoStack = [];
    sam3BaseImg = new Image();
    sam3BaseImg.onload = () => {
      sam3ClearPrompts();
      annotations = [];
      annLoadAnnotations(path);
      $("sam3-empty").style.display = "none";
      requestAnimationFrame(() => requestAnimationFrame(sam3FitCanvas));
    };
    sam3BaseImg.src = `/api/image?path=${encodeURIComponent(path)}`;
  } catch (e) {
    toast("载入异常: " + e.message, "error");
  } finally {
    sam3Busy = false;
  }
}

// ---- 文件面板收缩 ----
function toggleFilePanel() {
  const panel = $("ann-files-panel");
  const expandBtn = $("ann-expand-btn");
  const collapsed = panel.classList.toggle("collapsed");
  expandBtn.classList.toggle("hidden", !collapsed);
  setTimeout(sam3FitCanvas, 250);
}

// ---- 导出掩码 ----
function annExportAll() {
  if (!annotations.length) { toast("无标注可导出", "error"); return; }
  if (!sam3BaseImg) { toast("请先载入图片", "error"); return; }
  const tmp = document.createElement("canvas");
  tmp.width = sam3ImgW; tmp.height = sam3ImgH;
  const tctx = tmp.getContext("2d");
  tctx.fillStyle = "#000000";
  tctx.fillRect(0, 0, sam3ImgW, sam3ImgH);
  annotations.forEach((ann, i) => {
    const color = ANN_COLORS[i % ANN_COLORS.length];
    tctx.fillStyle = color + "70";
    tctx.strokeStyle = color;
    tctx.lineWidth = 2;
    if (ann.type === "mask" && ann.data.overlayImg) {
      const ox = ann.data.offsetX || 0, oy = ann.data.offsetY || 0;
      tctx.save(); tctx.translate(ox, oy);
      tctx.drawImage(ann.data.overlayImg, 0, 0, sam3ImgW, sam3ImgH);
      tctx.restore();
    } else if (ann.type === "polygon") {
      const pts = ann.data.points;
      if (pts && pts.length > 0) {
        tctx.beginPath();
        tctx.moveTo(pts[0][0], pts[0][1]);
        for (let j = 1; j < pts.length; j++) tctx.lineTo(pts[j][0], pts[j][1]);
        tctx.closePath(); tctx.fill(); tctx.stroke();
      }
    } else if (ann.type === "circle") {
      tctx.beginPath();
      tctx.arc(ann.data.center[0], ann.data.center[1], ann.data.radius, 0, Math.PI * 2);
      tctx.fill(); tctx.stroke();
    }
  });
  const a = document.createElement("a");
  const name = annFiles.length > 0 && annFileIdx >= 0
    ? annFiles[annFileIdx].name.replace(/\.[^.]+$/, "") + "_mask.png"
    : "mask_export.png";
  a.download = name;
  a.href = tmp.toDataURL("image/png");
  a.click();
  toast(`已导出 ${annotations.length} 个标注的掩码`, "success");
}

// ---- 文件列表 ----
async function annLoadFileList() {
  const folder = $("ann-folder").value.trim();
  if (!folder) { toast("请输入文件夹路径", "error"); return; }
  try {
    const d = await fetchJSON(`/api/files/list?path=${encodeURIComponent(folder)}`);
    if (d.error) { toast(d.error, "error"); return; }
    annFiles = d.files || [];
    annFileIdx = -1;
    annAnnotatedFiles = new Set();
    annRenderFileList();
    toast(`找到 ${annFiles.length} 张图片`, "success");
  } catch (e) { toast("加载失败: " + e.message, "error"); }
}

function annRenderFileList() {
  const box = $("ann-file-list");
  if (!annFiles.length) { box.innerHTML = `<div class="empty-state">无图片</div>`; return; }
  box.innerHTML = annFiles.map((f, i) => {
    const flagged = annAnnotatedFiles.has(f.name);
    return `<div class="ann-file-item ${i === annFileIdx ? "active" : ""} ${flagged ? "flagged" : ""}" onclick="annOpenFile(${i})" title="${esc(f.name)}">
      ${flagged ? '<i class="fa fa-flag ann-flag"></i>' : ''}
      <span class="ann-file-name">${esc(f.name)}</span>
    </div>`;
  }).join("");
}

async function annOpenFile(idx) {
  if (idx < 0 || idx >= annFiles.length) return;
  annFileIdx = idx;
  annRenderFileList();
  $("sam3-img-path") && ($("sam3-img-path").value = annFiles[idx].path);
  await sam3LoadImage(annFiles[idx].path);
}

function annNext() { if (annFileIdx < annFiles.length - 1) annOpenFile(annFileIdx + 1); else toast("已是最后一张", "info"); }
function annPrev() { if (annFileIdx > 0) annOpenFile(annFileIdx - 1); else toast("已是第一张", "info"); }

// ---- 保存/读取 ----
async function annSave() {
  if (!annFiles.length || annFileIdx < 0) { toast("请先选择图片", "error"); return; }
  const imageName = annFiles[annFileIdx].name;
  const annsData = annotations.map(a => {
    const d = { id: a.id, type: a.type, label: a.label };
    if (a.type === "mask") d.data = { overlay: a.data.overlayB64, offsetX: a.data.offsetX || 0, offsetY: a.data.offsetY || 0 };
    else if (a.type === "polygon") d.data = { points: a.data.points };
    else if (a.type === "circle") d.data = { center: a.data.center, radius: a.data.radius };
    return d;
  });
  try {
    const d = await fetchJSON("/api/annotations/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output_dir: annOutputDir, image_name: imageName, annotations: annsData }),
    });
    if (d.ok) {
      toast(`已保存 ${annsData.length} 个标注`, "success");
      annAnnotatedFiles.add(imageName);
      annRenderFileList();
    } else toast(d.error || "保存失败", "error");
  } catch (e) { toast("保存异常: " + e.message, "error"); }
}

async function annLoadAnnotations(path) {
  const imageName = path.split("\\").pop().split("/").pop();
  try {
    const d = await fetchJSON(`/api/annotations/load?output_dir=${encodeURIComponent(annOutputDir)}&image_name=${encodeURIComponent(imageName)}`);
    if (d.ok && d.annotations && d.annotations.length) {
      annotations = d.annotations.map(a => {
        const ann = { id: a.id || annNextId++, type: a.type, label: a.label || "object", data: {} };
        if (a.type === "mask") {
          ann.data.overlayB64 = a.data.overlay;
          ann.data.offsetX = a.data.offsetX || 0;
          ann.data.offsetY = a.data.offsetY || 0;
          ann.data.overlayImg = new Image();
          ann.data.overlayImg.onload = () => sam3Render();
          ann.data.overlayImg.src = "data:image/png;base64," + a.data.overlay;
        } else if (a.type === "polygon") {
          ann.data.points = a.data.points;
        } else if (a.type === "circle") {
          ann.data.center = a.data.center;
          ann.data.radius = a.data.radius;
        }
        return ann;
      });
      annNextId = Math.max(annNextId, ...annotations.map(a => a.id), 0) + 1;
      annAnnotatedFiles.add(imageName);
      annRenderTargets();
      annRenderFileList();
      sam3Render();
    }
  } catch (e) { /* 首次无文件 */ }
}

// ---- 目标列表 ----
function annRenderTargets() {
  $("ann-count").textContent = annotations.length;
  const box = $("ann-targets");
  if (!annotations.length) { box.innerHTML = `<div class="empty-state">无目标</div>`; return; }
  box.innerHTML = annotations.map((a, i) => {
    const color = ANN_COLORS[i % ANN_COLORS.length];
    const isSel = i === selectedAnnIdx;
    return `<div class="ann-target-item ${isSel ? "selected" : ""}" data-idx="${i}" onclick="annSelectTarget(${i})" ondblclick="annFocusTarget(${i})">
      <span class="ann-color-dot" style="background:${color}"></span>
      <span class="type-tag">${a.type}</span>
      <input class="ann-label-input" value="${esc(a.label || "object")}" data-idx="${i}" onclick="event.stopPropagation()" ondblclick="event.stopPropagation()" onchange="annRenameTarget(${i}, this.value)" onfocus="this.select()">
      <button class="locate-btn" onclick="event.stopPropagation(); annFocusTarget(${i})" title="定位"><i class="fa fa-crosshairs"></i></button>
      <button class="del-btn" onclick="event.stopPropagation(); annDeleteTarget(${i})" title="删除"><i class="fa fa-times"></i></button>
    </div>`;
  }).join("");
}

function annSelectTarget(idx) {
  if (sam3Tool !== "select") sam3SetTool("select");
  selectedAnnIdx = idx;
  sam3Render();
  annRenderTargets();
}

function annFocusTarget(idx) {
  if (idx < 0 || idx >= annotations.length) return;
  annSelectTarget(idx);
  const ann = annotations[idx];
  const [cx, cy] = annCenter(ann);
  const container = $("canvas-wrap");
  if (container) {
    const cw = container.clientWidth - 8;
    const ch = container.clientHeight - 30;
    const targetScale = Math.max(annScale, Math.min(cw / 200, ch / 200, 8));
    annScale = targetScale;
    annOffsetX = cw / 2 - cx * annScale;
    annOffsetY = ch / 2 - cy * annScale;
    sam3Render();
  }
  toast(`已定位到 #${idx + 1}: ${ann.label}`, "info");
}

function annRenameTarget(idx, name) {
  if (idx < 0 || idx >= annotations.length) return;
  const v = (name || "").trim() || "object";
  pushUndo();
  annotations[idx].label = v;
  toast(`已重命名为 ${v}`, "success");
}

function annDeleteTarget(idx) {
  if (idx < 0 || idx >= annotations.length) return;
  pushUndo();
  if (idx === selectedAnnIdx) selectedAnnIdx = -1;
  else if (idx < selectedAnnIdx) selectedAnnIdx--;
  annotations.splice(idx, 1);
  annRenderTargets();
  sam3Render();
  toast("已删除", "info");
}

// ---- 完成当前标注 ----
function annFinishCurrent() {
  if (sam3Tool === "polygon" && currentPolygon.length >= 3) {
    pushUndo();
    annotations.push({ id: annNextId++, type: "polygon", data: { points: currentPolygon.slice() }, label: ($("ann-label").value || "object").trim() });
    currentPolygon = [];
    annRenderTargets(); sam3Render();
    toast("多边形标注已添加", "success");
  } else if (sam3Tool === "circle" && currentCircle) {
    const x = Math.min(currentCircle.x1, currentCircle.x2);
    const y = Math.min(currentCircle.y1, currentCircle.y2);
    const w = Math.abs(currentCircle.x2 - currentCircle.x1);
    const h = Math.abs(currentCircle.y2 - currentCircle.y1);
    const r = Math.min(w, h) / 2;
    if (r < 3) { currentCircle = null; sam3Render(); return; }
    pushUndo();
    annotations.push({ id: annNextId++, type: "circle", data: { center: [x + w / 2, y + h / 2], radius: r }, label: ($("ann-label").value || "object").trim() });
    currentCircle = null;
    annRenderTargets(); sam3Render();
    toast("圆形标注已添加", "success");
  } else if (sam3OverlayImg) {
    pushUndo();
    annotations.push({ id: annNextId++, type: "mask", data: { overlayImg: sam3OverlayImg, overlayB64: sam3OverlayImg.src.split(",")[1], offsetX: 0, offsetY: 0 }, label: ($("ann-label").value || "object").trim() });
    sam3OverlayImg = null;
    sam3ClearPrompts();
    annRenderTargets(); sam3Render();
    toast("SAM3 mask 已保存为标注", "success");
  } else if (sam3GroundOverlays.length > 0) {
    pushUndo();
    let saved = 0;
    sam3GroundOverlays.forEach((oi) => {
      if (!oi) return;
      const tmp = document.createElement("canvas");
      tmp.width = sam3ImgW; tmp.height = sam3ImgH;
      tmp.getContext("2d").drawImage(oi, 0, 0);
      annotations.push({ id: annNextId++, type: "mask", data: { overlayImg: oi, overlayB64: tmp.toDataURL("image/png").split(",")[1], offsetX: 0, offsetY: 0 }, label: ($("ann-label").value || "object").trim() });
      saved++;
    });
    sam3GroundObjects = []; sam3GroundOverlays = [];
    annRenderTargets(); sam3Render();
    toast(`已保存 ${saved} 个 grounding mask`, "success");
  } else { toast("没有可完成的标注", "error"); }
}

// ---- SAM3 预测 ----
async function sam3Predict() {
  if (sam3Busy) return;
  sam3Busy = true;
  const body = { points: sam3Points.map(p => [p.x, p.y]), labels: sam3Points.map(p => p.label), box: sam3Box, multimask: sam3Points.length + (sam3Box ? 1 : 0) <= 1 };
  try {
    const d = await fetchJSON("/api/sam3/predict", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!d.ok) { toast(d.error || "预测失败", "error"); return; }
    if (d.masks && d.masks.length > 0) {
      const best = d.masks[d.best_index];
      sam3OverlayImg = new Image();
      sam3OverlayImg.onload = () => sam3Render();
      sam3OverlayImg.src = "data:image/png;base64," + best.overlay;
      toast(`分割完成 (score: ${best.score.toFixed(3)})`, "success");
    }
  } catch (e) { toast("预测异常: " + e.message, "error"); }
  finally { sam3Busy = false; }
}

// ---- Grounding ----
async function sam3Ground() {
  if (sam3Busy) return;
  const text = $("sam3-text").value.trim();
  if (!text && !sam3Box) { toast("请输入文字或画框", "error"); return; }
  sam3Busy = true;
  const boxes = [];
  if (sam3Box) {
    const [x1, y1, x2, y2] = sam3Box;
    boxes.push({ cx: ((x1 + x2) / 2) / sam3ImgW, cy: ((y1 + y2) / 2) / sam3ImgH, w: Math.abs(x2 - x1) / sam3ImgW, h: Math.abs(y2 - y1) / sam3ImgH, label: true });
  }
  try {
    const d = await fetchJSON("/api/sam3/ground", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, boxes }) });
    if (!d.ok) { toast(d.error || "检索失败", "error"); return; }
    const objs = d.objects || [];
    if (!objs.length) { toast("未找到匹配物体", "info"); return; }
    const label = text || ($("ann-label").value || "object").trim();
    const overlays = new Array(objs.length).fill(null);
    let loaded = 0, saved = 0;
    objs.forEach((obj, idx) => {
      const img = new Image();
      img.onload = () => {
        overlays[idx] = img; loaded++; sam3Render();
        if (loaded === objs.length) {
          pushUndo();
          overlays.forEach((oi) => {
            if (!oi) return;
            const tmp = document.createElement("canvas");
            tmp.width = sam3ImgW; tmp.height = sam3ImgH;
            tmp.getContext("2d").drawImage(oi, 0, 0);
            annotations.push({ id: annNextId++, type: "mask", data: { overlayImg: oi, overlayB64: tmp.toDataURL("image/png").split(",")[1], offsetX: 0, offsetY: 0 }, label });
            saved++;
          });
          sam3GroundObjects = []; sam3GroundOverlays = [];
          annRenderTargets(); sam3Render();
          toast(`找到 ${saved} 个物体，已保存`, "success");
        }
      };
      img.onerror = () => { loaded++; if (loaded === objs.length && saved === 0) { sam3Render(); toast(`找到 ${objs.length} 个物体但 mask 加载失败`, "error"); } };
      img.src = "data:image/png;base64," + obj.overlay;
    });
    sam3Render();
  } catch (e) { toast("检索异常: " + e.message, "error"); }
  finally { sam3Busy = false; }
}

// ---- 清除 ----
function sam3ClearPrompts() { sam3Points = []; sam3Box = null; sam3OverlayImg = null; sam3GroundObjects = []; sam3GroundOverlays = []; currentPolygon = []; currentCircle = null; }
function sam3Clear() { sam3ClearPrompts(); sam3Render(); fetchJSON("/api/sam3/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); toast("已清除当前提示", "info"); }
function annDeleteSelected() { if (selectedAnnIdx >= 0 && selectedAnnIdx < annotations.length) annDeleteTarget(selectedAnnIdx); }

// ---- Canvas 事件 ----
canvas.addEventListener("contextmenu", e => e.preventDefault());

canvas.addEventListener("mousedown", e => {
  if (!sam3BaseImg) return;
  // 右键长按 → 平移
  if (e.button === 2) {
    annPanning = true;
    annPanStart = { x: e.clientX, y: e.clientY, ox: annOffsetX, oy: annOffsetY };
    canvas.style.cursor = "grabbing";
    return;
  }
  // 中键 → 平移
  if (e.button === 1) {
    e.preventDefault();
    annPanning = true;
    annPanStart = { x: e.clientX, y: e.clientY, ox: annOffsetX, oy: annOffsetY };
    canvas.style.cursor = "grabbing";
    return;
  }
  if (e.button !== 0 || sam3Busy) return;
  const p = sam3CanvasToImage(e);

  // 选择工具
  if (sam3Tool === "select") {
    // 1) 先检查是否点中选中多边形的顶点
    if (selectedAnnIdx >= 0 && annotations[selectedAnnIdx].type === "polygon") {
      const pts = annotations[selectedAnnIdx].data.points;
      const hitR = 10 / annScale;
      for (let v = 0; v < pts.length; v++) {
        const dx = p.x - pts[v][0], dy = p.y - pts[v][1];
        if (Math.sqrt(dx * dx + dy * dy) <= hitR) {
          vertexDragging = true;
          vertexDragIdx = v;
          pushUndo();
          return;
        }
      }
    }
    // 2) 检查是否点中某个标注（从后往前）
    let hit = -1;
    for (let i = annotations.length - 1; i >= 0; i--) {
      if (annHitTest(annotations[i], p.x, p.y)) { hit = i; break; }
    }
    if (hit >= 0) {
      selectedAnnIdx = hit;
      annDragging = true;
      annDragStart = { x: p.x, y: p.y };
      annDragMoved = false;
      pushUndo();
      annRenderTargets();
      sam3Render();
    } else {
      selectedAnnIdx = -1;
      annRenderTargets();
      sam3Render();
    }
    return;
  }

  if (sam3Tool === "box") {
    sam3Drawing = true;
    sam3BoxStart = p;
    sam3Box = [p.x, p.y, p.x, p.y];
  } else if (sam3Tool === "circle") {
    sam3Drawing = true;
    currentCircle = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  }
});

canvas.addEventListener("mousemove", e => {
  const p = sam3CanvasToImage(e);
  mouseImgX = p.x; mouseImgY = p.y;

  if (annPanning) return;

  // 顶点拖动
  if (vertexDragging && selectedAnnIdx >= 0) {
    annotations[selectedAnnIdx].data.points[vertexDragIdx] = [p.x, p.y];
    sam3Render();
    return;
  }

  // 整体拖动
  if (annDragging && selectedAnnIdx >= 0) {
    const dx = p.x - annDragStart.x, dy = p.y - annDragStart.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) annDragMoved = true;
    const ann = annotations[selectedAnnIdx];
    if (ann.type === "polygon") {
      ann.data.points = ann.data.points.map(pt => [pt[0] + dx, pt[1] + dy]);
    } else if (ann.type === "circle") {
      ann.data.center = [ann.data.center[0] + dx, ann.data.center[1] + dy];
    } else if (ann.type === "mask") {
      ann.data.offsetX = (ann.data.offsetX || 0) + dx;
      ann.data.offsetY = (ann.data.offsetY || 0) + dy;
      ann._centroid = null; // 重置质心缓存
    }
    annDragStart = { x: p.x, y: p.y };
    sam3Render();
    return;
  }

  if (!sam3Drawing) {
    if (sam3Tool === "polygon" && currentPolygon.length > 0) sam3Render();
    return;
  }

  if (sam3Tool === "box") {
    sam3Box = [sam3BoxStart.x, sam3BoxStart.y, p.x, p.y];
    sam3Render();
  } else if (sam3Tool === "circle" && currentCircle) {
    currentCircle.x2 = p.x;
    currentCircle.y2 = p.y;
    sam3Render();
  }
});

canvas.addEventListener("mouseup", e => {
  if (annPanning && (e.button === 2 || e.button === 1)) {
    annPanning = false;
    canvas.style.cursor = sam3Tool === "select" ? "default" : "crosshair";
    return;
  }
  if (vertexDragging) {
    vertexDragging = false;
    vertexDragIdx = -1;
    toast("顶点已移动", "success");
    return;
  }
  if (annDragging) {
    annDragging = false;
    if (annDragMoved) toast("已移动标注", "success");
    return;
  }
  if (!sam3Drawing) return;
  sam3Drawing = false;
  const p = sam3CanvasToImage(e);
  if (sam3Tool === "box") {
    sam3Box = [sam3BoxStart.x, sam3BoxStart.y, p.x, p.y];
    const w = Math.abs(sam3Box[2] - sam3Box[0]), h = Math.abs(sam3Box[3] - sam3Box[1]);
    if (w < 5 || h < 5) { sam3Box = null; sam3Render(); return; }
    sam3Predict();
  } else if (sam3Tool === "circle" && currentCircle) {
    const w = Math.abs(currentCircle.x2 - currentCircle.x1);
    const h = Math.abs(currentCircle.y2 - currentCircle.y1);
    if (Math.min(w, h) < 6) { currentCircle = null; sam3Render(); return; }
    sam3Render();
    toast("圆形已绘制，点「完成」保存", "info");
  }
});

// 全局事件：确保移出 canvas 也能正确结束
document.addEventListener("mouseup", e => {
  if (annPanning && (e.button === 2 || e.button === 1)) {
    annPanning = false;
    canvas.style.cursor = sam3Tool === "select" ? "default" : "crosshair";
  }
  if (vertexDragging) { vertexDragging = false; vertexDragIdx = -1; }
  if (annDragging) { annDragging = false; if (annDragMoved) toast("已移动标注", "success"); }
});

document.addEventListener("mousemove", e => {
  if (!annPanning) return;
  annOffsetX = annPanStart.ox + (e.clientX - annPanStart.x);
  annOffsetY = annPanStart.oy + (e.clientY - annPanStart.y);
  sam3Render();
});

canvas.addEventListener("mouseleave", () => {
  mouseImgX = -1; mouseImgY = -1;
  if (sam3Tool === "polygon" && currentPolygon.length > 0) sam3Render();
});

canvas.addEventListener("click", e => {
  if (annPanning || sam3Drawing || !sam3BaseImg) return;
  if (sam3Tool === "box" || sam3Tool === "circle" || sam3Tool === "select") return;
  const p = sam3CanvasToImage(e);
  if (sam3Tool === "polygon") {
    if (currentPolygon.length >= 3) {
      const first = currentPolygon[0];
      const dx = p.x - first[0], dy = p.y - first[1];
      if (Math.sqrt(dx * dx + dy * dy) <= 8) { annFinishCurrent(); return; }
    }
    currentPolygon.push([p.x, p.y]);
    sam3Render();
  } else if (sam3Tool === "pos" || sam3Tool === "neg") {
    sam3Points.push({ x: p.x, y: p.y, label: sam3Tool === "pos" ? 1 : 0 });
    sam3Render();
    sam3Predict();
  }
});

canvas.addEventListener("dblclick", () => {
  if (sam3Tool === "polygon" && currentPolygon.length >= 3) annFinishCurrent();
});

canvas.addEventListener("wheel", e => {
  if (!sam3BaseImg) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (canvas.width / r.width);
  const my = (e.clientY - r.top) * (canvas.height / r.height);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newScale = Math.max(0.05, Math.min(40, annScale * factor));
  annOffsetX = mx - (mx - annOffsetX) * (newScale / annScale);
  annOffsetY = my - (my - annOffsetY) * (newScale / annScale);
  annScale = newScale;
  sam3Render();
}, { passive: false });

// ---- 键盘快捷键 ----
document.addEventListener("keydown", e => {
  if ($("module-sam").classList.contains("hidden")) return;
  // Ctrl+Z 撤销
  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    undo();
    return;
  }
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "1") sam3SetTool("pos");
  else if (e.key === "2") sam3SetTool("neg");
  else if (e.key === "3" || e.key === "b" || e.key === "B") sam3SetTool("box");
  else if (e.key === "4" || e.key === "p" || e.key === "P") sam3SetTool("polygon");
  else if (e.key === "5" || e.key === "c" || e.key === "C") sam3SetTool("circle");
  else if (e.key === "6" || e.key === "v" || e.key === "V" || e.key === "s" || e.key === "S") sam3SetTool("select");
  else if (e.key === "Enter") annFinishCurrent();
  else if (e.key === "Delete" || e.key === "Backspace") annDeleteSelected();
  else if (e.key === "Escape") { currentPolygon = []; currentCircle = null; selectedAnnIdx = -1; sam3Render(); annRenderTargets(); }
  else if (e.key === "r" || e.key === "R") sam3Clear();
  else if (e.key === "f" || e.key === "F") { if (selectedAnnIdx >= 0) annFocusTarget(selectedAnnIdx); else sam3FitCanvas(); }
  else if (e.key === "ArrowLeft") annPrev();
  else if (e.key === "ArrowRight") annNext();
});

// ---- 状态轮询 ----
async function sam3PollStatus() {
  try {
    const d = await fetchJSON("/api/sam3/status");
    if (d.online) $("sam3-status").innerHTML = `<span style="color:#4ade80">● SAM3 在线</span> ${d.gpu ? "(" + esc(d.gpu) + ")" : ""}`;
    else $("sam3-status").innerHTML = `<span style="color:#f87171">● SAM3 离线</span>`;
  } catch { $("sam3-status").innerHTML = `<span style="color:#f87171">● SAM3 离线</span>`; }
}

window.addEventListener("resize", () => {
  if (sam3BaseImg && !$("module-sam").classList.contains("hidden")) sam3FitCanvas();
});

sam3PollStatus();
setInterval(sam3PollStatus, 5000);

// ---- LocateAnything 辅助检测（在标注工具中直接调用） ----
async function laAnnDetect() {
  if (!sam3BaseImg || !sam3ImgW) { toast("请先载入图片", "error"); return; }
  if (sam3Busy) return;
  const query = ($("la-ann-query").value || "").trim();
  if (!query) { toast("请输入检测类别或短语", "error"); return; }
  if (!annFiles.length || annFileIdx < 0) { toast("无图片路径", "error"); return; }
  const imagePath = annFiles[annFileIdx].path;
  sam3Busy = true;
  toast("LocateAnything 检测中...", "info");
  try {
    const cats = query.split(",").map(s => s.trim()).filter(Boolean);
    let endpoint, body;
    if (cats.length === 1 && cats[0].length > 15) {
      // 长短语 → ground
      endpoint = "/api/la/ground";
      body = { image_path: imagePath, phrase: cats[0], mode: "multi" };
    } else {
      endpoint = "/api/la/detect";
      body = { image_path: imagePath, categories: cats };
    }
    const d = await fetchJSON(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!d.ok) { toast(d.error || "检测失败", "error"); return; }
    const boxes = d.boxes || [];
    if (!boxes.length) { toast("未检测到物体", "info"); return; }
    pushUndo();
    let added = 0;
    boxes.forEach(b => {
      // 将检测框转为多边形标注
      annotations.push({
        id: annNextId++,
        type: "polygon",
        data: { points: [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]] },
        label: b.label || query,
      });
      added++;
    });
    annRenderTargets();
    sam3Render();
    toast(`LocateAnything 检测到 ${added} 个物体，已添加为标注`, "success");
  } catch (e) {
    toast("检测异常: " + e.message, "error");
  } finally {
    sam3Busy = false;
  }
}
