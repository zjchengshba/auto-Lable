# Auto-Label 自动标注平台

一个可扩展的自动标注平台，集成 OCR 识别、SAM3 分割、手动标注等功能。通过 Web 界面操作，支持批量处理和逐张精标注。

## 功能模块

### 1. OCR 双引擎自动标注
- **PPOCR-V6**（paddleocr / rapidocr 后端可选）：快速识别
- **PPOCR-VL**（llama-cpp-python，GPU 加速）：多模态校验
- 两引擎一致 → 自动预标注；不一致 → 送入人工复核

### 2. 标注工具（SAM3 辅助 + 手动标注）
- **SAM3 辅助分割**：正样本点、负样本点、画框、文字提示
- **手动标注**：多边形、圆形
- **多目标**：一张图标注多个目标，逐个保存
- **Ctrl+滚轮缩放**：放大便于精细操作
- **文件浏览器**：打开文件夹，逐一标注
- **标注保存**：JSON 格式，每张图一个文件

## 环境要求

| 项 | 要求 |
|---|---|
| OS | Windows 10/11 |
| Python | 3.13（主服务） |
| Python | 3.12 + PyTorch 2.12 + CUDA 12.6（SAM3 服务，可选） |
| GPU | NVIDIA RTX 40 系以上（建议 8GB+ 显存） |
| CUDA Toolkit | 12.4（VL 编译用） |
| 磁盘 | 模型文件约 5 GB（OCR）+ 3.2 GB（SAM3） |

## 快速开始

### 1. 安装主服务依赖

```bash
pip install -r requirements.txt
```

### 2. 模型文件

模型已放在项目 `models/` 目录下，使用相对路径，无需额外配置：

```
models/
├── ppocr-v6-rec/              # PPOCR-V6 识别模型（~21MB）
│   ├── inference.pdmodel
│   ├── inference.pdiparams
│   └── inference.yml
└── ppocr-vl/                  # PPOCR-VL 大模型（~1.7GB）
    ├── PaddleOCR-VL-1.5-GGUF.gguf
    └── PaddleOCR-VL-1.5-GGUF-mmproj.gguf
```

SAM3 模型 checkpoint 需单独下载（约 3.2GB），放在 `F:\SAM3\sam3-main\sam3.pt`，或修改 `run_sam3.py` 中的 `CKPT_PATH`。

### 3. 启动 Web 界面

```bash
python run_web.py
```

浏览器打开 http://127.0.0.1:8000

### 4. 启动 SAM3 分割服务（可选）

如需使用标注工具中的 SAM3 辅助分割功能：

```bash
# 在 sam3 conda 环境中运行
D:\miniconda\envs\sam3\python.exe run_sam3.py
```

模型加载约 30 秒，启动后监听 :8001。Web 界面会自动检测 SAM3 服务是否在线。

## Web 界面

五个标签页：

1. **数据集**：选输入/输出目录，浏览子目录和图片数
2. **运行控制台**：选参数 → 开始 OCR 标注 → 看实时进度和结果流
3. **仪表盘**：统计卡、环形图、预标注表、待复核表
4. **人工修正**：左图 + V6/VL 左右对比，一键采纳或手填后保存
5. **标注工具**：SAM3 辅助 + 手动标注，多目标保存

### 标注工具快捷键

| 键 | 功能 |
|---|---|
| `1` | 正样本点 |
| `2` | 负样本点 |
| `3` / `B` | 画框 |
| `4` / `P` | 多边形 |
| `5` / `C` | 圆形 |
| `Enter` | 完成当前标注 |
| `R` | 清除提示 |
| `←` / `→` | 上一张 / 下一张 |
| `Ctrl+滚轮` | 缩放 |
| `中键拖拽` | 平移 |

### 人工修正快捷键

| 键 | 功能 |
|---|---|
| `1` | 采纳 V6 结果 |
| `2` | 采纳 VL 结果 |
| `Enter` | 保存修正 |
| `J` / `K` | 下一页 / 上一页 |

## 命令行使用

```bash
# 完整双引擎
python run.py --input C:\dataset\images --output out

# 只跑 V6（调试用）
python run.py --input C:\dataset\images --output out --no-vl

# 限量测试
python run.py --input C:\dataset\images --output out --limit 20

# 用 rapidocr 后端
python run.py --input C:\dataset\images --output out --v6-backend rapidocr

# 强制 CPU
python run.py --input C:\dataset\images --output out --cpu
```

## 输出文件

### OCR 标注输出

| 文件 | 说明 |
|---|---|
| `summary.json` | 总览：总数、预标注数、待复核数 |
| `pre_annotated.jsonl` | 自动预标注（两引擎一致） |
| `needs_review.jsonl` | 待人工复核（两引擎不一致） |
| `v6_only.jsonl` | 仅 V6 模式的输出 |
| `corrected.jsonl` | 人工修正结果 |

