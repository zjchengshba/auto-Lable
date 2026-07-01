# OCR 自动标注工具（PPOCR-V6 + PPOCR-VL 双引擎）

双引擎自动标注 + 可视化 Web 界面。PPOCR-V6 做快速识别，PPOCR-VL 做多模态校验，两者一致则自动预标注，不一致则送入人工复核。

## 功能

- **双引擎识别**：PPOCR-V6（paddleocr / rapidocr 后端可选） + PPOCR-VL（llama-cpp-python，GPU 加速）
- **自动预标注**：两引擎结果一致 → `pre_annotated.jsonl`，可直接当标签用
- **待复核队列**：结果不一致 → `needs_review.jsonl`，人工修正后写入 `corrected.jsonl`
- **Web 可视化界面**（深色玻璃拟态）：
  - 数据集浏览 & 路径选择
  - 实时运行控制台（进度条 + 结果流）
  - 仪表盘（统计卡 + Chart.js 环形图 + 结果表）
  - 人工修正（左图 + V6/VL 左右对比 + 快捷键）

## 环境要求

| 项 | 要求 |
|---|---|
| OS | Windows 10/11 |
| Python | 3.13（3.12 也可用，需重新装依赖） |
| GPU | NVIDIA RTX 40 系以上（建议 8GB 显存以上） |
| CUDA Toolkit | 12.4 |
| 磁盘 | 模型文件约 10 GB |

> 没有 GPU 也能用（强制 CPU），但 VL 每张图慢 4-5 倍。

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

如果安装后跑 VL 报 GPU 相关错，说明 `llama-cpp-python` 是 CPU 版。重装 GPU 版见下面「GPU 加速 VL」一节。

### 2. 确认模型路径

打开 `autolable/config.py`，检查以下路径是否存在：

```python
VL_GGUF    = r"F:\OCRprojrct\Models\PaddleOCR-VL-1.5-GGUF.gguf"
VL_MMPROJ  = r"F:\OCRprojrct\Models\PaddleOCR-VL-1.5-GGUF-mmproj.gguf"
V6_INFERENCE_DIR = r"C:\Users\BTW\Desktop\PaddleOCRSharp-master\PaddleOCRSharp-master\Demo\win_runtime_x64\inference"
```

- VL 的两个 GGUF 文件必须存在（约数 GB）。
- V6 用 paddleocr 后端时，模型会自动下载到 `~/.paddlex/`，无需手动配。
- V6 用 rapidocr 后端时，模型自带，无需额外配置。

### 3. 启动 Web 界面

```bash
python run_web.py
```

浏览器打开 <http://127.0.0.1:8000>

界面四个标签页：

1. **数据集**：选输入/输出目录，浏览子目录和图片数
2. **运行控制台**：选参数 → 开始标注 → 看实时进度和结果流
3. **仪表盘**：看统计、环形图、预标注表、待复核表
4. **人工修正**：左图 + V6/VL 左右对比，一键采纳或手填后保存

### 4. 命令行使用

```bash
# 完整双引擎
python run.py --input C:\dataset\images --output out

# 只跑 V6（调试用）
python run.py --input C:\dataset\images --output out --no-vl

# 限量测试
python run.py --input C:\dataset\images --output out --limit 20

# 用 rapidocr 后端
python run.py --input C:\dataset\images --output out --v6-backend rapidocr

# 强制 CPU（GPU 出问题时）
python run.py --input C:\dataset\images --output out --cpu
```

## 输出文件

输出目录下会生成：

| 文件 | 说明 |
|---|---|
| `summary.json` | 总览：总数、预标注数、待复核数、V6 后端、VL 是否启用 |
| `pre_annotated.jsonl` | 自动预标注（两引擎一致），格式 `{"filename","text"}` |
| `needs_review.jsonl` | 待人工复核（两引擎不一致），格式 `{"filename","text_v6","text_vl"}` |
| `v6_only.jsonl` | 仅 V6 模式的输出（`--no-vl` 时生成） |
| `corrected.jsonl` | 人工修正结果（Web 上保存后追加），格式同 pre_annotated |

