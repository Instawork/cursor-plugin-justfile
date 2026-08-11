/* global acquireVsCodeApi */
(function () {
  const bootError = document.getElementById("bootError");
  const fileLabel = document.getElementById("fileLabel");
  const rail = document.getElementById("rail");
  const railFilter = document.getElementById("railFilter");
  const graph = document.getElementById("graph");
  const graphError = document.getElementById("graphError");
  const promptTitle = document.getElementById("promptTitle");
  const promptPath = document.getElementById("promptPath");
  const promptEditor = document.getElementById("promptEditor");
  const promptError = document.getElementById("promptError");
  const promptFooter = document.getElementById("promptFooter");
  const saveStatus = document.getElementById("saveStatus");
  const promptStatusChip = document.getElementById("promptStatusChip");
  const graphStatusChip = document.getElementById("graphStatusChip");
  const conflictBanner = document.getElementById("conflictBanner");
  const conflictText = document.getElementById("conflictText");
  const keepMine = document.getElementById("keepMine");
  const loadDisk = document.getElementById("loadDisk");
  const bindCard = document.getElementById("bindCard");
  const bindCardTitle = document.getElementById("bindCardTitle");
  const bindCardBody = document.getElementById("bindCardBody");
  const bindCreateBtn = document.getElementById("bindCreateBtn");
  const bindLinkBtn = document.getElementById("bindLinkBtn");
  const bindOpenMmdBtn = document.getElementById("bindOpenMmdBtn");
  const emptyCard = document.getElementById("emptyCard");
  const insertStarterBtn = document.getElementById("insertStarterBtn");
  const emptyOpenMmdBtn = document.getElementById("emptyOpenMmdBtn");
  const openMmdBtn = document.getElementById("openMmdBtn");
  const openPromptBtn = document.getElementById("openPromptBtn");
  const revealPromptBtn = document.getElementById("revealPromptBtn");
  const previewPromptBtn = document.getElementById("previewPromptBtn");
  const zoomFit = document.getElementById("zoomFit");
  const zoomReset = document.getElementById("zoomReset");
  const zoomIn = document.getElementById("zoomIn");
  const zoomOut = document.getElementById("zoomOut");

  const PZ = window.__WS_panZoom__ || {};
  const RM = window.__WS_railModel__ || {};

  if (typeof acquireVsCodeApi !== "function") {
    if (bootError) {
      bootError.classList.remove("hidden");
      bootError.textContent = "acquireVsCodeApi is unavailable in this webview.";
    }
    return;
  }

  const vscode = acquireVsCodeApi();

  function showBootError(message) {
    if (bootError) {
      bootError.classList.remove("hidden");
      bootError.textContent = message;
    }
    vscode.postMessage({ type: "webviewLog", level: "error", message: message });
  }

  window.addEventListener("error", (event) => {
    showBootError("Workflow Studio crashed: " + (event.message || "unknown error"));
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason || "unknown");
    showBootError("Workflow Studio async error: " + reason);
  });

  let selectedNodeId = null;
  let applyingRemote = false;
  let renderToken = 0;
  let pendingSource = "";
  let beautifulMermaidApi = null;
  let beautifulMermaidLoading = null;
  let structure = [];
  let diagnostics = [];
  let collapsed = { bound: false, unbound: false, diagnostics: false };
  let panState = PZ.identityTransform ? PZ.identityTransform() : { scale: 1, x: 0, y: 0 };
  let panning = false;
  let panLast = null;
  let graphStage = null;

  function setPromptStatus(status) {
    saveStatus.dataset.status = status;
    saveStatus.textContent = status;
    promptStatusChip.dataset.status = status;
    promptStatusChip.textContent = "prompt: " + status;
  }

  function setGraphDirty(dirty) {
    graphStatusChip.dataset.dirty = dirty ? "true" : "false";
    graphStatusChip.textContent = dirty ? "graph: dirty" : "graph: saved";
  }

  function showError(el, message, recovery) {
    el.classList.remove("hidden");
    el.textContent = recovery ? message + " — " + recovery : message;
  }

  function clearError(el) {
    el.classList.add("hidden");
    el.textContent = "";
  }

  function setConflictVisible(visible, relativePath) {
    conflictBanner.classList.toggle("hidden", !visible);
    if (visible) {
      conflictText.textContent =
        "Disk changed on " + (relativePath || "prompt") + " while editing. Keep yours or load disk?";
      keepMine.focus();
    }
  }

  function setPromptActionsEnabled(enabled) {
    openPromptBtn.disabled = !enabled;
    revealPromptBtn.disabled = !enabled;
    previewPromptBtn.disabled = !enabled;
  }

  function showBindCard(nodeId, show) {
    bindCard.classList.toggle("hidden", !show);
    if (show) {
      bindCardTitle.textContent = "Bind prompt · " + nodeId;
      bindCardBody.textContent =
        "Create steps/" + nodeId + ".md (or link an existing markdown file) and add the %% @prompt directive.";
      bindCreateBtn.dataset.nodeId = nodeId;
      bindLinkBtn.dataset.nodeId = nodeId;
      emptyCard.classList.add("hidden");
      promptEditor.classList.add("hidden");
    } else {
      promptEditor.classList.remove("hidden");
    }
  }

  function showEmptyCard(show) {
    emptyCard.classList.toggle("hidden", !show);
    if (show) {
      bindCard.classList.add("hidden");
      promptEditor.classList.add("hidden");
    }
  }

  function applyPanTransform() {
    if (!graphStage || !PZ.toCssTransform) {
      return;
    }
    graphStage.style.transform = PZ.toCssTransform(panState);
  }

  function ensureStage() {
    graphStage = graph.querySelector(".graph-stage");
    if (!graphStage) {
      graphStage = document.createElement("div");
      graphStage.className = "graph-stage";
      while (graph.firstChild) {
        graphStage.appendChild(graph.firstChild);
      }
      graph.appendChild(graphStage);
    }
    applyPanTransform();
  }

  function fitGraph() {
    if (!PZ.fit) {
      return;
    }
    const svg = graph.querySelector("svg");
    if (!svg) {
      panState = PZ.identityTransform();
      applyPanTransform();
      return;
    }
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const content = {
      width: (vb && vb.width) || svg.getBoundingClientRect().width || 400,
      height: (vb && vb.height) || svg.getBoundingClientRect().height || 300,
    };
    const box = { width: graph.clientWidth, height: graph.clientHeight };
    panState = PZ.fit(box, content, 24);
    applyPanTransform();
  }

  function showSourceFallback(source, note) {
    const pre = document.createElement("pre");
    pre.className = "graph-fallback";
    pre.textContent = (note ? note + "\n\n" : "") + (source || "(empty workflow)");
    graph.innerHTML = "";
    graphStage = document.createElement("div");
    graphStage.className = "graph-stage";
    graphStage.appendChild(pre);
    graph.appendChild(graphStage);
    panState = PZ.identityTransform ? PZ.identityTransform() : { scale: 1, x: 0, y: 0 };
    applyPanTransform();
  }

  function selectableFlat() {
    if (!RM.groupRail) {
      return structure.filter((e) => e.nodeId);
    }
    const grouped = RM.groupRail(structure, diagnostics, railFilter.value || "");
    return grouped.flat.filter((e) => e.nodeId);
  }

  function renderRail() {
    const filter = railFilter.value || "";
    rail.innerHTML = "";
    if (!structure.length && !(diagnostics && diagnostics.length)) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No steps parsed yet. Add nodes to your .mmd, or insert a starter workflow.";
      rail.appendChild(empty);
      showEmptyCard(true);
      return;
    }
    showEmptyCard(false);

    const grouped = RM.groupRail
      ? RM.groupRail(structure, diagnostics, filter)
      : { sections: [{ id: "bound", label: "Steps", count: structure.length, entries: structure }] };

    for (const section of grouped.sections) {
      if (section.id === "diagnostics" && section.count === 0 && !diagnostics.length) {
        continue;
      }
      const title = document.createElement("button");
      title.type = "button";
      title.className = "rail-section-title";
      title.textContent = section.label + " (" + section.count + ")";
      title.setAttribute("aria-expanded", String(!collapsed[section.id]));
      title.addEventListener("click", () => {
        collapsed[section.id] = !collapsed[section.id];
        renderRail();
      });
      rail.appendChild(title);
      if (collapsed[section.id]) {
        continue;
      }
      if (section.id === "diagnostics") {
        for (const entry of section.entries) {
          const d = document.createElement("div");
          d.className = "diag";
          d.textContent = entry.label;
          rail.appendChild(d);
        }
        continue;
      }
      for (const entry of section.entries) {
        const btn = document.createElement("button");
        btn.type = "button";
        const kindClass =
          entry.kind === "file" ? " file" : entry.kind === "step" && entry.fileKey ? " member" : "";
        btn.className = "rail-item " + (entry.bound ? "bound" : "unbound") + kindClass;
        btn.setAttribute("role", "option");
        const members =
          RM.memberNodeIdsForSelection && entry.nodeId
            ? RM.memberNodeIdsForSelection(structure, entry.nodeId)
            : entry.nodeId
              ? [entry.nodeId]
              : [];
        const isSelected =
          !!entry.nodeId &&
          (entry.nodeId === selectedNodeId ||
            (entry.kind === "file" && selectedNodeId && members.includes(selectedNodeId)));
        btn.setAttribute("aria-selected", isSelected ? "true" : "false");
        btn.tabIndex = isSelected ? 0 : -1;
        if (isSelected) {
          btn.classList.add("selected");
        }
        btn.dataset.nodeId = entry.nodeId || "";
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.setAttribute("aria-hidden", "true");
        const body = document.createElement("span");
        const label = document.createElement("div");
        label.textContent =
          entry.kind === "file" || entry.kind === "controller"
            ? entry.label
            : entry.label + (entry.bound ? "" : " · unbound");
        body.appendChild(label);
        if (entry.kind === "controller" && entry.relativePath) {
          const meta = document.createElement("div");
          meta.className = "meta";
          meta.textContent = entry.relativePath;
          body.appendChild(meta);
        }
        btn.appendChild(dot);
        btn.appendChild(body);
        if (entry.nodeId) {
          btn.addEventListener("click", () => selectNode(entry.nodeId));
        } else {
          btn.disabled = true;
        }
        rail.appendChild(btn);
      }
    }
  }

  function nodeIdFromSvgEl(el) {
    let current = el;
    while (current && current !== graph) {
      if (current.classList && current.classList.contains("node")) {
        const dataId = current.getAttribute("data-id");
        if (dataId) {
          return dataId;
        }
        if (current.id) {
          const raw = current.id;
          const m = /^flowchart-([^-]+)/.exec(raw) || /^([A-Za-z][A-Za-z0-9_]*)/.exec(raw);
          if (m) {
            return m[1];
          }
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  function markSelectedInGraph() {
    const selected = new Set(
      RM.memberNodeIdsForSelection
        ? RM.memberNodeIdsForSelection(structure, selectedNodeId)
        : selectedNodeId
          ? [selectedNodeId]
          : [],
    );
    const nodes = graph.querySelectorAll(".node");
    for (const node of nodes) {
      const id = nodeIdFromSvgEl(node);
      node.classList.toggle("selected", !!(id && selected.has(id)));
    }
  }

  function themeFromCss() {
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue("--ws-bg").trim() || "#0f1216";
    const surface = styles.getPropertyValue("--ws-surface").trim() || "#171b22";
    const rule = styles.getPropertyValue("--ws-rule").trim() || "#2a313d";
    const text = styles.getPropertyValue("--ws-text").trim() || "#d7dde6";
    const accent = styles.getPropertyValue("--ws-accent").trim() || "#4cc2ff";
    const muted = styles.getPropertyValue("--ws-muted").trim() || "#8b95a7";
    return {
      bg,
      fg: text,
      surface,
      border: rule,
      line: rule,
      accent,
      muted,
      transparent: true,
    };
  }

  function loadBeautifulMermaid() {
    if (beautifulMermaidApi) {
      return Promise.resolve(beautifulMermaidApi);
    }
    if (beautifulMermaidLoading) {
      return beautifulMermaidLoading;
    }
    const uri = window.__WORKFLOW_STUDIO_BM_URI__;
    if (!uri) {
      return Promise.reject(new Error("beautiful-mermaid URI missing"));
    }
    beautifulMermaidLoading = new Promise((resolve, reject) => {
      const existing = document.querySelector("script[data-workflow-bm]");
      if (existing && window.BeautifulMermaid && typeof window.BeautifulMermaid.renderMermaidSVG === "function") {
        beautifulMermaidApi = window.BeautifulMermaid;
        resolve(beautifulMermaidApi);
        return;
      }
      const tag = document.createElement("script");
      tag.src = uri;
      tag.dataset.workflowBm = "1";
      tag.onload = () => {
        if (!window.BeautifulMermaid || typeof window.BeautifulMermaid.renderMermaidSVG !== "function") {
          reject(new Error("BeautifulMermaid global missing after load"));
          return;
        }
        beautifulMermaidApi = window.BeautifulMermaid;
        resolve(beautifulMermaidApi);
      };
      tag.onerror = () => reject(new Error("Failed to load beautiful-mermaid.js"));
      document.head.appendChild(tag);
    });
    return beautifulMermaidLoading;
  }

  function showGraphError(message, source) {
    graphError.classList.remove("hidden");
    graphError.innerHTML = "";
    const text = document.createElement("div");
    text.textContent = "Can't render Mermaid graph — " + message;
    graphError.appendChild(text);
    const actions = document.createElement("div");
    actions.className = "error-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "primary";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => vscode.postMessage({ type: "retryGraph" }));
    actions.appendChild(retry);
    graphError.appendChild(actions);
    const details = document.createElement("details");
    details.className = "details-source";
    const summary = document.createElement("summary");
    summary.textContent = "Show source";
    details.appendChild(summary);
    const pre = document.createElement("pre");
    pre.textContent = source || "";
    details.appendChild(pre);
    graphError.appendChild(details);
    showSourceFallback(source, "Render failed. Use Retry or Show source.");
  }

  async function renderGraph(source) {
    const token = ++renderToken;
    clearError(graphError);
    graphError.innerHTML = "";
    pendingSource = source || "";
    const trimmed = pendingSource.trim();
    if (!trimmed) {
      showSourceFallback("", "Workflow file is empty.");
      return;
    }
    graph.innerHTML = '<div class="loading-chip">Rendering…</div>';
    try {
      const api = await loadBeautifulMermaid();
      if (token !== renderToken) {
        return;
      }
      const svg = api.renderMermaidSVG(trimmed, themeFromCss());
      if (token !== renderToken) {
        return;
      }
      graph.innerHTML = "";
      graphStage = document.createElement("div");
      graphStage.className = "graph-stage";
      graphStage.innerHTML = svg;
      graph.appendChild(graphStage);
      graphStage.querySelectorAll(".node").forEach((node) => {
        node.style.cursor = "pointer";
        node.setAttribute("tabindex", "0");
        node.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const id = nodeIdFromSvgEl(node);
          if (id) {
            selectNode(id);
          }
        });
        node.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const id = nodeIdFromSvgEl(node);
            if (id) {
              selectNode(id);
            }
          }
        });
      });
      markSelectedInGraph();
      fitGraph();
    } catch (err) {
      const message = err && err.message ? err.message : "Mermaid render failed.";
      showGraphError(message, trimmed);
    }
  }

  function selectNode(nodeId) {
    selectedNodeId = nodeId;
    markSelectedInGraph();
    renderRail();
    vscode.postMessage({ type: "selectNode", nodeId });
  }

  function enableEditor(enabled) {
    promptEditor.disabled = !enabled;
  }

  function moveRailSelection(delta) {
    const flat = selectableFlat();
    if (!flat.length) {
      return;
    }
    let idx = RM.indexOfNode ? RM.indexOfNode(flat, selectedNodeId) : flat.findIndex((e) => e.nodeId === selectedNodeId);
    if (delta > 0) {
      idx = RM.nextIndex ? RM.nextIndex(idx, flat.length) : Math.min(flat.length - 1, Math.max(0, idx) + 1);
    } else {
      idx = RM.prevIndex ? RM.prevIndex(idx, flat.length) : Math.max(0, idx - 1);
    }
    if (idx >= 0 && flat[idx] && flat[idx].nodeId) {
      selectNode(flat[idx].nodeId);
      const el = rail.querySelector('.rail-item[data-node-id="' + flat[idx].nodeId + '"]');
      if (el) {
        el.focus();
      }
    }
  }

  promptEditor.addEventListener("input", () => {
    if (applyingRemote || promptEditor.disabled) {
      return;
    }
    setPromptStatus("editing");
    setConflictVisible(false);
    vscode.postMessage({ type: "promptEdit", content: promptEditor.value });
  });

  keepMine.addEventListener("click", () => {
    vscode.postMessage({ type: "conflictResolve", choice: "keep" });
  });
  loadDisk.addEventListener("click", () => {
    vscode.postMessage({ type: "conflictResolve", choice: "load" });
  });

  bindCreateBtn.addEventListener("click", () => {
    const nodeId = bindCreateBtn.dataset.nodeId;
    if (nodeId) {
      vscode.postMessage({ type: "bindPrompt", nodeId });
    }
  });
  bindLinkBtn.addEventListener("click", () => {
    const nodeId = bindLinkBtn.dataset.nodeId;
    if (nodeId) {
      vscode.postMessage({ type: "linkPrompt", nodeId });
    }
  });
  bindOpenMmdBtn.addEventListener("click", () => vscode.postMessage({ type: "openMmdAsText" }));
  emptyOpenMmdBtn.addEventListener("click", () => vscode.postMessage({ type: "openMmdAsText" }));
  openMmdBtn.addEventListener("click", () => vscode.postMessage({ type: "openMmdAsText" }));
  insertStarterBtn.addEventListener("click", () => vscode.postMessage({ type: "insertStarter" }));
  openPromptBtn.addEventListener("click", () => vscode.postMessage({ type: "openPromptInEditor" }));
  revealPromptBtn.addEventListener("click", () => vscode.postMessage({ type: "revealPrompt" }));
  previewPromptBtn.addEventListener("click", () => vscode.postMessage({ type: "previewPrompt" }));

  zoomFit.addEventListener("click", () => fitGraph());
  zoomReset.addEventListener("click", () => {
    panState = PZ.identityTransform ? PZ.identityTransform() : { scale: 1, x: 0, y: 0 };
    applyPanTransform();
  });
  zoomIn.addEventListener("click", () => {
    if (PZ.zoomBy) {
      panState = PZ.zoomBy(panState, PZ.ZOOM_STEP || 1.2);
      applyPanTransform();
    }
  });
  zoomOut.addEventListener("click", () => {
    if (PZ.zoomBy) {
      panState = PZ.zoomBy(panState, 1 / (PZ.ZOOM_STEP || 1.2));
      applyPanTransform();
    }
  });

  railFilter.addEventListener("input", () => renderRail());

  graph.addEventListener("wheel", (event) => {
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }
    event.preventDefault();
    if (!PZ.zoomAtPoint) {
      return;
    }
    const rect = graph.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? PZ.ZOOM_STEP || 1.2 : 1 / (PZ.ZOOM_STEP || 1.2);
    panState = PZ.zoomAtPoint(panState, factor, cx, cy);
    applyPanTransform();
  }, { passive: false });

  graph.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    if (event.target.closest && event.target.closest(".node")) {
      return;
    }
    panning = true;
    panLast = { x: event.clientX, y: event.clientY };
    graph.classList.add("panning");
    graph.setPointerCapture(event.pointerId);
  });
  graph.addEventListener("pointermove", (event) => {
    if (!panning || !panLast || !PZ.panBy) {
      return;
    }
    const dx = event.clientX - panLast.x;
    const dy = event.clientY - panLast.y;
    panLast = { x: event.clientX, y: event.clientY };
    panState = PZ.panBy(panState, dx, dy);
    applyPanTransform();
  });
  graph.addEventListener("pointerup", () => {
    panning = false;
    panLast = null;
    graph.classList.remove("panning");
  });
  graph.addEventListener("pointercancel", () => {
    panning = false;
    panLast = null;
    graph.classList.remove("panning");
  });

  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      vscode.postMessage({ type: "forceFlush" });
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "0") {
      event.preventDefault();
      panState = PZ.identityTransform ? PZ.identityTransform() : { scale: 1, x: 0, y: 0 };
      applyPanTransform();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      if (document.activeElement !== promptEditor) {
        event.preventDefault();
        railFilter.focus();
      }
      return;
    }
    const inFilter = document.activeElement === railFilter;
    const inEditor = document.activeElement === promptEditor;
    if (!inFilter && !inEditor && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      moveRailSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (!inFilter && !inEditor && event.key === "Enter" && selectedNodeId) {
      promptEditor.focus();
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") {
      return;
    }
    switch (msg.type) {
      case "init":
        if (bootError) {
          bootError.classList.add("hidden");
        }
        fileLabel.textContent = msg.fileName || "";
        selectedNodeId = msg.selectedNodeId || null;
        structure = msg.structure || [];
        diagnostics = msg.diagnostics || [];
        renderRail();
        void renderGraph(msg.mermaidSource || "");
        if (!structure.length) {
          showEmptyCard(true);
          enableEditor(false);
          setPromptActionsEnabled(false);
        }
        return;
      case "graphStatus":
        setGraphDirty(!!msg.dirty);
        return;
      case "command":
        if (msg.command === "focusRail") {
          railFilter.focus();
        } else if (msg.command === "focusGraph") {
          graph.focus();
        } else if (msg.command === "focusPrompt") {
          promptEditor.focus();
        } else if (msg.command === "bindSelectedNode" && selectedNodeId) {
          vscode.postMessage({ type: "bindPrompt", nodeId: selectedNodeId });
        } else if (msg.command === "nextUnbound" && RM.nextUnbound) {
          const next = RM.nextUnbound(structure, selectedNodeId);
          if (next) {
            selectNode(next);
          }
        }
        return;
      case "promptLoaded":
        clearError(promptError);
        setConflictVisible(false);
        showBindCard("", false);
        showEmptyCard(false);
        promptTitle.textContent = "Step · " + msg.nodeId;
        promptPath.textContent = msg.relativePath;
        promptStatusChip.title = msg.relativePath || "prompt";
        applyingRemote = true;
        promptEditor.value = msg.content || "";
        applyingRemote = false;
        enableEditor(true);
        setPromptActionsEnabled(true);
        setPromptStatus(msg.saveStatus || "saved");
        promptFooter.textContent = "Autosave on idle · watching FS";
        selectedNodeId = msg.nodeId;
        markSelectedInGraph();
        renderRail();
        return;
      case "promptError":
        setConflictVisible(false);
        enableEditor(false);
        setPromptActionsEnabled(false);
        applyingRemote = true;
        promptEditor.value = "";
        applyingRemote = false;
        promptTitle.textContent = msg.nodeId ? "Step · " + msg.nodeId : "Step";
        promptPath.textContent = "";
        setPromptStatus("idle");
        if (msg.nodeId && /no prompt bound|missing prompt binding/i.test(msg.message || "")) {
          clearError(promptError);
          showBindCard(msg.nodeId, true);
          promptFooter.textContent = msg.recovery || "Bind a prompt to edit.";
        } else if (msg.nodeId && /missing prompt file/i.test(msg.message || "")) {
          clearError(promptError);
          showBindCard(msg.nodeId, true);
          bindCardBody.textContent = msg.message + " — create or fix the file, then reselect.";
          promptFooter.textContent = msg.recovery || "";
        } else {
          showBindCard("", false);
          showError(promptError, msg.message || "Prompt unavailable.", msg.recovery || "");
          promptFooter.textContent = msg.recovery || "";
        }
        return;
      case "saveStatus":
        setPromptStatus(msg.status || "idle");
        if (msg.status === "conflict") {
          setConflictVisible(true);
        }
        return;
      case "conflict":
        setPromptStatus("conflict");
        setConflictVisible(true, msg.relativePath);
        promptFooter.textContent = "Conflict on " + (msg.relativePath || "prompt");
        return;
      default:
        return;
    }
  });

  fileLabel.textContent = "Rendering…";
  vscode.postMessage({ type: "ready" });
})();
