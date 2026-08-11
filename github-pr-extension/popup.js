import { getGithubAccessToken } from "./github-auth.js";

const STORAGE_DISMISSED = "dismissedInboxUrls";
const STORAGE_CACHE = "prDashboardCache";
const STORAGE_PINNED = "pinnedPrUrls";
/** sessionStorage: show full team-403 explanation once per browser session */
const SESSION_TEAMS403_DETAIL = "ghPrExt_teams403DetailShown";

const CACHE_VERSION = 1;
const STORAGE_CI_CACHE = "ciStatusCache";
const CI_CACHE_TTL_MS = 5 * 60 * 1000;

const SAML_SSO_PAT_DOC =
  "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on";

const els = {
  refresh: document.getElementById("refresh"),
  message: document.getElementById("message"),
  pinnedPanel: document.getElementById("pinned-panel"),
  pinnedList: document.getElementById("pinned-list"),
  pinnedEmpty: document.getElementById("pinned-empty"),
  pinnedCount: document.getElementById("pinned-count"),
  pinnedToggle: document.getElementById("pinned-toggle"),
  pinnedBody: document.getElementById("pinned-body"),
  mineList: document.getElementById("mine-list"),
  mineEmpty: document.getElementById("mine-empty"),
  mineCount: document.getElementById("mine-count"),
  mineToggle: document.getElementById("mine-toggle"),
  mineBody: document.getElementById("mine-body"),
  inboxList: document.getElementById("inbox-list"),
  inboxEmpty: document.getElementById("inbox-empty"),
  inboxCount: document.getElementById("inbox-count"),
  inboxToggle: document.getElementById("inbox-toggle"),
  inboxBody: document.getElementById("inbox-body"),
  optionsBtn: document.getElementById("options-link"),
  githubSearch: document.getElementById("github-search"),
};

function showMessage(text, isError) {
  els.message.textContent = text;
  els.message.classList.toggle("hidden", !text);
  els.message.classList.toggle("error", Boolean(isError));
}

async function getToken() {
  return getGithubAccessToken();
}

async function getDismissedSet() {
  const { [STORAGE_DISMISSED]: list } = await chrome.storage.local.get(STORAGE_DISMISSED);
  return new Set(Array.isArray(list) ? list : []);
}

async function addDismissed(url) {
  const set = await getDismissedSet();
  set.add(url);
  await chrome.storage.local.set({ [STORAGE_DISMISSED]: [...set] });
}

async function getPinnedUrls() {
  const { [STORAGE_PINNED]: list } = await chrome.storage.local.get(STORAGE_PINNED);
  return Array.isArray(list) ? list.filter((u) => typeof u === "string" && u) : [];
}

async function setPinnedUrls(urls) {
  await chrome.storage.local.set({ [STORAGE_PINNED]: urls });
}

async function togglePinnedUrl(url) {
  const urls = await getPinnedUrls();
  const i = urls.indexOf(url);
  if (i >= 0) {
    urls.splice(i, 1);
  } else {
    urls.unshift(url);
  }
  await setPinnedUrls(urls);
  return new Set(urls);
}

/**
 * @returns {Promise<{ v: number, at: string, mine: unknown[], inbox: unknown[] } | null>}
 */
async function getPrCache() {
  const { [STORAGE_CACHE]: raw } = await chrome.storage.local.get(STORAGE_CACHE);
  if (!raw || typeof raw !== "object") return null;
  const v = raw.v;
  const mine = raw.mine;
  const inbox = raw.inbox;
  const at = typeof raw.at === "string" ? raw.at : "";
  if (v !== CACHE_VERSION || !Array.isArray(mine) || !Array.isArray(inbox)) return null;
  return { v, at, mine, inbox };
}

async function setPrCache({ mine, inbox }) {
  await chrome.storage.local.set({
    [STORAGE_CACHE]: {
      v: CACHE_VERSION,
      at: new Date().toISOString(),
      mine,
      inbox,
    },
  });
}

