# No-Code AI Vision

A first-pass no-code computer vision workflow builder, similar in spirit to n8n but focused on camera pipelines.

The included sample workflow is:

```text
Camera Loader -> Object Detection -> Class Filter -> Live Preview -> Alert Output
```

The app runs locally and uses the browser camera APIs. Object detection can run through a local Ultralytics YOLO26 backend or the original TensorFlow.js COCO-SSD browser model.

## Run

Install Python dependencies first:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

```powershell
.\.venv\Scripts\python.exe main.py
```

Open:

```text
http://127.0.0.1:8000
```

Camera access works on `localhost`/`127.0.0.1` in modern browsers. Click **Run**, grant camera permission, then adjust the nodes in the inspector. The first YOLO26 run downloads the selected Ultralytics weights, such as `yolo26n.pt`.

## Current nodes

- Camera Loader: chooses camera, resolution, and facing mode.
- Object Detection: selects Ultralytics YOLO26 or browser COCO-SSD, confidence threshold, and inference interval.
- Class Filter: passes only configured classes such as `person, car, dog`.
- Live Preview: draws bounding boxes and labels, with a fullscreen preview button.
- Alert Output: writes detection events with a cooldown.

## Next useful steps

- Add persisted workflow import.
- Add RTSP/IP camera loading through a backend worker.
- Add backend inference nodes for YOLO/ONNX/TensorRT.
- Add webhook, database, and snapshot output nodes.
