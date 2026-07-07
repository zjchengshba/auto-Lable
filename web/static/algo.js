/* ===== 算法管理前端逻辑 ===== */
let algoPollTimer = null;
let algoCurrentSelected = "";

function algoSelect(id) {
  algoCurrentSelected = id;
  // 高亮选中项
  document.querySelectorAll(".algo-item").forEach(el => {
    el.classList.remove("ring-2", "ring-yellow-400/50");
    el.style.borderColor = "";
  });
  const item = document.getElementById("algo-item-" + id);
  if (item) {
    item.classList.add("ring-2", "ring-yellow-400/50");
    item.style.borderColor = "rgba(250,204,21,0.5)";
  }
}

async function algoLoadModels() {
  try {
    const d = await fetchJSON("/api/algo/models");
    if (d.ok && d.models) {
      const renderModel = (m) => `
        <div class="result-row">
          <div class="text-2xl text-yellow-400 mr-2"><i class="fa fa-cube"></i></div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium">${esc(m.name)}</div>
            <div class="text-xs text-muted text-mono truncate">${esc(m.path)}</div>
          </div>
          <span class="text-xs text-muted whitespace-nowrap">${m.size_mb} MB</span>
        </div>`;
      // 主面板
      const box = $("algo-models");
      if (box) {
        box.innerHTML = d.models.length ? d.models.map(renderModel).join("") : '<div class="empty-state">暂无已训练模型</div>';
      }
      // 侧边栏
      const sidebar = $("algo-models-sidebar");
      if (sidebar) {
        sidebar.innerHTML = d.models.length ? d.models.map(m => `
          <div class="flex items-center gap-2 px-2 py-1.5 rounded bg-yellow-400/5 border border-yellow-400/10 text-xs">
            <i class="fa fa-cube text-yellow-400/70"></i>
            <span class="flex-1 truncate text-gray-300">${esc(m.name)}</span>
            <span class="text-gray-600">${m.size_mb}MB</span>
          </div>`).join("") : '<div class="text-xs text-gray-600 text-center py-2">暂无</div>';
      }
    }
  } catch (e) { toast("加载模型失败: " + e.message, "error"); }
}

async function algoTrain() {
  const data_dir = $("algo-data-dir").value.trim();
  const epochs = parseInt($("algo-epochs").value) || 100;
  const imgsz = parseInt($("algo-imgsz").value) || 640;
  const batch = parseInt($("algo-batch").value) || 8;
  if (!data_dir) { toast("请输入数据目录", "error"); return; }

  $("algo-train-btn").disabled = true;
  $("algo-train-btn").innerHTML = '<i class="fa fa-cog fa-spin mr-1"></i>训练中...';
  $("algo-progress-wrap").classList.remove("hidden");
  $("algo-log").classList.remove("hidden");
  $("algo-log").innerHTML = "";
  $("algo-train-status").textContent = "启动中...";

  try {
    const d = await fetchJSON("/api/algo/rotated/train", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data_dir, epochs, imgsz, batch })
    });
    if (!d.ok) {
      toast(d.message || d.error || "启动训练失败", "error");
      $("algo-train-btn").disabled = false;
      $("algo-train-btn").innerHTML = '<i class="fa fa-play mr-1"></i>开始训练';
      $("algo-train-status").textContent = "失败";
      return;
    }
    toast("训练已启动（后台线程运行，不阻塞标注）", "success");
    if (algoPollTimer) clearInterval(algoPollTimer);
    algoPollTimer = setInterval(algoPollStatus, 1000);
  } catch (e) {
    toast("请求失败: " + e.message, "error");
    $("algo-train-btn").disabled = false;
    $("algo-train-btn").innerHTML = '<i class="fa fa-play mr-1"></i>开始训练';
    $("algo-train-status").textContent = "失败";
  }
}

async function algoPollStatus() {
  try {
    const d = await fetchJSON("/api/algo/rotated/train_status");
    if (!d.ok) return;
    const pct = d.total_epochs ? (d.epoch / d.total_epochs * 100) : (d.progress || 0);
    $("algo-progress-bar").style.width = pct + "%";
    $("algo-progress-text").textContent = `${d.epoch} / ${d.total_epochs}`;
    $("algo-progress-loss").textContent = d.loss ? `loss: ${d.loss}` : "";
    $("algo-train-status").textContent = d.running ? "训练中" : (d.error ? "错误" : "完成");
    if (d.log && d.log.length) {
      $("algo-log").innerHTML = d.log.slice(-100).map(l => `<div>${esc(l)}</div>`).join("");
      $("algo-log").scrollTop = $("algo-log").scrollHeight;
    }
    if (!d.running) {
      clearInterval(algoPollTimer); algoPollTimer = null;
      $("algo-train-btn").disabled = false;
      $("algo-train-btn").innerHTML = '<i class="fa fa-play mr-1"></i>开始训练';
      if (d.error) toast("训练失败: " + d.error, "error");
      else { toast("训练完成，模型已保存", "success"); algoLoadModels(); }
    }
  } catch (e) {}
}

// 进入算法页面时默认选中第一个
document.addEventListener("DOMContentLoaded", () => {
  // 延迟执行，等 app.js 加载完
  setTimeout(() => { algoSelect("rotated_yolov8_obb"); }, 100);
});
