from __future__ import annotations

import argparse
import base64
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
YOLO26_MODELS = ("yolo26n.pt", "yolo26s.pt", "yolo26m.pt", "yolo26l.pt", "yolo26x.pt")
YOLO26_MODEL_SET = set(YOLO26_MODELS)

_model_cache = {}
_model_lock = Lock()


def json_response(handler: SimpleHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def load_yolo_model(model_name: str):
    if model_name not in YOLO26_MODEL_SET:
        raise ValueError(f"Unsupported YOLO26 model '{model_name}'.")

    with _model_lock:
        if model_name in _model_cache:
            return _model_cache[model_name]
        try:
            from ultralytics import YOLO
        except ImportError as exc:
            raise RuntimeError(
                "Ultralytics is not installed. Run '.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt'."
            ) from exc

        model = YOLO(model_name)
        _model_cache[model_name] = model
        return model


def image_from_data_url(data_url: str):
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError(
            "Pillow is not installed. Run '.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt'."
        ) from exc

    _, _, encoded = data_url.partition(",")
    raw = base64.b64decode(encoded or data_url, validate=False)
    image = Image.open(BytesIO(raw))
    return image.convert("RGB")


def detect_yolo26(payload: dict) -> dict:
    model_name = payload.get("model") or "yolo26n.pt"
    threshold = float(payload.get("threshold", 0.55))
    imgsz = int(payload.get("imgsz", 640))
    end2end = bool(payload.get("end2end", True))
    image = image_from_data_url(payload["image"])
    model = load_yolo_model(model_name)
    results = model.predict(
        image,
        conf=threshold,
        imgsz=imgsz,
        end2end=end2end,
        verbose=False,
    )

    detections = []
    for result in results:
        names = result.names or {}
        if result.boxes is None:
            continue
        boxes = result.boxes.xyxy.cpu().tolist()
        scores = result.boxes.conf.cpu().tolist()
        classes = result.boxes.cls.cpu().tolist()
        for box, score, class_id in zip(boxes, scores, classes):
            x1, y1, x2, y2 = box
            detections.append(
                {
                    "class": names.get(int(class_id), str(int(class_id))),
                    "score": float(score),
                    "bbox": [float(x1), float(y1), float(x2 - x1), float(y2 - y1)],
                }
            )

    return {
        "detections": detections,
        "width": image.width,
        "height": image.height,
        "model": model_name,
    }


class NoCacheHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/api/yolo26/models":
            json_response(self, 200, {"models": list(YOLO26_MODELS)})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/detect":
            json_response(self, 404, {"error": "Not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0:
                raise ValueError("Missing request body.")
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            if not payload.get("image"):
                raise ValueError("Missing image payload.")
            json_response(self, 200, detect_yolo26(payload))
        except Exception as exc:
            json_response(self, 400, {"error": str(exc)})

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the no-code computer vision workflow builder."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8000, type=int)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), NoCacheHandler)
    print(f"No-code vision builder running at http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
