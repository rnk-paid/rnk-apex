const TOKEN_STORE_KEY = "__RNK_MAPGEN_PATREON_TOKENS__";
const MESSAGE_TYPES = new Set(["PATREON_AUTH_SUCCESS", "rnk-patreon-auth"]);

function getTokenStore() {
  if (!globalThis[TOKEN_STORE_KEY]) {
    globalThis[TOKEN_STORE_KEY] = {};
  }
  return globalThis[TOKEN_STORE_KEY];
}

function base64UrlDecode(payload) {
  try {
    const normalized = String(payload).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = atob(padded);
    return decodeURIComponent(Array.from(decoded, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
  } catch (_error) {
    return "";
  }
}

function decodeJwt(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = base64UrlDecode(parts[1]);
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch (_error) {
    return null;
  }
}

function getRandomState() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createPatreonAuthController({
  moduleName,
  defaultAuthBaseUrl,
  settingKey = "patreonAuthUrl",
  sharedTokenSettingKey = "patreonSharedToken",
  onChange = null,
}) {
  if (!moduleName) {
    throw new Error("createPatreonAuthController requires a moduleName.");
  }

  const tokenKey = `${moduleName}:token`;
  let authState = {
    token: "",
    claims: null,
  };
  let loginInFlight = null;

  function getAuthBaseUrl() {
    const configured = game.settings.get(moduleName, settingKey);
    const value = String(configured || defaultAuthBaseUrl || "").trim();
    return value.replace(/\/$/, "");
  }

  // The shared token lives in a world-scope setting so that once any GM (or
  // Assistant GM) in the world authenticates with Patreon, every other GM in
  // that same world inherits the same access without logging in separately,
  // and the login survives page reloads instead of living only in memory.
  function readSharedToken() {
    try {
      return String(game.settings.get(moduleName, sharedTokenSettingKey) || "");
    } catch (_error) {
      return "";
    }
  }

  function writeSharedToken(token) {
    if (!game.user?.isGM) return;
    try {
      game.settings.set(moduleName, sharedTokenSettingKey, token || "");
    } catch (_error) {
      // Setting may not be registered yet on very early calls; safe to ignore.
    }
  }

  function writeToken(token) {
    const store = getTokenStore();
    if (token) {
      store[tokenKey] = token;
      authState.token = token;
      authState.claims = decodeJwt(token);
    } else {
      delete store[tokenKey];
      authState.token = "";
      authState.claims = null;
    }
    writeSharedToken(token);
    onChange?.(getSnapshot());
    return token;
  }

  function readToken() {
    const store = getTokenStore();
    let token = store[tokenKey] || "";
    if (!token) {
      token = readSharedToken();
      if (token) store[tokenKey] = token;
    }
    if (!token) return "";
    if (authState.token !== token) {
      authState.token = token;
      authState.claims = decodeJwt(token);
    }
    return token;
  }

  function getClaims() {
    readToken();
    return authState.claims;
  }

  function isExpired(token = readToken()) {
    const claims = token ? decodeJwt(token) : null;
    const exp = Number(claims?.exp || 0);
    if (!exp) return false;
    return Date.now() >= (exp * 1000);
  }

  function getAccessLevel() {
    const claims = getClaims();
    return claims?.accessLevel || claims?.tier || "free";
  }

  function getTierRank() {
    const claims = getClaims();
    return Number(claims?.tierRank ?? 0);
  }

  function isAuthenticated() {
    const token = readToken();
    return Boolean(token) && !isExpired(token);
  }

  function clearToken() {
    writeToken("");
  }

  function getSnapshot() {
    const claims = getClaims();
    return {
      token: readToken(),
      claims,
      accessLevel: getAccessLevel(),
      tierRank: getTierRank(),
      isAuthenticated: isAuthenticated(),
      authBaseUrl: getAuthBaseUrl(),
    };
  }

  async function fetchTokenFromState(state) {
    const authBaseUrl = getAuthBaseUrl();
    if (!authBaseUrl || !state) return null;
    const response = await fetch(`${authBaseUrl}/auth/token/${encodeURIComponent(state)}`, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return data?.token || null;
  }

  function openPopup(authBaseUrl, state) {
    const loginUrl = `${authBaseUrl}/auth/authorize?state=${encodeURIComponent(state)}`;
    const popupName = `${moduleName}-patreon-auth`;
    const features = "width=520,height=760,menubar=no,toolbar=no,location=no,status=no";
    const popup = window.open(loginUrl, popupName, features);
    if (!popup) {
      ui.notifications.warn("RNK: Popup blocked. Allow popups for Patreon login.");
      return null;
    }
    try { popup.focus(); } catch (_error) {}
    return popup;
  }

  async function login() {
    if (loginInFlight) return loginInFlight;

    loginInFlight = new Promise(async (resolve) => {
      const authBaseUrl = getAuthBaseUrl();
      if (!authBaseUrl) {
        ui.notifications.error("RNK: Patreon auth server URL is not configured.");
        loginInFlight = null;
        resolve(null);
        return;
      }

      const state = getRandomState();
      const popup = openPopup(authBaseUrl, state);
      if (!popup) {
        loginInFlight = null;
        resolve(null);
        return;
      }

      let finished = false;
      const timeoutMs = 10 * 60 * 1000;
      const started = Date.now();
      let pollTimer = null;
      let messageTimer = null;

      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        if (pollTimer) window.clearInterval(pollTimer);
        if (messageTimer) window.clearInterval(messageTimer);
        loginInFlight = null;
      };

      const complete = (token) => {
        if (finished || !token) return;
        finished = true;
        writeToken(token);
        cleanup();
        resolve(token);
      };

      const onMessage = (event) => {
        if (!event?.data) return;
        if (event.data.state && event.data.state !== state) return;
        if (MESSAGE_TYPES.has(event.data.type) && typeof event.data.token === "string") {
          complete(event.data.token);
        }
      };

      window.addEventListener("message", onMessage);

      pollTimer = window.setInterval(async () => {
        if (finished) return;
        if (Date.now() - started > timeoutMs) {
          cleanup();
          ui.notifications.warn("RNK: Patreon login timed out.");
          resolve(null);
          return;
        }

        try {
          const token = await fetchTokenFromState(state);
          if (token) complete(token);
        } catch (_error) {
          // Ignore transient network noise and keep polling.
        }
      }, 1000);

      messageTimer = window.setInterval(() => {
        if (finished) return;
        if (popup.closed) {
          // Do not resolve yet; the token may still be available from the server endpoint.
        }
      }, 1000);
    });

    return loginInFlight;
  }

  function logout() {
    clearToken();
  }

  function getHeaderText() {
    const snapshot = getSnapshot();
    if (!snapshot.isAuthenticated) return "Patreon: locked";
    const name = snapshot.claims?.name || snapshot.claims?.patreonId || "Patron";
    const access = snapshot.accessLevel || "free";
    return `Patreon: ${name} (${access})`;
  }

  function syncStatusChip(root) {
    const chip = root?.querySelector?.("[data-patreon-auth-chip]");
    if (!chip) return;
    chip.textContent = getHeaderText();
    chip.dataset.state = isAuthenticated() ? "authenticated" : "locked";
  }

  function bindUI(root) {
    syncStatusChip(root);
    const loginButton = root?.querySelector?.("[data-action='patreon-login']");
    const logoutButton = root?.querySelector?.("[data-action='patreon-logout']");

    loginButton?.addEventListener("click", async (event) => {
      event.preventDefault();
      const token = await login();
      if (token) ui.notifications.info(`RNK: Patreon login complete — ${getAccessLevel()} access granted.`);
      syncStatusChip(root);
    });

    logoutButton?.addEventListener("click", (event) => {
      event.preventDefault();
      logout();
      ui.notifications.info("RNK: Patreon session cleared.");
      syncStatusChip(root);
    });
  }

  return {
    getAuthBaseUrl,
    getClaims,
    getAccessLevel,
    getTierRank,
    getSnapshot,
    getToken: readToken,
    hasToken: isAuthenticated,
    isExpired,
    login,
    logout,
    bindUI,
    syncStatusChip,
    setToken: writeToken,
  };
}
