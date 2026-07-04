/* ===== OCR 自动标注控制台 - 前端逻辑 ===== */

// ---- 全局状态 ----
let pollTimer = null;
let dashChart = null;
let dashTableMode = "pre";      // pre | review
let dashData = { pre: [], review: [], corrected: [], counts: {}, summary: {}, inputDir: "" };
let dashPage = 1;
let corrState = { output: "", page: 1, pages: 1, items: [], correctedFiles: new Set(), inputDir: "" };

// ---- 工具 ----
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
function imgUrl(absPath) { return `/api/image?path=${encodeURIComponent(absPath)}`; }
function joinPath(dir, rel) { return dir.replace(/[\\/]+$/, "") + "\\" + rel.replace(/^[\\/]+/, ""); }

function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("toast-container").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 300); }, 3000);
}

function openModal(src) {
  const root = $("modal-root");
  root.innerHTML = `<div class="modal" onclick="this.remove()"><img src="${esc(src)}"></div>`;
}

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

// ---- 模块/标签切换 ----
function enterModule(mod) {
  $("page-gate").classList.add("hidden");
  $("main-header").classList.remove("hidden");
  $("module-ocr").classList.add("hidden");
  $("module-sam").classList.add("hidden");
  $("module-detect").classList.add("hidden");
  if (mod === "ocr") {
    $("module-ocr").classList.remove("hidden");
    $("header-title").textContent = "AutoLabel AI — OCR 标注";
    $("header-subtitle").textContent = "批量图片文字识别与标注";
    $("header-icon").innerHTML = '<i class="fa fa-font"></i>';
    showOcrTab("dataset");
  } else if (mod === "sam") {
    $("module-sam").classList.remove("hidden");
    $("header-title").textContent = "AutoLabel AI — 分割标注";
    $("header-subtitle").textContent = "SAM3 智能分割 + 手动标注";
    $("header-icon").innerHTML = '<i class="fa fa-object-group"></i>';
  } else if (mod === "detect") {
    $("module-detect").classList.remove("hidden");
    $("header-title").textContent = "AutoLabel AI — 目标检测";
    $("header-subtitle").textContent = "LocateAnything 视觉语言检测";
    $("header-icon").innerHTML = '<i class="fa fa-search-plus"></i>';
  }
}

function goToGate() {
  $("page-gate").classList.remove("hidden");
  $("main-header").classList.add("hidden");
  $("module-ocr").classList.add("hidden");
  $("module-sam").classList.add("hidden");
  $("module-detect").classList.add("hidden");
}

