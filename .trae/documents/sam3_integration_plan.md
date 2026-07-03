# SAM3 分割功能集成方案

先分析把我把环境降级为3.12的操作可行性，对之前项目的改动大不大

<br />

## Context

项目是一个 OCR 自动标注工具（Flask + 单页前端），用户需要在浏览器中用 SAM3 分割图片：支持正样本点、负样本点、画框、文字提示四种标注方式，显示分割 mask 覆盖结果。

SAM3 需要 Python 3.12 + PyTorch 2.12 + CUDA 12.6，和当前项目的 Python 3.13 不兼容。SAM3 已安装在独立 conda 环境 `D:\miniconda\envs\sam3`，checkpoint `F:\SAM3\sam3-main\sam3.pt`（3.21 GB）已存在。

## 架构：双服务 HTTP 通信

```
浏览器 → Flask (:8000, Python 3.13) → SAM3 服务 (:8001, Python 3.12 sam3 env)
```

SAM3 模型常驻 :8001 内存，Flask 通过 `requests` 代理转发。模型加载需数秒，必须常驻不能每次请求重启。

## SAM3 两条推理路径（关键区别）

| 路径        | 用途           | API                                                                                  | box 格式           | 返回                                                                     |
| --------- | ------------ | ------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------- |
| 交互式       | 点+框 → 1个mask | `model.predict_inst(state, point_coords=, point_labels=, box=, multimask_output=)`   | XYXY 像素          | masks\[C,H,W], scores\[C]                                              |
| Grounding | 文字 → 多物体     | `processor.set_text_prompt(text, state)` / `add_geometric_prompt(box, label, state)` | \[cx,cy,w,h] 归一化 | state\["masks"]\[N,1,H,W], state\["boxes"]\[N,4], state\["scores"]\[N] |

* `build_sam3_image_model(checkpoint_path=..., enable_inst_interactivity=True)` 必须开启交互式

* `predict_inst` 的 box 是 XYXY 像素坐标，点的 `point_coords` 也是像素坐标，`point_labels` 1=正 0=负

* grounding 的 `add_geometric_prompt` box 是归一化 \[cx,cy,w,h]，label=True/False

## 实施步骤

### 1. 新建 `run_sam3.py`（SAM3 服务，:8001）

用 sam3 conda 环境运行。模型启动时加载一次，提供以下 API：

* `GET /health` → `{ok, gpu, device}`

* `POST /set_image` → 入参 `{image_path}`，调 `processor.set_image(PIL.Image)`，缓存 state

* `POST /predict` → 入参 `{points:[[x,y],...], labels:[1,0], box:[x1,y1,x2,y2]|null, multimask}`，调 `model.predict_inst(state, ...)`，返回 `{masks:[{overlay(base64 PNG), score}], best_index}`

* `POST /ground` → 入参 `{text, boxes:[{cx,cy,w,h,label}]}`，调 `reset_all_prompts` → `set_text_prompt` → `add_geometric_prompt`，返回 `{objects:[{overlay, score, box}]}`

* `POST /reset` → 清除提示

mask 编码为半透明 RGBA PNG base64，前端直接 `drawImage`。

### 2. 新建 `web/sam3_proxy.py`（Flask 代理封装）

`Sam3Client` 单例，1s 超时探测健康状态，转发到 `http://127.0.0.1:8001`。

### 3. 改 `web/app.py`（注册代理路由）

注册 5 个路由：`/api/sam3/status`、`/api/sam3/set_image`、`/api/sam3/predict`、`/api/sam3/ground`、`/api/sam3/reset`。复用 `_path_allowed` 校验图片路径。同时把 `_ALLOWED_ROOTS` 改为允许所有路径（用户之前要求）。

### 4. 改 `web/static/index.html`（新增 SAM3 tab）

* 导航栏加 `<button data-tab="sam3" class="tab"><span>SAM3 分割</span></button>`

* 新增 `<section id="page-sam3">`，布局：左侧大图画布 + 右侧工具栏（工具按钮、文字输入、结果列表）

* `showTab` 函数无需改动（已通用）

### 5. 新建 `web/static/sam3.js`（Canvas 标注逻辑）

核心功能：

* **坐标转换**：canvas 内部分辨率 = 图像原始尺寸，CSS 缩放显示，点击坐标按比例还原

* **渲染**：底图 → mask overlay → 点（绿=正, 红=负）→ 框（虚线）

* **工具**：pos/neg 点模式（click 添加点 → 自动预测）、box 模式（拖拽画框 → 预测）、文字 grounding

* **预测**：每次把全部累积点 + 当前 box 发给 `/api/sam3/predict`，multimask 根据提示数自动设

* **状态轮询**：每 5s 探测 SAM3 服务是否在线

### 6. 改 `web/static/styles.css`（canvas/工具栏样式）

新增 `.sam3-canvas-wrap`、`#sam3-canvas`、`.sam3-tools`、`.tool-btn` 等样式，保持深色玻璃拟态风格。

## 关键文件

| 文件                      | 操作 | 说明                                        |
| ----------------------- | -- | ----------------------------------------- |
| `run_sam3.py`           | 新增 | SAM3 服务入口，sam3 env 运行                     |
| `web/sam3_proxy.py`     | 新增 | Flask → SAM3 代理封装                         |
| `web/app.py`            | 改  | 注册 `/api/sam3/*` 路由 + 放宽 `_ALLOWED_ROOTS` |
| `web/static/index.html` | 改  | 新增 SAM3 tab + 布局                          |
| `web/static/sam3.js`    | 新增 | Canvas 标注逻辑                               |
| `web/static/styles.css` | 改  | canvas/工具栏样式                              |

## SAM3 源码参考

* `F:\SAM3\sam3-main\sam3\model\sam3_image.py:624` — `predict_inst(state, **kwargs)` 签名

* `F:\SAM3\sam3-main\sam3\model\sam1_task_predictor.py:229` — `predict(point_coords, point_labels, box, multimask_output)` 参数格式

* `F:\SAM3\sam3-main\sam3\model\sam3_image_processor.py:128` — `add_geometric_prompt(box, label, state)` 归一化 cxcywh

* `F:\SAM3\sam3-main\sam3\model_builder.py:573` — `build_sam3_image_model` 签名

## 启动方式

1. 先在 sam3 env 安装 flask：`D:\miniconda\envs\sam3\python.exe -m pip install flask`
2. 启动 SAM3 服务：`D:\miniconda\envs\sam3\python.exe run_sam3.py`（加载模型约 5-10 秒）
3. 启动 Web 服务：`python run_web.py`
4. 浏览器打开 <http://127.0.0.1:8000，切到「SAM3> 分割」tab

## 验证

1. SAM3 服务启动后控制台打印 `SAM3 ready.`，`GET /health` 返回 `{ok:true}`
2. Flask `/api/sam3/status` 返回在线状态
3. 浏览器载入一张图片，点击正样本点，应显示蓝色半透明 mask 覆盖
4. 添加负样本点，mask 应缩小排除负点区域
5. 画框，应分割框内物体
6. 输入文字（如 "text"）点检索，应返回多个匹配物体的 mask 列表
7. 清除提示后 canvas 恢复干净底图

## 注意事项

* GPU 显存：SAM3 ≈ 3.4GB + PPOCR-VL 可能逼近 12GB 上限，重 OCR 任务期间可停 SAM3 服务

* box 格式双重性：交互式用 XYXY 像素，grounding 用归一化 cxcywh，前端需分别转换

* grounding 会修改共享 state，每次 `/ground` 先 `reset_all_prompts` 保证幂等

