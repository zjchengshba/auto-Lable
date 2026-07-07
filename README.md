# Auto-Label 自动标注平台

一个可扩展的自动标注平台，集成 OCR 识别、SAM3 分割、LocateAnything 目标检测、旋转目标检测、算法训练五大模块。通过 Web 界面操作，支持批量处理、AI 辅助标注、模型训练与自动标注。

## 功能模块

### 1. OCR 双引擎自动标注
- **PPOCR-V6**（paddleocr / rapidocr 后端可选）：快速识别
- **PPOCR-VL**（llama-cpp-python，GPU 加速）：多模态校验
- 两引擎一致 → 自动预标注；不一致 → 送入人工复核
- 子页面：数据集 / 控制台 / 仪表盘 / 人工修正 / 导出结果

### 2. 分割标注（SAM3）
- **SAM3 辅助分割**：正样本点、负样本点、画框、文字提示（Grounding）
- **LocateAnything 辅助**：在分割模块中可直接调用 LA 检测，结果自动转为标注框，再逐一发送给 SAM3 分割
- **手动标注**：多边形、圆形
- **掩码拖动**：SAM3 生成的掩码可拖动调整位置
- **多目标**：一张图标注多个目标，逐个保存
- **Ctrl+Z 撤销**：最多 50 步
- **滚轮缩放 / 右键拖动平移**
- **文件浏览器**：打开文件夹，逐一标注，已标注加旗子标识
- **导出**：仅导出掩码（黑色背景 + 彩色掩码，不含原图）
- **标注保存**：JSON 格式，每张图一个文件

### 3. 目标检测（LocateAnything + 手动标注）
- **LocateAnything 视觉语言检测**：
  - 类别检测（detect）：输入类别名，如 `person,car`
  - 短语定位（ground）：输入短语，如 `红色的杯子`
  - 文字检测（detect_text）：检测图中的文字
  - 指针定位（point）：定位短语所指物体
- **手动标注工具**：方框、多边形、选择/拖动
- **搜索词自动命名**：用物品名称搜索时，标签自动改为搜索词
- **标注管理**：选中、定位、重命名、删除
- **发送到分割标注**：每个方框逐一发送给 SAM3，逐一分割生成掩码
- **布局与 SAM 模块完全对齐**：左侧文件列表、中间画布、右侧标注目标

### 4. 旋转目标检测（多边形 + 最小外接矩形）
- **多边形标注**：圈选物体轮廓，自动计算最小外接矩形（MinAreaRect）
- **SAM3 分割辅助**：点/框/文本提示分割得到掩码，从掩码计算旋转框
- **LocateAnything 辅助**：LA 检测得到框 → 逐框 SAM 分割 → mask_to_rbox → 自动批量保存
- **顶点拖动修改**：拖动旋转矩形角点，Enter 重算外接矩形
- **模型自动标注**：选择已训练的 YOLOv8-OBB 模型，单图/批量预测
- **页面内训练**：标注页面直接配置训练参数，后台线程训练，不阻塞标注
- **批量处理**：遍历整个文件夹，LA 检测 + SAM 分割 + rbox 计算，自动保存
- **输出格式**：JSONL，每行一个图片记录

旋转框格式 `rbox: [cx, cy, w, h, angle]`，angle 范围 [0, 360)，w ≤ h。

### 5. 算法管理（主页右上角入口）
- **算法列表**：左侧侧边栏展示可用算法，点击切换
- **训练配置**：右侧详情面板配置数据目录、轮数、图像尺寸、批大小
- **数据增强**：ultralytics 内置（旋转 ±45°、平移、缩放、剪切、翻转、Mosaic、MixUp、HSV），OBB 角点自动变换
- **训练监控**：实时进度条 + 日志流
- **模型管理**：已训练模型列表，可刷新
- **当前算法**：旋转目标检测（YOLOv8-OBB）

## 环境要求

| 项 | 要求 |
|---|---|
| OS | Windows 10/11 |
| Python | 3.13（主服务） |
| Python | 3.12 + PyTorch 2.12 + CUDA 12.6（SAM3 服务） |
| Python | 3.12 + Transformers（LocateAnything 服务） |
| Python | 3.12 + Ultralytics（算法训练，主环境即可） |
| GPU | NVIDIA RTX 40 系以上（建议 8GB+ 显存） |
| CUDA Toolkit | 12.4（VL 编译用） |
| 磁盘 | 模型文件约 5 GB（OCR）+ 3.2 GB（SAM3）+ 6 GB（LA） |

## 快速开始

### 1. 安装主服务依赖

```bash
pip install -r requirements.txt
pip install ultralytics  # 算法训练（YOLOv8-OBB）
```

### 2. 模型文件

模型已放在项目 `models/` 目录下，使用相对路径，无需额外配置：

```
models/
├── ppocr-v6-rec/              # PPOCR-V6 识别模型
├── ppocr-vl/                  # PPOCR-VL 大模型
└── yolov8n-obb.pt             # YOLOv8-OBB 预训练权重（旋转目标检测）
```

