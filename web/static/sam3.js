/* ===== 标注工具：SAM3 辅助 + 多边形/圆形手动标注 ===== */

// ---- 状态 ----
let sam3Tool = "pos";
let sam3Points = [];          // SAM3 临时点 [{x, y, label}]
let sam3Box = null;           // SAM3 临时框 [x1,y1,x2,y2]
let sam3ImgW = 0, sam3ImgH = 0;
let sam3BaseImg = null;       // 底图 Image
let sam3OverlayImg = null;    // SAM3 当前 mask overlay
let sam3GroundObjects = [];
let sam3GroundOverlays = [];   // grounding 所有物体的 overlay Image 列表
let sam3ActiveIdx = -1;
let sam3Drawing = false;
let sam3BoxStart = null;
let sam3Busy = false;

// 手动标注
let annotations = [];         // 已保存标注 [{id, type, data, label}]
let annNextId = 1;
let currentPolygon = [];      // 正在画的多边形顶点
let currentCircle = null;     // 正在画的圆 {center, radius}
let circleDragStart = null;

// 缩放/平移
let annScale = 1, annOffsetX = 0, annOffsetY = 0;
let annPanning = false, annPanStart = null;

// 文件列表
let annFiles = [];
let annFileIdx = -1;
let annOutputDir = "annotations_out";

const canvas = document.getElementById("sam3-canvas");
const ctx = canvas.getContext("2d");
const ANN_COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"];

// ---- 坐标转换（考虑缩放/平移） ----
function sam3CanvasToImage(e) {
  const r = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) * (canvas.width / r.width);
  const cy = (e.clientY - r.top) * (canvas.height / r.height);
  return {
    x: Math.round((cx - annOffsetX) / annScale),
    y: Math.round((cy - annOffsetY) / annScale),
  };
}

