# 自动标注程序（OCR 双引擎）— 交付确认与使用说明

## 背景与现状

用户需求：开发自动化标注程序，未来集成 SAM / Locate Anything / OCR，**现阶段先实现 OCR**。思路为
PPOCR-V6（轻量专用模型）与 PPOCR-VL（多模态大模型）同时识别同一张 crop：

- 两引擎一致且非空 → `pre_annotated.jsonl`（`{"filename","text"}`）
- 不一致 → `needs_review.jsonl`（`{"filename","text_v6","text_vl"}`，两个候选作为人工复核提示）
- VL 关闭（调试）→ `v6_only.jsonl`

原 C# 实现位于 `D:\C#code\ConsoleApp2\ConsoleApp2`（V6）与 `D:\C#code\ConsoleApp1\ConsoleApp1`（VL），
现**已全部用 Python 重写**到 `c:\Users\BTW\Desktop\autolable`。

**经探查确认：所有源码文件均已存在且与设计一致，系统已端到端验证通过。** 本计划因此不是"待实现清单"，
而是交付确认 + 使用说明 + 可选后续项。

## 已交付文件清单（已存在，无需新建）

| 文件 | 作用 |
|------|------|
| `run.py` | 薄入口，转发到 `autolable.cli.main` |
| `requirements.txt` | 依赖 + Python 3.13 环境下的实际安装约束注释 |
| `autolable/__init__.py` | 包标识 |
| `autolable/config.py` | `Config` dataclass：模型路径、GPU 层数、温度等 |
| `autolable/text_utils.py` | `clean_text` / `normalize_for_compare`（移植 C# `CleanFormatSymbols` + 去空格小写比对） |
| `autolable/annotator.py` | `DualEngineAnnotator`：递归遍历图片、双引擎比对、写三份输出 + summary.json |
| `autolable/cli.py` | argparse 入口：`--input/--output/--v6-backend/--no-vl/--limit/--cpu` |
| `autolable/engines/base.py` | `OCREngine` ABC（`name`/`init`/`recognize`） |
| `autolable/engines/ppocr_v6.py` | `PaddleOCRBackend`（paddleocr 3.7 `TextRecognition` rec-only）+ `RapidOCRBackend`（rapidocr 3.x rec-only）+ `make_v6_backend` 工厂 |
| `autolable/engines/ppocr_vl.py` | `PaddleOCRVLBackend`：`MTMDChatHandler` 注入图像 embedding，chat 模板为主路径，`MANUAL_PROMPT_PATH` 可切回 C# 精确 prompt |

## 已验证结论（来自上一轮会话）

1. **三引擎一致**：同一张图 paddleocr / rapidocr / VL 均返回 `'Li Fe(LFP)-C.F'`，
   `clean_text` 后 = `'Li FeLFP-C.F'`，与现有 `recog_labels.txt` 格式完全对齐。
2. **端到端 CLI**：10 图 → 6 pre_annotated / 4 needs_review，输出文件格式正确。
3. **后端切换**：`--v6-backend rapidocr` 正常工作。
4. **双引擎价值体现**：VL 对复杂文本（如 `EN=77.00 kWh`）输出 LaTeX 形式
   `\(E_N = 77.00 \text{ kWh}\)`，与 V6 不一致 → 正确标记 needs_review。

## 使用方法（已可用，无需改动）

```powershell
# 默认：paddleocr 后端 + VL 双引擎
python run.py --input C:\Users\BTW\Desktop\20260328new --output out

# 切换 rapidocr 后端
python run.py --input <图片目录> --output out --v6-backend rapidocr

# 调试：仅 V6（不加载大模型，快）
python run.py --input <图片目录> --output out --no-vl

# 限量跑前 N 张
python run.py --input <图片目录> --output out --limit 20

# 强制 CPU
python run.py --input <图片目录> --output out --cpu
```

输出目录产物：
- `pre_annotated.jsonl` — 可直接当标注文件使用（格式同 `recog_labels.txt`）
- `needs_review.jsonl` — 人工复核清单（含 v6/vl 两个候选）
- `summary.json` — `{total, pre_annotated, needs_review, v6_backend, vl_enabled}`
- `v6_only.jsonl` — 仅 `--no-vl` 时生成

## 当前环境约束（已记录在 requirements.txt 注释中）

- **paddleocr 后端跑 CPU**：paddlepaddle-gpu 无 Python 3.13 wheel。
- **rapidocr 后端跑 CPU**：onnxruntime-gpu 1.27 需 CUDA 13，本机 CUDA 12.4 缺 cublasLt64_13.dll，自动回退 CPU（rec 仅 ~70ms，影响小）。
- **VL 跑 CPU**：llama-cpp-python 为 CPU 编译。CPU 上每图 ~8s（696 张约 1.5h）。GPU 加速路径见下。

## 可选后续项（用户未显式要求，需确认后才做）

下列均为"潜在后续"，**本计划不包含执行**，仅作为选项列出供用户决定：

1. **VL GPU 加速**：解决 llama-cpp-python GPU 编译
   - 方案 A：安装 MSVC 14.39 工具集（CUDA 12.4 的 nvcc 与当前 MSVC 14.51 不兼容，编译崩溃）
   - 方案 B：升级 CUDA 到 13.x + 从 github 取预编译 CUDA wheel（当前 github 不通）
   - 预期：VL 单图从 ~8s 降到 <1s

2. **全量数据集验证**：跑完整 696 张，统计 pre/review 实际占比，评估预标注覆盖率。

3. **远期集成**（用户原始愿景）：SAM、Locate Anything 模块接入。

## 验证步骤（确认交付状态）

由于代码已就绪，"验证"= 重新跑一次冒烟测试确认环境未损坏：

1. 确认依赖可导入：`python -c "import paddleocr, rapidocr, llama_cpp; print('ok')"`
2. 跑限量双引擎：`python run.py --input C:\Users\BTW\Desktop\20260328new --output out --limit 10`
3. 检查产物：`out/pre_annotated.jsonl`、`out/needs_review.jsonl`、`out/summary.json` 是否生成且内容合理。

## 结论

实现已完成并验证。若用户希望推进任何"可选后续项"，请在批准本计划后告知具体方向；
否则当前系统已满足"先实现 OCR、全部用 Python"的原始需求，可直接投入使用。