SAM3 模型 checkpoint 需单独下载（约 3.2GB），放在 `F:\SAM3\sam3-main\sam3.pt`，或修改 `run_sam3.py` 中的 `CKPT_PATH`。

LocateAnything-3B 模型放在 `F:\eagle\Embodied\LocateAnything-3B`，或修改 `run_la.py` 中的 `MODEL_PATH`。

### 3. 启动 Web 界面

```bash
python run_web.py
```

浏览器打开 http://127.0.0.1:8000

### 4. 启动 SAM3 分割服务（可选）

如需使用分割标注中的 SAM3 辅助分割功能：

```bash
# 在 sam3 conda 环境中运行
D:\miniconda\envs\sam3\python.exe run_sam3.py
```

模型加载约 30 秒，启动后监听 :8001。Web 界面会自动检测 SAM3 服务是否在线。

### 5. 启动 LocateAnything 检测服务（可选）

如需使用目标检测模块：

```bash
# 在 locateanything conda 环境中运行
D:\miniconda\envs\locateanything\python.exe run_la.py
```

模型加载约 20 秒，启动后监听 :8002。Web 界面会自动检测 LA 服务是否在线。

> **GPU 显存优化**：LA 服务会自动将图片缩放到最大 1280px 后推理，每次请求后清理显存，在 12GB 显卡上可稳定运行。

## Web 界面

首页为功能选择页，四个任务卡片 + 右上角"算法"入口：

1. **OCR 标注**：数据集 / 控制台 / 仪表盘 / 人工修正 / 导出结果
2. **分割标注**：SAM3 辅助 + 手动标注，多目标保存，仅掩码导出
3. **目标检测**：LocateAnything 检测 + 手动标注，可发送到分割标注
4. **旋转目标检测**：多边形 + 最小外接矩形，支持模型训练与自动标注
5. **算法**（右上角）：模型训练与管理，YOLOv8-OBB 旋转目标检测

浏览器返回按钮在标注软件内导航，不会跳到外部页面。刷新页面保持当前模块。

### 分割标注快捷键

| 键 | 功能 |
|---|---|
| `1` | 正样本点 |
| `2` | 负样本点 |
| `3` / `B` | 画框 |
| `4` / `P` | 多边形 |
| `5` / `C` | 圆形 |
| `6` | 选择/拖动 |
| `Enter` | 完成当前标注 |
| `R` | 清除提示 |
| `F` | 适配/定位 |
| `Del` | 删除选中 |
| `Ctrl+Z` | 撤销 |
| `←` / `→` | 上一张 / 下一张 |
| 滚轮 | 缩放 |
| 右键/中键拖动 | 平移 |

### 目标检测快捷键

| 键 | 功能 |
|---|---|
| `1` | 方框工具 |
| `2` | 多边形工具 |
| `3` | 选择工具 |
| `Enter` | 完成当前标注 |
| `F` | 适配/定位 |
| `Del` | 删除选中 |
| `Ctrl+Z` | 撤销 |
| `←` / `→` | 上一张 / 下一张 |

### 旋转目标检测快捷键

| 键 | 功能 |
|---|---|
| `1` / `P` | 多边形工具 |
| `2` / `S` | 选择工具 |
| `3` | SAM 正样本点 |
| `4` | SAM 负样本点 |
| `5` / `B` | SAM 画框 |
| `Enter` | 完成多边形 → 计算最小外接矩形；选中拖动后重算 |
| `F` | 适配/定位 |
| `Del` | 删除选中（自动保存） |
| `Ctrl+Z` | 撤销 |
| `←` / `→` | 上一张 / 下一张 |
| 滚轮 | 缩放 |
| 右键/中键拖动 | 平移 |

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

# 限额测试
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

掩码导出（PNG）：黑色背景 + 彩色掩码，不含原图。

### 目标检测输出

保存在 `detect_out/annotations/` 目录下，每张图一个 JSON 文件：

```json
{
  "image_name": "example.png",
  "annotations": [
    {"id": 1, "type": "rect", "label": "person", "data": {"x1": 100, "y1": 50, "x2": 300, "y2": 400}},
    {"id": 2, "type": "polygon", "label": "car", "data": {"points": [[100,100],[200,100],[200,200]]}}
  ]
}
```

### 旋转目标检测输出

保存在标注目录下的 `rotated_det_labels.txt`，JSONL 格式，每行一个图片记录：

```json
{"filename":"example.jpg","width":1920,"height":1080,"ann":[{"bbox":null,"bbox_label":"bottle","ignore":false,"polygon":null,"rbox":[960,540,120,200,45.0]}]}
```

`rbox` 格式：`[center_x, center_y, width, height, angle]`，angle 范围 [0, 360)，w ≤ h。

### 训练产物

保存在 `models/rotated_det/train/` 目录下：

