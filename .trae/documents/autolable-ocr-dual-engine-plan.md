# 自动化标注程序 — OCR 双引擎模块实现方案

## Context（背景）

用户正在 `c:\Users\BTW\Desktop\autolable` 构建一个自动化标注程序，未来会集成 SAM、Locate-Anything、OCR 等能力，本期先实现 OCR 模块。

OCR 的设计思路：**PPOCR-V6**（轻量专用模型）与 **PPOCR-VL**（多模态大模型）同时识别同一张图：
- 两者清洗后一致 → 自动预标注（`pre_annotated`）
- 不一致 → 标记需人工复核（`needs_review`），保留两个候选答案作为提示

两套引擎此前均用 C# 实现：
- PPOCR-V6（PaddleOCRSharp，rec-only）：`D:\C#code\ConsoleApp2\ConsoleApp2\Program.cs`
- PPOCR-VL（LLamaSharp + GGUF mmproj）：`D:\C#code\ConsoleApp1\ConsoleApp1\Program.cs`

现需用 Python 统一实现，便于后续扩展 SAM 等模块。

## 环境现状（已核实）

- Python 3.13.12；已装 opencv-python 4.13、numpy 2.4、pillow 12.2
- 未装：`paddleocr`/`paddlepaddle-gpu`、`rapidocr`/`onnxruntime-gpu`、`llama-cpp-python`
- GPU：NVIDIA RTX 4070 12GB
- V6 现有模型 `PP-OCRv6_small_rec_infer` 为 PaddleOCRSharp 格式（`inference.json`+`inference.pdiparams`，**无 `.pdmodel`**），Python 库无法直接复用 → 两个后端各自加载自带模型
- VL 模型为 GGUF+mmproj（llama.cpp 格式），可直接复用：
  - `F:\OCRprojrct\Models\PaddleOCR-VL-1.5-GGUF.gguf`
  - `F:\OCRprojrct\Models\PaddleOCR-VL-1.5-GGUF-mmproj.gguf`
- 字典 `ppocr_keys.txt` 位于 `C:\Users\BTW\Desktop\PaddleOCRSharp-master\PaddleOCRSharp-master\Demo\win_runtime_x64\inference\ppocr_keys.txt`
- 参考数据集 `C:\Users\BTW\Desktop\20260328new`（crops 子目录 + 696 条 recog_labels.txt，仅用作测试输入图片）

## 用户确认的决策

1. V6 后端：**paddleocr 与 rapidocr 都实现，通过配置切换**
2. 运行模式：**仅自动标注模式**（不做准确率评估、不做单图调试入口）
3. 复核结果：**分两个文件**（`pre_annotated.jsonl` / `needs_review.jsonl`）

## 架构设计

```
autolable/
├── autolable/
│   ├── __init__.py
│   ├── config.py            # 配置数据类：模型路径、后端选择、GPU 参数
│   ├── text_utils.py        # clean_text / normalize_for_compare（移植自 C# CleanFormatSymbols）
│   ├── engines/
│   │   ├── __init__.py
│   │   ├── base.py          # OCREngine ABC：recognize(image_path)->str，init() 复用
│   │   ├── ppocr_v6.py      # PaddleOCRBackend + RapidOCRBackend + make_v6_backend(cfg) 工厂
│   │   └── ppocr_vl.py      # PaddleOCRVLBackend（llama-cpp-python 多模态）
│   ├── annotator.py         # DualEngineAnnotator：跑两引擎→比对→分类→写两文件
│   └── cli.py               # argparse 入口
├── run.py                   # 薄入口：from autolable.cli import main; main()
└── requirements.txt
```

说明：`engines/base.py` 的 ABC 是合理的——annotator 需统一遍历 3 个引擎实现（2 个 V6 后端 + VL），且用户要求后端可切换，工厂模式直接服务该需求。**不预先建 SAM/Locate-Anything 桩代码**，留待后续模块按同一 ABC 思路扩展。

## 关键实现细节

### 1. text_utils.py（文本清洗，移植 C#）
- `clean_text(s)`：去掉 `\ ( ) { } _`，trim（对应 C# 两版的 CleanFormatSymbols 并集）
- `normalize_for_compare(s)`：`clean_text` 后再去空格、小写（对应 C# 比对逻辑）

### 2. engines/base.py
```python
class OCREngine(ABC):
    @abstractmethod
    def init(self) -> None: ...
    @abstractmethod
    def recognize(self, image_path: str) -> str: ...  # 返回纯文本（多块拼接）
```
引擎在 annotator 中初始化一次、全局复用（对应 C# 全局 `_ocrEngine` 缓存）。

### 3. engines/ppocr_v6.py（两个后端 + 工厂）
- **PaddleOCRBackend**：`from paddleocr import PaddleOCR`，`use_det=False, use_cls=False, use_rec=True, use_gpu=True`，PP-OCRv6 rec 模型，`rec_char_dict_path=ppocr_keys.txt`。`ocr.ocr(img_path)` 结果提取所有 text block 拼接。
- **RapidOCRBackend**：`from rapidocr import RapidOCR`，`RapidOCR(det=False, cls=False, rec=True)`，结果 `[box, text, score]` 列表，拼接 text。
- `make_v6_backend(cfg)`：按 `cfg.v6_backend`（`"paddleocr"`/`"rapidocr"`）返回实例。
- 两者都是 rec-only：把整张 crop 当单行文本识别，与 C# 行为一致（crops 已是裁好的文本区域）。