function slimIssue(issue, extra = {}) {
  const user = issue.user && typeof issue.user === "object" ? issue.user : null;
  return {
    html_url: issue.html_url,
    title: issue.title,
    number: issue.number,
    user: user && user.login ? { login: String(user.login) } : null,
    updated_at: issue.updated_at,
    repository_url: issue.repository_url,
    draft: Boolean(issue.draft),
    comments: typeof issue.comments === "number" ? issue.comments : 0,
    state: typeof issue.state === "string" ? issue.state : "open",
    ...extra,
  };
}

function githubFetch(path, token) {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  }).then(async (res) => {
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text || "Invalid JSON" };
    }
    if (!res.ok) {
      const msg =
        body?.message ||
        body?.errors?.[0]?.message ||
        `GitHub API error (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return body;
  });
}

function encodeQuery(q) {
  return encodeURIComponent(q).replace(/%20/g, "+");
}

async function searchIssues(token, query, perPage = 40) {
  const q = encodeQuery(query);
  return githubFetch(
    `/search/issues?q=${q}&per_page=${perPage}&sort=updated&order=desc`,
    token
  );
}

/**
 * Teams the user belongs to (for team-review-requested search).
 * Fails soft on 403/404 (e.g. token missing read:org).
 * @returns {{ teams: Array<{ organization: { login: string }, slug: string }>, teamsForbidden: boolean }}
 */
async function fetchUserTeamsLenient(token) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(
      `https://api.github.com/user/teams?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (res.status === 403) {
      return { teams: out, teamsForbidden: true };
    }
    if (res.status === 404) return { teams: out, teamsForbidden: false };
    if (!res.ok) return { teams: out, teamsForbidden: false };
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    for (const t of data) {
      const org = t?.organization?.login;
      const slug = t?.slug;
      if (org && slug) out.push({ organization: { login: org }, slug });
    }
    if (data.length < 100) break;
  }
  return { teams: out, teamsForbidden: false };
}

function buildOrgAccessHint({
  teamsForbidden,
  inboxSearchIncomplete,
  mineHasOrgRepo,
  inboxCount,
  login,
}) {
  if (inboxCount > 0) return "";
  const likelyOrgIssue =
    teamsForbidden || inboxSearchIncomplete || mineHasOrgRepo;
  if (!likelyOrgIssue) return "";

  const parts = [];
  if (teamsForbidden) {
    const ss = typeof sessionStorage !== "undefined" ? sessionStorage : null;
    const already = ss && ss.getItem(SESSION_TEAMS403_DETAIL);
    if (already) {
      parts.push(
        "Your token still cannot list teams (403), so team-requested reviews are omitted—add read:org (or fine-grained org access)."
      );
    } else {
      parts.push(
        "Team review requests need API access to your teams: add read:org on a classic PAT (or org + repo permissions on a fine-grained PAT)."
      );
      if (ss) ss.setItem(SESSION_TEAMS403_DETAIL, "1");
    }
  }
  if (inboxSearchIncomplete) {
    parts.push(
      "GitHub search returned incomplete results; org or team PRs may be missing—check token scopes and try again."
    );
  }
  if (mineHasOrgRepo && login) {
    parts.push(
      "You have open PRs under an organization but nothing in Review & mentions—private org reviews often need repo + read:org, and SSO orgs must authorize the token."
    );
  }

  const scope =
    "Classic PAT: repo, read:org. Fine-grained: grant organization access plus Pull requests (and Metadata) on relevant repos.";
  const sso = `SSO-enabled orgs: authorize the token for the org (${SAML_SSO_PAT_DOC}).`;

  if (parts.length === 0) return "";
  return `${parts.join(" ")} ${scope} ${sso}`;
}

function fullRepoName(issue) {
  const repoUrl = issue.repository_url || "";
  const m = repoUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
  return m ? m[1] : "";
}

function repoLabelFallback(issue) {
  const u = issue.html_url || "";
  const m = u.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\//);
  return m ? m[1] : "";
}

function repoHue(fullName) {
  let h = 0;
  for (let i = 0; i < fullName.length; i++) {
    h = (h * 31 + fullName.charCodeAt(i)) >>> 0;
  }
  return 25 + (h % 176);
}

