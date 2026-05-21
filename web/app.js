const NODE_WIDTH = 190;
const NODE_HEIGHT = 108;
const NODE_PORT_Y = 54;
const CANVAS_PADDING = 16;

const NODE_BLUEPRINTS = {
  camera: {
    title: "Camera Loader",
    subtitle: "Browser webcam or capture card",
    x: 44,
    y: 72,
    config: {
      deviceId: "",
      width: 1280,
      height: 720,
      facingMode: "environment",
    },
  },
  detector: {
    title: "Object Detection",
    subtitle: "COCO-SSD model in browser",
    x: 332,
    y: 72,
    config: {
      threshold: 0.55,
      intervalMs: 450,
      modelBase: "lite_mobilenet_v2",
    },
  },
  filter: {
    title: "Class Filter",
    subtitle: "Only pass selected labels",
    x: 332,
    y: 236,
    config: {
      classes: "person, car, dog, cat, bottle",
      minCount: 1,
    },
  },
  preview: {
    title: "Live Preview",
    subtitle: "Draw boxes and labels",
    x: 44,
    y: 400,
    config: {
      showBoxes: true,
      showLabels: true,
    },
  },
  alert: {
    title: "Alert Output",
    subtitle: "Browser event log",
    x: 332,
    y: 400,
    config: {
      cooldownSeconds: 5,
      message: "Detected target object",
    },
  },
};

const DEFAULT_WORKFLOW = {
  nodes: [
    makeNode("camera"),
    makeNode("detector"),
    makeNode("filter"),
    makeNode("preview"),
    makeNode("alert"),
  ],
  edges: [
    ["camera", "detector"],
    ["detector", "filter"],
    ["filter", "preview"],
    ["filter", "alert"],
  ],
};

const state = {
  workflow: loadWorkflow(),
  selectedNodeId: "camera",
  stream: null,
  model: null,
  running: false,
  modelLoading: false,
  cameraDevices: [],
  detections: [],
  filteredDetections: [],
  lastDetectionAt: 0,
  lastAlertAt: 0,
  frameCounter: 0,
  fps: 0,
  lastFpsAt: performance.now(),
  lastInferenceAt: 0,
  dragging: null,
  connecting: null,
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  updateNodeStatuses();
  renderInspector();
  renderEdges();
  listCameras();
  logEvent("Workflow ready", "Configure nodes, then run the sample pipeline.");
  if (window.lucide) {
    window.lucide.createIcons();
  }
});

function makeNode(type, overrides = {}) {
  const blueprint = NODE_BLUEPRINTS[type];
  return {
    id: overrides.id || type,
    type,
    title: blueprint.title,
    subtitle: blueprint.subtitle,
    x: overrides.x ?? blueprint.x,
    y: overrides.y ?? blueprint.y,
    enabled: overrides.enabled ?? true,
    status: "idle",
    config: {
      ...blueprint.config,
      ...(overrides.config || {}),
    },
  };
}

function cacheElements() {
  els.workflowCanvas = document.getElementById("workflowCanvas");
  els.nodeLayer = document.getElementById("nodeLayer");
  els.edgeLayer = document.getElementById("edgeLayer");
  els.nodeForm = document.getElementById("nodeForm");
  els.selectedNodeLabel = document.getElementById("selectedNodeLabel");
  els.workflowStatus = document.getElementById("workflowStatus");
  els.modelStatus = document.getElementById("modelStatus");
  els.cameraFeed = document.getElementById("cameraFeed");
  els.overlayCanvas = document.getElementById("overlayCanvas");
  els.emptyState = document.getElementById("emptyState");
  els.eventLog = document.getElementById("eventLog");
  els.fpsValue = document.getElementById("fpsValue");
  els.objectCount = document.getElementById("objectCount");
}