### 4. engines/ppocr_vl.py（llama-cpp-python）
- `from llama_cpp import Llama`，加载 `Llama(model_path=vl_gguf, clip_model_path=mmproj, n_gpu_layers=32, n_ctx=4096, verbose=False)`，GPU offload 32 层（对应 C# `GpuLayerCount=32`）。
- 识别：`create_chat_completion`，messages 含 image_url（file://）+ text "OCR"，`temperature=0, max_tokens=1024`，stop `</s>`。
- **风险点**：PPOCR-VL 的对话模板需匹配 `<|begin_of_sentence|>User: <image>OCR:Assistant:\n`（C# 手工构造）。先用上面高级 API + 模型内置 chat template 试一张图；若输出异常，回退到低级路径：手工拼该 prompt，用 mtmd embed 注入后 `create_completion`。此点在实现时用单图验证。
- 复用 C# 的温度/截断参数。

### 5. annotator.py（核心比对逻辑）
```python
class DualEngineAnnotator:
    def __init__(self, v6: OCREngine, vl: OCREngine, input_dir, output_dir): ...
    def run(self):
        for img in 递归遍历 input_dir 下 *.png/*.jpg/*.bmp/*.jpeg:
            t6 = v6.recognize(img); tvl = vl.recognize(img)
            rel = 相对 input_dir 的路径（正斜杠）
            if normalize_for_compare(t6)==normalize_for_compare(tvl) and 非空:
                pre_annotated.jsonl 写 {"filename": rel, "text": clean_text(t6)}
            else:
                needs_review.jsonl 写 {"filename": rel, "text_v6": t6, "text_vl": tvl}
        写 summary.json（pre/review/total 计数）
```
- 输出 `filename` 格式与现有 `recog_labels.txt` 一致（相对根目录、可含 `crops/` 前缀），使 `pre_annotated.jsonl` 可直接当作标注文件复用。

### 6. cli.py
```
python run.py --input <图片目录> --output <输出目录>
              [--v6-backend paddleocr|rapidocr]  默认 paddleocr
              [--no-vl]            # 仅跑 V6（调试用）
              [--limit N]          # 只处理前 N 张
              [--image-glob "*.png"]
```
- 默认 input 示例指向 `C:\Users\BTW\Desktop\20260328new\crops`。
- 引擎初始化与识别均加 try/except，单图失败记入 needs_review 并继续。

### 7. config.py
dataclass 含：VL gguf/mmproj 路径、ppocr_keys.txt 路径、`v6_backend`、`n_gpu_layers`、`n_ctx`、`max_tokens`、`temperature`。默认值用上述已核实路径。

### 8. requirements.txt
```
paddlepaddle-gpu
paddleocr
rapidocr
onnxruntime-gpu
llama-cpp-python
opencv-python
numpy
pillow
```
`llama-cpp-python` 需 GPU 版（安装时设 `CMAKE_ARGS="-DGGML_CUDA=on"`），实现阶段给出安装命令。

## 关键复用（来自 C#，避免重复造轮子）

- 清洗规则：`D:\C#code\ConsoleApp2\Program.cs:335-342` 与 `D:\C#code\ConsoleApp1\Program.cs:200-213` → `text_utils.py`
- 比对逻辑（去空格+忽略大小写）：两份 C# 的 `isCorrect` 判断 → `normalize_for_compare`
- VL 推理参数（temp=0, max_tokens=1024, stop `</s>`, gpu_layers=32, prompt）：`D:\C#code\ConsoleApp1\Program.cs:217-301` → `ppocr_vl.py`
- V6 rec-only 配置（det/cls off, rec on）：`D:\C#code\ConsoleApp2\Program.cs:207-231` → `ppocr_v6.py`

## 验证方案

1. 装依赖：先装 `paddlepaddle-gpu`/`paddleocr`、`rapidocr`/`onnxruntime-gpu`，再 `CMAKE_ARGS="-DGGML_CUDA=on" pip install llama-cpp-python`。
2. 单图冒烟（验证 VL 模板风险点）：临时对 `20260328new\crops` 下任一 png 调 `PaddleOCRVLBackend.recognize` 与 V6 后端，打印结果，确认 VL 输出无乱码/无重复 prompt。
3. 小批量跑：`python run.py --input C:\Users\BTW\Desktop\20260328new\crops --output out --limit 20`，检查 `pre_annotated.jsonl` / `needs_review.jsonl` / `summary.json` 生成且字段正确。
4. 后端切换：`--v6-backend rapidocr` 再跑同样 20 张，确认可切换且结果合理。
5. 全量跑 696 张，记录 pre/review 占比。

## 实施步骤顺序

1. 创建目录结构 + `requirements.txt` + 安装依赖
2. `text_utils.py` + `config.py`
3. `engines/base.py` + `engines/ppocr_v6.py`（两后端）
4. `engines/ppocr_vl.py`（含单图验证模板风险）
5. `annotator.py` + `cli.py` + `run.py`
6. 小批量→全量验证
