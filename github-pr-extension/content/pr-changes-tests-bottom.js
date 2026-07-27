/**
 * GitHub PR "Files changed": Code / Tests split + tests-last ordering.
 *
 * Does not move React-owned nodes (GitHub immediately reverts that).
 * - File tree: mirror panel we own; native tree hidden while enabled.
 * - Diffs: flexbox `order` on entries (list is d-flex flex-column).
 */
(function () {
  const STORAGE_KEY = "testsToBottomEnabled";
  const ROOT_CLASS = "gh-pr-ext-tests-root-active";
  const MIRROR_READY_CLASS = "gh-pr-ext-mirror-ready";
  const MIRROR_ID = "gh-pr-ext-mirror-tree";
  const DEBOUNCE_MS = 120;
  const RETRY_MS = 350;
  const RETRY_MAX_MS = 90000;

  let enabled = true;
  let scheduled = null;
  let applying = false;
  let pageObserver = null;
  let retryTimer = null;
  /** @type {Array<{ path: string, href: string }>} */
  let cachedFileRows = [];
  let lastRowSignature = "";

  function isPrChangesPage() {
    return /\/pull\/\d+\/changes\/?$/.test(location.pathname);
  }

  /** @param {string} path */
  function isTestPath(path) {
    const p = String(path || "").replace(/\\/g, "/").trim();
    if (!p) return false;
    const base = p.split("/").pop() || "";

    if (/(^|\/)(tests?|__tests__|fixtures|__snapshots__)(\/|$)/i.test(p)) {
      return true;
    }
    if (/\.(test|spec)\.(jsx?|tsx?|mjs|cjs|vue|svelte|py)$/i.test(p)) {
      return true;
    }
    if (/_(test|spec)\.py$/i.test(p)) return true;
    if (/^test_[^/]+\.py$/i.test(base)) return true;
    if (/^conftest\.py$/i.test(base)) return true;
    if (/\.snap$/i.test(base)) return true;

    return false;
  }

  function stripPathText(text) {
    return String(text || "")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .trim();
  }

  function escHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** @param {Element} li */
  function pathFromTreeItem(li) {
    const id = li.getAttribute("id");
    if (id && id.includes("/")) return id;
    const link = li.querySelector('a[href^="#diff-"]');
    if (link) {
      const label = li.getAttribute("aria-label") || link.textContent;
      const folder = findFolderPrefix(li);
      const name = stripPathText(label);
      if (folder && name) return `${folder}/${name}`;
      if (name.includes("/")) return name;
    }
    return id || "";
  }

  /** @param {Element} li */
  function findFolderPrefix(li) {
    const parts = [];
    let node = li.parentElement?.closest("li[role='treeitem']");
    while (node) {
      const id = node.getAttribute("id");
      if (id && !node.className.includes("file-tree-row")) {
        parts.unshift(id);
      } else {
        const span = node.querySelector(
          ":scope > .PRIVATE_TreeView-item-container .PRIVATE_TreeView-item-content-text > span"
        );
        const name = span?.textContent?.trim();
        if (name && !node.className.includes("file-tree-row")) {
          parts.unshift(name);
        }
      }
      node = node.parentElement?.closest("li[role='treeitem']");
    }
    return parts.join("/");
  }

  /** @param {Element} entry */
  function pathFromDiffEntry(entry) {
    const code = entry.querySelector(
      '.DiffFileHeader-module__file-name code, [class*="file-name"] code, [class*="file-name"] a code'
    );
    if (code) return stripPathText(code.textContent);
    const link = entry.querySelector(
      '.DiffFileHeader-module__file-name a[href^="#diff-"], [class*="file-name"] a[href^="#diff-"]'
    );
    if (link) return stripPathText(link.textContent);
    return "";
  }

  function getFileTreeRoot() {
    return document.querySelector(
      '#pr-file-tree ul[role="tree"][aria-label="File Tree"], #pr-file-tree ul[role="tree"]'
    );
  }

  function getFileTreeRows() {
    const root = getFileTreeRoot();
    if (!root) return [];
    return [...root.querySelectorAll('li[class*="file-tree-row"]')];
  }

  function getDiffList() {
    return document.querySelector('[data-testid="progressive-diffs-list"]');
  }

  /** @param {Element} list */
  function getDiffEntries(list) {
    const byClass = [
      ...list.querySelectorAll('[class*="PullRequestDiffsList-module__diffEntry"]'),
    ];
    if (byClass.length > 0) return byClass;
    return [...list.querySelectorAll(':scope > div[id^="diff-"]')];
  }

  function countFileTreeRows() {
    return getFileTreeRows().length;
  }

  function countDiffEntries() {
    const list = getDiffList();
    return list ? getDiffEntries(list).length : 0;
  }

  function rowSignature(rows) {
    return rows
      .map((r) => r.path)
      .sort()
      .join("\n");
  }

  /** @returns {Array<{ path: string, href: string }>} */
  function collectRowsFromTree() {
    const out = [];
    for (const li of getFileTreeRows()) {
      const path = pathFromTreeItem(li);
      if (!path) continue;
      const link = li.querySelector('a[href^="#diff-"]');
      const href = link?.getAttribute("href") || "";
      out.push({ path, href });
    }
    return out;
  }

  /** @returns {Array<{ path: string, href: string }>} */
  function collectRowsFromDiffs() {
    const list = getDiffList();
    if (!list) return [];
    const out = [];
    for (const entry of getDiffEntries(list)) {
      const path = pathFromDiffEntry(entry);
      if (!path) continue;
      const anchor =
        entry.querySelector('[id^="diff-"][class*="Diff-module__diff"]') ||
        entry.querySelector('[id^="diff-"]');
      const href = anchor?.id ? `#${anchor.id}` : "";
      out.push({ path, href });
    }
    return out;
  }

  /** @param {string} path */
  function findDiffHrefForPath(path) {
    const list = getDiffList();
    if (!list || !path) return "";
    for (const entry of getDiffEntries(list)) {
      if (pathFromDiffEntry(entry) === path) {
        const anchor = entry.querySelector('[id^="diff-"]');
        if (anchor?.id) return `#${anchor.id}`;
      }
    }
    return "";
  }

  /** @returns {Array<{ path: string, href: string }>} */
  function collectAllFileRows() {
    const merged = new Map();

    for (const r of cachedFileRows) {
      if (r.path) merged.set(r.path, { path: r.path, href: r.href || "" });
    }
    for (const r of collectRowsFromTree()) {
      if (!r.path) continue;
      const prev = merged.get(r.path);
      merged.set(r.path, {
        path: r.path,
        href: r.href || prev?.href || "",
      });
    }
    for (const r of collectRowsFromDiffs()) {
      if (!r.path) continue;
      const prev = merged.get(r.path);
      merged.set(r.path, {
        path: r.path,
        href: r.href || prev?.href || "",
      });
    }

    let rows = [...merged.values()];
    for (const r of rows) {
      if (!r.href) r.href = findDiffHrefForPath(r.path);
    }
    rows = rows.filter((r) => r.path);

    if (rows.length > 0) {
      cachedFileRows = rows.map((r) => ({ path: r.path, href: r.href }));
    } else if (cachedFileRows.length > 0) {
      rows = cachedFileRows.map((r) => ({ ...r }));
    }

    return rows;
  }

  function isPageReady() {
    return collectAllFileRows().length > 0 && countDiffEntries() > 0;
  }

  function shouldSkipMirrorRebuild(mutations) {
    const panel = document.getElementById(MIRROR_ID);
    if (!panel) return false;
    return mutations.every((m) => {
      const node = m.target;
      return node instanceof Node && panel.contains(node);
    });
  }

  function ensureMirrorPanel() {
    let panel = document.getElementById(MIRROR_ID);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = MIRROR_ID;
    panel.className = "gh-pr-ext-mirror-tree";
    panel.setAttribute("role", "navigation");
    panel.setAttribute("aria-label", "File tree (Code and Tests)");

    const scroll = document.querySelector(
      '#pr-file-tree [class*="FileTreeScrollable"]'
    );
    if (scroll) {
      scroll.insertBefore(panel, scroll.firstChild);
    } else {
      document.getElementById("pr-file-tree")?.appendChild(panel);
    }
    wireMirrorPanel(panel);
    return panel;
  }

  function wireMirrorPanel(panel) {
    if (panel.dataset.wired) return;
    panel.dataset.wired = "1";
    panel.addEventListener("click", (e) => {
      const btn = e.target.closest(".gh-pr-ext-mirror-folder-btn");
      if (!btn || !panel.contains(btn)) return;
      const expanded = btn.getAttribute("aria-expanded") === "true";
      const next = !expanded;
      btn.setAttribute("aria-expanded", String(next));
      const children = btn.parentElement?.querySelector(
        ":scope > .gh-pr-ext-mirror-children"
      );
      if (children) children.hidden = !next;
      const chev = btn.querySelector(".gh-pr-ext-mirror-chevron");
      if (chev) chev.textContent = next ? "▼" : "▶";
    });
  }

  function removeMirrorPanel() {
    document.getElementById(MIRROR_ID)?.remove();
  }

  function createPathNode() {
    return { dirs: new Map(), files: [] };
  }

  /** @param {{ dirs: Map<string, object>, files: object[] }} node */
  function sortPathNode(node) {
    node.files.sort((a, b) => a.path.localeCompare(b.path));
    const sorted = [...node.dirs.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    node.dirs = new Map(sorted);
    for (const child of node.dirs.values()) sortPathNode(child);
  }

  /** @param {{ path: string, href: string }} row @param {{ dirs: Map, files: object[] }} node */
  function insertPathRow(node, row) {
    const parts = row.path.split("/").filter(Boolean);
    if (parts.length === 0) return;
    const fileName = parts.pop();
    let cur = node;
    for (const part of parts) {
      if (!cur.dirs.has(part)) cur.dirs.set(part, createPathNode());
      cur = cur.dirs.get(part);
    }
    cur.files.push({ ...row, fileName: fileName || row.path });
  }

  /** @param {{ dirs: Map<string, object>, files: object[] }} node @param {"code"|"test"} kind @param {number} depth */
  function renderPathNodeHtml(node, kind, depth) {
    let html = "";
    for (const [dirName, child] of node.dirs) {
      html +=
        `<li class="gh-pr-ext-mirror-folder" role="treeitem" aria-expanded="true">` +
        `<button type="button" class="gh-pr-ext-mirror-folder-btn" aria-expanded="true">` +
        `<span class="gh-pr-ext-mirror-chevron" aria-hidden="true">▼</span>` +
        `<span class="gh-pr-ext-mirror-folder-name">${escHtml(dirName)}</span>` +
        `</button>` +
        `<ul class="gh-pr-ext-mirror-children" role="group">` +
        renderPathNodeHtml(child, kind, depth + 1) +
        `</ul></li>`;
    }
    for (const file of node.files) {
      const href = file.href || "#";
      const title = escHtml(file.path);
      const label = escHtml(file.fileName);
      const inner = file.href
        ? `<a class="gh-pr-ext-mirror-link" href="${escHtml(href)}" title="${title}">${label}</a>`
        : `<span class="gh-pr-ext-mirror-file-label" title="${title}">${label}</span>`;
      html +=
        `<li class="gh-pr-ext-mirror-file gh-pr-ext-mirror-file--${kind}" role="treeitem" style="--depth:${depth}">` +
        inner +
        `</li>`;
    }
    return html;
  }

  /** @param {Array<{path:string,href:string}>} rows @param {"code"|"test"} kind @param {string} title */
  function renderMirrorSectionHtml(rows, kind, title) {
    const root = createPathNode();
    for (const row of rows) insertPathRow(root, row);
    sortPathNode(root);
    const inner = renderPathNodeHtml(root, kind, 0);
    return (
      `<div class="gh-pr-ext-tree-section-label">${escHtml(title)} (${rows.length})</div>` +
      `<ul class="gh-pr-ext-mirror-tree-root gh-pr-ext-mirror-tree-root--${kind}" role="group" aria-label="${escHtml(title)}">` +
      inner +
      `</ul>`
    );
  }

  function buildMirrorTree() {
    const panel = ensureMirrorPanel();
    const rows = collectAllFileRows();
    if (rows.length === 0) {
      return cachedFileRows.length > 0 && panel.childElementCount > 0;
    }

    const sig = rowSignature(rows);
    if (sig === lastRowSignature && panel.querySelector(".gh-pr-ext-mirror-tree-root")) {
      return true;
    }
    lastRowSignature = sig;

    const code = rows.filter((r) => !isTestPath(r.path));
    const tests = rows.filter((r) => isTestPath(r.path));

    for (const li of getFileTreeRows()) {
      const path = pathFromTreeItem(li);
      const test = isTestPath(path);
      li.classList.toggle("gh-pr-ext-test-file", test);
      li.classList.toggle("gh-pr-ext-code-file", !test);
    }

    panel.innerHTML =
      renderMirrorSectionHtml(code, "code", "Code") +
      renderMirrorSectionHtml(tests, "test", "Tests");

    return true;
  }

  function restoreMirrorTree() {
    removeMirrorPanel();
    cachedFileRows = [];
    lastRowSignature = "";
    for (const li of getFileTreeRows()) {
      li.classList.remove("gh-pr-ext-test-file", "gh-pr-ext-code-file");
    }
  }

  function applyDiffOrder() {
    const list = getDiffList();
    if (!list) return false;

    const entries = getDiffEntries(list);
    if (entries.length === 0) return false;

    for (const entry of entries) {
      const path = pathFromDiffEntry(entry);
      const test = isTestPath(path);
      entry.classList.toggle("gh-pr-ext-test-diff", test);
      entry.classList.toggle("gh-pr-ext-code-diff", !test);
      entry.style.order = test ? "2" : "0";
    }

    return true;
  }

  function restoreDiffOrder() {
    const list = getDiffList();
    if (!list) return;

    for (const entry of getDiffEntries(list)) {
      entry.classList.remove("gh-pr-ext-test-diff", "gh-pr-ext-code-diff");
      entry.style.removeProperty("order");
    }
  }

  function applyAll() {
    if (!enabled || applying) return;
    applying = true;
    try {
      // Scrape while native tree may still be visible (display:none unmounts rows).
      const rows = collectAllFileRows();
      const treeOk = buildMirrorTree();
      const diffOk = applyDiffOrder();
      if (treeOk && rows.length > 0) {
        document.documentElement.classList.add(MIRROR_READY_CLASS);
      } else {
        document.documentElement.classList.remove(MIRROR_READY_CLASS);
      }
      if (treeOk || diffOk) {
        document.documentElement.classList.add(ROOT_CLASS);
      }
      updateToggleHint(treeOk || rows.length > 0, diffOk);
    } finally {
      applying = false;
    }
  }

  function restoreAll() {
    applying = true;
    try {
      restoreMirrorTree();
      restoreDiffOrder();
      document.documentElement.classList.remove(ROOT_CLASS, MIRROR_READY_CLASS);
      updateToggleHint(false, false);
    } finally {
      applying = false;
    }
  }

  function updateToggleHint(treeOk, diffOk) {
    const label = document.getElementById("gh-pr-ext-tests-toggle");
    if (!label) return;
    const nTree = collectAllFileRows().length;
    const nDiff = countDiffEntries();
    if (!enabled) {
      label.title = "Split file tree into Code and Tests; show tests last";
      return;
    }
    label.title = `Tests last: ON — tree ${treeOk ? "ok" : "waiting"} (${nTree} files), diffs ${diffOk ? "ok" : "waiting"} (${nDiff} panels). Scroll the diff column if counts stay at 0.`;
  }

  function scheduleApply() {
    if (applying) return;
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = null;
      if (!enabled || applying) return;
      applyAll();
    }, DEBOUNCE_MS);
  }

  function ensureToggle() {
    const existing = document.getElementById("gh-pr-ext-tests-toggle");
    if (existing) {
      const input = existing.querySelector("input");
      if (input) input.checked = enabled;
      updateToggleHint(false, false);
      return;
    }

    const commitsBtn = document.getElementById("changes-selector-button");
    if (!commitsBtn) return;

    const anchor =
      commitsBtn.closest(
        '[class*="PullRequestFilesToolbar-module__hide-commit-selector"]'
      ) || commitsBtn.parentElement;
    if (!anchor?.parentElement) return;

    const label = document.createElement("label");
    label.id = "gh-pr-ext-tests-toggle";
    label.className = "gh-pr-ext-tests-toggle";
    label.title = "Split file tree into Code and Tests; show tests last";

    const input = document.createElement("input");
    input.id = "gh-pr-ext-tests-last";
    input.name = "gh-pr-ext-tests-last";
    input.type = "checkbox";
    input.checked = enabled;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-label", "Tests last");
    label.htmlFor = input.id;

    const text = document.createElement("span");
    text.textContent = "Tests last";

    input.addEventListener("change", async () => {
      enabled = input.checked;
      await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
      if (enabled) {
        startRetryLoop();
        applyAll();
      } else {
        stopRetryLoop();
        restoreAll();
      }
    });

    label.append(input, text);
    anchor.parentElement.insertBefore(label, anchor.nextSibling);
  }

  function observeTargets() {
    if (pageObserver) return;

    pageObserver = new MutationObserver((mutations) => {
      if (applying) return;
      if (shouldSkipMirrorRebuild(mutations)) return;
      ensureToggle();
      if (!enabled) return;
      scheduleApply();
    });

    const observe = (el) => {
      if (el) pageObserver.observe(el, { childList: true, subtree: true });
    };

    observe(document.getElementById("pr-file-tree"));
    observe(document.querySelector('[data-testid="progressive-diffs-list"]'));
    observe(document.getElementById("diff-comparison-viewer-container"));

    if (!document.getElementById("pr-file-tree")) {
      pageObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function stopRetryLoop() {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  function startRetryLoop() {
    if (retryTimer) return;
    const started = Date.now();
    retryTimer = setInterval(() => {
      if (!enabled) {
        stopRetryLoop();
        return;
      }
      ensureToggle();
      if (isPageReady()) {
        applyAll();
        observeTargets();
        stopRetryLoop();
        return;
      }
      if (Date.now() - started > RETRY_MAX_MS) {
        applyAll();
        stopRetryLoop();
        return;
      }
      if (countFileTreeRows() > 0) buildMirrorTree();
      if (countDiffEntries() > 0) applyDiffOrder();
      updateToggleHint(countFileTreeRows() > 0, countDiffEntries() > 0);
    }, RETRY_MS);
  }

  async function init() {
    if (!isPrChangesPage()) return;

    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (typeof stored[STORAGE_KEY] === "boolean") {
      enabled = stored[STORAGE_KEY];
    }

    ensureToggle();
    observeTargets();

    if (enabled) {
      startRetryLoop();
      scheduleApply();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