function showOcrTab(name) {
  document.querySelectorAll(".ocr-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".ocr-page").forEach(p => p.classList.add("hidden"));
  const el = document.getElementById("ocr-" + name);
  if (el) el.classList.remove("hidden");
}

async function exportResults() {
  const out = $("dash-output")?.value || $("ds-output-path")?.value || "out";
  try {
    const d = await fetchJSON(`/api/export/results?output_dir=${encodeURIComponent(out)}`);
    if (d.error) { toast(d.error, "error"); return; }
    const blob = new Blob([JSON.stringify(d.data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "export_results.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出 ${d.total} 条结果`, "success");
  } catch (e) {
    toast("导出失败: " + e.message, "error");
  }
}

// ============================================================
// 1. 数据集页
// ============================================================
function browseDir(path, target) {
  if (!path) { toast("请先输入路径", "error"); return; }
  fetchJSON(`/api/browse?path=${encodeURIComponent(path)}`).then(d => {
    if (d.error) { toast(d.error, "error"); return; }
    $("ds-breadcrumb").textContent = d.path;
    const box = $("ds-browser");
    if (!d.subdirs.length && d.total_images === 0) {
      box.innerHTML = `<div class="empty-state">该目录无子目录与图片</div>`;
    } else {
      let html = "";
      if (d.total_images > 0) {
        html += `<div class="result-row" style="background:rgba(99,102,241,0.08)">
          <div class="flex-1">
            <div class="text-sm font-medium">当前目录共 ${d.total_images} 张图片（递归）</div>
            <div class="text-xs text-muted text-mono">${esc(d.path)}</div>
          </div>
          <button class="btn-mini" onclick="setPath('${target}','${esc(d.path)}')">设为${target==="input"?"输入":"输出"}</button>
        </div>`;
      }
      d.subdirs.forEach(s => {
        html += `<div class="result-row">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <div class="flex-1">
            <div class="text-sm font-medium">${esc(s.name)}</div>
            <div class="text-xs text-muted">直接图片 ${s.image_count}</div>
          </div>
          <button class="btn-ghost" onclick="browseDir('${esc(s.path)}','${target}')">进入</button>
          <button class="btn-mini" onclick="setPath('${target}','${esc(s.path)}')">设为${target==="input"?"输入":"输出"}</button>
        </div>`;
      });
      box.innerHTML = html;
    }
    if (target === "input") $("ds-input-info").textContent = `递归 ${d.total_images} 张图片`;
  }).catch(e => toast("浏览失败: " + e, "error"));
}

function setPath(target, path) {
  if (target === "input") {
    $("ds-input-path").value = path;
    $("run-input").value = path;
    sessionStorage.setItem("input_dir", path);
    toast("已设为输入目录", "success");
  } else {
    $("ds-output-path").value = path;
    $("run-output").value = path;
    $("dash-output").value = path;
    $("corr-output").value = path;
    sessionStorage.setItem("output_dir", path);
    toast("已设为输出目录", "success");
  }
}

// ============================================================
// 2. 运行控制台
// ============================================================
function startRun() {
  const body = {
    input: $("run-input").value,
    output: $("run-output").value,
    v6_backend: $("run-v6backend").value,
    no_vl: $("run-novl").checked,
    limit: parseInt($("run-limit").value) || null,
    cpu: $("run-cpu").checked,
  };
  $("run-btn").disabled = true;
  $("run-btn").textContent = "运行中...";
  $("run-status").textContent = "启动中...";
  $("run-status").className = "text-sm text-yellow-300";
  $("run-stream").innerHTML = "";
  fetchJSON("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(d => {
      if (!d.ok) {
        toast(d.error || "启动失败", "error");
        $("run-btn").disabled = false;
        $("run-btn").textContent = "开始标注";
        $("run-status").textContent = "失败";
        return;
      }
      toast("任务已启动", "success");
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(pollProgress, 1000);
    })
    .catch(e => {
      toast("请求失败: " + e, "error");
      $("run-btn").disabled = false;
      $("run-btn").textContent = "开始标注";
    });
}

function pollProgress() {
  fetchJSON("/api/progress").then(s => {
    $("run-status").textContent = statusText(s.status);
    $("run-status").className = "text-sm " + statusColor(s.status);
    const pct = s.total ? (s.done / s.total * 100) : 0;
    $("run-progress").style.width = pct + "%";
    $("run-pct").textContent = `${s.done} / ${s.total}`;
    $("run-current").textContent = s.current || "";
    $("run-pre-count").textContent = s.pre_count;
    $("run-review-count").textContent = s.review_count;
    $("run-done-count").textContent = s.done;
    $("gpu-status").textContent = "GPU: " + (s.vl_enabled ? (s.message.includes("CPU") ? "CPU" : "GPU") : "VL关");

    // 渲染最近结果流（追加新增）
    renderStream(s);

    if (s.status === "done") {
      clearInterval(pollTimer); pollTimer = null;
      $("run-btn").disabled = false;
      $("run-btn").textContent = "开始标注";
      toast(`完成：预标注 ${s.pre_count}，待复核 ${s.review_count}`, "success");
      // 同步输出目录到仪表盘/修正页
      $("dash-output").value = s.output_dir || $("run-output").value;
      $("corr-output").value = s.output_dir || $("run-output").value;
      setTimeout(() => { showOcrTab("dashboard"); loadResults($("dash-output").value); }, 1200);
    } else if (s.status === "error") {
      clearInterval(pollTimer); pollTimer = null;
      $("run-btn").disabled = false;
      $("run-btn").textContent = "开始标注";
      toast("运行错误: " + s.message, "error");
    }
  }).catch(() => {});
}

let _streamCount = 0;
function renderStream(s) {
  if (!s.recent || s.recent.length <= _streamCount) return;
  const box = $("run-stream");
  if (_streamCount === 0) box.innerHTML = "";
  const newItems = s.recent.slice(_streamCount);
  _streamCount = s.recent.length;
  newItems.forEach(p => {
    const tagCls = p.tag === "PRE" ? "badge-pre" : p.tag === "REVIEW" ? "badge-review" : "badge-v6only";
    const abs = s.input_dir ? joinPath(s.input_dir, p.rel) : "";
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `
      <span class="text-xs text-muted text-mono" style="min-width:48px">${p.idx}/${p.total}</span>
      <span class="${tagCls}">${p.tag}</span>
      ${abs ? `<img class="thumb" src="${imgUrl(abs)}" onclick="openModal('${imgUrl(abs)}')" onerror="this.style.visibility='hidden'">` : ""}
      <div class="flex-1 min-w-0">
        <div class="text-xs text-muted truncate text-mono">${esc(p.rel)}</div>
        <div class="text-sm truncate">v6=<span class="text-green-300">${esc(p.text_v6)}</span>${p.text_vl !== null ? ` | vl=<span class="text-fuchsia-300">${esc(p.text_vl)}</span>` : ""}</div>
      </div>`;
    box.appendChild(row);
  });
  box.scrollTop = box.scrollHeight;
}

function statusText(s) { return { idle: "空闲", running: "运行中", done: "完成", error: "错误" }[s] || s; }
function statusColor(s) { return { idle: "text-muted", running: "text-yellow-300", done: "text-green-400", error: "text-red-400" }[s] || "text-muted"; }

// ============================================================
// 3. 仪表盘
// ============================================================
function loadResults(output) {
  if (!output) { toast("请输入输出目录", "error"); return; }
  fetchJSON(`/api/results?output=${encodeURIComponent(output)}&type=all&page=${dashPage}&size=50`).then(d => {
    if (d.error) { toast(d.error, "error"); return; }
    dashData.counts = d.counts;
    dashData.summary = d.summary || {};
    dashData.inputDir = d.summary?.input_dir || "";
    dashData.pre = d.pre?.items || [];
    dashData.review = d.review?.items || [];
    dashData.correctedFiles = new Set(d.corrected_files || []);
    renderStats();
    renderChart();
    dashSwitchTable(dashTableMode);
    $("dash-summary-text").textContent = `总数 ${d.summary?.total ?? "-"} | V6: ${d.summary?.v6_backend ?? "-"} | VL: ${d.summary?.vl_enabled ? "开" : "关"}`;
  }).catch(e => toast("加载失败: " + e, "error"));
}

function renderStats() {
  const c = dashData.counts;
  $("stat-total").textContent = c.pre + c.review ?? "-";
  $("stat-pre").textContent = c.pre ?? "-";
  $("stat-review").textContent = c.review ?? "-";
  $("stat-corrected").textContent = c.corrected ?? "-";
}

function renderChart() {
  const ctx = $("dash-chart");
  if (!ctx) return;
  const c = dashData.counts;
  if (dashChart) dashChart.destroy();
  dashChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["预标注", "待复核"],
      datasets: [{
        data: [c.pre || 0, c.review || 0],
        backgroundColor: ["rgba(34, 197, 94, 0.7)", "rgba(249, 115, 22, 0.7)"],
        borderColor: ["rgba(34, 197, 94, 0.9)", "rgba(249, 115, 22, 0.9)"],
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cbd5e1" } } },
    },
  });
}

function dashSwitchTable(mode) {
  dashTableMode = mode;
  $("dash-tab-pre").style.opacity = mode === "pre" ? "1" : "0.5";
  $("dash-tab-review").style.opacity = mode === "review" ? "1" : "0.5";
  const rows = mode === "pre" ? dashData.pre : dashData.review;
  const box = $("dash-table");
  if (!rows.length) { box.innerHTML = `<div class="empty-state">无数据</div>`; $("dash-pager").innerHTML = ""; return; }
  box.innerHTML = rows.map(r => {
    const abs = dashData.inputDir ? joinPath(dashData.inputDir, r.filename) : "";
    if (mode === "pre") {
      return `<div class="result-row">
        <img class="thumb" src="${imgUrl(abs)}" onclick="openModal('${imgUrl(abs)}')" onerror="this.style.visibility='hidden'">
        <div class="flex-1 min-w-0">
          <div class="text-xs text-muted truncate text-mono">${esc(r.filename)}</div>
          <div class="text-sm text-green-300 truncate">${esc(r.text)}</div>
        </div></div>`;
    }
    return `<div class="result-row">
      <img class="thumb" src="${imgUrl(abs)}" onclick="openModal('${imgUrl(abs)}')" onerror="this.style.visibility='hidden'">
      <div class="flex-1 min-w-0">
        <div class="text-xs text-muted truncate text-mono">${esc(r.filename)}</div>
        <div class="text-sm truncate">v6=<span class="text-green-300">${esc(r.text_v6)}</span> | vl=<span class="text-fuchsia-300">${esc(r.text_vl)}</span></div>
      </div></div>`;
  }).join("");
  $("dash-pager").innerHTML = "";
}

// ============================================================
// 4. 人工修正
// ============================================================
function loadReview(output, page) {
  if (!output) { toast("请输入输出目录", "error"); return; }
  corrState.output = output; corrState.page = page;
  fetchJSON(`/api/results?output=${encodeURIComponent(output)}&type=review&page=${page}&size=10`).then(d => {
    if (d.error) { toast(d.error, "error"); return; }
    corrState.items = d.review?.items || [];
    corrState.pages = d.review?.pages || 1;
    corrState.correctedFiles = new Set(d.corrected_files || []);
    corrState.inputDir = d.summary?.input_dir || "";
    renderReview();
    $("corr-info").textContent = `待复核 ${d.counts.review} | 已修正 ${d.counts.corrected} | 剩余 ${d.counts.review_remaining}`;
  }).catch(e => toast("加载失败: " + e, "error"));
}

function renderReview() {
  const box = $("corr-list");
  if (!corrState.items.length) { box.innerHTML = `<div class="empty-state">无待复核项</div>`; $("corr-pager").innerHTML = ""; return; }
  box.innerHTML = corrState.items.map((r, i) => {
    const abs = corrState.inputDir ? joinPath(corrState.inputDir, r.filename) : "";
    const done = corrState.correctedFiles.has(r.filename);
    return `<div class="glass-card correct-card ${done ? "opacity-50" : ""}" data-idx="${i}">
      <!-- 左：大图 -->
      <div class="img-col">
        <img class="thumb-xl" src="${imgUrl(abs)}" onclick="openModal('${imgUrl(abs)}')" onerror="this.style.visibility='hidden'" title="点击放大">
        <div class="img-caption">${esc(r.filename)}</div>
        ${done ? '<span class="badge-pre" style="margin-top:.3rem">✓ 已修正</span>' : '<span class="badge-review" style="margin-top:.3rem">待复核</span>'}
      </div>
      <!-- 右：V6 / VL 对比 + 手填 -->
      <div class="col">
        <div class="result-row-2">
          <div class="result-box v6">
            <div class="result-label">PPOCR-V6 结果</div>
            <div class="result-text green">${esc(r.text_v6)}</div>
            <button class="btn-mini" onclick="adoptText(${i},'v6')" ${done?"disabled":""}>采纳 V6</button>
          </div>
          <div class="result-box vl">
            <div class="result-label">PPOCR-VL 结果</div>
            <div class="result-text fuchsia">${esc(r.text_vl)}</div>
            <button class="btn-mini" onclick="adoptText(${i},'vl')" ${done?"disabled":""}>采纳 VL</button>
          </div>
        </div>
        <div style="display:flex;gap:.6rem;align-items:center;padding-top:.6rem;border-top:1px solid var(--glass-border)">
          <input class="input" id="corr-input-${i}" placeholder="点击「采纳 V6」或「采纳 VL」，或手动输入正确结果" value="${esc(r.text_v6)}">
          <button class="btn-gradient" onclick="saveCorrection(${i})" ${done?"disabled":""}>保存修正</button>
        </div>
        <div class="text-xs text-muted" style="text-align:right">
          快捷键：1=采纳V6 &nbsp; 2=采纳VL &nbsp; Enter=保存 &nbsp; J/K=翻页
        </div>
      </div>
    </div>`;
  }).join("");
  // 分页
  const pg = $("corr-pager");
  pg.innerHTML = "";
  if (corrState.pages > 1) {
    const prev = document.createElement("button");
    prev.className = "btn-ghost"; prev.textContent = "‹ 上一页"; prev.disabled = corrState.page <= 1;
    prev.onclick = () => loadReview(corrState.output, corrState.page - 1);
    pg.appendChild(prev);
    const info = document.createElement("span");
    info.className = "text-sm text-muted"; info.textContent = `${corrState.page} / ${corrState.pages}`;
    pg.appendChild(info);
    const next = document.createElement("button");
    next.className = "btn-ghost"; next.textContent = "下一页 ›"; next.disabled = corrState.page >= corrState.pages;
    next.onclick = () => loadReview(corrState.output, corrState.page + 1);
    pg.appendChild(next);
  }
}

function adoptText(idx, which) {
  const r = corrState.items[idx];
  if (!r) return;
  $("corr-input-" + idx).value = which === "v6" ? r.text_v6 : r.text_vl;
  $("corr-input-" + idx).focus();
}

function saveCorrection(idx) {
  const r = corrState.items[idx];
  if (!r) return;
  const text = $("corr-input-" + idx).value;
  if (!text.trim()) { toast("文本不能为空", "error"); return; }
  fetchJSON("/api/correct", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ output: corrState.output, filename: r.filename, text: text })
  }).then(d => {
    if (d.ok) {
      toast("已保存修正", "success");
      corrState.correctedFiles.add(r.filename);
      renderReview();
    } else toast(d.error || "保存失败", "error");
  }).catch(e => toast("保存失败: " + e, "error"));
}