function bindEvents() {
  document.getElementById("startWorkflow").addEventListener("click", startWorkflow);
  document.getElementById("stopWorkflow").addEventListener("click", stopWorkflow);
  document.getElementById("saveWorkflow").addEventListener("click", saveWorkflow);
  document.getElementById("exportWorkflow").addEventListener("click", exportWorkflow);
  document.getElementById("resetWorkflow").addEventListener("click", resetWorkflow);

  document.querySelectorAll(".palette-item").forEach((button) => {
    button.draggable = true;
    button.addEventListener("click", () => selectNodeByType(button.dataset.type));
    button.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("application/x-node-type", button.dataset.type);
      event.dataTransfer.effectAllowed = "copy";
    });
  });

  els.workflowCanvas.addEventListener("dragover", (event) => {
    if (!Array.from(event.dataTransfer.types).includes("application/x-node-type")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  els.workflowCanvas.addEventListener("drop", (event) => {
    const type = event.dataTransfer.getData("application/x-node-type");
    if (!type) return;
    event.preventDefault();
    const point = canvasPoint(event);
    addNodeToCanvas(type, point.x - NODE_WIDTH / 2, point.y - NODE_HEIGHT / 2);
  });

  window.addEventListener("resize", () => {
    renderEdges();
    drawDetections();
  });

  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointermove", onConnectionMove);
  document.addEventListener("pointerup", stopPointerAction);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      const active = document.activeElement;
      if (active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
      if (state.selectedNodeId) removeNode(state.selectedNodeId);
    }
  });
}

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    logEvent("Camera API unavailable", "Use a modern browser on localhost or HTTPS.");
    return;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  state.cameraDevices = devices.filter((device) => device.kind === "videoinput");
  renderInspector();
}

function loadWorkflow() {
  try {
    const stored = localStorage.getItem("visionWorkflow");
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        return parsed;
      }
    }
  } catch (error) {
    console.warn(error);
  }
  return structuredClone(DEFAULT_WORKFLOW);
}

function saveWorkflow() {
  localStorage.setItem("visionWorkflow", JSON.stringify(state.workflow));
  logEvent("Workflow saved", "The graph and node settings were stored in this browser.");
}

function exportWorkflow() {
  const payload = JSON.stringify(state.workflow, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "vision-workflow.json";
  link.click();
  URL.revokeObjectURL(url);
  logEvent("Workflow exported", "Downloaded vision-workflow.json.");
}

function resetWorkflow() {
  state.workflow = structuredClone(DEFAULT_WORKFLOW);
  state.selectedNodeId = "camera";
  saveWorkflow();
  updateNodeStatuses();
  renderInspector();
  renderEdges();
}

function renderWorkflow() {
  els.nodeLayer.innerHTML = "";
  for (const node of state.workflow.nodes) {
    const element = document.createElement("article");
    element.className = `workflow-node ${node.id === state.selectedNodeId ? "selected" : ""}`;
    element.style.transform = `translate(${node.x}px, ${node.y}px)`;
    element.dataset.nodeId = node.id;
    element.innerHTML = `
      <span class="node-port in" data-port="in" title="Connect input"></span>
      <div class="node-title-row">
        <span class="node-title">${escapeHtml(node.title)}</span>
        <span class="status-pill ${node.enabled ? "" : "paused"}">${node.enabled ? node.status : "off"}</span>
      </div>
      <div class="node-subtitle">${escapeHtml(node.subtitle)}</div>
      <div class="node-actions">
        <button class="mini-button" data-action="select">Config</button>
        <button class="mini-button" data-action="toggle">${node.enabled ? "Disable" : "Enable"}</button>
        <button class="mini-button danger" data-action="remove" title="Remove node">Remove</button>
      </div>
      <span class="node-port out" data-port="out" title="Drag to connect"></span>
    `;
    element.addEventListener("pointerdown", (event) => startDrag(event, node.id));
    element.querySelector('[data-port="out"]').addEventListener("pointerdown", (event) => {
      startConnection(event, node.id);
    });
    element.querySelector('[data-action="select"]').addEventListener("click", (event) => {
      event.stopPropagation();
      selectNode(node.id);
    });
    element.querySelector('[data-action="toggle"]').addEventListener("click", (event) => {
      event.stopPropagation();
      toggleNode(node.id);
    });
    element.querySelector('[data-action="remove"]').addEventListener("click", (event) => {
      event.stopPropagation();
      removeNode(node.id);
    });
    element.addEventListener("click", () => selectNode(node.id));
    els.nodeLayer.appendChild(element);
  }
}

function renderEdges() {
  const rect = els.workflowCanvas.getBoundingClientRect();
  els.edgeLayer.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  els.edgeLayer.innerHTML = "";
  state.workflow.edges.forEach(([fromId, toId], index) => {
    const from = state.workflow.nodes.find((node) => node.id === fromId);
    const to = state.workflow.nodes.find((node) => node.id === toId);
    if (!from || !to) return;
    const startX = from.x + NODE_WIDTH;
    const startY = from.y + NODE_PORT_Y;
    const endX = to.x;
    const endY = to.y + NODE_PORT_Y;
    const d = connectionPath(startX, startY, endX, endY);
    const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hitPath.setAttribute("d", d);
    hitPath.setAttribute("fill", "none");
    hitPath.setAttribute("stroke", "transparent");
    hitPath.setAttribute("stroke-width", "16");
    hitPath.setAttribute("stroke-linecap", "round");
    hitPath.dataset.edgeIndex = String(index);
    hitPath.classList.add("edge-hit-path");
    hitPath.addEventListener("click", () => removeEdge(index));
    els.edgeLayer.appendChild(hitPath);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#126b63");
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linecap", "round");
    path.classList.add("edge-path");
    els.edgeLayer.appendChild(path);
  });

  if (state.connecting) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", connectionPath(
      state.connecting.startX,
      state.connecting.startY,
      state.connecting.currentX,
      state.connecting.currentY
    ));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#b9432f");
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-dasharray", "6 6");
    path.classList.add("edge-path", "preview");
    els.edgeLayer.appendChild(path);
  }
}

