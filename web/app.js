const NODE_WIDTH = 210;
const NODE_HEIGHT = 88;
const NODE_PORT_Y = 44;
const CANVAS_PADDING = 16;

const NODE_ICONS = {
  camera: "video",
  detector: "scan-search",
  filter: "filter",
  preview: "monitor-play",
  alert: "bell-ring",
};

const NODE_BLUEPRINTS = {
  camera: {
    title: "Camera Loader",
    subtitle: "Python OpenCV capture",
    x: 44,
    y: 72,
    config: {
      source: 0,
      width: 1280,
      height: 720,
    },
  },
  detector: {
    title: "Object Detection",
    subtitle: "Backend Ultralytics YOLO26",
    x: 332,
    y: 72,
    config: {
      engine: "yolo26",
      threshold: 0.55,
      intervalMs: 450,
      yoloModel: "yolo26n.pt",
      imgsz: 640,
      end2end: true,
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
    title: "OpenCV Preview",
    subtitle: "Python display window",
    x: 44,
    y: 400,
    config: {
      showBoxes: true,
      showLabels: true,
    },
  },
  alert: {
    title: "Alert Output",
    subtitle: "Backend event log",
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
  workflow: normalizeWorkflow(loadWorkflow()),
  selectedNodeId: "camera",
  running: false,
  statusPollTimer: null,
  dragging: null,
  connecting: null,
  terminalCursor: 0,
  terminalPollTimer: null,
  terminalAutoScroll: true,
  contextMenuNodeId: null,
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  updateNodeStatuses();
  renderInspector();
  renderEdges();
  pollBackendStatus();
  startTerminalPolling();
  logEvent("Workflow ready", "The browser edits graph connections; Python runs the camera pipeline.");
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

function normalizeWorkflow(workflow) {
  for (const node of workflow.nodes || []) {
    const blueprint = NODE_BLUEPRINTS[node.type];
    if (!blueprint) continue;
    node.title = node.customTitle || blueprint.title;
    node.subtitle = blueprint.subtitle;
    node.config = { ...blueprint.config, ...(node.config || {}) };
    if (node.type === "camera" && node.config.source === undefined) {
      node.config.source = /^\d+$/.test(String(node.config.deviceId || "")) ? Number(node.config.deviceId) : 0;
    }
    if (node.type === "detector") {
      node.config.engine = "yolo26";
    }
  }
  return workflow;
}

function cacheElements() {
  els.workflowCanvas = document.getElementById("workflowCanvas");
  els.nodeLayer = document.getElementById("nodeLayer");
  els.edgeLayer = document.getElementById("edgeLayer");
  els.nodeForm = document.getElementById("nodeForm");
  els.selectedNodeLabel = document.getElementById("selectedNodeLabel");
  els.workflowStatus = document.getElementById("workflowStatus");
  els.eventLog = document.getElementById("eventLog");
  els.fpsValue = document.getElementById("fpsValue");
  els.objectCount = document.getElementById("objectCount");
  els.terminalPanel = document.getElementById("terminalPanel");
  els.terminalHeader = document.getElementById("terminalHeader");
  els.terminalBody = document.getElementById("terminalBody");
  els.terminalToggle = document.getElementById("terminalToggle");
  els.terminalClear = document.getElementById("terminalClear");
  els.terminalOpen = document.getElementById("terminalOpen");
  els.terminalStatus = document.getElementById("terminalStatus");
  els.contextMenu = document.getElementById("nodeContextMenu");
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

  window.addEventListener("resize", renderEdges);
  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointermove", onConnectionMove);
  document.addEventListener("pointerup", stopPointerAction);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu();
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const active = document.activeElement;
    if (active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
    if (state.selectedNodeId) removeNode(state.selectedNodeId);
  });

  els.terminalHeader.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    toggleTerminal();
  });
  els.terminalToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleTerminal();
  });
  els.terminalClear.addEventListener("click", (event) => {
    event.stopPropagation();
    els.terminalBody.innerHTML = "";
  });
  els.terminalOpen.addEventListener("click", (event) => {
    event.stopPropagation();
    openExternalTerminal();
  });
  els.terminalBody.addEventListener("scroll", () => {
    const body = els.terminalBody;
    state.terminalAutoScroll = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  });

  els.contextMenu.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const nodeId = state.contextMenuNodeId;
    hideContextMenu();
    if (!nodeId) return;
    if (action === "delete") removeNode(nodeId);
    else if (action === "toggle") toggleNode(nodeId);
    else if (action === "rename") renameNode(nodeId);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!els.contextMenu.contains(event.target)) hideContextMenu();
  });
  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("resize", hideContextMenu);
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
  normalizeWorkflow(state.workflow);
  localStorage.setItem("visionWorkflow", JSON.stringify(state.workflow));
  logEvent("Workflow saved", "The graph and node settings were stored in this browser.");
}

