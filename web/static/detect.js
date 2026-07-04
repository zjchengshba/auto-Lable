/* ===== 目标检测模块：LocateAnything + 手动标注 ===== */

// ---- 状态 ----
let detTool = "rect";
let detImgW = 0, detImgH = 0;
let detBaseImg = null;
let detAnnotations = [];
let detNextId = 1;
let detSelectedIdx = -1;
let detCurrentPolygon = [];
let detCurrentRect = null;
let detDrawing = false;
let detRectStart = null;

// 拖动
let detDragging = false;
let detDragStart = null;
let detDragMoved = false;
let detVertexDragging = false;
let detVertexDragIdx = -1;

// 缩放/平移
let detScale = 1, detOffsetX = 0, detOffsetY = 0;
let detPanning = false, detPanStart = null;

// 鼠标位置
let detMouseX = -1, detMouseY = -1;

// 撤销
let detUndoStack = [];
const DET_UNDO_MAX = 50;

// 文件列表
let detFiles = [];
let detFileIdx = -1;
let detOutputDir = "detect_out";
let detAnnotatedFiles = new Set();

// LA
let laBusy = false;

const DET_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"];
const detCanvas = document.getElementById("det-canvas");
const detCtx = detCanvas.getContext("2d");

// ---- 撤销 ----
function detPushUndo() {
  const snap = detAnnotations.map(a => ({ id: a.id, type: a.type, label: a.label, data: JSON.parse(JSON.stringify(a.data)) }));
  detUndoStack.push(snap);
  if (detUndoStack.length > DET_UNDO_MAX) detUndoStack.shift();
}

function detUndo() {
  if (!detUndoStack.length) { toast("无可撤销操作", "info"); return; }
  const prev = detUndoStack.pop();
  detAnnotations = prev.map(a => ({ id: a.id, type: a.type, label: a.label, data: JSON.parse(JSON.stringify(a.data)) }));
  detSelectedIdx = -1;
  detRenderTargets();
  detRender();
  toast("已撤销", "info");
}

// ---- 坐标转换 ----
function detCanvasToImage(e) {
  const r = detCanvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) * (detCanvas.width / r.width);
  const cy = (e.clientY - r.top) * (detCanvas.height / r.height);
  return {
    x: Math.round((cx - detOffsetX) / detScale),
    y: Math.round((cy - detOffsetY) / detScale),
  };
}

// ---- 标注中心 ----
function detCenter(ann) {
  if (ann.type === "rect") {
    return [(ann.data.x1 + ann.data.x2) / 2, (ann.data.y1 + ann.data.y2) / 2];
  }
  if (ann.type === "polygon" && ann.data.points && ann.data.points.length) {
    let sx = 0, sy = 0;
    ann.data.points.forEach(p => { sx += p[0]; sy += p[1]; });
    return [sx / ann.data.points.length, sy / ann.data.points.length];
  }
  return [detImgW / 2, detImgH / 2];
}

// ---- 命中检测 ----
function detHitTest(ann, x, y) {
  if (ann.type === "rect") {
    const x1 = Math.min(ann.data.x1, ann.data.x2), x2 = Math.max(ann.data.x1, ann.data.x2);
    const y1 = Math.min(ann.data.y1, ann.data.y2), y2 = Math.max(ann.data.y1, ann.data.y2);
    return x >= x1 && x <= x2 && y >= y1 && y <= y2;
  }
  if (ann.type === "polygon") {
    return detPointInPolygon([x, y], ann.data.points);
  }
  return false;
}

function detPointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// ---- 渲染 ----
function detRender() {
  if (!detBaseImg) return;
  detCtx.clearRect(0, 0, detCanvas.width, detCanvas.height);
  detCtx.save();
  detCtx.translate(detOffsetX, detOffsetY);
  detCtx.scale(detScale, detScale);
  detCtx.drawImage(detBaseImg, 0, 0);

  detAnnotations.forEach((ann, i) => {
    const color = DET_COLORS[i % DET_COLORS.length];
    const isSel = i === detSelectedIdx;
    const alpha = isSel ? "50" : "25";
    const lw = isSel ? 3 : 2;

    if (ann.type === "rect") {
      const x = Math.min(ann.data.x1, ann.data.x2);
      const y = Math.min(ann.data.y1, ann.data.y2);
      const w = Math.abs(ann.data.x2 - ann.data.x1);
      const h = Math.abs(ann.data.y2 - ann.data.y1);
      detCtx.fillStyle = color + alpha;
      detCtx.fillRect(x, y, w, h);
      detCtx.strokeStyle = color;
      detCtx.lineWidth = lw;
      detCtx.strokeRect(x, y, w, h);
      // 标签
      detCtx.font = "bold 14px sans-serif";
      const labelW = detCtx.measureText(ann.label || "").width + 8;
      detCtx.fillStyle = color;
      detCtx.fillRect(x, y - 18, labelW, 18);
      detCtx.fillStyle = "#fff";
      detCtx.fillText(ann.label || "", x + 4, y - 5);
      if (isSel) {
        // 选中时顶点标记
        [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].forEach(pt => {
          detCtx.fillStyle = "#fff";
          detCtx.fillRect(pt[0] - 4, pt[1] - 4, 8, 8);
          detCtx.strokeStyle = color;
          detCtx.lineWidth = 1.5;
          detCtx.strokeRect(pt[0] - 4, pt[1] - 4, 8, 8);
        });
      }
    } else if (ann.type === "polygon") {
      const pts = ann.data.points;
      if (pts && pts.length > 0) {
        detCtx.beginPath();
        detCtx.moveTo(pts[0][0], pts[0][1]);
        for (let j = 1; j < pts.length; j++) detCtx.lineTo(pts[j][0], pts[j][1]);
        detCtx.closePath();
        detCtx.fillStyle = color + alpha;
        detCtx.fill();
        detCtx.strokeStyle = color;
        detCtx.lineWidth = lw;
        detCtx.stroke();
        if (isSel) {
          for (const pt of pts) {
            detCtx.fillStyle = "#fff";
            detCtx.fillRect(pt[0] - 4, pt[1] - 4, 8, 8);
            detCtx.strokeStyle = color;
            detCtx.lineWidth = 1.5;
            detCtx.strokeRect(pt[0] - 4, pt[1] - 4, 8, 8);
          }
        }
      }
    }
  });

  // 当前正在绘制的矩形
  if (detCurrentRect) {
    const x = Math.min(detCurrentRect.x1, detCurrentRect.x2);
    const y = Math.min(detCurrentRect.y1, detCurrentRect.y2);
    const w = Math.abs(detCurrentRect.x2 - detCurrentRect.x1);
    const h = Math.abs(detCurrentRect.y2 - detCurrentRect.y1);
    detCtx.strokeStyle = "#ef4444";
    detCtx.lineWidth = 2;
    detCtx.setLineDash([6, 4]);
    detCtx.strokeRect(x, y, w, h);
    detCtx.setLineDash([]);
  }

  // 多边形预览
  if (detCurrentPolygon.length > 0) {
    detCtx.beginPath();
    detCtx.moveTo(detCurrentPolygon[0][0], detCurrentPolygon[0][1]);
    for (let j = 1; j < detCurrentPolygon.length; j++) detCtx.lineTo(detCurrentPolygon[j][0], detCurrentPolygon[j][1]);
    if (detMouseX >= 0 && detMouseY >= 0) detCtx.lineTo(detMouseX, detMouseY);
    detCtx.strokeStyle = "#f59e0b";
    detCtx.lineWidth = 2;
    detCtx.setLineDash(detCurrentPolygon.length > 1 ? [] : [6, 4]);
    detCtx.stroke();
    if (detCurrentPolygon.length >= 2 && detMouseX >= 0) {
      detCtx.beginPath();
      detCtx.moveTo(detMouseX, detMouseY);
      detCtx.lineTo(detCurrentPolygon[0][0], detCurrentPolygon[0][1]);
      detCtx.strokeStyle = "rgba(245,158,11,0.35)";
      detCtx.setLineDash([4, 3]);
      detCtx.stroke();
    }
    detCtx.setLineDash([]);
    for (let j = 0; j < detCurrentPolygon.length; j++) {
      const pt = detCurrentPolygon[j];
      detCtx.beginPath();
      detCtx.arc(pt[0], pt[1], 3, 0, Math.PI * 2);
      detCtx.fillStyle = j === 0 ? "#fff" : "#f59e0b";
      detCtx.fill();
      detCtx.strokeStyle = "#f59e0b";
      detCtx.lineWidth = 1;
      detCtx.stroke();
    }
  }

  detCtx.restore();
}