// ---- 渲染 ----
function sam3Render() {
  if (!sam3BaseImg) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(annOffsetX, annOffsetY);
  ctx.scale(annScale, annScale);
  // 底图
  ctx.drawImage(sam3BaseImg, 0, 0);
  // 已保存标注
  annotations.forEach((ann, i) => {
    const color = ANN_COLORS[i % ANN_COLORS.length];
    if (ann.type === "mask" && ann.data.overlayImg) {
      ctx.drawImage(ann.data.overlayImg, 0, 0, sam3ImgW, sam3ImgH);
    } else if (ann.type === "polygon") {
      const pts = ann.data.points;
      if (pts.length > 0) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
        ctx.closePath();
        ctx.fillStyle = color + "30";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else if (ann.type === "circle") {
      ctx.beginPath();
      ctx.arc(ann.data.center[0], ann.data.center[1], ann.data.radius, 0, Math.PI * 2);
      ctx.fillStyle = color + "30";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });
  // SAM3 当前 overlay
  if (sam3OverlayImg) ctx.drawImage(sam3OverlayImg, 0, 0, sam3ImgW, sam3ImgH);
  // Grounding 所有物体 overlay
  for (const oi of sam3GroundOverlays) {
    if (oi) ctx.drawImage(oi, 0, 0, sam3ImgW, sam3ImgH);
  }
  // SAM3 点
  for (const p of sam3Points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = p.label === 1 ? "rgba(34,197,94,0.9)" : "rgba(239,68,68,0.9)";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (p.label === 0) {
      ctx.beginPath();
      ctx.moveTo(p.x - 3, p.y - 3); ctx.lineTo(p.x + 3, p.y + 3);
      ctx.moveTo(p.x + 3, p.y - 3); ctx.lineTo(p.x - 3, p.y + 3);
      ctx.stroke();
    }
  }
  // SAM3 框
  if (sam3Box) {
    const [x1, y1, x2, y2] = sam3Box;
    ctx.strokeStyle = "#d946ef";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.setLineDash([]);
  }
  // 当前多边形预览
  if (currentPolygon.length > 0) {
    ctx.beginPath();
    ctx.moveTo(currentPolygon[0][0], currentPolygon[0][1]);
    for (let j = 1; j < currentPolygon.length; j++) ctx.lineTo(currentPolygon[j][0], currentPolygon[j][1]);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2;
    ctx.stroke();
    // 顶点
    for (const pt of currentPolygon) {
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], 4, 0, Math.PI * 2);
      ctx.fillStyle = "#f59e0b";
      ctx.fill();
    }
  }
  // 当前圆形预览
  if (currentCircle) {
    ctx.beginPath();
    ctx.arc(currentCircle.center[0], currentCircle.center[1], currentCircle.radius, 0, Math.PI * 2);
    ctx.strokeStyle = "#06b6d4";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

// ---- 工具切换 ----
function sam3SetTool(tool) {
  sam3Tool = tool;
  // 切换工具时完成未完成的手动标注
  if (currentPolygon.length > 0 && tool !== "polygon") currentPolygon = [];
  currentCircle = null;
  document.querySelectorAll(".tool-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
  canvas.style.cursor = tool === "box" || tool === "circle" ? "crosshair" : "pointer";
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
    canvas.width = sam3ImgW;
    canvas.height = sam3ImgH;
    annScale = 1; annOffsetX = 0; annOffsetY = 0;
    sam3BaseImg = new Image();
    sam3BaseImg.onload = () => {
      sam3ClearPrompts();
      annotations = [];
      annLoadAnnotations(path);
      sam3Render();
      $("sam3-empty").style.display = "none";
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
}

// ---- 导出所有掩码 ----
function annExportAll() {
  if (!annotations.length) { toast("无标注可导出", "error"); return; }
  if (!sam3BaseImg) { toast("请先载入图片", "error"); return; }
  // 创建合成 canvas：透明底 + 每个标注用不同颜色画 mask/多边形/圆形（不含原图）
  const tmp = document.createElement("canvas");
  tmp.width = sam3ImgW;
  tmp.height = sam3ImgH;
  const tctx = tmp.getContext("2d");
  annotations.forEach((ann, i) => {
    const color = ANN_COLORS[i % ANN_COLORS.length];
    tctx.fillStyle = color + "60";
    tctx.strokeStyle = color;
    tctx.lineWidth = 2;
    if (ann.type === "mask" && ann.data.overlayImg) {
      tctx.drawImage(ann.data.overlayImg, 0, 0, sam3ImgW, sam3ImgH);
    } else if (ann.type === "polygon") {
      const pts = ann.data.points;
      if (pts.length > 0) {
        tctx.beginPath();
        tctx.moveTo(pts[0][0], pts[0][1]);
        for (let j = 1; j < pts.length; j++) tctx.lineTo(pts[j][0], pts[j][1]);
        tctx.closePath();
        tctx.fill();
        tctx.stroke();
      }
    } else if (ann.type === "circle") {
      tctx.beginPath();
      tctx.arc(ann.data.center[0], ann.data.center[1], ann.data.radius, 0, Math.PI * 2);
      tctx.fill();
      tctx.stroke();
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
    annRenderFileList();
    toast(`找到 ${annFiles.length} 张图片`, "success");
  } catch (e) {
    toast("加载失败: " + e.message, "error");
  }
}

function annRenderFileList() {
  const box = $("ann-file-list");
  if (!annFiles.length) { box.innerHTML = `<div class="empty-state">无图片</div>`; return; }
  box.innerHTML = annFiles.map((f, i) =>
    `<div class="ann-file-item ${i === annFileIdx ? "active" : ""}" onclick="annOpenFile(${i})" title="${esc(f.name)}">${esc(f.name)}</div>`
  ).join("");
}

async function annOpenFile(idx) {
  if (idx < 0 || idx >= annFiles.length) return;
  annFileIdx = idx;
  annRenderFileList();
  $("sam3-img-path") && ($("sam3-img-path").value = annFiles[idx].path);
  await sam3LoadImage(annFiles[idx].path);
}

function annNext() {
  if (annFileIdx < annFiles.length - 1) annOpenFile(annFileIdx + 1);
  else toast("已是最后一张", "info");
}
function annPrev() {
  if (annFileIdx > 0) annOpenFile(annFileIdx - 1);
  else toast("已是第一张", "info");
}

// ---- 保存/读取标注 ----
async function annSave() {
  if (!annFiles.length || annFileIdx < 0) { toast("请先选择图片", "error"); return; }
  const imageName = annFiles[annFileIdx].name;
  const annsData = annotations.map(a => {
    const d = { id: a.id, type: a.type, label: a.label };
    if (a.type === "mask") d.data = { overlay: a.data.overlayB64 };
    else if (a.type === "polygon") d.data = { points: a.data.points };
    else if (a.type === "circle") d.data = { center: a.data.center, radius: a.data.radius };
    return d;
  });
  try {
    const d = await fetchJSON("/api/annotations/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output_dir: annOutputDir, image_name: imageName, annotations: annsData }),
    });
    if (d.ok) toast(`已保存 ${annsData.length} 个标注`, "success");
    else toast(d.error || "保存失败", "error");
  } catch (e) {
    toast("保存异常: " + e.message, "error");
  }
}

async function annLoadAnnotations(path) {
  const imageName = path.split("\\").pop().split("/").pop();
  try {
    const d = await fetchJSON(`/api/annotations/load?output_dir=${encodeURIComponent(annOutputDir)}&image_name=${encodeURIComponent(imageName)}`);
    if (d.ok && d.annotations) {
      annotations = d.annotations.map(a => {
        const ann = { id: a.id || annNextId++, type: a.type, label: a.label || "object", data: {} };
        if (a.type === "mask") {
          ann.data.overlayB64 = a.data.overlay;
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
      annRenderTargets();
      sam3Render();
    }
  } catch (e) { /* 首次标注无文件，忽略 */ }
}

// ---- 目标列表 ----
function annRenderTargets() {
  $("ann-count").textContent = annotations.length;
  const box = $("ann-targets");
  if (!annotations.length) { box.innerHTML = `<div class="empty-state">无目标</div>`; return; }
  box.innerHTML = annotations.map((a, i) =>
    `<div class="ann-target-item">
      <span class="type-tag">${a.type}</span>
      <span>${esc(a.label || "object")}</span>
      <button class="del-btn" onclick="annDeleteTarget(${i})">×</button>
    </div>`
  ).join("");
}

function annDeleteTarget(idx) {
  annotations.splice(idx, 1);
  annRenderTargets();
  sam3Render();
}

// ---- 完成当前标注 ----
function annFinishCurrent() {
  if (sam3Tool === "polygon" && currentPolygon.length >= 3) {
    annotations.push({
      id: annNextId++, type: "polygon",
      data: { points: currentPolygon.slice() },
      label: ($("ann-label").value || "object").trim(),
    });
    currentPolygon = [];
    annRenderTargets();
    sam3Render();
    toast("多边形标注已添加", "success");
  } else if (sam3Tool === "circle" && currentCircle && currentCircle.radius > 2) {
    annotations.push({
      id: annNextId++, type: "circle",
      data: { center: currentCircle.center.slice(), radius: currentCircle.radius },
      label: ($("ann-label").value || "object").trim(),
    });
    currentCircle = null;
    annRenderTargets();
    sam3Render();
    toast("圆形标注已添加", "success");
  } else if (sam3OverlayImg) {
    // SAM3 mask → 保存为标注
    annotations.push({
      id: annNextId++, type: "mask",
      data: { overlayImg: sam3OverlayImg, overlayB64: sam3OverlayImg.src.split(",")[1] },
      label: ($("ann-label").value || "object").trim(),
    });
    sam3OverlayImg = null;
    sam3ClearPrompts();
    annRenderTargets();
    sam3Render();
    toast("SAM3 mask 已保存为标注", "success");
  } else if (sam3GroundOverlays.length > 0) {
    // Grounding 结果 → 每个物体作为独立 mask 标注保存
    let saved = 0;
    sam3GroundOverlays.forEach((oi) => {
      if (!oi) return;
      // 把这个 overlay 转成 dataURL 保存
      const tmp = document.createElement("canvas");
      tmp.width = sam3ImgW; tmp.height = sam3ImgH;
      const tctx = tmp.getContext("2d");
      tctx.drawImage(oi, 0, 0);
      annotations.push({
        id: annNextId++, type: "mask",
        data: { overlayImg: oi, overlayB64: tmp.toDataURL("image/png").split(",")[1] },
        label: ($("ann-label").value || "object").trim(),
      });
      saved++;
    });
    sam3GroundObjects = [];
    sam3GroundOverlays = [];
    annRenderTargets();
    sam3Render();
    toast(`已保存 ${saved} 个 grounding mask 为标注`, "success");
  } else {
    toast("没有可完成的标注", "error");
  }
}

// ---- SAM3 预测 ----
async function sam3Predict() {
  if (sam3Busy) return;
  sam3Busy = true;
  const body = {
    points: sam3Points.map(p => [p.x, p.y]),
    labels: sam3Points.map(p => p.label),
    box: sam3Box,
    multimask: sam3Points.length + (sam3Box ? 1 : 0) <= 1,
  };
  try {
    const d = await fetchJSON("/api/sam3/predict", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!d.ok) { toast(d.error || "预测失败", "error"); return; }
    if (d.masks && d.masks.length > 0) {
      const best = d.masks[d.best_index];
      sam3OverlayImg = new Image();
      sam3OverlayImg.onload = () => sam3Render();
      sam3OverlayImg.src = "data:image/png;base64," + best.overlay;
      toast(`分割完成 (score: ${best.score.toFixed(3)})，点「完成」保存`, "success");
    }
  } catch (e) {
    toast("预测异常: " + e.message, "error");
  } finally {
    sam3Busy = false;
  }
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
    const d = await fetchJSON("/api/sam3/ground", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, boxes }),
    });
    if (!d.ok) { toast(d.error || "检索失败", "error"); return; }
    const objs = d.objects || [];
    if (!objs.length) { toast("未找到匹配物体", "info"); return; }
    // 加载所有物体的 overlay，加载完成后自动保存为标注（标签名=查找关键词）
    const label = text || ($("ann-label").value || "object").trim();
    const overlays = new Array(objs.length).fill(null);
    let loaded = 0;
    let saved = 0;
    objs.forEach((obj, idx) => {
      const img = new Image();
      img.onload = () => {
        overlays[idx] = img;
        loaded++;
        // 实时渲染已加载的
        sam3Render();
        if (loaded === objs.length) {
          // 全部加载完成 → 自动保存到 annotations
          overlays.forEach((oi) => {
            if (!oi) return;
            const tmp = document.createElement("canvas");
            tmp.width = sam3ImgW; tmp.height = sam3ImgH;
            const tctx = tmp.getContext("2d");
            tctx.drawImage(oi, 0, 0);
            annotations.push({
              id: annNextId++, type: "mask",
              data: { overlayImg: oi, overlayB64: tmp.toDataURL("image/png").split(",")[1] },
              label: label,
            });
            saved++;
          });
          sam3GroundObjects = [];
          sam3GroundOverlays = [];
          annRenderTargets();
          sam3Render();
          toast(`找到 ${saved} 个物体，已自动保存为标注`, "success");
        }
      };
      img.onerror = () => {
        loaded++;
        if (loaded === objs.length && saved === 0) {
          sam3Render();
          toast(`找到 ${objs.length} 个物体但 mask 加载失败`, "error");
        }
      };
      img.src = "data:image/png;base64," + obj.overlay;
    });
    sam3Render();
  } catch (e) {
    toast("检索异常: " + e.message, "error");
  } finally {
    sam3Busy = false;
  }
}

// ---- 清除 ----
function sam3ClearPrompts() {
  sam3Points = [];
  sam3Box = null;
  sam3OverlayImg = null;
  sam3GroundObjects = [];
  sam3GroundOverlays = [];
  currentPolygon = [];
  currentCircle = null;
}

function sam3Clear() {
  sam3ClearPrompts();
  sam3Render();
  fetchJSON("/api/sam3/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  toast("已清除当前提示", "info");
}

// ---- Canvas 事件 ----
// 阻止右键菜单弹出（右键用于平移）
canvas.addEventListener("contextmenu", e => e.preventDefault());

canvas.addEventListener("mousedown", e => {
  if (!sam3BaseImg) return;
  if (e.button === 2) {
    // 右键 → 平移（不受 sam3Busy 限制）
    annPanning = true;
    annPanStart = { x: e.clientX, y: e.clientY, ox: annOffsetX, oy: annOffsetY };
    canvas.style.cursor = "grabbing";
    return;
  }
  if (e.button !== 0) return; // 非左键忽略
  if (sam3Busy) return;
  const p = sam3CanvasToImage(e);
  if (sam3Tool === "box") {
    sam3Drawing = true;
    sam3BoxStart = p;
    sam3Box = [p.x, p.y, p.x, p.y];
  } else if (sam3Tool === "circle") {
    sam3Drawing = true;
    circleDragStart = p;
    currentCircle = { center: [p.x, p.y], radius: 0 };
  }
});

canvas.addEventListener("mousemove", e => {
  if (annPanning) return; // 平移由 document mousemove 处理
  if (!sam3Drawing) return;
  const p = sam3CanvasToImage(e);
  if (sam3Tool === "box") {
    sam3Box = [sam3BoxStart.x, sam3BoxStart.y, p.x, p.y];
    sam3Render();
  } else if (sam3Tool === "circle" && currentCircle) {
    const dx = p.x - circleDragStart.x, dy = p.y - circleDragStart.y;
    currentCircle.radius = Math.sqrt(dx * dx + dy * dy);
    sam3Render();
  }
});

canvas.addEventListener("mouseup", e => {
  if (annPanning) { annPanning = false; canvas.style.cursor = (sam3Tool === "box" || sam3Tool === "circle") ? "crosshair" : "pointer"; return; }
  if (!sam3Drawing) return;
  sam3Drawing = false;
  const p = sam3CanvasToImage(e);
  if (sam3Tool === "box") {
    sam3Box = [sam3BoxStart.x, sam3BoxStart.y, p.x, p.y];
    const w = Math.abs(sam3Box[2] - sam3Box[0]), h = Math.abs(sam3Box[3] - sam3Box[1]);
    if (w < 5 || h < 5) { sam3Box = null; sam3Render(); return; }
    sam3Predict();
  } else if (sam3Tool === "circle" && currentCircle) {
    if (currentCircle.radius < 3) { currentCircle = null; sam3Render(); return; }
    sam3Render();
    toast("圆形已绘制，点「完成」保存", "info");
  }
});

// 全局 mouseup 确保鼠标移出 canvas 后右键拖动也能正确结束
document.addEventListener("mouseup", e => {
  if (annPanning && e.button === 2) {
    annPanning = false;
    canvas.style.cursor = (sam3Tool === "box" || sam3Tool === "circle") ? "crosshair" : "pointer";
  }
});

// 全局 mousemove 确保右键拖动时鼠标移出 canvas 仍能平移
document.addEventListener("mousemove", e => {
  if (!annPanning) return;
  annOffsetX = annPanStart.ox + (e.clientX - annPanStart.x);
  annOffsetY = annPanStart.oy + (e.clientY - annPanStart.y);
  sam3Render();
});

canvas.addEventListener("click", e => {
  if (annPanning || sam3Drawing || !sam3BaseImg) return;
  if (sam3Tool === "box" || sam3Tool === "circle") return;
  const p = sam3CanvasToImage(e);
  if (sam3Tool === "polygon") {
    currentPolygon.push([p.x, p.y]);
    sam3Render();
  } else if (sam3Tool === "pos" || sam3Tool === "neg") {
    sam3Points.push({ x: p.x, y: p.y, label: sam3Tool === "pos" ? 1 : 0 });
    sam3Render();
    sam3Predict();
  }
});

canvas.addEventListener("dblclick", e => {
  if (sam3Tool === "polygon" && currentPolygon.length >= 3) {
    annFinishCurrent();
  }
});

// 滚轮缩放（单独滚轮即可）
canvas.addEventListener("wheel", e => {
  if (!sam3BaseImg) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (canvas.width / r.width);
  const my = (e.clientY - r.top) * (canvas.height / r.height);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newScale = Math.max(0.2, Math.min(10, annScale * factor));
  // 以鼠标位置为中心缩放
  annOffsetX = mx - (mx - annOffsetX) * (newScale / annScale);
  annOffsetY = my - (my - annOffsetY) * (newScale / annScale);
  annScale = newScale;
  sam3Render();
}, { passive: false });

// ---- 键盘快捷键 ----
document.addEventListener("keydown", e => {
  if ($("module-sam").classList.contains("hidden")) return;
  if (e.target.tagName === "INPUT") return;
  if (e.key === "1") sam3SetTool("pos");
  else if (e.key === "2") sam3SetTool("neg");
  else if (e.key === "3" || e.key === "b" || e.key === "B") sam3SetTool("box");
  else if (e.key === "4" || e.key === "p" || e.key === "P") sam3SetTool("polygon");
  else if (e.key === "5" || e.key === "c" || e.key === "C") sam3SetTool("circle");
  else if (e.key === "Enter") annFinishCurrent();
  else if (e.key === "r" || e.key === "R") sam3Clear();
  else if (e.key === "ArrowLeft") annPrev();
  else if (e.key === "ArrowRight") annNext();
});

// ---- 状态轮询 ----
async function sam3PollStatus() {
  try {
    const d = await fetchJSON("/api/sam3/status");
    if (d.online) {
      $("sam3-status").innerHTML = `<span style="color:#4ade80">● SAM3 在线</span> ${d.gpu ? "(" + esc(d.gpu) + ")" : ""}`;
    } else {
      $("sam3-status").innerHTML = `<span style="color:#f87171">● SAM3 离线</span>`;
    }
  } catch {
    $("sam3-status").innerHTML = `<span style="color:#f87171">● SAM3 离线</span>`;
  }
}

sam3PollStatus();
setInterval(sam3PollStatus, 5000);