function renderInspector() {
  const node = selectedNode();
  if (!node) {
    els.selectedNodeLabel.textContent = "No node selected";
    els.nodeForm.innerHTML = '<div class="empty-inspector">Select a node or drag one from the palette.</div>';
    return;
  }
  els.selectedNodeLabel.textContent = node.title;
  els.nodeForm.innerHTML = "";
  els.nodeForm.appendChild(makeToggleField("enabled", "Enabled", node.enabled, (checked) => {
    node.enabled = checked;
    renderWorkflow();
    updateNodeStatuses();
  }));

  if (node.type === "camera") {
    els.nodeForm.appendChild(makeSelectField("deviceId", "Camera", node.config.deviceId, cameraOptions(), (value) => {
      node.config.deviceId = value;
    }));
    els.nodeForm.appendChild(makeSelectField("facingMode", "Facing mode", node.config.facingMode, [
      ["environment", "Rear / environment"],
      ["user", "Front / user"],
    ], (value) => {
      node.config.facingMode = value;
    }));
    els.nodeForm.appendChild(makeNumberField("width", "Width", node.config.width, 320, 3840, (value) => {
      node.config.width = value;
    }));
    els.nodeForm.appendChild(makeNumberField("height", "Height", node.config.height, 240, 2160, (value) => {
      node.config.height = value;
    }));
  }

  if (node.type === "detector") {
    els.nodeForm.appendChild(makeRangeField("threshold", "Confidence", node.config.threshold, 0.1, 0.95, 0.05, (value) => {
      node.config.threshold = value;
    }));
    els.nodeForm.appendChild(makeNumberField("intervalMs", "Inference interval ms", node.config.intervalMs, 150, 2000, (value) => {
      node.config.intervalMs = value;
    }));
    els.nodeForm.appendChild(makeSelectField("modelBase", "Model", node.config.modelBase, [
      ["lite_mobilenet_v2", "Fast mobile model"],
      ["mobilenet_v1", "Balanced model"],
      ["mobilenet_v2", "More accurate model"],
    ], (value) => {
      node.config.modelBase = value;
      state.model = null;
      els.modelStatus.textContent = "Model changed";
    }));
  }

  if (node.type === "filter") {
    els.nodeForm.appendChild(makeTextAreaField("classes", "Allowed classes", node.config.classes, (value) => {
      node.config.classes = value;
    }));
    els.nodeForm.appendChild(makeNumberField("minCount", "Minimum count", node.config.minCount, 1, 100, (value) => {
      node.config.minCount = value;
    }));
  }

  if (node.type === "preview") {
    els.nodeForm.appendChild(makeToggleField("showBoxes", "Show boxes", node.config.showBoxes, (checked) => {
      node.config.showBoxes = checked;
      drawDetections();
    }));
    els.nodeForm.appendChild(makeToggleField("showLabels", "Show labels", node.config.showLabels, (checked) => {
      node.config.showLabels = checked;
      drawDetections();
    }));
  }

  if (node.type === "alert") {
    els.nodeForm.appendChild(makeNumberField("cooldownSeconds", "Cooldown seconds", node.config.cooldownSeconds, 1, 120, (value) => {
      node.config.cooldownSeconds = value;
    }));
    els.nodeForm.appendChild(makeTextAreaField("message", "Alert message", node.config.message, (value) => {
      node.config.message = value;
    }));
  }
}

