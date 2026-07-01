# GPU 加速 VL + 可视化页面 实施计划（更新版）

## Context（背景与动机）

当前双引擎 OCR 自动标注程序（PPOCR-V6 + PPOCR-VL）已用 Python 实现并跑通，但存在两个问题：

1. **VL 太慢**：llama-cpp-python 当前是 CPU 编译版（`llama_supports_gpu_offload()` 返回 False），每图 ~8s。完整 696 张约需 1.5h。
2. **无可视化界面**：目前只有 CLI，无法浏览结果、人工复核、或从页面启动任务。

用户要求：① 用 GPU 跑 PPOCR-VL；② 做一个"高端大气"的可视化页面，含数据集加载、实时运行控制台、结果仪表盘、交互式人工修正。

环境探查结论（本次重新确认）：
- GPU = RTX 4070 12GB；**驱动 596.36（支持 CUDA 13.2）**；安装的 toolkit = **CUDA 12.4**（nvcc V12.4.99）。
- **MSVC 仅 14.51.36231**（CUDA 12.4 不兼容，nvcc 崩溃 0xc0000005）；无 14.39 工具集。
- **VS Installer 已不再运行**（之前阻塞安装的 singleton 锁已释放，可立即重试 modify）。
- **预编译 CUDA wheel 不可用**：abetlen 官方 CUDA wheel 只到 v0.3.4 且无 cp313（仅 cp310/311/312），当前是 Python 3.13.12 + llama-cpp-python 0.3.32。
- V6 在 CPU 上仅 ~70ms，不是瓶颈 → **V6 保持 CPU 不动**，只加速 VL。
- **flask 未安装**；requirements.txt 缺 flask。

## 当前进度（截至本次规划）

