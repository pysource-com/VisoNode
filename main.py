from __future__ import annotations

import argparse
import json
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Lock, Thread
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
YOLO26_MODELS = ("yolo26n.pt", "yolo26s.pt", "yolo26m.pt", "yolo26l.pt", "yolo26x.pt")
YOLO26_MODEL_SET = set(YOLO26_MODELS)
MAX_EVENTS = 32

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


def read_json_body(handler: SimpleHTTPRequestHandler) -> dict:
    content_length = int(handler.headers.get("Content-Length", "0"))
    if content_length <= 0:
        raise ValueError("Missing request body.")
    return json.loads(handler.rfile.read(content_length).decode("utf-8"))


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


def enabled_node(workflow: dict, node_id: str) -> dict | None:
    node = node_by_id(workflow, node_id)
    return node if node and node.get("enabled", True) else None


def node_by_id(workflow: dict, node_id: str) -> dict | None:
    return next((node for node in workflow.get("nodes", []) if node.get("id") == node_id), None)


def has_active_path(workflow: dict, from_id: str, to_id: str) -> bool:
    if not enabled_node(workflow, from_id) or not enabled_node(workflow, to_id):
        return False
    if from_id == to_id:
        return True

    visited = set()
    queue = [from_id]
    edges = workflow.get("edges", [])
    while queue:
        current_id = queue.pop(0)
        if current_id == to_id:
            return True
        if current_id in visited:
            continue
        visited.add(current_id)
        for edge_from_id, edge_to_id in edges:
            if edge_from_id == current_id and edge_to_id not in visited and enabled_node(workflow, edge_to_id):
                queue.append(edge_to_id)
    return False


def active_detector_node(workflow: dict) -> dict | None:
    detector = enabled_node(workflow, "detector")
    if detector and has_active_path(workflow, "camera", "detector"):
        return detector
    return None


def active_filter_node(workflow: dict) -> dict | None:
    filter_node = enabled_node(workflow, "filter")
    if filter_node and active_detector_node(workflow) and has_active_path(workflow, "detector", "filter"):
        return filter_node
    return None


def detections_for_node(workflow: dict, node_id: str, detections: list[dict], filtered: list[dict]) -> list[dict]:
    if not enabled_node(workflow, node_id) or not has_active_path(workflow, "camera", node_id):
        return []
    if active_filter_node(workflow) and has_active_path(workflow, "filter", node_id):
        return filtered
    if active_detector_node(workflow) and has_active_path(workflow, "detector", node_id):
        return detections
    return []


def normalize_camera_source(value) -> int | str:
    if value is None or value == "":
        return 0
    if isinstance(value, int):
        return value
    text = str(value).strip()
    return int(text) if text.isdigit() else text


def detect_yolo26_frame(frame, detector: dict) -> list[dict]:
    config = detector.get("config", {})
    model_name = config.get("yoloModel") or "yolo26n.pt"
    threshold = float(config.get("threshold", 0.55))
    imgsz = int(config.get("imgsz", 640))
    model = load_yolo_model(model_name)
    predict_args = {
        "conf": threshold,
        "imgsz": imgsz,
        "verbose": False,
    }
    if "end2end" in config:
        predict_args["end2end"] = bool(config.get("end2end"))

    try:
        results = model.predict(frame, **predict_args)
    except TypeError:
        predict_args.pop("end2end", None)
        results = model.predict(frame, **predict_args)

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
    return detections


def filter_detections(workflow: dict, detections: list[dict]) -> list[dict]:
    filter_node = active_filter_node(workflow)
    if not filter_node:
        return detections
    config = filter_node.get("config", {})
    classes = {
        item.strip().lower()
        for item in str(config.get("classes", "")).split(",")
        if item.strip()
    }
    filtered = [
        item for item in detections
        if not classes or item.get("class", "").lower() in classes
    ]
    return filtered if len(filtered) >= int(config.get("minCount", 1)) else []


def draw_detections(frame, detections: list[dict], preview: dict) -> None:
    import cv2

    config = preview.get("config", {})
    show_boxes = bool(config.get("showBoxes", True))
    show_labels = bool(config.get("showLabels", True))
    for detection in detections:
        x, y, width, height = [int(round(value)) for value in detection.get("bbox", [0, 0, 0, 0])]
        if show_boxes:
            cv2.rectangle(frame, (x, y), (x + width, y + height), (41, 211, 145), 2)
        if show_labels:
            label = f"{detection.get('class', 'object')} {round(float(detection.get('score', 0)) * 100)}%"
            text_size, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
            label_y = max(0, y - text_size[1] - 8)
            cv2.rectangle(frame, (x, label_y), (x + text_size[0] + 10, label_y + text_size[1] + 8), (8, 18, 27), -1)
            cv2.putText(frame, label, (x + 5, label_y + text_size[1] + 2), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)


