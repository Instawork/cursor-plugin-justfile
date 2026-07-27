/**
 * GitHub auth: OAuth 2.0 device flow (no client secret) or legacy PAT in sync storage.
 * @see https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

export const STORAGE_PAT = "githubToken";
/** Sync: OAuth app public client id */
export const STORAGE_OAUTH_CLIENT_ID = "githubOAuthClientId";
/** Local: OAuth access token payload */
export const STORAGE_OAUTH = "githubOAuthCredentials";

/** Space-separated scopes — match PAT guidance (private repos + org teams). */
export const OAUTH_SCOPES = "repo read:org";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * @returns {Promise<string>} Bearer token for api.github.com, or "" if unset.
 */
export async function getGithubAccessToken() {
  const { [STORAGE_OAUTH]: oauth } = await chrome.storage.local.get(STORAGE_OAUTH);
  const t = oauth?.access_token;
  if (typeof t === "string" && t.trim()) return t.trim();
  const { [STORAGE_PAT]: pat } = await chrome.storage.sync.get(STORAGE_PAT);
  return typeof pat === "string" ? pat.trim() : "";
}

export async function getOAuthClientId() {
  const { [STORAGE_OAUTH_CLIENT_ID]: id } = await chrome.storage.sync.get(STORAGE_OAUTH_CLIENT_ID);
  return typeof id === "string" ? id.trim() : "";
}

export async function setOAuthClientId(clientId) {
  const v = typeof clientId === "string" ? clientId.trim() : "";
  if (!v) {
    await chrome.storage.sync.remove(STORAGE_OAUTH_CLIENT_ID);
    return;
  }
  await chrome.storage.sync.set({ [STORAGE_OAUTH_CLIENT_ID]: v });
}

export async function saveOAuthCredentials(data) {
  await chrome.storage.local.set({
    [STORAGE_OAUTH]: {
      access_token: data.access_token,
      token_type: data.token_type || "bearer",
      scope: data.scope || "",
      savedAt: new Date().toISOString(),
    },
  });
}

export async function clearOAuthCredentials() {
  await chrome.storage.local.remove(STORAGE_OAUTH);
}

/**
 * @returns {Promise<{ device_code: string, user_code: string, verification_uri: string, expires_in: number, interval: number }>}
 */
export async function requestDeviceCode(clientId) {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      scope: OAUTH_SCOPES,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data.error_description ||
      data.error ||
      `Device code request failed (${res.status})`;
    const err = new Error(msg);
    err.code = data.error;
    throw err;
  }
  if (!data.device_code || !data.user_code) {
    throw new Error("Invalid device code response from GitHub.");
  }
  return data;
}

/**
 * Poll until the user completes authorization or timeout.
 * @param {string} clientId
 * @param {string} deviceCode
 * @param {number} intervalSec from GitHub (min seconds between polls)
 * @param {number} expiresInSec from GitHub (device + user code lifetime, often 900)
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ access_token: string, token_type?: string, scope?: string }>}
 */
export async function pollDeviceAccessToken(
  clientId,
  deviceCode,
  intervalSec,
  expiresInSec,
  opts = {}
) {
  const { signal } = opts;
  let intervalMs = (intervalSec || 5) * 1000;
  const lifetimeMs = Math.max(60_000, (expiresInSec || 900) * 1000);
  const deadline = Date.now() + lifetimeMs - 10_000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Sign-in cancelled.");
    await new Promise((r) => setTimeout(r, intervalMs));
    if (signal?.aborted) throw new Error("Sign-in cancelled.");

    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (data.access_token) {
      return {
        access_token: data.access_token,
        token_type: data.token_type,
        scope: data.scope,
      };
    }

    if (data.error === "authorization_pending") {
      continue;
    }
    if (data.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (data.error === "expired_token") {
      throw new Error("The sign-in code expired. Try again.");
    }
    if (data.error === "access_denied") {
      throw new Error("Sign-in was cancelled on GitHub.");
    }
    if (data.error === "device_flow_disabled") {
      throw new Error(
        "Device flow is off for this OAuth app. On GitHub: OAuth app → enable “Device authorization”."
      );
    }

    const msg = data.error_description || data.error || `Token error (${res.status})`;
    throw new Error(msg);
  }

  throw new Error("Sign-in timed out. Open Settings and try again.");
}
