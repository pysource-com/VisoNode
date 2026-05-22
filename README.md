# No-Code AI Vision

A first-pass no-code computer vision workflow builder, similar in spirit to n8n but focused on camera pipelines.

The included sample workflow is:

```text
Camera Loader -> Object Detection -> Class Filter -> OpenCV Preview -> Alert Output
```

The app runs locally. The browser is only the workflow editor: it sends the graph and node settings to Python. Python owns camera capture, YOLO26 inference, filtering, alert generation, and preview display through OpenCV.

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

Open the editor, configure the graph, then click **Run**. Python opens the configured OpenCV camera source, processes frames according to the active node connections, and displays the output in a native OpenCV window. Press **Stop**, `q`, or `Esc` to stop the runtime. The first YOLO26 run downloads the selected Ultralytics weights, such as `yolo26n.pt`.

## Current nodes

- Camera Loader: chooses the OpenCV source, resolution, and capture settings.
- Object Detection: selects Ultralytics YOLO26 model, confidence threshold, and inference interval.
- Class Filter: passes only configured classes such as `person, car, dog`.
- OpenCV Preview: draws bounding boxes and labels in a native OpenCV window.
- Alert Output: writes backend detection events with a cooldown.

## Next useful steps

- Add persisted workflow import.
- Add RTSP/IP camera presets.
- Add inference nodes for ONNX/TensorRT.
- Add webhook, database, and snapshot output nodes.