// ---- 键盘快捷（修正页）----
let _corrActiveIdx = 0;
document.addEventListener("keydown", e => {
  if ($("ocr-correct").classList.contains("hidden")) return;
  if (e.target.tagName === "INPUT" && e.key !== "Enter") return;
  if (e.key === "j" || e.key === "J") {
    if (corrState.page < corrState.pages) loadReview(corrState.output, corrState.page + 1);
  } else if (e.key === "k" || e.key === "K") {
    if (corrState.page > 1) loadReview(corrState.output, corrState.page - 1);
  } else if (e.key === "1") {
    e.preventDefault();
    if (corrState.items[_corrActiveIdx]) adoptText(_corrActiveIdx, "v6");
  } else if (e.key === "2") {
    e.preventDefault();
    if (corrState.items[_corrActiveIdx]) adoptText(_corrActiveIdx, "vl");
  } else if (e.key === "Enter" && e.target.tagName !== "INPUT") {
    e.preventDefault();
    if (corrState.items[_corrActiveIdx]) saveCorrection(_corrActiveIdx);
  }
});

// ---- 初始化：恢复 sessionStorage ----
(function init() {
  const si = sessionStorage.getItem("input_dir");
  const so = sessionStorage.getItem("output_dir");
  if (si) { $("ds-input-path").value = si; $("run-input").value = si; }
  if (so) { $("ds-output-path").value = so; $("run-output").value = so; $("dash-output").value = so; $("corr-output").value = so; }
})();