class WorkflowRunner:
    def __init__(self) -> None:
        self._lock = Lock()
        self._stop_event = Event()
        self._thread: Thread | None = None
        self._status = {
            "running": False,
            "state": "idle",
            "fps": 0,
            "objectCount": 0,
            "model": None,
            "error": None,
            "events": [],
        }

    def start(self, workflow: dict) -> dict:
        self.stop()
        if not enabled_node(workflow, "camera"):
            raise ValueError("Camera Loader node is disabled.")

        self._stop_event = Event()
        with self._lock:
            self._status.update({
                "running": True,
                "state": "starting",
                "fps": 0,
                "objectCount": 0,
                "model": None,
                "error": None,
                "events": [],
            })
        self._thread = Thread(target=self._run, args=(workflow,), daemon=True)
        self._thread.start()
        return self.status()

    def stop(self) -> dict:
        thread = self._thread
        if thread and thread.is_alive():
            self._stop_event.set()
            thread.join(timeout=5)
        self._thread = None
        with self._lock:
            if self._status["state"] != "error":
                self._status.update({"running": False, "state": "stopped", "fps": 0, "objectCount": 0})
        return self.status()

    def status(self) -> dict:
        with self._lock:
            return dict(self._status, events=list(self._status["events"]))

    def _run(self, workflow: dict) -> None:
        import cv2

        capture = None
        window_name = "No-Code AI Vision"
        last_fps_at = time.monotonic()
        frame_count = 0
        last_inference_at = 0.0
        last_alert_at = 0.0
        detections: list[dict] = []
        filtered: list[dict] = []
        try:
            camera = enabled_node(workflow, "camera")
            camera_config = camera.get("config", {})
            source = normalize_camera_source(
                camera_config.get("source", camera_config.get("cameraIndex", camera_config.get("deviceId", 0)))
            )
            capture = cv2.VideoCapture(source)
            width = int(camera_config.get("width", 0) or 0)
            height = int(camera_config.get("height", 0) or 0)
            if width > 0:
                capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            if height > 0:
                capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            if not capture.isOpened():
                raise RuntimeError(f"Unable to open camera source {source!r}.")

            detector = active_detector_node(workflow)
            if detector:
                engine = detector.get("config", {}).get("engine", "yolo26")
                if engine != "yolo26":
                    raise RuntimeError("Backend runtime supports Ultralytics YOLO26 only.")
                model_name = detector.get("config", {}).get("yoloModel") or "yolo26n.pt"
                load_yolo_model(model_name)
                self._set_status(state="running", model=model_name)
            else:
                self._set_status(state="running")

            self._add_event("Workflow running", "Python is capturing, processing, and displaying frames with OpenCV.")

            while not self._stop_event.is_set():
                ok, frame = capture.read()
                if not ok:
                    raise RuntimeError("Camera frame could not be read.")

                now = time.monotonic()
                detector = active_detector_node(workflow)
                if detector:
                    interval = max(0.05, float(detector.get("config", {}).get("intervalMs", 450)) / 1000)
                    if now - last_inference_at >= interval:
                        last_inference_at = now
                        detections = detect_yolo26_frame(frame, detector)
                        threshold = float(detector.get("config", {}).get("threshold", 0.55))
                        detections = [item for item in detections if float(item.get("score", 0)) >= threshold]
                        filtered = filter_detections(workflow, detections)

                preview = enabled_node(workflow, "preview")
                display_frame = frame.copy()
                preview_detections = detections_for_node(workflow, "preview", detections, filtered)
                if preview and has_active_path(workflow, "camera", "preview"):
                    draw_detections(display_frame, preview_detections, preview)
                    cv2.imshow(window_name, display_frame)
                    key = cv2.waitKey(1) & 0xFF
                    if key in (27, ord("q")):
                        self._stop_event.set()
                else:
                    cv2.waitKey(1)

                alert_detections = detections_for_node(workflow, "alert", detections, filtered)
                alert_node = enabled_node(workflow, "alert")
                if alert_node and alert_detections and has_active_path(workflow, "camera", "alert"):
                    cooldown = max(0, float(alert_node.get("config", {}).get("cooldownSeconds", 5)))
                    if now - last_alert_at >= cooldown:
                        last_alert_at = now
                        labels = ", ".join(item.get("class", "object") for item in alert_detections)
                        self._add_event(
                            str(alert_node.get("config", {}).get("message") or "Detected target object"),
                            f"{len(alert_detections)} match(es): {labels}",
                        )

                frame_count += 1
                elapsed = now - last_fps_at
                if elapsed >= 1:
                    visible_count = len(preview_detections) or len(alert_detections)
                    self._set_status(
                        state="running",
                        fps=round(frame_count / elapsed),
                        objectCount=visible_count,
                    )
                    frame_count = 0
                    last_fps_at = now
        except Exception as exc:
            self._set_status(running=False, state="error", error=str(exc))
            self._add_event("Workflow error", str(exc))
        finally:
            if capture is not None:
                capture.release()
            cv2.destroyAllWindows()
            if self._stop_event.is_set():
                self._set_status(running=False, state="stopped", fps=0, objectCount=0)
                self._add_event("Workflow stopped", "Python runtime stopped and released the camera.")

    def _set_status(self, **updates) -> None:
        with self._lock:
            self._status.update(updates)

    def _add_event(self, title: str, detail: str) -> None:
        event = {
            "time": time.strftime("%H:%M:%S"),
            "title": title,
            "detail": detail,
        }
        with self._lock:
            self._status["events"].insert(0, event)
            del self._status["events"][MAX_EVENTS:]


runner = WorkflowRunner()


class NoCacheHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/yolo26/models":
            json_response(self, 200, {"models": list(YOLO26_MODELS)})
            return
        if path == "/api/workflow/status":
            json_response(self, 200, runner.status())
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/workflow/start":
                payload = read_json_body(self)
                workflow = payload.get("workflow")
                if not isinstance(workflow, dict):
                    raise ValueError("Missing workflow payload.")
                json_response(self, 200, runner.start(workflow))
                return
            if path == "/api/workflow/stop":
                json_response(self, 200, runner.stop())
                return
            json_response(self, 404, {"error": "Not found"})
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
    print("The browser edits the workflow; Python owns capture, inference, and OpenCV display.")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    finally:
        runner.stop()


if __name__ == "__main__":
    main()