function cameraOptions() {
  const options = [["", "Default camera"]];
  for (const device of state.cameraDevices) {
    options.push([device.deviceId, device.label || `Camera ${options.length}`]);
  }
  return options;
}

function makeSelectField(name, label, value, options, onChange) {
  const wrapper = makeLabel(label);
  const select = document.createElement("select");
  select.name = name;
  for (const [optionValue, optionLabel] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionLabel;
    option.selected = optionValue === value;
    select.appendChild(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  wrapper.appendChild(select);
  return wrapper;
}

function makeNumberField(name, label, value, min, max, onChange) {
  const wrapper = makeLabel(label);
  const input = document.createElement("input");
  input.type = "number";
  input.name = name;
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.addEventListener("input", () => onChange(Number(input.value)));
  wrapper.appendChild(input);
  return wrapper;
}

function makeRangeField(name, label, value, min, max, step, onChange) {
  const wrapper = makeLabel(`${label}: ${Number(value).toFixed(2)}`);
  const input = document.createElement("input");
  input.type = "range";
  input.name = name;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    wrapper.querySelector("span").textContent = `${label}: ${Number(input.value).toFixed(2)}`;
    onChange(Number(input.value));
  });
  wrapper.appendChild(input);
  return wrapper;
}

function makeTextAreaField(name, label, value, onChange) {
  const wrapper = makeLabel(label);
  const textarea = document.createElement("textarea");
  textarea.name = name;
  textarea.value = value;
  textarea.addEventListener("input", () => onChange(textarea.value));
  wrapper.appendChild(textarea);
  return wrapper;
}

function makeToggleField(name, label, value, onChange) {
  const wrapper = document.createElement("label");
  wrapper.className = "checkbox-row";
  const text = document.createElement("span");
  text.textContent = label;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.checked = value;
  input.addEventListener("change", () => onChange(input.checked));
  wrapper.append(text, input);
  return wrapper;
}

function makeLabel(label) {
  const wrapper = document.createElement("label");
  const text = document.createElement("span");
  text.textContent = label;
  wrapper.appendChild(text);
  return wrapper;
}

async function startWorkflow() {
  if (state.running) return;
  setStatus("Starting");
  updateNodeStatuses("starting");
  try {
    await startCamera();
    await listCameras();
    await loadDetectionModel();
    state.running = true;
    state.lastFpsAt = performance.now();
    state.frameCounter = 0;
    setStatus("Running");
    updateNodeStatuses("running");
    logEvent("Workflow running", "Camera frames are flowing through object detection.");
    requestAnimationFrame(processFrame);
  } catch (error) {
    console.error(error);
    setStatus("Error");
    updateNodeStatuses("error");
    logEvent("Start failed", error.message || "Unable to start workflow.");
  }
}

async function startCamera() {
  const camera = getNode("camera");
  if (!camera?.enabled) {
    throw new Error("Camera Loader node is disabled.");
  }
  stopCamera();
  const video = {
    width: { ideal: Number(camera.config.width) || 1280 },
    height: { ideal: Number(camera.config.height) || 720 },
  };
  if (camera.config.deviceId) {
    video.deviceId = { exact: camera.config.deviceId };
  } else if (camera.config.facingMode) {
    video.facingMode = { ideal: camera.config.facingMode };
  }
  state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  els.cameraFeed.srcObject = state.stream;
  await els.cameraFeed.play();
  resizeOverlay();
  els.emptyState.classList.add("hidden");
}

async function loadDetectionModel() {
  const detector = activeDetectorNode();
  if (!detector) {
    return;
  }
  if (state.model || state.modelLoading) return;
  if (!window.cocoSsd) {
    throw new Error("COCO-SSD library did not load. Check the internet connection for CDN assets.");
  }
  state.modelLoading = true;
  els.modelStatus.textContent = "Loading model";
  try {
    state.model = await window.cocoSsd.load({ base: detector.config.modelBase });
    els.modelStatus.textContent = "Model ready";
  } finally {
    state.modelLoading = false;
  }
}