function tagReason(items, reason) {
  const arr = items || [];
  return arr.map((it) => ({ ...it, _inboxReason: reason }));
}

function dedupeByUrlWithReasons(items) {
  const map = new Map();
  for (const it of items) {
    const url = it.html_url;
    if (!url) continue;
    const prev = map.get(url);
    if (!prev) {
      const reasons = it._inboxReason ? [it._inboxReason] : [];
      map.set(url, { ...it, _inboxReasons: reasons });
      continue;
    }
    const reasons = new Set(prev._inboxReasons || []);
    if (it._inboxReason) reasons.add(it._inboxReason);
    map.set(url, { ...prev, ...it, _inboxReasons: [...reasons] });
  }
  return [...map.values()];
}

function formatRelativeTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

const REASON_LABELS = {
  review: "Review requested",
  mention: "Mentioned",
  "team-review": "Team review",
};

function formatInboxReasons(reasons) {
  if (!reasons || reasons.length === 0) return "";
  const labels = [...new Set(reasons)]
    .map((r) => REASON_LABELS[r] || r)
    .filter(Boolean);
  return labels.join(" · ");
}

function buildStateParts(issue, { isMine, inboxReasons }) {
  const parts = [];
  const state = String(issue.state || "open").toLowerCase();
  if (state === "open") parts.push("Open");
  else parts.push(state.charAt(0).toUpperCase() + state.slice(1));
  if (issue.draft) parts.push("Draft");
  if (!isMine && inboxReasons && inboxReasons.length) {
    const r = formatInboxReasons(inboxReasons);
    if (r) parts.push(r);
  }
  const n = issue.comments;
  if (typeof n === "number" && n > 0) {
    parts.push(`${n} comment${n === 1 ? "" : "s"}`);
  }
  return parts;
}

function countPrItems(container) {
  return container.querySelectorAll(".pr-item").length;
}

function wireSectionToggle(button, body) {
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    const next = !expanded;
    button.setAttribute("aria-expanded", String(next));
    body.hidden = !next;
  });
}

wireSectionToggle(els.mineToggle, els.mineBody);
wireSectionToggle(els.inboxToggle, els.inboxBody);
wireSectionToggle(els.pinnedToggle, els.pinnedBody);

/** Latest PR lists for re-render after pin/dismiss (same fetch or cache pass). */
let listSnapshot = { mineItems: [], inboxRawItems: [], extraPinnedIssues: [] };

/** URL → CI result, kept in memory so re-renders can re-apply badges without refetching. */
const ciResultsMap = new Map();

function parsePrInfo(htmlUrl) {
  const m = String(htmlUrl || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: m[3] } : null;
}

async function getCiCache() {
  const { [STORAGE_CI_CACHE]: raw } = await chrome.storage.local.get(STORAGE_CI_CACHE);
  return raw && typeof raw === "object" ? raw : {};
}

async function setCiCache(data) {
  await chrome.storage.local.set({ [STORAGE_CI_CACHE]: data });
}

function rollupCheckRuns(checkRuns) {
  if (!checkRuns || checkRuns.length === 0) return { status: "none", total: 0 };
  let hasFailed = false;
  let hasPending = false;
  for (const run of checkRuns) {
    if (run.status !== "completed") {
      hasPending = true;
    } else if (
      run.conclusion === "failure" ||
      run.conclusion === "cancelled" ||
      run.conclusion === "timed_out" ||
      run.conclusion === "action_required"
    ) {
      hasFailed = true;
    }
  }
  const total = checkRuns.length;
  if (hasFailed) return { status: "failing", total };
  if (hasPending) return { status: "pending", total };
  return { status: "passing", total };
}

async function fetchPrCiStatus(token, owner, repo, number) {
  const pr = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`, token);
  const sha = pr.head?.sha;
  if (!sha) return { status: "none", total: 0 };

  const data = await githubFetch(
    `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
    token
  );
  const checkRuns = data.check_runs || [];
  if (checkRuns.length > 0) return rollupCheckRuns(checkRuns);

  const combined = await githubFetch(
    `/repos/${owner}/${repo}/commits/${sha}/status`,
    token
  );
  const { state, total_count: total = 0 } = combined;
  if (state === "success") return { status: "passing", total };
  if (state === "pending") return { status: "pending", total };
  if (state === "failure" || state === "error") return { status: "failing", total };
  return { status: "none", total: 0 };
}

