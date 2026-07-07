"""旋转目标检测训练 pipeline：JSONL rbox → YOLO OBB 格式 → 训练 → 推理。

数据增强由 ultralytics 内置处理，OBB 角点会随旋转/裁剪/翻转自动变换。
"""
from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path

import cv2
import numpy as np

# 训练状态全局变量
_train_state = {
    "running": False,
    "progress": 0,
    "epoch": 0,
    "total_epochs": 0,
    "loss": 0.0,
    "metrics": {},
    "log": [],
    "model_path": "",
    "error": "",
}


def rbox_to_corners(rbox):
    """rbox [cx, cy, w, h, angle] → 4 角点 [[x1,y1],...]"""
    cx, cy, w, h, angle = rbox
    angle_rad = np.deg2rad(angle)
    cos_a, sin_a = np.cos(angle_rad), np.sin(angle_rad)
    hw, hh = w / 2, h / 2
    dx = np.array([-hw, hw, hw, -hw])
    dy = np.array([-hh, -hh, hh, hh])
    x = cx + dx * cos_a - dy * sin_a
    y = cy + dx * sin_a + dy * cos_a
    return np.stack([x, y], axis=1)


def prepare_dataset(data_dir, output_dir, val_ratio=0.2):
    """转换 JSONL 标注 → YOLO OBB 格式。

    目录结构：
      output_dir/images/train, output_dir/images/val
      output_dir/labels/train, output_dir/labels/val
      output_dir/data.yaml
    """
    data_dir = Path(data_dir)
    output_dir = Path(output_dir)
    label_file = data_dir / "rotated_det_labels.txt"
    classes_file = data_dir / "classes.txt"

    # 读取类别
    classes = []
    if classes_file.exists():
        classes = [c.strip() for c in classes_file.read_text(encoding="utf-8").splitlines() if c.strip()]
    if not classes:
        classes = ["object"]

    # 读取标注
    annotations = {}
    if label_file.exists():
        for line in label_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                annotations[obj["filename"]] = obj
            except (json.JSONDecodeError, KeyError):
                continue

    # 清空旧目录并重建
    if output_dir.exists():
        shutil.rmtree(output_dir)
    for split in ["train", "val"]:
        (output_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (output_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    # 划分 train/val
    files = list(annotations.keys())
    if not files:
        raise ValueError("数据目录中无标注记录")
    np.random.seed(42)
    np.random.shuffle(files)
    n_val = max(1, int(len(files) * val_ratio))
    val_files = set(files[:n_val])

    for filename, obj in annotations.items():
        split = "val" if filename in val_files else "train"
        # 复制图片
        src_img = data_dir / filename
        if not src_img.exists():
            continue
        dst_img = output_dir / "images" / split / filename
        shutil.copy2(src_img, dst_img)

        # 生成 YOLO 标签（每行：class_id x1 y1 x2 y2 x3 y3 x4 y4，归一化）
        W = obj.get("width", 0)
        H = obj.get("height", 0)
        if W <= 0 or H <= 0:
            # 从图片读取尺寸
            img = cv2.imread(str(src_img))
            if img is not None:
                H, W = img.shape[:2]
            else:
                continue
        label_lines = []
        for ann in obj.get("ann", []):
            rbox = ann.get("rbox")
            if not rbox or len(rbox) < 5:
                continue
            label = ann.get("bbox_label", "object")
            cls_id = classes.index(label) if label in classes else 0
            corners = rbox_to_corners(rbox)  # 4x2
            # 归一化
            corners[:, 0] /= W
            corners[:, 1] /= H
            corners = np.clip(corners, 0, 1)
            coords = " ".join(f"{x:.6f}" for x in corners.flatten())
            label_lines.append(f"{cls_id} {coords}")

        label_path = output_dir / "labels" / split / (filename.rsplit(".", 1)[0] + ".txt")
        label_path.write_text("\n".join(label_lines) + ("\n" if label_lines else ""), encoding="utf-8")

    # 生成 data.yaml
    yaml_content = f"path: {output_dir.resolve()}\ntrain: images/train\nval: images/val\nnames:\n"
    for i, c in enumerate(classes):
        yaml_content += f"  {i}: {c}\n"
    (output_dir / "data.yaml").write_text(yaml_content, encoding="utf-8")
    return str(output_dir / "data.yaml")


def train_rotated_async(data_dir, epochs=100, imgsz=640, batch=16):
    """后台线程启动训练。"""
    if _train_state["running"]:
        return False, "训练正在进行中"

    def _train():
        try:
            _train_state.update(
                running=True, progress=0, epoch=0, total_epochs=epochs,
                loss=0.0, metrics={}, log=[], model_path="", error=""
            )
            _train_state["log"].append(f"开始训练: data_dir={data_dir}, epochs={epochs}, imgsz={imgsz}, batch={batch}")

            from ultralytics import YOLO

            # 准备数据集
            dataset_dir = Path(data_dir) / "yolo_dataset"
            _train_state["log"].append("转换数据集为 YOLO OBB 格式...")
            data_yaml = prepare_dataset(data_dir, dataset_dir)
            _train_state["log"].append(f"数据集已准备: {data_yaml}")

            # 加载预训练模型（优先用本地 models/yolov8n-obb.pt）
            local_pt = Path("models/yolov8n-obb.pt").resolve()
            if local_pt.exists():
                model_path = str(local_pt)
                _train_state["log"].append(f"加载本地预训练模型: {model_path}")
            else:
                model_path = "yolov8n-obb.pt"
                _train_state["log"].append("加载预训练模型 yolov8n-obb.pt（在线下载）...")
            model = YOLO(model_path)

            # 训练回调：更新进度
            def _on_epoch_end(epoch):
                _train_state["epoch"] = epoch + 1
                _train_state["progress"] = int((epoch + 1) / epochs * 100)

            # 训练（ultralytics 自动处理 OBB 数据增强）
            _train_state["log"].append("开始训练（数据增强：旋转±45°/平移/缩放/剪切/翻转/mosaic/mixup）...")
            results = model.train(
                data=data_yaml,
                epochs=epochs,
                imgsz=imgsz,
                batch=batch,
                project=str(Path("models/rotated_det").resolve()),
                name="train",
                exist_ok=True,
                # 强数据增强（小数据集）
                degrees=45.0,       # 旋转 ±45°
                translate=0.2,      # 平移
                scale=0.5,          # 缩放
                shear=10.0,         # 剪切
                flipud=0.5,         # 上下翻转
                fliplr=0.5,         # 左右翻转
                mosaic=1.0,         # mosaic
                mixup=0.3,          # mixup
                hsv_h=0.015,        # 色调
                hsv_s=0.7,          # 饱和度
                hsv_v=0.4,          # 明度
                verbose=True,
            )

            best_pt = Path("models/rotated_det/train/weights/best.pt").resolve()
            _train_state["model_path"] = str(best_pt)
            _train_state["progress"] = 100
            _train_state["log"].append(f"训练完成，最佳权重: {best_pt}")
        except Exception as e:
            _train_state["error"] = str(e)
            _train_state["log"].append(f"错误: {e}")
        finally:
            _train_state["running"] = False

    threading.Thread(target=_train, daemon=True).start()
    return True, "训练已启动"


def predict_rotated(model_path, image_path, conf=0.25):
    """单图推理 → 返回 rbox 列表。"""
    from ultralytics import YOLO
    model = YOLO(model_path)
    results = model.predict(image_path, verbose=False, conf=conf)
    out = []
    for r in results:
        if r.obb is None:
            continue
        for box in r.obb:
            xywhr = box.xywhr[0].tolist()
            cx, cy, w, h, angle_rad = xywhr
            angle_deg = float(np.rad2deg(angle_rad)) % 360
            conf_val = float(box.conf[0])
            cls = int(box.cls[0])
            # 计算 4 角点
            rbox = [float(cx), float(cy), float(w), float(h), round(angle_deg, 2)]
            corners = rbox_to_corners(rbox).tolist()
            out.append({
                "rbox": rbox,
                "corners": [[float(p[0]), float(p[1])] for p in corners],
                "confidence": round(conf_val, 3),
                "class_id": cls,
            })
    return out


def predict_rotated_batch(model_path, folder, output_dir, conf=0.25):
    """批量推理 → 写入 rotated_det_labels.txt。"""
    from ultralytics import YOLO
    model = YOLO(model_path)
    folder = Path(folder)
    output_dir = Path(output_dir)
    label_file = output_dir / "rotated_det_labels.txt"

    # 读取已有标注（避免覆盖未预测的图）
    existing = {}
    if label_file.exists():
        for line in label_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                existing[obj["filename"]] = obj
            except json.JSONDecodeError:
                continue

    img_exts = (".jpg", ".jpeg", ".png", ".bmp", ".webp")
    img_files = [f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in img_exts]
    processed = []
    for img_path in img_files:
        results = model.predict(str(img_path), verbose=False, conf=conf)
        anns = []
        for r in results:
            if r.obb is None:
                continue
            h, w = r.orig_shape
            for box in r.obb:
                xywhr = box.xywhr[0].tolist()
                cx, cy, bw, bh, angle_rad = xywhr
                angle = float(np.rad2deg(angle_rad)) % 360
                conf_val = float(box.conf[0])
                anns.append({
                    "bbox": None,
                    "bbox_label": "object",
                    "ignore": False,
                    "polygon": None,
                    "rbox": [round(cx, 2), round(cy, 2), round(bw, 2), round(bh, 2), round(angle, 2)],
                })
            if anns and w > 0 and h > 0:
                existing[img_path.name] = {
                    "filename": img_path.name,
                    "width": int(w),
                    "height": int(h),
                    "ann": anns,
                }
        if anns:
            processed.append(img_path.name)

    # 写入文件
    with open(label_file, "w", encoding="utf-8") as f:
        for obj in existing.values():
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")

    return processed


def list_models():
    """列出已训练模型。"""
    models_dir = Path("models/rotated_det")
    if not models_dir.exists():
        return []
    models = []
    for weights in models_dir.rglob("best.pt"):
        rel = weights.parent.parent.name  # train, train2, ...
        models.append({
            "name": rel,
            "path": str(weights.resolve()),
            "size_mb": round(weights.stat().st_size / 1024 / 1024, 2),
        })
    return models