function stopWorkflow() {
  state.running = false;
  state.detections = [];
  state.filteredDetections = [];
  stopCamera();
  clearCanvas();
  setStatus("Stopped");
  updateNodeStatuses("idle");
  els.emptyState.classList.remove("hidden");
  els.fpsValue.textContent = "0";
  els.objectCount.textContent = "0";
  logEvent("Workflow stopped", "Camera stream closed.");
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  els.cameraFeed.srcObject = null;
}

async function processFrame(timestamp) {
  if (!state.running) return;
  updateFps(timestamp);
  const detector = activeDetectorNode();
  if (detector && !state.model && !state.modelLoading) {
    loadDetectionModel().catch((error) => {
      console.error(error);
      setStatus("Error");
      updateNodeStatuses("error");
      logEvent("Model load failed", error.message || "Unable to load detection model.");
    });
  }
  if (!detector) {
    state.detections = [];
    state.filteredDetections = [];
    els.objectCount.textContent = "0";
    clearCanvas();
    requestAnimationFrame(processFrame);
    return;
  }

  const shouldInfer = state.model && timestamp - state.lastInferenceAt >= Number(detector.config.intervalMs);
  if (shouldInfer) {
    state.lastInferenceAt = timestamp;
    const predictions = await state.model.detect(els.cameraFeed);
    state.detections = predictions.filter((item) => item.score >= Number(detector.config.threshold));
    state.filteredDetections = filterDetections(state.detections);
    els.objectCount.textContent = String(detectionsForNode("preview").length || detectionsForNode("alert").length);
    drawDetections();
    maybeAlert();
  }
  requestAnimationFrame(processFrame);
}

function filterDetections(detections) {
  const filter = activeFilterNode();
  if (!filter) return detections;
  const classes = filter.config.classes
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const filtered = classes.length
    ? detections.filter((item) => classes.includes(item.class.toLowerCase()))
    : detections;
  return filtered.length >= Number(filter.config.minCount) ? filtered : [];
}

function drawDetections() {
  resizeOverlay();
  clearCanvas();
  const preview = getNode("preview");
  if (!preview?.enabled || !isGraphNodeActive("preview")) return;
  const visibleDetections = detectionsForNode("preview");
  if (!visibleDetections.length) return;
  const ctx = els.overlayCanvas.getContext("2d");
  const scaleX = els.overlayCanvas.width / els.cameraFeed.videoWidth;
  const scaleY = els.overlayCanvas.height / els.cameraFeed.videoHeight;
  for (const detection of visibleDetections) {
    const [x, y, width, height] = detection.bbox;
    const boxX = x * scaleX;
    const boxY = y * scaleY;
    const boxWidth = width * scaleX;
    const boxHeight = height * scaleY;
    if (preview.config.showBoxes) {
      ctx.strokeStyle = "#29d391";
      ctx.lineWidth = 3;
      ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);
    }
    if (preview.config.showLabels) {
      const label = `${detection.class} ${Math.round(detection.score * 100)}%`;
      ctx.font = "700 14px system-ui";
      const labelWidth = ctx.measureText(label).width + 12;
      ctx.fillStyle = "rgba(8, 18, 27, 0.88)";
      ctx.fillRect(boxX, Math.max(0, boxY - 26), labelWidth, 24);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, boxX + 6, Math.max(16, boxY - 9));
    }
  }
}

function resizeOverlay() {
  if (!els.cameraFeed.videoWidth || !els.cameraFeed.videoHeight) return;
  if (
    els.overlayCanvas.width !== els.cameraFeed.videoWidth ||
    els.overlayCanvas.height !== els.cameraFeed.videoHeight
  ) {
    els.overlayCanvas.width = els.cameraFeed.videoWidth;
    els.overlayCanvas.height = els.cameraFeed.videoHeight;
  }
}

function clearCanvas() {
  const ctx = els.overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
}