function updateCiBadge(url, ciResult) {
  ciResultsMap.set(url, ciResult);
  const { status, total } = ciResult;
  const label =
    total > 0
      ? `CI: ${status} (${total} check${total === 1 ? "" : "s"})`
      : `CI: ${status === "none" ? "no checks" : status}`;
  for (const li of document.querySelectorAll(`[data-pr-url="${CSS.escape(url)}"]`)) {
    const badge = li.querySelector(".ci-badge");
    if (!badge) continue;
    badge.className = `ci-badge ci-${status}`;
    badge.title = label;
    badge.setAttribute("aria-label", label);
  }
}

function applyCiResultsToDom() {
  for (const [url, result] of ciResultsMap) {
    updateCiBadge(url, result);
  }
}

async function loadCiStatusesAsync(token, issues) {
  if (!token || !issues || issues.length === 0) return;
  const now = Date.now();
  const cache = await getCiCache();
  const toFetch = [];

  for (const issue of issues) {
    const url = issue.html_url;
    if (!url) continue;
    const cached = cache[url];
    if (cached && cached.at && now - new Date(cached.at).getTime() < CI_CACHE_TTL_MS) {
      updateCiBadge(url, cached);
    } else {
      toFetch.push(issue);
    }
  }

  if (toFetch.length === 0) return;

  const BATCH = 8;
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const batch = toFetch.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (issue) => {
        const url = issue.html_url;
        const info = parsePrInfo(url);
        if (!info) return;
        try {
          const result = await fetchPrCiStatus(token, info.owner, info.repo, info.number);
          cache[url] = { ...result, at: new Date().toISOString() };
          updateCiBadge(url, result);
        } catch {
          // silently skip CI errors
        }
      })
    );
    await setCiCache(cache);
  }
}

function issueByUrlMap(mineItems, inboxRawItems) {
  const m = new Map();
  for (const it of mineItems || []) {
    if (it.html_url) m.set(it.html_url, { ...it, _section: "mine" });
  }
  for (const it of inboxRawItems || []) {
    if (!it.html_url) continue;
    const cur = m.get(it.html_url);
    const reasons = it._inboxReasons || (it._inboxReason ? [it._inboxReason] : []);
    if (!cur) {
      m.set(it.html_url, { ...it, _section: "inbox", _inboxReasons: reasons });
      continue;
    }
    const merged = new Set([...(cur._inboxReasons || []), ...reasons]);
    m.set(it.html_url, {
      ...cur,
      ...it,
      _section: cur._section === "mine" ? "mine" : "inbox",
      _inboxReasons: [...merged],
    });
  }
  return m;
}

