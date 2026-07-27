import {
  STORAGE_PAT,
  STORAGE_OAUTH,
  clearOAuthCredentials,
  getOAuthClientId,
  pollDeviceAccessToken,
  requestDeviceCode,
  saveOAuthCredentials,
  setOAuthClientId,
} from "./github-auth.js";

const STORAGE_DISMISSED = "dismissedInboxUrls";
const STORAGE_PINNED = "pinnedPrUrls";

const oauthClientIdInput = document.getElementById("oauth-client-id");
const saveOauthClientBtn = document.getElementById("save-oauth-client");
const oauthSignInBtn = document.getElementById("oauth-sign-in");
const oauthDisconnectBtn = document.getElementById("oauth-disconnect");
const oauthDevicePanel = document.getElementById("oauth-device-panel");
const oauthUserCode = document.getElementById("oauth-user-code");
const openDevicePageBtn = document.getElementById("open-device-page");
const oauthStatusEl = document.getElementById("oauth-status");

const tokenInput = document.getElementById("token");
const saveBtn = document.getElementById("save");
const clearDismissedBtn = document.getElementById("clear-dismissed");
const clearPinnedBtn = document.getElementById("clear-pinned");
const statusEl = document.getElementById("status");

let devicePollAbort = null;

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok === true ? "ok" : ok === false ? "err" : "";
}

function setOauthStatus(text, ok) {
  oauthStatusEl.textContent = text;
  oauthStatusEl.className = ok === true ? "ok" : ok === false ? "err" : "";
}

async function refreshAuthSummary() {
  const { [STORAGE_OAUTH]: bundle } = await chrome.storage.local.get(STORAGE_OAUTH);
  const hasOAuth = Boolean(bundle?.access_token);
  const hasPatField = tokenInput.value.trim().length > 0;
  if (hasOAuth) {
    setOauthStatus("Signed in with GitHub (OAuth).", true);
    oauthDisconnectBtn.disabled = false;
  } else {
    setOauthStatus(
      hasPatField
        ? "Using a personal access token below (no OAuth session)."
        : "Not signed in. Use OAuth above or paste a token below.",
      undefined
    );
    oauthDisconnectBtn.disabled = true;
  }
}

async function load() {
  const { [STORAGE_PAT]: token } = await chrome.storage.sync.get(STORAGE_PAT);
  tokenInput.value = typeof token === "string" ? token : "";
  oauthClientIdInput.value = await getOAuthClientId();
  await refreshAuthSummary();
}

saveOauthClientBtn.addEventListener("click", async () => {
  await setOAuthClientId(oauthClientIdInput.value);
  setOauthStatus("Client ID saved.", true);
});

oauthDisconnectBtn.addEventListener("click", async () => {
  await clearOAuthCredentials();
  if (devicePollAbort) devicePollAbort.abort();
  devicePollAbort = null;
  oauthDevicePanel.classList.add("hidden");
  oauthSignInBtn.disabled = false;
  setOauthStatus("Disconnected from GitHub.", true);
  await refreshAuthSummary();
});

oauthSignInBtn.addEventListener("click", async () => {
  const clientId = oauthClientIdInput.value.trim() || (await getOAuthClientId());
  if (!clientId) {
    setOauthStatus("Enter your OAuth app Client ID first (or save it).", false);
    return;
  }
  await setOAuthClientId(clientId);
  oauthClientIdInput.value = clientId;

  if (devicePollAbort) devicePollAbort.abort();
  devicePollAbort = new AbortController();

  oauthSignInBtn.disabled = true;
  setOauthStatus("Requesting device code…", undefined);
  oauthDevicePanel.classList.add("hidden");

  try {
    const device = await requestDeviceCode(clientId);
    oauthUserCode.textContent = device.user_code;
    oauthDevicePanel.classList.remove("hidden");
    setOauthStatus(
      `Enter the code on GitHub, then wait — this page will confirm when you’re done (${device.expires_in}s window).`,
      undefined
    );

    const tokenPayload = await pollDeviceAccessToken(
      clientId,
      device.device_code,
      device.interval,
      device.expires_in,
      { signal: devicePollAbort.signal }
    );
    await saveOAuthCredentials(tokenPayload);
    setOauthStatus("Signed in. You can close this tab and open the extension.", true);
    oauthDevicePanel.classList.add("hidden");
    await refreshAuthSummary();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setOauthStatus(msg, false);
  } finally {
    oauthSignInBtn.disabled = false;
    devicePollAbort = null;
  }
});

openDevicePageBtn.addEventListener("click", () => {
  window.open("https://github.com/login/device", "_blank", "noopener,noreferrer");
});

saveBtn.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    await chrome.storage.sync.remove(STORAGE_PAT);
    setStatus("Token cleared.", true);
    await refreshAuthSummary();
    return;
  }
  await chrome.storage.sync.set({ [STORAGE_PAT]: token });
  setStatus("Token saved. OAuth still takes priority if you are signed in with GitHub.", true);
  await refreshAuthSummary();
});

clearDismissedBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(STORAGE_DISMISSED);
  setStatus("Dismissed PRs cleared.", true);
});

clearPinnedBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(STORAGE_PINNED);
  setStatus("Pinned PRs cleared.", true);
});

load();