function maybeAlert() {
  const alertNode = getNode("alert");
  if (!alertNode?.enabled || !isGraphNodeActive("alert")) return;
  const alertDetections = detectionsForNode("alert");
  if (!alertDetections.length) return;
  const now = Date.now();
  const cooldownMs = Number(alertNode.config.cooldownSeconds) * 1000;
  if (now - state.lastAlertAt < cooldownMs) return;
  state.lastAlertAt = now;
  const labels = alertDetections.map((item) => item.class).join(", ");
  logEvent(alertNode.config.message, `${alertDetections.length} match(es): ${labels}`);
}

function updateFps(timestamp) {
  state.frameCounter += 1;
  const elapsed = timestamp - state.lastFpsAt;
  if (elapsed >= 1000) {
    state.fps = Math.round((state.frameCounter * 1000) / elapsed);
    state.frameCounter = 0;
    state.lastFpsAt = timestamp;
    els.fpsValue.textContent = String(state.fps);
  }
}

function logEvent(title, detail) {
  const item = document.createElement("li");
  item.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
  els.eventLog.prepend(item);
  while (els.eventLog.children.length > 8) {
    els.eventLog.lastChild.remove();
  }
}

function selectNode(id) {
  state.selectedNodeId = id;
  renderWorkflow();
  renderInspector();
}

function selectNodeByType(type) {
  const node = state.workflow.nodes.find((item) => item.type === type);
  if (node) selectNode(node.id);
}

function toggleNode(id) {
  const node = getNode(id);
  if (!node) return;
  node.enabled = !node.enabled;
  renderWorkflow();
  renderInspector();
  updateNodeStatuses();
}

function addNodeToCanvas(type, x, y) {
  const existing = state.workflow.nodes.find((node) => node.type === type);
  const rect = els.workflowCanvas.getBoundingClientRect();
  if (existing) {
    existing.x = clamp(x, CANVAS_PADDING, rect.width - NODE_WIDTH - CANVAS_PADDING);
    existing.y = clamp(y, CANVAS_PADDING, rect.height - NODE_HEIGHT - CANVAS_PADDING);
    selectNode(existing.id);
    renderEdges();
    saveWorkflow();
    return;
  }

  const node = makeNode(type, {
    x: clamp(x, CANVAS_PADDING, rect.width - NODE_WIDTH - CANVAS_PADDING),
    y: clamp(y, CANVAS_PADDING, rect.height - NODE_HEIGHT - CANVAS_PADDING),
  });
  state.workflow.nodes.push(node);
  selectNode(node.id);
  renderEdges();
  saveWorkflow();
}

function removeNode(id) {
  const node = getNode(id);
  if (!node) return;
  state.workflow.nodes = state.workflow.nodes.filter((item) => item.id !== id);
  state.workflow.edges = state.workflow.edges.filter(([fromId, toId]) => fromId !== id && toId !== id);
  if (state.selectedNodeId === id) {
    state.selectedNodeId = state.workflow.nodes[0]?.id || null;
  }
  if (node.type === "detector") {
    state.model = null;
    els.modelStatus.textContent = "Model not loaded";
  }
  updateNodeStatuses();
  renderWorkflow();
  renderInspector();
  renderEdges();
  saveWorkflow();
  logEvent("Node removed", `${node.title} was removed from the workflow.`);
}

function removeEdge(index) {
  const [fromId, toId] = state.workflow.edges[index] || [];
  state.workflow.edges.splice(index, 1);
  updateNodeStatuses();
  renderEdges();
  saveWorkflow();
  if (fromId && toId) {
    logEvent("Connection removed", `${edgeLabel(fromId)} -> ${edgeLabel(toId)}`);
  }
}

function connectNodes(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const exists = state.workflow.edges.some(([from, to]) => from === fromId && to === toId);
  if (exists) return;
  state.workflow.edges.push([fromId, toId]);
  updateNodeStatuses();
  renderEdges();
  saveWorkflow();
  logEvent("Connection added", `${edgeLabel(fromId)} -> ${edgeLabel(toId)}`);
}

function edgeLabel(id) {
  return getNode(id)?.title || id;
}

function selectedNode() {
  return getNode(state.selectedNodeId);
}

function getNode(id) {
  return state.workflow.nodes.find((node) => node.id === id);
}

function isGraphNodeActive(id) {
  const node = getNode(id);
  if (!node?.enabled) return false;
  if (id === "camera") return true;
  return hasActivePath("camera", id);
}