function renderPrItem(issue, options) {
  const { dismissable, showPin, pinnedSet, onPinToggled, isMine, flatRepoHue } =
    options;

  const li = document.createElement("li");
  li.className = `pr-item${dismissable ? " inbox-row" : ""}${flatRepoHue != null ? " pr-item-flat" : ""}`;
  li.dataset.prUrl = String(issue.html_url || "");
  if (flatRepoHue != null) {
    li.style.setProperty("--repo-h", String(flatRepoHue));
  }

  const main = document.createElement("div");
  main.className = "pr-main";

  const title = document.createElement("p");
  title.className = "pr-title";
  const a = document.createElement("a");
  a.href = String(issue.html_url || "#");
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = String(issue.title || "(no title)");
  title.appendChild(a);

  const meta = document.createElement("p");
  meta.className = "pr-meta";
  const repo = fullRepoName(issue) || repoLabelFallback(issue) || "";
  const num = issue.number != null ? `#${issue.number}` : "";
  const author = issue.user && issue.user.login ? `@${issue.user.login}` : "";
  const metaBits = [repo && `${repo}${num ? ` ${num}` : ""}`, author].filter(Boolean);
  meta.textContent = metaBits.join(" · ");

  const reasons = issue._inboxReasons || (issue._inboxReason ? [issue._inboxReason] : []);
  const stateParts = buildStateParts(issue, { isMine, inboxReasons: reasons });
  const stateLine = document.createElement("p");
  stateLine.className = "pr-state";
  const ciBadge = document.createElement("span");
  ciBadge.className = "ci-badge ci-none";
  ciBadge.setAttribute("aria-label", "CI status");
  stateLine.appendChild(ciBadge);
  if (stateParts.length > 0) {
    stateLine.appendChild(document.createTextNode(stateParts.join(" · ")));
  }

  main.appendChild(title);
  main.appendChild(meta);
  main.appendChild(stateLine);
  li.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "pr-actions";

  if (showPin && issue.html_url) {
    const url = String(issue.html_url);
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "pin";
    const isPinned = pinnedSet && pinnedSet.has(url);
    pinBtn.classList.toggle("pin-active", isPinned);
    pinBtn.textContent = isPinned ? "Unpin" : "Pin";
    pinBtn.title = isPinned ? "Unpin this PR" : "Pin to top";
    pinBtn.setAttribute("aria-label", isPinned ? "Unpin this PR" : "Pin to top");
    pinBtn.setAttribute("aria-pressed", isPinned ? "true" : "false");
    pinBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await togglePinnedUrl(url);
      if (typeof onPinToggled === "function") await onPinToggled();
    });
    actions.appendChild(pinBtn);
  }

  if (dismissable) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dismiss";
    btn.textContent = "Hide";
    btn.title = "Hide from this extension (stored locally; not on GitHub)";
    btn.setAttribute(
      "aria-label",
      "Hide from this extension (stored locally; not on GitHub)"
    );
    btn.addEventListener("click", async () => {
      const url = String(issue.html_url || "");
      await addDismissed(url);
      const pinnedNow = await getPinnedUrls();
      if (url && pinnedNow.includes(url)) {
        await setPinnedUrls(pinnedNow.filter((x) => x !== url));
      }
      if (typeof onPinToggled === "function") await onPinToggled();
    });
    actions.appendChild(btn);
  }

  if (actions.children.length > 0) {
    li.appendChild(actions);
  }

  return li;
}

function renderFlatSorted(container, items, opts) {
  const { dismissable, pinnedSet, onPinToggled, isMine } = opts;
  container.replaceChildren();
  const sorted = [...items].sort((a, b) => {
    const ta = new Date(String(a.updated_at || 0)).getTime();
    const tb = new Date(String(b.updated_at || 0)).getTime();
    return tb - ta;
  });
  const ul = document.createElement("ul");
  ul.className = "pr-list pr-list-flat";
  for (const issue of sorted) {
    const hue = repoHue(fullRepoName(issue) || repoLabelFallback(issue) || "unknown");
    ul.appendChild(
      renderPrItem(issue, {
        dismissable,
        showPin: true,
        pinnedSet,
        onPinToggled,
        isMine: Boolean(isMine),
        flatRepoHue: hue,
      })
    );
  }
  container.appendChild(ul);
}

function renderRepoGroups(container, grouped, opts) {
  const { dismissable, pinnedSet, onPinToggled, isMine } = opts;
  container.replaceChildren();
  for (const [repoName, issues] of grouped) {
    const hue = repoHue(repoName);
    const wrap = document.createElement("div");
    wrap.className = "repo-group";
    wrap.style.setProperty("--repo-h", String(hue));

    const headerRow = document.createElement("div");
    headerRow.className = "repo-header-row";

    const pill = document.createElement("span");
    pill.className = "repo-pill";
    pill.setAttribute("aria-hidden", "true");

    const repoLink = document.createElement("a");
    repoLink.className = "repo-name";
    repoLink.href = `https://github.com/${repoName}/pulls`;
    repoLink.target = "_blank";
    repoLink.rel = "noopener";
    repoLink.textContent = repoName;

    headerRow.appendChild(pill);
    headerRow.appendChild(repoLink);
    wrap.appendChild(headerRow);

    const ul = document.createElement("ul");
    ul.className = "pr-list";

    for (const issue of issues) {
      ul.appendChild(
        renderPrItem(issue, {
          dismissable,
          showPin: true,
          pinnedSet,
          onPinToggled,
          isMine: Boolean(isMine),
        })
      );
    }
    wrap.appendChild(ul);
    container.appendChild(wrap);
  }
}