### 分割标注输出

保存在 `annotations_out/annotations/` 目录下，每张图一个 JSON 文件：

```json
{
  "image_name": "example.png",
  "annotations": [
    {"id": 1, "type": "polygon", "label": "text", "data": {"points": [[100,100],[200,100],[200,200]]}},
    {"id": 2, "type": "circle", "label": "logo", "data": {"center": [300,300], "radius": 50}},
    {"id": 3, "type": "mask", "label": "object", "data": {"overlay": "base64_png..."}}
  ]
}
```

## 架构

```
autolable/
├── autolable/
│   ├── annotator.py          # 双引擎标注主逻辑
│   ├── cli.py                # CLI 入口参数解析
│   ├── config.py             # 配置（模型相对路径）
│   ├── text_utils.py         # 文本清洗、归一化比较
│   └── engines/
│       ├── base.py           # OCREngine 抽象基类
│       ├── ppocr_v6.py       # V6 后端：paddleocr + rapidocr
│       └── ppocr_vl.py       # VL 后端：llama-cpp-python
├── models/                   # 本地模型文件
│   ├── ppocr-v6-rec/
│   └── ppocr-vl/
├── web/
│   ├── app.py                # Flask 路由（OCR + SAM3 代理 + 标注 API）
│   ├── runner.py             # 后台任务运行器
│   ├── sam3_proxy.py         # SAM3 服务代理封装
│   └── static/
│       ├── index.html        # SPA 单页（5 个标签页）
│       ├── app.js            # OCR 相关前端逻辑
│       ├── sam3.js           # 标注工具前端逻辑
│       └── styles.css        # 玻璃拟态样式
├── run.py                    # CLI 入口
├── run_web.py                # Web 服务入口（:8000）
└── run_sam3.py               # SAM3 服务入口（:8001，sam3 env 运行）
```

### 双服务架构

```
浏览器 → Flask (:8000, Python 3.13) → SAM3 服务 (:8001, Python 3.12 sam3 env)
```

- Flask 主服务处理 OCR、人工修正、标注工具的所有 API
- SAM3 服务独立运行（PyTorch 2.12 + CUDA 12.6），模型常驻内存
- 两个服务通过 HTTP 通信，Flask 代理转发 SAM3 请求

## GPU 加速 VL（推荐）

默认 `llama-cpp-python` 用 CPU 跑 VL，每张图约 8 秒。GPU 加速后约 1.5 秒/图。

### 前置条件

- CUDA Toolkit 12.4（`nvcc --version` 确认）
- MSVC 14.39 工具集（CUDA 12.4 不兼容 14.50+）
- `ninja`（`pip install ninja`）

### 编译 llama-cpp-python 带 CUDA

```powershell
$env:TEMP = "C:\t"
pip install ninja
cmd /c "`"D:\Visiual Stidio\community\VC\Auxiliary\Build\vcvarsall.bat`" amd64 -vcvars_ver=14.39 && pip install llama-cpp-python --force-reinstall --no-binary :all:"
```

环境变量：
- `CMAKE_ARGS=-DGGML_CUDA=on -DGGML_CUDA_ARCHITECTURES=89`（89 对应 RTX 40 系）
- `CMAKE_GENERATOR=Ninja`

### 验证

```bash
python -c "from llama_cpp import llama_supports_gpu_offload; print(llama_supports_gpu_offload())"
# 输出 True 就是 GPU 版
```

## SAM3 环境配置（可选）

SAM3 需要独立的 conda 环境：

```bash
# 创建环境
conda create -n sam3 python=3.12 -y
conda activate sam3

# 安装 PyTorch 2.12 + CUDA 12.6
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126

# 安装 SAM3（从源码）
cd F:\SAM3\sam3-main
pip install -e .

# 安装 Flask
pip install flask
```

## 常见问题

**Q: VL 初始化报错找不到 GGUF 文件？**
A: 检查 `models/ppocr-vl/` 目录下的两个 GGUF 文件是否存在。

**Q: SAM3 服务离线？**
A: 确认已运行 `D:\miniconda\envs\sam3\python.exe run_sam3.py`，且控制台显示 `SAM3 ready.`。

**Q: GPU 编译失败？**
A: 检查：① MSVC 14.39 装了没；② vcvarsall 用的是 `-vcvars_ver=14.39`；③ CUDA 12.4 的 nvcc 在 PATH 里；④ TEMP 设成短路径。

**Q: 为什么有的结果标 PRE 有的标 REVIEW？**
A: 两引擎结果经过归一化后完全一致 → PRE；否则 REVIEW。

**Q: GPU 显存不够？**
A: SAM3 ≈ 3.4GB + PPOCR-VL 可能逼近 12GB 上限。重 OCR 任务期间可停 SAM3 服务。
