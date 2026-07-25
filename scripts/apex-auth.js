/**
 * Apex Patreon gate — shared world token (MapGen-style) for auto-pilot + UI.
 */
import { createPatreonAuthController } from './rnk-patreon-auth.js';

const MODULE_ID = 'rnk-apex';

/** Same public auth host used by RNK MapGen (Patreon redirect is registered there). */
export const DEFAULT_PATREON_AUTH_URL = 'https://mapgen-api.rnkstudios.uk';

let _auth = null;
let _warnAt = 0;

export function getApexAuth() {
  if (_auth) return _auth;
  _auth = createPatreonAuthController({
    moduleName: MODULE_ID,
    defaultAuthBaseUrl: DEFAULT_PATREON_AUTH_URL,
    settingKey: 'patreonAuthUrl',
    sharedTokenSettingKey: 'patreonSharedToken',
    onChange: () => {
      try {
        Hooks.callAll('rnkApexAuthChanged', _auth.getSnapshot());
      } catch {
        /* ignore */
      }
    }
  });
  return _auth;
}

export function isApexAuthenticated() {
  try {
    return getApexAuth().hasToken();
  } catch {
    return false;
  }
}

export function requireApexAuth({ notify = true } = {}) {
  if (isApexAuthenticated()) return true;
  if (notify) {
    const now = Date.now();
    if (now - _warnAt > 4000) {
      _warnAt = now;
      ui.notifications?.warn?.('Apex: authenticate with Patreon first (active patron required).');
    }
  }
  return false;
}

export async function ensureApexAuth({ prompt = true } = {}) {
  const auth = getApexAuth();
  if (auth.hasToken()) return true;
  if (!prompt || !game.user?.isGM) return false;
  const token = await auth.login();
  return Boolean(token);
}