function groupByRepoSorted(items) {
  const map = new Map();
  for (const it of items) {
    const name = fullRepoName(it) || repoLabelFallback(it) || "unknown";
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(it);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      const ta = new Date(String(a.updated_at || 0)).getTime();
      const tb = new Date(String(b.updated_at || 0)).getTime();
      return tb - ta;
    });
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function filterOutPinned(items, pinnedSet) {
  if (!pinnedSet || pinnedSet.size === 0) return items;
  return items.filter((it) => it.html_url && !pinnedSet.has(it.html_url));
}

/**
 * Fetch pinned URLs missing from search results.
 * Open → keep and return issue data; closed/merged → drop; lookup failure → keep URL, hide.
 * @returns {Promise<{ survivingUrls: string[], fetchedIssues: unknown[] }>}
 */
async function reconcileMissingPins(token, pinnedUrls, lookup) {
  const results = await Promise.all(
    pinnedUrls.map(async (url) => {
      if (lookup.has(url)) {
        return { url, keep: true, issue: null };
      }
      if (!token) {
        return { url, keep: true, issue: null };
      }
      const info = parsePrInfo(url);
      if (!info) {
        return { url, keep: true, issue: null };
      }
      try {
        const pr = await githubFetch(
          `/repos/${info.owner}/${info.repo}/pulls/${info.number}`,
          token
        );
        const state = String(pr.state || "").toLowerCase();
        if (state !== "open") {
          // Confirmed closed or merged — unpin.
          return { url, keep: false, issue: null };
        }
        const issue = slimIssue(pr, {
          repository_url: `https://api.github.com/repos/${info.owner}/${info.repo}`,
          _section: "inbox",
          _inboxReasons: [],
        });
        if (!issue.html_url) issue.html_url = url;
        return { url, keep: true, issue };
      } catch {
        // Keep pin on failure (incl. permission 404); hide until next successful lookup.
        return { url, keep: true, issue: null };
      }
    })
  );

  const survivingUrls = [];
  const fetchedIssues = [];
  for (const r of results) {
    if (!r.keep) continue;
    survivingUrls.push(r.url);
    if (r.issue) fetchedIssues.push(r.issue);
  }
  return { survivingUrls, fetchedIssues };
}

function renderPinnedList(pinnedUrls, lookup, pinnedSet, onPinToggled) {
  els.pinnedList.replaceChildren();
  let shown = 0;
  for (const url of pinnedUrls) {
    const issue = lookup.get(url);
    if (!issue) continue;
    const reasons = issue._inboxReasons || (issue._inboxReason ? [issue._inboxReason] : []);
    const isMinePin = issue._section === "mine" && reasons.length === 0;
    const li = renderPrItem(issue, {
      dismissable: true,
      showPin: true,
      pinnedSet,
      onPinToggled,
      isMine: isMinePin,
      flatRepoHue: repoHue(fullRepoName(issue) || repoLabelFallback(issue) || "unknown"),
    });
    els.pinnedList.appendChild(li);
    shown += 1;
  }
  els.pinnedCount.textContent = String(shown);
  els.pinnedEmpty.classList.toggle("hidden", shown > 0);
  els.pinnedPanel.classList.toggle("hidden", shown === 0);
}

function syncMineChrome() {
  const n = countPrItems(els.mineList);
  els.mineCount.textContent = String(n);
  els.mineEmpty.classList.toggle("hidden", n > 0);
}

function syncInboxChrome() {
  const n = countPrItems(els.inboxList);
  els.inboxCount.textContent = String(n);
  els.inboxEmpty.classList.toggle("hidden", n > 0);
}