function exportWorkflow() {
  normalizeWorkflow(state.workflow);
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
    element.dataset.type = node.type;
    const statusKey = node.enabled ? node.status : "off";
    const statusLabel = node.enabled ? node.status : "off";
    const toggleIcon = node.enabled ? "pause" : "play";
    const toggleTitle = node.enabled ? "Disable node" : "Enable node";
    element.innerHTML = `
      <span class="node-port in" data-port="in" title="Connect input"></span>
      <div class="node-toolbar">
        <button class="mini-button" data-action="toggle" title="${toggleTitle}"><i data-lucide="${toggleIcon}"></i></button>
        <button class="mini-button danger" data-action="remove" title="Remove node"><i data-lucide="trash-2"></i></button>
      </div>
      <div class="node-icon"><i data-lucide="${NODE_ICONS[node.type] || "box"}"></i></div>
      <div class="node-body">
        <div class="node-title-row">
          <span class="node-title">${escapeHtml(node.title)}</span>
          <span class="status-pill" data-status="${escapeHtml(statusKey)}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="node-subtitle">${escapeHtml(node.subtitle)}</div>
      </div>
      <span class="node-port out" data-port="out" title="Drag to connect"></span>
    `;
    element.addEventListener("pointerdown", (event) => startDrag(event, node.id));
    element.querySelector('[data-port="out"]').addEventListener("pointerdown", (event) => {
      startConnection(event, node.id);
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
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      selectNode(node.id);
      showContextMenu(event.clientX, event.clientY, node.id);
    });
    els.nodeLayer.appendChild(element);
  }
  if (window.lucide) window.lucide.createIcons();
}