// ---- 工具切换 ----
function detSetTool(tool) {
  detTool = tool;
  if (tool !== "select") detSelectedIdx = -1;
  if (detCurrentPolygon.length > 0 && tool !== "polygon") detCurrentPolygon = [];
  detCurrentRect = null;
  document.querySelectorAll(".det-tool-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
  const cursors = { rect: "crosshair", polygon: "crosshair", select: "default" };
  detCanvas.style.cursor = cursors[tool] || "default";
  detRender();
  detRenderTargets();
}

// ---- 画布自适应 ----
function detFitCanvas() {
  if (!detImgW || !detBaseImg) return;
  const container = $("det-canvas-wrap");
  if (!container) return;
  const cw = container.clientWidth - 8;
  const ch = container.clientHeight - 30;
  if (cw <= 0 || ch <= 0) return;
  detCanvas.width = cw;
  detCanvas.height = ch;
  detCanvas.style.width = cw + "px";
  detCanvas.style.height = ch + "px";
  const s = Math.min(cw / detImgW, ch / detImgH);
  detScale = s;
  detOffsetX = (cw - detImgW * s) / 2;
  detOffsetY = (ch - detImgH * s) / 2;
  detRender();
}

// ---- 载入图片 ----
async function detLoadImage(path) {
  if (!path) { toast("请输入图片路径", "error"); return; }
  $("det-current-name") && ($("det-current-name").textContent = path.split("\\").pop().split("/").pop());
  try {
    detImgW = 0; detImgH = 0;
    detBaseImg = new Image();
    detBaseImg.onload = () => {
      detImgW = detBaseImg.naturalWidth;
      detImgH = detBaseImg.naturalHeight;
      detAnnotations = [];
      detSelectedIdx = -1;
      detUndoStack = [];
      detCurrentPolygon = [];
      detCurrentRect = null;
      $("det-empty").style.display = "none";
      detLoadAnnotations(path);
      requestAnimationFrame(() => requestAnimationFrame(detFitCanvas));
      detRenderTargets();
      detRender();
    };
    detBaseImg.onerror = () => { toast("图片加载失败", "error"); };
    detBaseImg.src = "/api/image?path=" + encodeURIComponent(path);
  } catch (e) {
    toast("载入异常: " + e.message, "error");
  }
}

// ---- 文件面板收缩 ----
function detToggleFilePanel() {
  const panel = $("det-files-panel");
  const expandBtn = $("det-expand-btn");
  const collapsed = panel.classList.toggle("collapsed");
  expandBtn.classList.toggle("hidden", !collapsed);
  setTimeout(detFitCanvas, 250);
}

// ---- 文件列表 ----
async function detLoadFileList() {
  const folder = $("det-folder").value.trim();
  if (!folder) { toast("请输入文件夹路径", "error"); return; }
  try {
    const d = await fetchJSON("/api/files/list?path=" + encodeURIComponent(folder));
    if (d.error) { toast(d.error, "error"); return; }
    detFiles = d.files || [];
    detFileIdx = -1;
    detAnnotatedFiles = new Set();
    detRenderFileList();
    toast("找到 " + detFiles.length + " 张图片", "success");
  } catch (e) { toast("加载失败: " + e.message, "error"); }
}

function detRenderFileList() {
  const box = $("det-file-list");
  if (!detFiles.length) { box.innerHTML = '<div class="empty-state">无图片</div>'; return; }
  box.innerHTML = detFiles.map((f, i) => {
    const flagged = detAnnotatedFiles.has(f.name);
    return '<div class="ann-file-item ' + (i === detFileIdx ? "active" : "") + " " + (flagged ? "flagged" : "") + '" onclick="detOpenFile(' + i + ')" title="' + esc(f.name) + '">' +
      (flagged ? '<i class="fa fa-flag ann-flag"></i>' : '') +
      '<span class="ann-file-name">' + esc(f.name) + '</span></div>';
  }).join("");
}

async function detOpenFile(idx) {
  if (idx < 0 || idx >= detFiles.length) return;
  detFileIdx = idx;
  detRenderFileList();
  await detLoadImage(detFiles[idx].path);
}

function detNext() { if (detFileIdx < detFiles.length - 1) detOpenFile(detFileIdx + 1); else toast("已是最后一张", "info"); }
function detPrev() { if (detFileIdx > 0) detOpenFile(detFileIdx - 1); else toast("已是第一张", "info"); }

// ---- 保存/读取 ----
async function detSave() {
  if (!detFiles.length || detFileIdx < 0) { toast("请先选择图片", "error"); return; }
  const imageName = detFiles[detFileIdx].name;
  const annsData = detAnnotations.map(a => {
    const d = { id: a.id, type: a.type, label: a.label };
    if (a.type === "rect") d.data = { x1: a.data.x1, y1: a.data.y1, x2: a.data.x2, y2: a.data.y2 };
    else if (a.type === "polygon") d.data = { points: a.data.points };
    return d;
  });
  try {
    const d = await fetchJSON("/api/annotations/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output_dir: detOutputDir, image_name: imageName, annotations: annsData }),
    });
    if (d.ok) {
      toast("已保存 " + annsData.length + " 个标注", "success");
      detAnnotatedFiles.add(imageName);
      detRenderFileList();
    } else toast(d.error || "保存失败", "error");
  } catch (e) { toast("保存异常: " + e.message, "error"); }
}