/**
 * @param {object} params
 * @param {unknown[]} params.mineItems
 * @param {unknown[]} params.inboxRawItems inbox union before dismiss+pin filters (for pin lookup)
 * @param {unknown[]} [params.extraPinnedIssues] open pins fetched outside search (lookup only)
 * @param {Set<string>} params.dismissed
 * @param {string[]} params.pinnedUrls
 * @param {Set<string>} params.pinnedSet
 */
function renderAllLists({
  mineItems,
  inboxRawItems,
  extraPinnedIssues = [],
  dismissed,
  pinnedUrls,
  pinnedSet,
}) {
  listSnapshot = { mineItems, inboxRawItems, extraPinnedIssues };
  const lookup = issueByUrlMap(mineItems, inboxRawItems);
  for (const it of extraPinnedIssues) {
    if (it?.html_url && !lookup.has(it.html_url)) {
      lookup.set(it.html_url, it);
    }
  }

  const onPinToggled = async () => {
    const [pinned, dis] = await Promise.all([getPinnedUrls(), getDismissedSet()]);
    renderAllLists({
      mineItems: listSnapshot.mineItems,
      inboxRawItems: listSnapshot.inboxRawItems,
      extraPinnedIssues: listSnapshot.extraPinnedIssues || [],
      dismissed: dis,
      pinnedUrls: pinned,
      pinnedSet: new Set(pinned),
    });
  };

  renderPinnedList(pinnedUrls, lookup, pinnedSet, onPinToggled);

  const mineFiltered = filterOutPinned(mineItems, pinnedSet).filter(
    (it) => it.html_url && !dismissed.has(it.html_url)
  );
  const inboxFiltered = filterOutPinned(inboxRawItems, pinnedSet).filter(
    (it) => it.html_url && !dismissed.has(it.html_url)
  );

  renderFlatSorted(els.mineList, mineFiltered, {
    dismissable: true,
    pinnedSet,
    onPinToggled,
    isMine: true,
  });
  syncMineChrome();

  renderFlatSorted(els.inboxList, inboxFiltered, {
    dismissable: true,
    pinnedSet,
    onPinToggled,
    isMine: false,
  });
  syncInboxChrome();
  applyCiResultsToDom();
}