| 文件 | 说明 |
|---|---|
| `weights/best.pt` | 最佳权重 |
| `weights/last.pt` | 最后一轮权重 |
| `results.csv` | 训练 metrics |
| `results.png` | 训练曲线图 |
| `confusion_matrix.png` | 混淆矩阵 |
| `BoxPR_curve.png` | PR 曲线 |
| `BoxF1_curve.png` | F1 曲线 |

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
├── models/                   # 本地模型文件（gitignore）
│   ├── ppocr-v6-rec/
│   ├── ppocr-vl/
│   └── yolov8n-obb.pt        # YOLOv8-OBB 预训练权重
├── web/
│   ├── app.py                # Flask 路由（OCR + SAM3 + LA + 标注 + 算法 API）
│   ├── runner.py             # 后台任务运行器
│   ├── sam3_proxy.py         # SAM3 服务代理封装
│   ├── la_proxy.py           # LocateAnything 服务代理封装
│   ├── trainer_rotated.py    # 旋转目标检测训练 + 推理
│   └── static/
│       ├── index.html        # SPA 单页（功能选择 + 五大模块）
│       ├── app.js            # OCR 逻辑 + 模块切换 + 浏览器历史管理
│       ├── sam3.js           # 分割标注前端逻辑
│       ├── detect.js         # 目标检测前端逻辑
│       ├── rotated.js        # 旋转目标检测前端逻辑
│       ├── algo.js           # 算法管理前端逻辑
│       └── styles.css        # 玻璃拟态样式
├── run.py                    # CLI 入口
├── run_web.py                # Web 服务入口（:8000）
├── run_sam3.py               # SAM3 服务入口（:8001，sam3 env）
└── run_la.py                 # LocateAnything 服务入口（:8002，locateanything env）
```

### 三服务架构

```
浏览器 → Flask (:8000, Python 3.13) ─┬→ SAM3 服务 (:8001, sam3 env)
                                      └→ LocateAnything 服务 (:8002, locateanything env)
```

- Flask 主服务处理 OCR、人工修正、标注工具、算法训练的所有 API 和静态文件
- SAM3 服务独立运行（PyTorch 2.12 + CUDA 12.6），模型常驻内存
- LocateAnything 服务独立运行（Transformers + LocateAnything-3B），GPU 推理
- 算法训练使用 ultralytics，后台线程运行，不阻塞标注
- 三个服务通过 HTTP 通信，Flask 代理转发 SAM3 和 LA 请求

## 算法训练

### 旋转目标检测训练（YOLOv8-OBB）

1. 在旋转目标检测页面标注图片（多边形 → 自动计算最小外接矩形）
2. 标注 20+ 张图后，点击工具栏"训练"按钮或进入算法管理页面
3. 配置训练参数（轮数、图像尺寸、批大小），点击开始训练
4. 训练在后台线程运行，可继续标注其他图片
5. 训练完成后，在旋转目标检测页面选择模型，点击"单图预测"或"批量预测"自动标注

### 数据增强

ultralytics 内置数据增强，OBB 角点自动变换：

- 旋转 ±45°
- 平移 ±20%
- 缩放 ±50%
- 剪切 ±10°
- 上下/左右翻转
- Mosaic
- MixUp
- HSV 色彩扰动

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

## LocateAnything 环境配置（可选）

LocateAnything 需要独立的 conda 环境：

```bash
# 创建环境
conda create -n locateanything python=3.12 -y
conda activate locateanything

# 安装 PyTorch + Transformers
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126
pip install transformers accelerate flask pillow

# 模型放在 F:\eagle\Embodied\LocateAnything-3B
```

## 常见问题

**Q: VL 初始化报错找不到 GGUF 文件？**
A: 检查 `models/ppocr-vl/` 目录下的两个 GGUF 文件是否存在。

**Q: SAM3 服务离线？**
A: 确认已运行 `D:\miniconda\envs\sam3\python.exe run_sam3.py`，且控制台显示 `SAM3 ready.`。

**Q: LocateAnything 服务离线？**
A: 确认已运行 `D:\miniconda\envs\locateanything\python.exe run_la.py`，且控制台显示 `LocateAnything ready.`。

**Q: LA 检测报 CUDA out of memory？**
A: LA 服务已内置图片缩放（最大 1280px）和显存清理。如仍 OOM，尝试关闭 SAM3 服务释放显存。

**Q: LA 检测报 y1 must be greater than or equal to y0？**
A: 已修复。模型输出坐标已自动规范化（min/max），确保 x1<=x2 且 y1<=y2。

**Q: GPU 编译失败？**
A: 检查：① MSVC 14.39 装了没；② vcvarsall 用的是 `-vcvars_ver=14.39`；③ CUDA 12.4 的 nvcc 在 PATH 里；④ TEMP 设成短路径。

**Q: 为什么有的结果标 PRE 有的标 REVIEW？**
A: 两引擎结果经过归一化后完全一致 → PRE；否则 REVIEW。

**Q: GPU 显存不够？**
A: SAM3 ≈ 3.4GB + LA ≈ 6GB + PPOCR-VL 可能逼近 12GB 上限。建议不要同时运行所有服务，或按需启停。

**Q: 旋转目标检测训练需要多少张图？**
A: 建议 20+ 张图。数据增强会自动扩充训练样本。

**Q: 浏览器返回按钮跳到外部页面？**
A: 已修复。使用 History API 管理浏览器历史，返回按钮在标注软件内导航。