async function detLoadAnnotations(path) {
  const imageName = path.split("\\").pop().split("/").pop();
  try {
    const d = await fetchJSON("/api/annotations/load?output_dir=" + encodeURIComponent(detOutputDir) + "&image_name=" + encodeURIComponent(imageName));
    if (d.ok && d.annotations && d.annotations.length) {
      detAnnotations = d.annotations.map(a => {
        const ann = { id: a.id || detNextId++, type: a.type, label: a.label || "object", data: {} };
        if (a.type === "rect") ann.data = { x1: a.data.x1, y1: a.data.y1, x2: a.data.x2, y2: a.data.y2 };
        else if (a.type === "polygon") ann.data = { points: a.data.points };
        return ann;
      });
      detNextId = Math.max(detNextId, ...detAnnotations.map(a => a.id), 0) + 1;
      detAnnotatedFiles.add(imageName);
      detRenderTargets();
      detRenderFileList();
      detRender();
    }
  } catch (e) { /* 首次无文件 */ }
}

// ---- 标注目标列表 ----
function detRenderTargets() {
  $("det-count").textContent = detAnnotations.length;
  const box = $("det-targets");
  if (!detAnnotations.length) { box.innerHTML = '<div class="empty-state">无目标</div>'; return; }
  box.innerHTML = detAnnotations.map((a, i) => {
    const color = DET_COLORS[i % DET_COLORS.length];
    const isSel = i === detSelectedIdx;
    return '<div class="ann-target-item ' + (isSel ? "selected" : "") + '" data-idx="' + i + '" onclick="detSelectTarget(' + i + ')" ondblclick="detFocusTarget(' + i + ')">' +
      '<span class="ann-color-dot" style="background:' + color + '"></span>' +
      '<span class="type-tag">' + a.type + '</span>' +
      '<input class="ann-label-input" value="' + esc(a.label || "object") + '" data-idx="' + i + '" onclick="event.stopPropagation()" ondblclick="event.stopPropagation()" onchange="detRenameTarget(' + i + ', this.value)" onfocus="this.select()">' +
      '<button class="locate-btn" onclick="event.stopPropagation(); detFocusTarget(' + i + ')" title="定位"><i class="fa fa-crosshairs"></i></button>' +
      '<button class="del-btn" onclick="event.stopPropagation(); detDeleteTarget(' + i + ')" title="删除"><i class="fa fa-times"></i></button>' +
      '</div>';
  }).join("");
}

function detSelectTarget(idx) {
  if (detTool !== "select") detSetTool("select");
  detSelectedIdx = idx;
  detRender();
  detRenderTargets();
}

function detFocusTarget(idx) {
  if (idx < 0 || idx >= detAnnotations.length) return;
  detSelectTarget(idx);
  const ann = detAnnotations[idx];
  const [cx, cy] = detCenter(ann);
  const container = $("det-canvas-wrap");
  if (container) {
    const cw = container.clientWidth - 8;
    const ch = container.clientHeight - 30;
    const targetScale = Math.max(detScale, Math.min(cw / 200, ch / 200, 8));
    detScale = targetScale;
    detOffsetX = cw / 2 - cx * detScale;
    detOffsetY = ch / 2 - cy * detScale;
    detRender();
  }
  toast("已定位到 #" + (idx + 1) + ": " + ann.label, "info");
}