`filename` 都是相对于输入目录的路径（正斜杠），可以直接当标签文件用。

## GPU 加速 VL（推荐）

默认 `llama-cpp-python` 用 CPU 跑 VL，每张图约 8 秒。GPU 加速后约 1.5 秒/图。

### 前置条件

- CUDA Toolkit 12.4（`nvcc --version` 确认）
- MSVC 14.39 工具集（CUDA 12.4 不兼容 14.50+）
- `ninja`（`pip install ninja`）

### 安装 MSVC 14.39

打开 VS Installer → 修改 → 单个组件 → 搜索「MSVC v143 - VS 2022 C++ x64/x86 生成工具 (v14.39-17.9)」→ 勾选安装。

或命令行（需提权）：

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
  --installPath "D:\Visiual Stidio\community" `
  --add Microsoft.VisualStudio.Component.VC.14.39.17.9.x86.x64 `
  --quiet --norestart
```

### 编译 llama-cpp-python 带 CUDA

```powershell
$env:TEMP = "C:\t"
pip install ninja
cmd /c "`"D:\Visiual Stidio\community\VC\Auxiliary\Build\vcvarsall.bat`" amd64 -vcvars_ver=14.39 && pip install llama-cpp-python --force-reinstall --no-binary :all:"
```

环境变量：
- `CMAKE_ARGS=-DGGML_CUDA=on -DGGML_CUDA_ARCHITECTURES=89` （89 对应 RTX 40 系）
- `CMAKE_GENERATOR=Ninja`

### 验证

```bash
python -c "from llama_cpp import llama_supports_gpu_offload; print(llama_supports_gpu_offload())"
# 输出 True 就是 GPU 版
```

然后跑限量测试看速度：

```bash
python run.py --input C:\dataset\images --output out --limit 5
```

## 架构

```
autolable/
├── annotator.py          # 双引擎标注主逻辑（含 progress_cb）
├── cli.py                # CLI 入口参数解析
├── config.py             # 配置（模型路径、运行参数）
├── text_utils.py         # 文本清洗、归一化比较
└── engines/
    ├── base.py           # OCREngine 抽象基类
    ├── ppocr_v6.py       # V6 后端：paddleocr + rapidocr
    └── ppocr_vl.py       # VL 后端：llama-cpp-python + MTMDChatHandler

web/
├── app.py                # Flask 路由（7 个 API）
├── runner.py             # 后台任务运行器（单例 + 线程 + 进度状态）
├── __init__.py
└── static/
    ├── index.html        # SPA 单页
    ├── app.js            # 前端逻辑
    └── styles.css        # 玻璃拟态样式

run.py                    # CLI 入口
run_web.py                # Web 入口
```

## 快捷键（人工修正页）

| 键 | 功能 |
|---|---|
| `1` | 采纳 V6 结果 |
| `2` | 采纳 VL 结果 |
| `Enter` | 保存修正 |
| `J` / `K` | 下一页 / 上一页 |

## 常见问题

**Q: VL 初始化报错找不到 GGUF 文件？**
A: 检查 `config.py` 里的 `VL_GGUF` 和 `VL_MMPROJ` 路径对不对。

**Q: 提示 No module named flask？**
A: `pip install flask`，或 `pip install -r requirements.txt` 重装全部依赖。

**Q: GPU 编译失败？**
A: 检查：① MSVC 14.39 装了没；② vcvarsall 用的是 `-vcvars_ver=14.39`；③ CUDA 12.4 的 nvcc 在 PATH 里；④ TEMP 设成短路径（`C:\t`），别用长路径。

**Q: 为什么有的结果标 PRE 有的标 REVIEW？**
A: 两引擎结果经过归一化（去空格、统一大小写、去 LaTeX 特殊符号等）后完全一致 → PRE；否则 REVIEW。