| 项 | 状态 | 说明 |
|----|------|------|
| [autolable/annotator.py](file:///c:/Users/BTW/Desktop/autolable/autolable/annotator.py) B1 重构 | ✅ 已完成 | progress_cb 回调已加，向后兼容 CLI |
| [web/runner.py](file:///c:/Users/BTW/Desktop/autolable/web/runner.py) B3 后台运行器 | ✅ 已完成 | JobRunner 单例，start/progress/_on_progress |
| [web/app.py](file:///c:/Users/BTW/Desktop/autolable/web/app.py) B4 Flask 路由 | ✅ 已完成 | 7 路由：/、browse、run、progress、results、image、correct |
| [web/\_\_init\_\_.py](file:///c:/Users/BTW/Desktop/autolable/web/__init__.py) | ✅ 已完成 | 空包标识 |
| run_web.py 入口 B6 | ❌ 未创建 | |
| requirements.txt 加 flask B7 | ❌ 未做 | flask 也未 pip install |
| web/static/ 前端 B5 | ❌ 未创建 | index.html + app.js + styles.css |
| Web UI 烟测 | ❌ 未做 | |
| MSVC 14.39 工具集安装 A1 | ❌ 未做 | 锁已释放，可立即重试 |
| llama-cpp-python GPU 编译 A2 | ❌ 未做 | 依赖 A1 |
| GPU offload 验证 A3 | ❌ 未做 | 依赖 A2 |

---

## 工作线 A：GPU 加速 PPOCR-VL（剩余）

### A1. 安装 MSVC 14.39 工具集

VS Installer 锁已释放，直接执行 modify（需提权，注意路径拼写是 Stid**i**o）：
```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify --installPath "D:\Visiual Stidio\community" --add Microsoft.VisualStudio.Component.VC.14.39.17.9.x86.x64 --quiet --norestart
```
- **不加 `--wait`**（上次 exit 87 就是它导致的未知选项）。
- 静默安装需 1-3 分钟，期间不要开 VS Installer GUI。
- 验证：`Get-ChildItem "D:\Visiual Stidio\community\VC\Tools\MSVC"` 应出现 `14.39` 目录。
- 若仍失败 → 提示用户在 VS Installer GUI 手动勾选"MSVC v143 - VS 2022 C++ x64/x86 生成工具 (v14.39-17.9)"。

### A2. 源码编译 llama-cpp-python 0.3.32 带 CUDA

CUDA 12.4 官方支持 MSVC 19.39（=14.39），此组合是已知兼容配置。步骤：

1. 准备构建环境（PowerShell，单条命令链）：
   ```powershell
   $env:TEMP = "C:\t"                                    # 缩短路径（避免超 260 字符崩溃）
   pip install ninja                                      # Ninja 生成器
   & "D:\Visiual Stidio\community\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64
   & "D:\Visiual Stidio\community\VC\Auxiliary\Build\vcvarsall.bat" 14.39 amd64
   cl 2>&1 | Select-String "Microsoft.*14\.39"            # 确认 cl 是 14.39
   nvcc --version                                         # 确认仍是 CUDA 12.4
   ```
2. 设编译参数并重建：
   ```powershell
   $env:CMAKE_ARGS = "-DGGML_CUDA=on"
   $env:CMAKE_GENERATOR = "Ninja"
   pip install llama-cpp-python --force-reinstall --no-binary :all:
   ```
3. 若编译报错，按错误信息调试（常见：CUDA 工具集未找到→确认 vcvarsall 锁定 14.39；路径超长→TEMP 已设 C:\t）。

### A3. 验证 GPU offload

```powershell
python -c "from llama_cpp import llama_supports_gpu_offload; print('gpu_offload:', llama_supports_gpu_offload())"
# 期望: gpu_offload: True
```
然后跑限量 VL：
```powershell
python run.py --input C:\Users\BTW\Desktop\20260328new --output out --limit 5
```
同时另一窗口 `nvidia-smi` 应见 python 进程占显存；VL 单图应从 ~8s 降到 <2s。

### A4. 回退方案（仅当 A2 编译仍失败）

用户已预授权回退。新建 py3.12 conda 环境，用预编译 cu124 wheel（仅 v0.3.4 旧版）：
```powershell
conda create -n autolable312 python=3.12 -y
conda activate autolable312
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124/
# 在新环境重装 paddleocr/rapidocr/opencv/numpy/pillow/flask 等
```
风险：0.3.4 的 `MTMDChatHandler` API 可能与 0.3.32 有差异，需适配 [ppocr_vl.py](file:///c:/Users/BTW/Desktop/autolable/autolable/engines/ppocr_vl.py)。优先尝试 A2。

---

## 工作线 B：可视化页面（剩余）

### 设计语言（高端大气）

深色主题 + 渐变（indigo→purple→fuchsia）+ 玻璃拟态卡片（backdrop-blur、半透明、柔光边框）+ 圆角大阴影 + 响应式网格。Tailwind CSS（CDN）+ Chart.js（CDN，统计图）+ 原生 JS（fetch API 调用，无构建步骤）。图标用内联 SVG。

### B6. 创建 run_web.py 入口

在项目根目录创建 [run_web.py](file:///c:/Users/BTW/Desktop/autolable/run_web.py)：
```python
"""Web UI entry: python run_web.py [--host 127.0.0.1 --port 8000]"""
from web.app import create_app

app = create_app()

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    a = p.parse_args()
    app.run(host=a.host, port=a.port, debug=False, threaded=True)
```

### B7. 更新 requirements.txt + 安装 flask

在 [requirements.txt](file:///c:/Users/BTW/Desktop/autolable/requirements.txt) 末尾追加：
```
# Web UI
flask
```
然后 `pip install flask`。

### B5. 前端 SPA（web/static/index.html + app.js + styles.css）

创建 `web/static/` 目录，放三个文件。单页四个标签页（顶部导航，渐变高亮当前页）。

#### B5.1 web/static/index.html

结构：
```html
<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OCR 自动标注控制台</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <!-- 渐变背景层 -->
  <div class="fixed inset-0 -z-10 bg-gradient"></div>

  <!-- 顶部导航 -->
  <nav class="glass-nav">
    <div class="brand">OCR 自动标注</div>
    <div class="tabs">
      <button data-tab="dataset" class="tab active">数据集</button>
      <button data-tab="run" class="tab">运行控制台</button>
      <button data-tab="dashboard" class="tab">仪表盘</button>
      <button data-tab="correct" class="tab">人工修正</button>
    </div>
  </nav>

  <main>
    <!-- 1. 数据集页 -->
    <section id="page-dataset" class="page">
      <!-- 路径输入 + 浏览 → 子目录树 + 图片数；选定 input/output -->
    </section>

    <!-- 2. 运行控制台 -->
    <section id="page-run" class="page hidden">
      <!-- 选项 + 开始按钮 → 进度条 + 实时结果流 -->
    </section>

    <!-- 3. 仪表盘 -->
    <section id="page-dashboard" class="page hidden">
      <!-- 统计卡 + 环形图 + 结果表 -->
    </section>

    <!-- 4. 人工修正 -->
    <section id="page-correct" class="page hidden">
      <!-- needs_review 列表，三栏对比 + 保存 -->
    </section>
  </main>

  <div id="toast-container"></div>
  <script src="/static/app.js"></script>
</body>
</html>
```

#### B5.2 四个标签页详细规范

**① 数据集页**：
- 两个路径选择器：输入目录（默认 `C:\Users\BTW\Desktop\20260328new`）、输出目录（默认 `out`）。
- "浏览"按钮 → `GET /api/browse?path=` → 展示子目录列表（每行：文件夹名 + 直接图片数 + 递归总数），点击文件夹进入下一层。
- 选定 input 目录后显示"共 N 张图片（递归）"。
- 两个"设为输入/输出"按钮锁定选择。
- 状态持久化到 sessionStorage，切标签不丢。

**② 运行控制台**：
- 选项区：v6-backend 下拉（paddleocr/rapidocr）、no-vl 复选框、limit 数字输入、cpu 复选框。
- "开始标注"渐变大按钮 → `POST /api/run`。
- 运行后每 1s 轮询 `GET /api/progress`：
  - 顶部进度条（done/total，百分比 + 当前文件名）。
  - 统计小卡：预标注数（绿）、待复核数（橙）。
  - 实时结果流：滚动列表，每行 `[idx/total] [TAG] filename: v6=... vl=...`，PRE 绿标签/REVIEW 橙标签。
  - 状态：idle/running/done/error，error 时显示 message。
- 完成后 toast 提示 + 自动切到仪表盘。

**③ 仪表盘**：
- 顶部 4 张统计卡（渐变图标）：总数、预标注、待复核、已修正。
- Chart.js 环形图：pre vs review 占比。
- 两张结果表（可切换/分页）：
  - 预标注表：缩略图 + filename + text。
  - 待复核表：缩略图 + filename + text_v6 + text_vl。
- 缩略图通过 `/api/image?path=<abs>` 加载，点击行展开大图 modal。
- 顶部"加载结果"按钮 + output 目录输入（默认 `out`）。

**④ 人工修正**：
- 从 output 目录读 needs_review（分页，每页 10 条）。
- 每条三栏布局：
  - 左：缩略图（可点击放大）。
  - 中：V6 文本 + "采纳 V6"按钮。
  - 右：VL 文本 + "采纳 VL"按钮。
  - 底：手填输入框（采纳后自动填入）+ "保存修正"按钮。
- 保存 → `POST /api/correct` → 该行标记已完成（绿色勾），计数 +1。
- 已修正的条目灰显但仍可见，便于回查。
- 键盘快捷：J/K 翻页、1 采纳 V6、2 采纳 VL、Enter 保存。

#### B5.3 web/static/app.js

纯原生 JS，无框架。模块化函数：
- `showTab(name)`：切换标签页，更新 active 状态。
- `browseDir(path)`：fetch /api/browse，渲染子目录树。
- `selectInput(path)` / `selectOutput(path)`：更新 sessionStorage + UI。
- `startRun()`：收集选项 → POST /api/run → 启动轮询。
- `pollProgress()`：setInterval 1s → GET /api/progress → 更新进度条/结果流；done 时停轮询 + showTab('dashboard')。
- `loadResults(output)`：GET /api/results?output= → 渲染统计卡 + Chart.js + 表格。
- `loadReview(output, page)`：GET /api/results?output=&type=review&page= → 渲染修正列表。
- `adoptV6(item)` / `adoptVL(item)`：填入手填框。
- `saveCorrection(item)`：POST /api/correct → 标记完成。
- `toast(msg, type)`：右下角 toast（success/error/info），3s 自动消失。
- `imgUrl(absPath)`：返回 `/api/image?path=${encodeURIComponent(absPath)}`。

#### B5.4 web/static/styles.css

自定义样式（Tailwind 经 CDN 处理大部分，这里补充玻璃拟态等特效）：
- `body`：min-h-screen，深色背景 `#0a0a0f`。
- `.bg-gradient`：固定全屏渐变 `linear-gradient(135deg, #1e1b4b 0%, #4c1d95 50%, #831843 100%)`，带微妙噪点。
- `.glass-nav`：`backdrop-filter: blur(20px)`，半透明 `rgba(255,255,255,0.05)`，底部柔光边框。
- `.glass-card`：玻璃拟态卡片，`backdrop-filter: blur(12px)`，`background: rgba(255,255,255,0.04)`，`border: 1px solid rgba(255,255,255,0.08)`，`border-radius: 16px`，大阴影。
- `.tab`：默认半透明；`.tab.active`：渐变文字 `bg-clip-text`（indigo→fuchsia），底部渐变下划线。
- `.btn-gradient`：`background: linear-gradient(135deg, #6366f1, #a855f7, #d946ef)`，hover 微亮，圆角，白字。
- `.badge-pre`：绿色徽章 `rgba(34,197,94,0.15)` + 绿字。
- `.badge-review`：橙色徽章 `rgba(249,115,22,0.15)` + 橙字。
- `.progress-bar`：渐变填充 `linear-gradient(90deg, #6366f1, #d946ef)`，圆角，过渡动画。
- 自定义滚动条（细，半透明）。
- `@keyframes fadeIn`：结果流新行动画。
- `@keyframes pulse`：运行中按钮脉冲。

### B8. Web UI 烟测

```powershell
pip install flask
python run_web.py
```
浏览器开 `http://127.0.0.1:8000`：
1. 数据集页能浏览 `C:\Users\BTW\Desktop\20260328new` 并显示图片数。
2. 运行控制台选目录 + `--no-vl` + limit 3 启动，进度条与结果流正常更新。
3. 仪表盘加载 `out` 目录，统计卡 + 环形图 + 表格数据正确。
4. 人工修正对一条 needs_review 采纳保存 → `corrected.jsonl` 出现该行。

---

## 执行顺序

1. **B6 + B7**：创建 run_web.py + 更新 requirements.txt + `pip install flask`（快速，解锁前端）。
2. **B5**：创建前端三件套（index.html + app.js + styles.css）。
3. **B8**：Web UI 烟测（用 --no-vl 或小 limit，不依赖 GPU）。
4. **A1**：装 MSVC 14.39 工具集（锁已释放，可立即执行）。
5. **A2**：源码编译 llama-cpp-python 带 CUDA。
6. **A3**：验证 GPU offload + 限量 VL 测速。
7. **集成测试**：Web 页面启动真实双引擎任务（GPU VL），观察实时进度 + 仪表盘 + 修正流程。

> B 线（Web）与 A 线（GPU）相互独立。B 线用 `--no-vl` 即可烟测，不等 GPU。优先完成 B 线让用户能用页面，再攻 GPU。

## 验证（端到端）

1. **Web 烟测**：`python run_web.py` → 浏览器四标签页均可交互，--no-vl limit 3 跑通实时进度。
2. **GPU**：`python -c "from llama_cpp import llama_supports_gpu_offload; print(llama_supports_gpu_offload())"` → True；`run.py --limit 5` 时 `nvidia-smi` 见 python 占显存，VL 单图 <2s。
3. **集成**：Web 页面选目录 + limit 10 启动双引擎（GPU VL），进度条/结果流/仪表盘/修正全流程正常。
4. **回归**：CLI `python run.py --input ... --output out --limit 3` 仍正常（progress_cb 默认 None，不影响）。

## 假设与决策

- V6 保持 CPU（够快，paddlepaddle-gpu 无 py3.13 wheel）。
- 单任务模型：Web 一次只跑一个标注任务（JobRunner 单例），够用。
- 前端用 CDN（Tailwind/Chart.js），无构建步骤，部署简单；本地工具可接受联网加载。
- 图片服务做路径白名单校验（`C:\Users\BTW\Desktop` 或 `D:\` 下），防目录穿越。
- corrected.jsonl 复用 jsonl 行格式 `{"filename","text"}`，与 pre_annotated 同构，便于合并。
- GPU 回退：A2 编译失败则按用户预授权建 py3.12 环境用预编译 cu124 wheel（v0.3.4），需适配 ppocr_vl.py API。