function detRenameTarget(idx, name) {
  if (idx < 0 || idx >= detAnnotations.length) return;
  const v = (name || "").trim() || "object";
  detPushUndo();
  detAnnotations[idx].label = v;
  toast("已重命名为 " + v, "success");
}

function detDeleteTarget(idx) {
  if (idx < 0 || idx >= detAnnotations.length) return;
  detPushUndo();
  if (idx === detSelectedIdx) detSelectedIdx = -1;
  else if (idx < detSelectedIdx) detSelectedIdx--;
  detAnnotations.splice(idx, 1);
  detRenderTargets();
  detRender();
  toast("已删除", "info");
}

function detDeleteSelected() { if (detSelectedIdx >= 0 && detSelectedIdx < detAnnotations.length) detDeleteTarget(detSelectedIdx); }

// ---- 完成当前标注 ----
function detFinishCurrent() {
  if (detTool === "polygon" && detCurrentPolygon.length >= 3) {
    detPushUndo();
    detAnnotations.push({ id: detNextId++, type: "polygon", data: { points: detCurrentPolygon.slice() }, label: ($("det-label").value || "object").trim() });
    detCurrentPolygon = [];
    detRenderTargets(); detRender();
    toast("多边形标注已添加", "success");
  } else if (detTool === "rect" && detCurrentRect) {
    const w = Math.abs(detCurrentRect.x2 - detCurrentRect.x1);
    const h = Math.abs(detCurrentRect.y2 - detCurrentRect.y1);
    if (w < 5 || h < 5) { detCurrentRect = null; detRender(); return; }
    detPushUndo();
    detAnnotations.push({ id: detNextId++, type: "rect", data: { x1: detCurrentRect.x1, y1: detCurrentRect.y1, x2: detCurrentRect.x2, y2: detCurrentRect.y2 }, label: ($("det-label").value || "object").trim() });
    detCurrentRect = null;
    detRenderTargets(); detRender();
    toast("方框标注已添加", "success");
  } else { toast("没有可完成的标注", "error"); }
}

