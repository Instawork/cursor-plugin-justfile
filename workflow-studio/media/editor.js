(/* global acquireVsCodeApi */
(function () {
  const bootError = document.getElementById("bootError");
  const fileLabel = document.getElementById("fileLabel");
  const rail = document.getElementById("rail");
  const graph = document.getElementById("graph");
  const graphError = document.getElementById("graphError");
  const promptTitle = document.getElementById("promptTitle");
  const promptPath = document.getElementById("promptPath");
  const promptEditor = document.getElementById("promptEditor");
  const promptError = document.getElementById("promptError");
  const promptFooter = document.getElementById("promptFooter");
  const saveStatus = document.getElementById("saveStatus");
  const conflictBanner = document.getElementById("conflictBanner");
  const keepMine = document.getElementById("keepMine");
  const loadDisk = document.getElementById("loadDisk");

  function showBootError(message) {
    if (!bootError) {
      return;
    }
    bootError.classList.remove("hidden");
    bootError.textContent = message;
  }

  window.addEventListener("error", (event) => {
    showBootError("Workflow Studio crashed: " + (event.message || "unknown error"));
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason || "unknown");
    showBootError("Workflow Studio async error: " + reason);
  });

  if (typeof acquireVsCodeApi !== "function") {
    showBootError("acquireVsCodeApi is unavailable in this webview.");
    return;
  }

  const vscode = acquireVsCodeApi();
  let selectedNodeId = null;
  let applyingRemote = false;
  let renderToken = 0;
  let pendingSource = "";
  let mermaidApi = null;
  let mermaidLoading = null;

  function setStatus(status) {
    saveStatus.dataset.status = status;
    saveStatus.textContent = status;
  }

  function showError(el, message, recovery) {
    el.classList.remove("hidden");
    el.textContent = recovery ? message + " — " + recovery : message;
  }

  function clearError(el) {
    el.classList.add("hidden");
    el.textContent = "";
  }

  function setConflictVisible(visible) {
    conflictBanner.classList.toggle("hidden", !visible);
  }

  function showSourceFallback(source, note) {
    const pre = document.createElement("pre");
    pre.className = "graph-fallback";
    pre.textContent = (note ? note + "\n\n" : "") + (source || "(empty workflow)");
    graph.innerHTML = "";
    graph.appendChild(pre);
  }

  function renderRail(structure, diagnostics) {
    rail.innerHTML = "";
    const title = document.createElement("div");
    title.className = "pane-title";
    title.textContent = "Structure";
    rail.appendChild(title);
    for (const diag of diagnostics || []) {
      const d = document.createElement("div");
      d.className = "diag";
      d.textContent = diag;
      rail.appendChild(d);
    }
    if (!structure || structure.length === 0) {
      const empty = document.createElement("div");
      empty.className = "diag";
      empty.textContent = "No nodes found in this .mmd yet.";
      rail.appendChild(empty);
      return;
    }
    for (const entry of structure || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rail-item " + (entry.bound ? "bound" : "unbound");
      if (entry.nodeId && entry.nodeId === selectedNodeId) {
        btn.classList.add("selected");
      }
      btn.dataset.nodeId = entry.nodeId || "";
      const dot = document.createElement("span");
      dot.className = "dot";
      const body = document.createElement("span");
      const label = document.createElement("div");
      label.textContent = entry.label;
      body.appendChild(label);
      if (entry.relativePath) {
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = entry.relativePath;
        body.appendChild(meta);
      } else if (!entry.bound && entry.nodeId) {
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = "unbound";
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

  function nodeIdFromSvgEl(el) {
    let current = el;
    while (current && current !== graph) {
      if (current.classList && current.classList.contains("node") && current.id) {
        const raw = current.id;
        const m = /^flowchart-([^-]+)/.exec(raw) || /^([A-Za-z][A-Za-z0-9_]*)/.exec(raw);
        if (m) {
          return m[1];
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  function markSelectedInGraph() {
    const nodes = graph.querySelectorAll(".node");
    for (const node of nodes) {
      const id = nodeIdFromSvgEl(node);
      node.classList.toggle("selected", id === selectedNodeId);
    }
  }

  function loadMermaid() {
    if (mermaidApi) {
      return Promise.resolve(mermaidApi);
    }
    if (mermaidLoading) {
      return mermaidLoading;
    }
    const uri = window.__WORKFLOW_STUDIO_MERMAID_URI__;
    if (!uri) {
      return Promise.reject(new Error("Mermaid URI missing"));
    }
    mermaidLoading = new Promise((resolve, reject) => {
      const existing = document.querySelector("script[data-workflow-mermaid]");
      if (existing && typeof window.mermaid !== "undefined") {
        mermaidApi = window.mermaid;
        resolve(mermaidApi);
        return;
      }
      const tag = document.createElement("script");
      tag.src = uri;
      tag.dataset.workflowMermaid = "1";
      tag.onload = () => {
        if (typeof window.mermaid === "undefined" || !window.mermaid.initialize) {
          reject(new Error("Mermaid global missing after load"));
          return;
        }
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "dark",
          themeVariables: {
            darkMode: true,
            background: "#141821",
            primaryColor: "#1C2230",
            primaryTextColor: "#E7ECF3",
            primaryBorderColor: "#39435A",
            lineColor: "#39435A",
            secondaryColor: "#1C2230",
            tertiaryColor: "#141821",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          },
        });
        mermaidApi = window.mermaid;
        resolve(mermaidApi);
      };
      tag.onerror = () => reject(new Error("Failed to load mermaid.min.js"));
      document.head.appendChild(tag);
    });
    return mermaidLoading;
  }

  async function renderGraph(source) {
    const token = ++renderToken;
    clearError(graphError);
    pendingSource = source || "";
    const trimmed = pendingSource.trim();
    if (!trimmed) {
      showSourceFallback("", "Workflow file is empty.");
      return;
    }
    showSourceFallback(trimmed, "Rendering graph…");
    try {
      const api = await loadMermaid();
      if (token !== renderToken) {
        return;
      }
      const { svg, bindFunctions } = await api.render("workflowStudioGraph-" + token, trimmed);
      if (token !== renderToken) {
        return;
      }
      graph.innerHTML = svg;
      if (typeof bindFunctions === "function") {
        bindFunctions(graph);
      }
      graph.querySelectorAll(".node").forEach((node) => {
        node.style.cursor = "pointer";
        node.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const id = nodeIdFromSvgEl(node);
          if (id) {
            selectNode(id);
          }
        });
      });
      markSelectedInGraph();
    } catch (err) {
      const message = err && err.message ? err.message : "Mermaid render failed.";
      showError(graphError, "Can't render Mermaid graph — showing source.", message);
      showSourceFallback(trimmed, "Mermaid unavailable (" + message + "). Source:");
    }
  }

  function selectNode(nodeId) {
    selectedNodeId = nodeId;
    markSelectedInGraph();
    for (const item of rail.querySelectorAll(".rail-item")) {
      item.classList.toggle("selected", item.dataset.nodeId === nodeId);
    }
    vscode.postMessage({ type: "selectNode", nodeId });
  }

  function enableEditor(enabled) {
    promptEditor.disabled = !enabled;
  }

  promptEditor.addEventListener("input", () => {
    if (applyingRemote || promptEditor.disabled) {
      return;
    }
    setStatus("editing");
    setConflictVisible(false);
    vscode.postMessage({ type: "promptEdit", content: promptEditor.value });
  });

  keepMine.addEventListener("click", () => {
    vscode.postMessage({ type: "conflictResolve", choice: "keep" });
  });
  loadDisk.addEventListener("click", () => {
    vscode.postMessage({ type: "conflictResolve", choice: "load" });
  });

  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      vscode.postMessage({ type: "forceFlush" });
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
        renderRail(msg.structure, msg.diagnostics);
        void renderGraph(msg.mermaidSource || "");
        return;
      case "promptLoaded":
        clearError(promptError);
        setConflictVisible(false);
        promptTitle.textContent = "Step · " + msg.nodeId;
        promptPath.textContent = msg.relativePath;
        applyingRemote = true;
        promptEditor.value = msg.content || "";
        applyingRemote = false;
        enableEditor(true);
        setStatus(msg.saveStatus || "saved");
        promptFooter.textContent = "Autosave on idle · watching FS";
        selectedNodeId = msg.nodeId;
        markSelectedInGraph();
        return;
      case "promptError":
        setConflictVisible(false);
        enableEditor(false);
        applyingRemote = true;
        promptEditor.value = "";
        applyingRemote = false;
        promptTitle.textContent = msg.nodeId ? "Step · " + msg.nodeId : "Step";
        promptPath.textContent = "";
        showError(promptError, msg.message || "Prompt unavailable.", msg.recovery || "");
        setStatus("idle");
        promptFooter.textContent = msg.recovery || "";
        return;
      case "saveStatus":
        setStatus(msg.status || "idle");
        if (msg.status === "conflict") {
          setConflictVisible(true);
        }
        return;
      case "conflict":
        setStatus("conflict");
        setConflictVisible(true);
        promptFooter.textContent = "Conflict on " + (msg.relativePath || "prompt");
        return;
      default:
        return;
    }
  });

  fileLabel.textContent = "ready";
  vscode.postMessage({ type: "ready" });
})();