function activeDetectorNode() {
  const detector = getNode("detector");
  return detector?.enabled && hasActivePath("camera", "detector") ? detector : null;
}

function activeFilterNode() {
  const filter = getNode("filter");
  return filter?.enabled && activeDetectorNode() && hasActivePath("detector", "filter") ? filter : null;
}

function detectionsForNode(id) {
  if (!isGraphNodeActive(id)) return [];
  if (activeFilterNode() && hasActivePath("filter", id)) {
    return state.filteredDetections;
  }
  if (activeDetectorNode() && hasActivePath("detector", id)) {
    return state.detections;
  }
  return [];
}

function hasActivePath(fromId, toId) {
  const fromNode = getNode(fromId);
  const toNode = getNode(toId);
  if (!fromNode?.enabled || !toNode?.enabled) return false;
  if (fromId === toId) return true;

  const visited = new Set();
  const queue = [fromId];
  while (queue.length) {
    const currentId = queue.shift();
    if (currentId === toId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    for (const [edgeFromId, edgeToId] of state.workflow.edges) {
      if (edgeFromId !== currentId || visited.has(edgeToId)) continue;
      const nextNode = getNode(edgeToId);
      if (nextNode?.enabled) queue.push(edgeToId);
    }
  }
  return false;
}

function setStatus(status) {
  els.workflowStatus.textContent = status;
}

function updateNodeStatuses(status = null) {
  for (const node of state.workflow.nodes) {
    if (node.id !== "camera" && !isGraphNodeActive(node.id)) {
      node.status = "unlinked";
    } else if (status) {
      node.status = status;
    } else {
      node.status = state.running ? "running" : "idle";
    }
  }
  renderWorkflow();
}

function startDrag(event, nodeId) {
  if (event.target.closest("button, .node-port")) return;
  const node = getNode(nodeId);
  if (!node) return;
  const rect = els.workflowCanvas.getBoundingClientRect();
  state.dragging = {
    nodeId,
    offsetX: event.clientX - rect.left - node.x,
    offsetY: event.clientY - rect.top - node.y,
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  selectNode(nodeId);
}

function onDragMove(event) {
  if (!state.dragging) return;
  const node = getNode(state.dragging.nodeId);
  if (!node) return;
  const rect = els.workflowCanvas.getBoundingClientRect();
  node.x = clamp(event.clientX - rect.left - state.dragging.offsetX, CANVAS_PADDING, rect.width - NODE_WIDTH - CANVAS_PADDING);
  node.y = clamp(event.clientY - rect.top - state.dragging.offsetY, CANVAS_PADDING, rect.height - NODE_HEIGHT - CANVAS_PADDING);
  renderWorkflow();
  renderEdges();
}

function startConnection(event, nodeId) {
  event.preventDefault();
  event.stopPropagation();
  const node = getNode(nodeId);
  if (!node) return;
  state.connecting = {
    fromId: nodeId,
    startX: node.x + NODE_WIDTH,
    startY: node.y + NODE_PORT_Y,
    currentX: node.x + NODE_WIDTH,
    currentY: node.y + NODE_PORT_Y,
  };
  selectNode(nodeId);
  renderEdges();
}

function onConnectionMove(event) {
  if (!state.connecting) return;
  const point = canvasPoint(event);
  state.connecting.currentX = point.x;
  state.connecting.currentY = point.y;
  renderEdges();
}

function stopPointerAction(event) {
  const wasDragging = Boolean(state.dragging);
  if (state.connecting) {
    const targetPort = document.elementFromPoint(event.clientX, event.clientY)?.closest(".node-port.in");
    const toId = targetPort?.closest(".workflow-node")?.dataset.nodeId;
    connectNodes(state.connecting.fromId, toId);
    state.connecting = null;
    renderEdges();
  }
  if (state.dragging) {
    state.dragging = null;
  }
  if (wasDragging) {
    saveWorkflow();
  }
}

function canvasPoint(event) {
  const rect = els.workflowCanvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function connectionPath(startX, startY, endX, endY) {
  const direction = endX >= startX ? 1 : -1;
  const curve = Math.max(70, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + curve * direction} ${startY}, ${endX - curve * direction} ${endY}, ${endX} ${endY}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