// ---- LocateAnything 检测 ----
async function laRun() {
  if (!detBaseImg || !detImgW) { toast("请先载入图片", "error"); return; }
  if (laBusy) return;
  if (!detFiles.length || detFileIdx < 0) { toast("请先从文件列表选择图片", "error"); return; }
  const mode = $("la-mode").value;
  const query = ($("la-query").value || "").trim();
  if ((mode === "detect" || mode === "ground" || mode === "point") && !query) { toast("请输入查询内容", "error"); return; }
  const imagePath = detFiles[detFileIdx].path;
  laBusy = true;
  toast("LocateAnything 检测中...", "info");
  const t0 = Date.now();
  try {
    let endpoint, body;
    if (mode === "detect") {
      endpoint = "/api/la/detect";
      body = { image_path: imagePath, categories: query.split(",").map(s => s.trim()).filter(Boolean) };
    } else if (mode === "ground") {
      endpoint = "/api/la/ground";
      body = { image_path: imagePath, phrase: query, mode: "multi" };
    } else if (mode === "text") {
      endpoint = "/api/la/detect_text";
      body = { image_path: imagePath };
    } else if (mode === "point") {
      endpoint = "/api/la/point";
      body = { image_path: imagePath, phrase: query };
    }
    const d = await fetchJSON(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    if (!d.ok) { toast(d.error || "检测失败", "error"); return; }
    const boxes = d.boxes || [];
    const points = d.points || [];
    if (!boxes.length && !points.length) { toast("未检测到物体 (" + elapsed + "s)", "info"); return; }
    // 搜索词作为标签名
    const searchLabel = mode === "text" ? "text" : query.split(",")[0].trim();
    detPushUndo();
    let added = 0;
    boxes.forEach(b => {
      detAnnotations.push({
        id: detNextId++,
        type: "rect",
        data: { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 },
        label: b.label || searchLabel,
      });
      added++;
    });
    // 点结果转为小方框
    points.forEach(p => {
      detAnnotations.push({
        id: detNextId++,
        type: "rect",
        data: { x1: p.x - 5, y1: p.y - 5, x2: p.x + 5, y2: p.y + 5 },
        label: searchLabel,
      });
      added++;
    });
    // 更新标签输入框为搜索词
    if (searchLabel) $("det-label").value = searchLabel;
    detRenderTargets();
    detRender();
    toast("检测到 " + added + " 个物体 (" + elapsed + "s)", "success");
  } catch (e) {
    toast("检测异常: " + e.message, "error");
  } finally {
    laBusy = false;
  }
}

// ---- 导出 ----
function detExport() {
  if (!detAnnotations.length) { toast("无标注可导出", "error"); return; }
  const data = {
    image: detFiles.length > 0 && detFileIdx >= 0 ? detFiles[detFileIdx].name : "unknown",
    width: detImgW,
    height: detImgH,
    annotations: detAnnotations.map(a => {
      const d = { id: a.id, type: a.type, label: a.label };
      if (a.type === "rect") d.data = { x1: a.data.x1, y1: a.data.y1, x2: a.data.x2, y2: a.data.y2 };
      else if (a.type === "polygon") d.data = { points: a.data.points };
      return d;
    }),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const name = detFiles.length > 0 && detFileIdx >= 0
    ? detFiles[detFileIdx].name.replace(/\.[^.]+$/, "") + "_detection.json"
    : "detection.json";
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("已导出 " + detAnnotations.length + " 个标注", "success");
}

// ---- 发送到分割标注：逐框分割 ----
async function detSendToSam() {
  if (!detBaseImg || !detFiles.length || detFileIdx < 0) { toast("请先载入图片", "error"); return; }
  const rectAnns = detAnnotations.filter(a => a.type === "rect");
  if (!rectAnns.length) { toast("无方框标注可发送", "error"); return; }
  const imagePath = detFiles[detFileIdx].path;
  enterModule("sam");
  toast("正在加载图片到分割标注...", "info");
  await new Promise(r => setTimeout(r, 300));
  if (typeof sam3LoadImage !== "function") { toast("SAM模块未就绪", "error"); return; }
  await sam3LoadImage(imagePath);
  await new Promise(r => setTimeout(r, 500));
  // 逐一处理每个框
  toast("开始逐框分割 (" + rectAnns.length + " 个)...", "info");
  for (let i = 0; i < rectAnns.length; i++) {
    const ann = rectAnns[i];
    const box = [Math.min(ann.data.x1, ann.data.x2), Math.min(ann.data.y1, ann.data.y2),
                 Math.max(ann.data.x1, ann.data.x2), Math.max(ann.data.y1, ann.data.y2)];
    toast("分割中 " + (i + 1) + "/" + rectAnns.length + ": " + ann.label, "info");
    // 设置 box 并预测
    sam3Points = [];
    sam3Box = box;
    sam3Render();
    await sam3Predict();
    await new Promise(r => setTimeout(r, 300));
    // 如果有结果，保存为标注
    if (sam3OverlayImg) {
      pushUndo();
      annotations.push({
        id: annNextId++,
        type: "mask",
        data: { overlayImg: sam3OverlayImg, overlayB64: sam3OverlayImg.src.split(",")[1], offsetX: 0, offsetY: 0 },
        label: ann.label,
      });
      annRenderTargets();
      sam3Render();
    }
    sam3OverlayImg = null;
    sam3Box = null;
    sam3ClearPrompts();
    sam3Render();
    await new Promise(r => setTimeout(r, 200));
  }
  toast("逐框分割完成: " + rectAnns.length + " 个", "success");
}

// ---- Canvas 事件 ----
detCanvas.addEventListener("contextmenu", e => e.preventDefault());

detCanvas.addEventListener("mousedown", e => {
  if (!detBaseImg) return;
  if (e.button === 2) {
    detPanning = true;
    detPanStart = { x: e.clientX, y: e.clientY, ox: detOffsetX, oy: detOffsetY };
    detCanvas.style.cursor = "grabbing";
    return;
  }
  if (e.button === 1) {
    e.preventDefault();
    detPanning = true;
    detPanStart = { x: e.clientX, y: e.clientY, ox: detOffsetX, oy: detOffsetY };
    detCanvas.style.cursor = "grabbing";
    return;
  }
  if (e.button !== 0) return;
  const p = detCanvasToImage(e);

  if (detTool === "select") {
    // 检查顶点拖动
    if (detSelectedIdx >= 0) {
      const ann = detAnnotations[detSelectedIdx];
      if (ann.type === "polygon") {
        const pts = ann.data.points;
        const hitR = 10 / detScale;
        for (let v = 0; v < pts.length; v++) {
          const dx = p.x - pts[v][0], dy = p.y - pts[v][1];
          if (Math.sqrt(dx * dx + dy * dy) <= hitR) {
            detVertexDragging = true;
            detVertexDragIdx = v;
            detPushUndo();
            return;
          }
        }
      } else if (ann.type === "rect") {
        // 检查矩形四角
        const corners = [
          [ann.data.x1, ann.data.y1], [ann.data.x2, ann.data.y1],
          [ann.data.x2, ann.data.y2], [ann.data.x1, ann.data.y2],
        ];
        const hitR = 10 / detScale;
        for (let v = 0; v < corners.length; v++) {
          const dx = p.x - corners[v][0], dy = p.y - corners[v][1];
          if (Math.sqrt(dx * dx + dy * dy) <= hitR) {
            detVertexDragging = true;
            detVertexDragIdx = v;
            detPushUndo();
            return;
          }
        }
      }
    }
    // 检查整体命中
    let hit = -1;
    for (let i = detAnnotations.length - 1; i >= 0; i--) {
      if (detHitTest(detAnnotations[i], p.x, p.y)) { hit = i; break; }
    }
    if (hit >= 0) {
      detSelectedIdx = hit;
      detDragging = true;
      detDragStart = { x: p.x, y: p.y };
      detDragMoved = false;
      detPushUndo();
      detRenderTargets();
      detRender();
    } else {
      detSelectedIdx = -1;
      detRenderTargets();
      detRender();
    }
    return;
  }

  if (detTool === "rect") {
    detDrawing = true;
    detRectStart = p;
    detCurrentRect = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  }
});

detCanvas.addEventListener("mousemove", e => {
  const p = detCanvasToImage(e);
  detMouseX = p.x; detMouseY = p.y;

  if (detPanning) return;

  if (detVertexDragging && detSelectedIdx >= 0) {
    const ann = detAnnotations[detSelectedIdx];
    if (ann.type === "polygon") {
      ann.data.points[detVertexDragIdx] = [p.x, p.y];
    } else if (ann.type === "rect") {
      const corners = ["x1y1", "x2y1", "x2y2", "x1y2"];
      const c = corners[detVertexDragIdx];
      if (c[0] === "x1") ann.data.x1 = p.x;
      if (c[0] === "x2") ann.data.x2 = p.x;
      if (c[1] === "y1") ann.data.y1 = p.y;
      if (c[1] === "y2") ann.data.y2 = p.y;
    }
    detRender();
    return;
  }

  if (detDragging && detSelectedIdx >= 0) {
    const dx = p.x - detDragStart.x, dy = p.y - detDragStart.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) detDragMoved = true;
    const ann = detAnnotations[detSelectedIdx];
    if (ann.type === "rect") {
      ann.data.x1 += dx; ann.data.y1 += dy;
      ann.data.x2 += dx; ann.data.y2 += dy;
    } else if (ann.type === "polygon") {
      ann.data.points = ann.data.points.map(pt => [pt[0] + dx, pt[1] + dy]);
    }
    detDragStart = { x: p.x, y: p.y };
    detRender();
    return;
  }

  if (!detDrawing) {
    if (detTool === "polygon" && detCurrentPolygon.length > 0) detRender();
    return;
  }

  if (detTool === "rect" && detCurrentRect) {
    detCurrentRect.x2 = p.x;
    detCurrentRect.y2 = p.y;
    detRender();
  }
});

detCanvas.addEventListener("mouseup", e => {
  if (detPanning && (e.button === 2 || e.button === 1)) {
    detPanning = false;
    detCanvas.style.cursor = detTool === "select" ? "default" : "crosshair";
    return;
  }
  if (detVertexDragging) {
    detVertexDragging = false;
    detVertexDragIdx = -1;
    toast("顶点已移动", "success");
    return;
  }
  if (detDragging) {
    detDragging = false;
    if (detDragMoved) toast("已移动标注", "success");
    return;
  }
  if (!detDrawing) return;
  detDrawing = false;
  if (detTool === "rect" && detCurrentRect) {
    const w = Math.abs(detCurrentRect.x2 - detCurrentRect.x1);
    const h = Math.abs(detCurrentRect.y2 - detCurrentRect.y1);
    if (w < 5 || h < 5) { detCurrentRect = null; detRender(); return; }
    detRender();
    toast("方框已绘制，点「完成」保存", "info");
  }
});

detCanvas.addEventListener("click", e => {
  if (detPanning || detDrawing || !detBaseImg) return;
  if (detTool === "rect" || detTool === "select") return;
  const p = detCanvasToImage(e);
  if (detTool === "polygon") {
    if (detCurrentPolygon.length >= 3) {
      const first = detCurrentPolygon[0];
      const dx = p.x - first[0], dy = p.y - first[1];
      if (Math.sqrt(dx * dx + dy * dy) <= 8) { detFinishCurrent(); return; }
    }
    detCurrentPolygon.push([p.x, p.y]);
    detRender();
  }
});

detCanvas.addEventListener("dblclick", () => {
  if (detTool === "polygon" && detCurrentPolygon.length >= 3) detFinishCurrent();
});

detCanvas.addEventListener("wheel", e => {
  if (!detBaseImg) return;
  e.preventDefault();
  const r = detCanvas.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (detCanvas.width / r.width);
  const my = (e.clientY - r.top) * (detCanvas.height / r.height);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newScale = Math.max(0.05, Math.min(40, detScale * factor));
  detOffsetX = mx - (mx - detOffsetX) * (newScale / detScale);
  detOffsetY = my - (my - detOffsetY) * (newScale / detScale);
  detScale = newScale;
  detRender();
}, { passive: false });

detCanvas.addEventListener("mouseleave", () => {
  detMouseX = -1; detMouseY = -1;
  if (detTool === "polygon" && detCurrentPolygon.length > 0) detRender();
});

// 全局事件
document.addEventListener("mouseup", e => {
  if (detPanning && (e.button === 2 || e.button === 1)) {
    detPanning = false;
    detCanvas.style.cursor = detTool === "select" ? "default" : "crosshair";
  }
  if (detVertexDragging) { detVertexDragging = false; detVertexDragIdx = -1; }
  if (detDragging) { detDragging = false; if (detDragMoved) toast("已移动标注", "success"); }
});

document.addEventListener("mousemove", e => {
  if (!detPanning) return;
  detOffsetX = detPanStart.ox + (e.clientX - detPanStart.x);
  detOffsetY = detPanStart.oy + (e.clientY - detPanStart.y);
  detRender();
});

// ---- 键盘快捷键 ----
document.addEventListener("keydown", e => {
  if ($("module-detect").classList.contains("hidden")) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    detUndo();
    return;
  }
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "1") detSetTool("rect");
  else if (e.key === "2") detSetTool("polygon");
  else if (e.key === "3" || e.key === "v" || e.key === "V" || e.key === "s" || e.key === "S") detSetTool("select");
  else if (e.key === "Enter") detFinishCurrent();
  else if (e.key === "Delete" || e.key === "Backspace") detDeleteSelected();
  else if (e.key === "Escape") { detCurrentPolygon = []; detCurrentRect = null; detSelectedIdx = -1; detRender(); detRenderTargets(); }
  else if (e.key === "f" || e.key === "F") { if (detSelectedIdx >= 0) detFocusTarget(detSelectedIdx); else detFitCanvas(); }
  else if (e.key === "ArrowLeft") detPrev();
  else if (e.key === "ArrowRight") detNext();
});

// ---- 状态轮询 ----
async function laPollStatus() {
  try {
    const d = await fetchJSON("/api/la/status");
    if (d.online) {
      $("la-status").innerHTML = '<span style="color:#4ade80">● LA 在线</span>' + (d.gpu ? " (" + esc(d.gpu) + ")" : "");
    } else {
      $("la-status").innerHTML = '<span style="color:#f87171">● LA 离线</span>';
    }
  } catch {
    $("la-status").innerHTML = '<span style="color:#f87171">● LA 离线</span>';
  }
}

window.addEventListener("resize", () => {
  if (detBaseImg && !$("module-detect").classList.contains("hidden")) detFitCanvas();
});

laPollStatus();
setInterval(laPollStatus, 5000);