async function load() {
  els.refresh.disabled = true;

  const [token, cache, dismissed, pinnedUrlsRaw] = await Promise.all([
    getToken(),
    getPrCache(),
    getDismissedSet(),
    getPinnedUrls(),
  ]);
  const pinnedSet = new Set(pinnedUrlsRaw);

  if (cache && Array.isArray(cache.mine) && Array.isArray(cache.inbox)) {
    renderAllLists({
      mineItems: cache.mine,
      inboxRawItems: cache.inbox,
      dismissed,
      pinnedUrls: pinnedUrlsRaw,
      pinnedSet,
    });
    const allCacheForCi = [...new Map(
      [...cache.mine, ...cache.inbox].map((it) => [it.html_url, it])
    ).values()];
    loadCiStatusesAsync(token, allCacheForCi).catch(() => {});
    const rel = formatRelativeTime(cache.at);
    showMessage(
      rel ? `Showing cached data (${rel}). Refreshing…` : "Showing cached data. Refreshing…",
      false
    );
  } else {
    els.mineList.replaceChildren();
    els.inboxList.replaceChildren();
    els.pinnedList.replaceChildren();
    els.mineEmpty.classList.add("hidden");
    els.inboxEmpty.classList.add("hidden");
    els.pinnedEmpty.classList.add("hidden");
    els.pinnedPanel.classList.add("hidden");
    els.mineCount.textContent = "0";
    els.inboxCount.textContent = "0";
    els.pinnedCount.textContent = "0";
    showMessage("Loading…", false);
  }

  if (!token) {
    showMessage(
      cache
        ? "Sign in with GitHub or add a token in Settings to refresh. Cached lists shown above."
        : "Sign in with GitHub (OAuth) or add a personal token in Settings.",
      true
    );
    if (!cache) {
      els.mineEmpty.classList.remove("hidden");
      els.inboxEmpty.classList.remove("hidden");
    }
    els.refresh.disabled = false;
    return;
  }

  try {
    const user = await githubFetch("/user", token);
    const login = user.login;
    if (!login) throw new Error("Could not read GitHub username.");

    els.githubSearch.href =
      "https://github.com/pulls?q=is%3Aopen+is%3Apr+author%3A%40me+archived%3Afalse";

    const { teams, teamsForbidden } = await fetchUserTeamsLenient(token);

    const [mineRes, reviewRes, mentionsRes] = await Promise.all([
      searchIssues(token, "is:pr is:open archived:false author:@me"),
      searchIssues(token, "is:pr is:open archived:false review-requested:@me"),
      searchIssues(token, "is:pr is:open archived:false mentions:@me"),
    ]);

    const teamResList =
      teams.length === 0
        ? []
        : await Promise.all(
            teams.map((t) => {
              const q = `is:pr is:open archived:false team-review-requested:${t.organization.login}/${t.slug}`;
              return searchIssues(token, q).catch(() => ({ items: [] }));
            })
          );

    const mineItems = mineRes.items || [];
    const combinedTagged = [
      ...tagReason(reviewRes.items || [], "review"),
      ...tagReason(mentionsRes.items || [], "mention"),
      ...teamResList.flatMap((r) => tagReason(r.items || [], "team-review")),
    ];
    const inboxRawItems = dedupeByUrlWithReasons(combinedTagged);

    const slimMine = mineItems.map((it) => slimIssue(it));
    const slimInbox = inboxRawItems.map((it) =>
      slimIssue(it, { _inboxReasons: it._inboxReasons || [] })
    );
    await setPrCache({ mine: slimMine, inbox: slimInbox });

    const dismissedNow = await getDismissedSet();
    const pinnedNow = await getPinnedUrls();
    const searchLookup = issueByUrlMap(mineItems, inboxRawItems);
    const { survivingUrls, fetchedIssues } = await reconcileMissingPins(
      token,
      pinnedNow,
      searchLookup
    );
    if (
      survivingUrls.length !== pinnedNow.length ||
      survivingUrls.some((u, i) => u !== pinnedNow[i])
    ) {
      await setPinnedUrls(survivingUrls);
    }
    const pinnedSetNow = new Set(survivingUrls);

    renderAllLists({
      mineItems,
      inboxRawItems,
      extraPinnedIssues: fetchedIssues,
      dismissed: dismissedNow,
      pinnedUrls: survivingUrls,
      pinnedSet: pinnedSetNow,
    });

    const allForCi = [...new Map(
      [...mineItems, ...inboxRawItems, ...fetchedIssues].map((it) => [it.html_url, it])
    ).values()];
    loadCiStatusesAsync(token, allForCi).catch(() => {});

    const inboxVisible = inboxRawItems.filter(
      (it) =>
        it.html_url &&
        !dismissedNow.has(it.html_url) &&
        !pinnedSetNow.has(it.html_url)
    );

    const inboxSearchIncomplete = [reviewRes, mentionsRes, ...teamResList].some(
      (r) => Boolean(r && r.incomplete_results)
    );
    let mineHasOrgRepo = false;
    for (const it of mineItems) {
      const repoName = fullRepoName(it) || repoLabelFallback(it);
      const owner = repoName.includes("/") ? repoName.split("/")[0] : "";
      if (owner && owner !== login) {
        mineHasOrgRepo = true;
        break;
      }
    }

    const orgHint = buildOrgAccessHint({
      teamsForbidden,
      inboxSearchIncomplete,
      mineHasOrgRepo,
      inboxCount: inboxVisible.length,
      login,
    });
    showMessage(orgHint, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (cache && Array.isArray(cache.mine)) {
      showMessage(`${msg} — cached data kept above.`, true);
    } else {
      showMessage(msg, true);
      els.mineEmpty.classList.remove("hidden");
      els.inboxEmpty.classList.remove("hidden");
    }
  } finally {
    els.refresh.disabled = false;
  }
}

els.refresh.addEventListener("click", () => load());
els.optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
load();