function renderEdges() {
  const rect = els.workflowCanvas.getBoundingClientRect();
  els.edgeLayer.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  els.edgeLayer.innerHTML = "";
  state.workflow.edges.forEach(([fromId, toId], index) => {
    const from = getNode(fromId);
    const to = getNode(toId);
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
    path.setAttribute("stroke", "#5b6275");
    path.setAttribute("stroke-width", "2.5");
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
    path.setAttribute("stroke", "#ff6d5a");
    path.setAttribute("stroke-width", "2.5");
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
    els.nodeForm.appendChild(makeTextField("source", "OpenCV source", node.config.source, (value) => {
      node.config.source = /^\d+$/.test(value) ? Number(value) : value;
    }));
    els.nodeForm.appendChild(makeNumberField("width", "Width", node.config.width, 320, 3840, (value) => {
      node.config.width = value;
    }));
    els.nodeForm.appendChild(makeNumberField("height", "Height", node.config.height, 240, 2160, (value) => {
      node.config.height = value;
    }));
  }

  if (node.type === "detector") {
    node.config.engine = "yolo26";
    els.nodeForm.appendChild(makeRangeField("threshold", "Confidence", node.config.threshold, 0.1, 0.95, 0.05, (value) => {
      node.config.threshold = value;
    }));
    els.nodeForm.appendChild(makeNumberField("intervalMs", "Inference interval ms", node.config.intervalMs, 150, 2000, (value) => {
      node.config.intervalMs = value;
    }));
    els.nodeForm.appendChild(makeSelectField("yoloModel", "YOLO26 model", node.config.yoloModel || "yolo26n.pt", [
      ["yolo26n.pt", "YOLO26 nano"],
      ["yolo26s.pt", "YOLO26 small"],
      ["yolo26m.pt", "YOLO26 medium"],
      ["yolo26l.pt", "YOLO26 large"],
      ["yolo26x.pt", "YOLO26 extra large"],
    ], (value) => {
      node.config.yoloModel = value;
    }));
    els.nodeForm.appendChild(makeNumberField("imgsz", "Image size", node.config.imgsz || 640, 320, 1280, (value) => {
      node.config.imgsz = value;
    }));
    els.nodeForm.appendChild(makeToggleField("end2end", "End-to-end head", node.config.end2end ?? true, (checked) => {
      node.config.end2end = checked;
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
    }));
    els.nodeForm.appendChild(makeToggleField("showLabels", "Show labels", node.config.showLabels, (checked) => {
      node.config.showLabels = checked;
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

function makeTextField(name, label, value, onChange) {
  const wrapper = makeLabel(label);
  const input = document.createElement("input");
  input.type = "text";
  input.name = name;
  input.value = String(value ?? "");
  input.addEventListener("input", () => onChange(input.value));
  wrapper.appendChild(input);
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
    normalizeWorkflow(state.workflow);
    saveWorkflow();
    const payload = await postJson("/api/workflow/start", { workflow: state.workflow });
    renderBackendStatus(payload);
    startStatusPolling();
  } catch (error) {
    console.error(error);
    setStatus("Error");
    updateNodeStatuses("error");
    logEvent("Start failed", error.message || "Unable to start workflow.");
  }
}

async function stopWorkflow() {
  try {
    const payload = await postJson("/api/workflow/stop", {});
    renderBackendStatus(payload);
  } catch (error) {
    console.error(error);
    logEvent("Stop failed", error.message || "Unable to stop workflow.");
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `${url} failed.`);
  }
  return body;
}

function startStatusPolling() {
  if (state.statusPollTimer) return;
  state.statusPollTimer = window.setInterval(pollBackendStatus, 750);
}

async function pollBackendStatus() {
  try {
    const response = await fetch("/api/workflow/status", { cache: "no-store" });
    if (!response.ok) return;
    renderBackendStatus(await response.json());
  } catch (error) {
    console.warn(error);
  }
}

function renderBackendStatus(payload) {
  state.running = Boolean(payload.running);
  setStatus(titleCase(payload.state || "idle"));
  els.fpsValue.textContent = String(payload.fps || 0);
  els.objectCount.textContent = String(payload.objectCount || 0);
  updateNodeStatuses(payload.state === "error" ? "error" : state.running ? "running" : "idle");
  if (Array.isArray(payload.events) && payload.events.length) {
    renderEvents(payload.events);
  }
  if (state.running && !state.statusPollTimer) {
    state.statusPollTimer = window.setInterval(pollBackendStatus, 750);
  }
  if (!state.running && state.statusPollTimer) {
    window.clearInterval(state.statusPollTimer);
    state.statusPollTimer = null;
  }
}

function renderEvents(events) {
  els.eventLog.innerHTML = "";
  for (const event of events.slice(0, 8)) {
    const item = document.createElement("li");
    const time = event.time ? `${event.time} ` : "";
    item.innerHTML = `<strong>${escapeHtml(time + event.title)}</strong><span>${escapeHtml(event.detail)}</span>`;
    els.eventLog.appendChild(item);
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

function titleCase(value) {
  return String(value).slice(0, 1).toUpperCase() + String(value).slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* ===== Terminal ===== */
function startTerminalPolling() {
  if (state.terminalPollTimer) return;
  pollTerminal();
  state.terminalPollTimer = window.setInterval(pollTerminal, 500);
}

async function pollTerminal() {
  try {
    const response = await fetch(`/api/terminal/logs?since=${state.terminalCursor}`, { cache: "no-store" });
    if (!response.ok) {
      setTerminalStatus("disconnected", "Disconnected");
      return;
    }
    const payload = await response.json();
    setTerminalStatus("connected", "Connected");
    if (typeof payload.cursor === "number") state.terminalCursor = payload.cursor;
    if (Array.isArray(payload.lines) && payload.lines.length) {
      appendTerminalLines(payload.lines);
    }
  } catch (error) {
    setTerminalStatus("disconnected", "Disconnected");
  }
}

async function openExternalTerminal() {
  try {
    const response = await fetch("/api/terminal/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Could not open external terminal.");
    }
    pollTerminal();
  } catch (error) {
    appendTerminalLines([
      {
        time: new Date().toLocaleTimeString([], { hour12: false }),
        text: `ERROR: ${error.message}`,
      },
    ]);
  }
}

function appendTerminalLines(lines) {
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const row = document.createElement("div");
    row.className = `term-line ${classifyTerminalLine(line.text)}`;
    row.innerHTML = `<span class="term-time">${escapeHtml(line.time || "")}</span><span class="term-text">${escapeHtml(line.text)}</span>`;
    fragment.appendChild(row);
  }
  els.terminalBody.appendChild(fragment);
  while (els.terminalBody.childElementCount > 800) {
    els.terminalBody.firstElementChild.remove();
  }
  if (state.terminalAutoScroll) {
    els.terminalBody.scrollTop = els.terminalBody.scrollHeight;
  }
}

function classifyTerminalLine(text) {
  const value = String(text || "");
  if (/^error\b|^err\b|: error|exception/i.test(value)) return "err";
  if (/^warn\b|warning/i.test(value)) return "warn";
  if (/loaded|running|opened|workflow/i.test(value)) return "ok";
  return "";
}

function setTerminalStatus(state, label) {
  if (!els.terminalStatus) return;
  els.terminalStatus.dataset.state = state;
  els.terminalStatus.textContent = label;
}

function toggleTerminal() {
  const collapsed = els.terminalPanel.dataset.collapsed === "true";
  els.terminalPanel.dataset.collapsed = collapsed ? "false" : "true";
  if (!collapsed) return;
  state.terminalAutoScroll = true;
  els.terminalBody.scrollTop = els.terminalBody.scrollHeight;
}

/* ===== Context menu ===== */
function showContextMenu(clientX, clientY, nodeId) {
  const node = getNode(nodeId);
  if (!node) return;
  state.contextMenuNodeId = nodeId;
  const toggleLabel = els.contextMenu.querySelector('[data-label="toggle"]');
  if (toggleLabel) toggleLabel.textContent = node.enabled ? "Disable" : "Enable";

  els.contextMenu.hidden = false;
  const rect = els.contextMenu.getBoundingClientRect();
  const x = Math.min(clientX, window.innerWidth - rect.width - 6);
  const y = Math.min(clientY, window.innerHeight - rect.height - 6);
  els.contextMenu.style.left = `${Math.max(6, x)}px`;
  els.contextMenu.style.top = `${Math.max(6, y)}px`;
  if (window.lucide) window.lucide.createIcons();
}

function hideContextMenu() {
  if (!els.contextMenu || els.contextMenu.hidden) return;
  els.contextMenu.hidden = true;
  state.contextMenuNodeId = null;
}

function renameNode(nodeId) {
  const node = getNode(nodeId);
  if (!node) return;
  const current = node.customTitle || node.title || "";
  const next = window.prompt("Rename node", current);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) {
    delete node.customTitle;
  } else {
    node.customTitle = trimmed;
  }
  node.title = node.customTitle || NODE_BLUEPRINTS[node.type]?.title || node.title;
  renderWorkflow();
  renderInspector();
  saveWorkflow();
}
