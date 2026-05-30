# No-Code AI Vision

A first-pass no-code computer vision workflow builder, similar in spirit to n8n but focused on vision input pipelines.

The included sample workflow is:

```text
Input -> Object Detection -> Class Filter -> OpenCV Preview -> Alert Output
```

The app runs locally. The browser is only the workflow editor: it sends the graph and node settings to Python. Python owns camera/file loading, YOLO26 inference, filtering, alert generation, and preview display through OpenCV.

## Run

Install Python dependencies first. The default install uses the normal Python packages and runs on CPU:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

On Apple Silicon Macs (M1–M5), the default install already includes Metal (MPS) GPU acceleration and CoreML support — use a virtual environment instead of the PowerShell paths:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`coremltools` is installed automatically on macOS, so both the Apple GPU (MPS) and the CoreML / Neural Engine device are available without any extra step.

For NVIDIA GPU acceleration, install the CUDA-enabled PyTorch build before running the app:

```powershell
.\scripts\install-gpu.ps1
```

The GPU installer uses PyTorch's CUDA wheel index, installs the app requirements, and runs a CUDA smoke test. By default it installs the `cu128` wheel set. To target another supported PyTorch CUDA wheel set:

```powershell
.\scripts\install-gpu.ps1 -CudaWheel cu126
```

To diagnose an existing install:

```powershell
.\scripts\check-gpu.ps1
```

```powershell
.\.venv\Scripts\python.exe main.py
```

Open:

```text
http://127.0.0.1:8000
```

Open the editor, configure the graph, then click **Run**. Python opens the configured input source, processes frames according to the active node connections, and displays the output in a native OpenCV window. Press **Stop**, `q`, or `Esc` to stop the runtime. The first YOLO26 run downloads the selected Ultralytics weights, such as `yolo26n.pt`.

The Object Detection node includes a **Device** setting:

- Auto: uses CUDA when PyTorch sees an NVIDIA GPU, then the Apple GPU (MPS) on Apple Silicon, otherwise CPU.
- CPU: always runs inference on CPU.
- CUDA devices: require a working CUDA-enabled PyTorch install and fail loudly if CUDA is unavailable.
- MPS (Apple GPU): runs on the Metal GPU of Apple Silicon Macs. Available automatically with the default macOS install.
- CoreML (Apple Neural Engine): exports the model to a CoreML package on first use, then runs it through the Neural Engine/GPU — the fastest option in local testing. Requires `coremltools` (installed automatically on macOS). The export is cached per input size, so only the first run is slow. Note: the CoreML *export* depends on the installed `torch`/`coremltools` versions matching; with bleeding-edge PyTorch the export can occasionally fail, in which case the app reports it clearly and you can retry or use the MPS device.

## Current nodes

- Input: chooses camera or file mode. Camera mode accepts an OpenCV camera index, stream URL, or capture source plus resolution. File mode accepts a local image or video path and can loop video files.
- Object Detection: selects Ultralytics YOLO26 model, confidence threshold, inference interval, and the inference device (CPU, NVIDIA GPU, or Apple Silicon GPU/Neural Engine).
- Class Filter: passes only configured classes such as `person, car, dog`.
- OpenCV Preview: draws bounding boxes and labels in a native OpenCV window.
- Alert Output: writes backend detection events with a cooldown.

## License

This project is licensed under the GNU Affero General Public License v3.0, the same open-source license used by Ultralytics repositories. See [LICENSE](LICENSE).

## Next useful steps

- Add persisted workflow import.
- Add RTSP/IP camera presets.
- Add inference nodes for ONNX/TensorRT.
- Add webhook, database, and snapshot output nodes.
