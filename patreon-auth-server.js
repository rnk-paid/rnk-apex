/**
 * RNK System Optimizer
 * Patreon OAuth authentication router and optional standalone server.
 *
 * Delivery paths after OAuth (Foundry often loses window.opener through Patreon):
 * 1. /auth/bridge keeps a same-origin shell so postMessage to Foundry still works
 * 2. Success page notifies via BroadcastChannel + localStorage (bridge listens)
 * 3. GET /auth/token/:state polling fallback (disk-backed so multi-process works)
 */

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';

const TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN_EXPIRY = '30d';
const CHANNEL_NAME = 'rnk-patreon-auth';
const STORAGE_KEY_PREFIX = 'rnk-patreon-auth:';

function noStore(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0'
  });
}

function createPendingTokenStore({ now = Date.now, logger = console, directory } = {}) {
  const memoryTokens = new Map();
  const memoryStates = new Map();
  const dir = directory || join(tmpdir(), 'rnk-patreon-pending');

  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    logger.warn?.('[RNK Auth Server] Unable to create pending-token directory; using memory only', error.message);
  }

  function statePath(state) {
    const safe = String(state).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
    return join(dir, `${safe}.json`);
  }

  function rememberState(state, expires) {
    const key = String(state);
    memoryStates.set(key, expires);
  }

  function storeToken(state, token, ttlMs = TOKEN_TTL_MS) {
    const key = String(state);
    const expires = now() + ttlMs;
    const entry = { token, expires };
    memoryTokens.set(key, entry);
    rememberState(key, expires);
    try {
      writeFileSync(statePath(key), JSON.stringify(entry), 'utf8');
    } catch (error) {
      logger.warn?.('[RNK Auth Server] Failed to persist pending token', error.message);
    }
  }

  function readDisk(state) {
    try {
      const raw = readFileSync(statePath(state), 'utf8');
      const entry = JSON.parse(raw);
      if (!entry?.token || !entry?.expires) return null;
      if (entry.expires <= now()) {
        try { unlinkSync(statePath(state)); } catch { /* ignore */ }
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  function takeToken(state) {
    const key = String(state);
    let entry = memoryTokens.get(key);
    if (!entry || entry.expires <= now()) {
      entry = readDisk(key);
    }
    if (!entry || entry.expires <= now()) {
      memoryTokens.delete(key);
      return null;
    }
    // Keep a short grace window so concurrent polls / multi-tab do not race-lose the JWT.
    const graceExpires = Math.min(entry.expires, now() + 30_000);
    const retained = { token: entry.token, expires: graceExpires };
    memoryTokens.set(key, retained);
    try {
      writeFileSync(statePath(key), JSON.stringify(retained), 'utf8');
    } catch { /* ignore */ }
    return entry.token;
  }

  function hasPendingState(state) {
    const key = String(state);
    const until = memoryStates.get(key) || 0;
    if (until > now()) return true;
    return Boolean(readDisk(key));
  }

  function markPending(state, ttlMs = TOKEN_TTL_MS) {
    rememberState(state, now() + ttlMs);
  }

  function cleanup() {
    const timestamp = now();
    for (const [state, entry] of memoryTokens) {
      if (entry.expires <= timestamp) memoryTokens.delete(state);
    }
    for (const [state, expires] of memoryStates) {
      if (expires <= timestamp) memoryStates.delete(state);
    }
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
          if (!entry?.expires || entry.expires <= timestamp) unlinkSync(join(dir, name));
        } catch {
          try { unlinkSync(join(dir, name)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  function clear() {
    memoryTokens.clear();
    memoryStates.clear();
  }

  return { storeToken, takeToken, hasPendingState, markPending, cleanup, clear };
}

export function resolvePatreonAuthConfig(env = process.env) {
  const config = {
    clientId: String(env.PATREON_CLIENT_ID || '').trim(),
    clientSecret: String(env.PATREON_CLIENT_SECRET || '').trim(),
    redirectUri: String(env.PATREON_REDIRECT_URI || env.REDIRECT_URI || '').trim(),
    jwtSecret: String(env.JWT_SECRET || env.VQ_MASTER_KEY || '').trim(),
    campaignId: String(env.RNK_CAMPAIGN_ID || env.PATREON_CAMPAIGN_ID || '').trim(),
    creatorIds: String(env.PATREON_CREATOR_IDS || env.PATREON_CREATOR_ID || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  };
  const missing = ['clientId', 'clientSecret', 'redirectUri', 'jwtSecret', 'campaignId']
    .filter((key) => !config[key]);

  if (missing.length > 0) {
    throw new Error(`Missing Patreon auth configuration: ${missing.join(', ')}`);
  }

  const explicitJwtSecret = String(env.JWT_SECRET || '').trim();
  const masterKey = String(env.VQ_MASTER_KEY || '').trim();
  if (explicitJwtSecret && masterKey && explicitJwtSecret !== masterKey) {
    throw new Error('JWT_SECRET must match VQ_MASTER_KEY');
  }

  return Object.freeze(config);
}

export function createPatreonAuthRouter(options = {}) {
  const config = resolvePatreonAuthConfig(options.env || process.env);
  const httpClient = options.httpClient || axios;
  const tokenSigner = options.tokenSigner || jwt;
  const logger = options.logger || console;
  const now = options.now || Date.now;
  const router = express.Router();
  const pending = options.pendingStore || createPendingTokenStore({ now, logger });

  router.use(cors());
  router.use(express.json());

  const cleanupTimer = setInterval(() => pending.cleanup(), 60000);
  cleanupTimer.unref?.();

  router.dispose = () => {
    clearInterval(cleanupTimer);
    pending.clear();
  };

  async function getCampaignOwnerId(accessToken) {
    try {
      const response = await httpClient.get(
        `https://www.patreon.com/api/oauth2/v2/campaigns/${encodeURIComponent(config.campaignId)}?include=creator`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = response.data;
      const ownerId = data?.data?.relationships?.creator?.data?.id
        || data?.data?.relationships?.user?.data?.id
        || data?.included?.find((item) => item?.type === 'user' && item?.id)?.id
        || null;

      if (ownerId) {
        logger.info('[RNK Auth Server] Campaign owner detected', {
          campaignId: config.campaignId,
          ownerId
        });
      } else {
        logger.warn('[RNK Auth Server] Campaign owner could not be resolved');
      }
      return ownerId;
    } catch (error) {
      logger.warn(
        '[RNK Auth Server] Unable to resolve campaign owner; continuing with membership lookup',
        error.response?.data || error.message
      );
      return null;
    }
  }

  async function handlePatreonCallback(req, res) {
    const { code, error, state } = req.query;

    if (error) {
      logger.error('[RNK Auth Server] Patreon returned an OAuth error', error);
      return res.status(400).send(`Authentication failed: ${escapeHtml(error)}`);
    }
    if (!code) {
      return res.status(400).send('No authorization code provided.');
    }

    try {
      const tokenResponse = await httpClient.post(
        'https://www.patreon.com/api/oauth2/token',
        new URLSearchParams({
          code: String(code),
          grant_type: 'authorization_code',
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const accessToken = tokenResponse.data?.access_token;
      if (!accessToken) throw new Error('Patreon did not return an access token');

      const identityResponse = await httpClient.get(
        'https://www.patreon.com/api/oauth2/v2/identity',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const userData = identityResponse.data;
      const patreonId = userData?.data?.id;
      if (!patreonId) throw new Error('Patreon identity did not include a user ID');
      const normalizedPatreonId = String(patreonId);

      let isActivePatron = false;
      let tierId = null;
      const configuredCreator = config.creatorIds.includes(normalizedPatreonId);
      const campaignOwnerId = config.creatorIds.length === 0
        ? await getCampaignOwnerId(accessToken)
        : null;
      logger.info('[RNK Auth Server] Patreon identity resolved', {
        patreonId: normalizedPatreonId,
        creatorMatch: configuredCreator,
        creatorBypassConfigured: config.creatorIds.length > 0
      });

      if (configuredCreator || (campaignOwnerId && campaignOwnerId === patreonId)) {
        isActivePatron = true;
        tierId = 'creator';
      }

      if (!isActivePatron) {
        const membershipResponse = await httpClient.get(
          'https://www.patreon.com/api/oauth2/v2/identity?include=memberships,memberships.currently_entitled_tiers&fields[member]=patron_status,currently_entitled_amount_cents,last_charge_status',
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const membershipData = membershipResponse.data;
        const included = Array.isArray(membershipData?.included) ? membershipData.included : [];
        const membershipIds = (membershipData?.data?.relationships?.memberships?.data || [])
          .map((membership) => membership.id);
        const memberships = included.filter((item) =>
          item.type === 'member' && membershipIds.includes(item.id)
        );
        const member = memberships.find((membership) => {
          const attributes = membership.attributes || {};
          const amount = Number(attributes.currently_entitled_amount_cents || 0);
          const status = String(attributes.patron_status || '').toLowerCase();
          const charge = String(attributes.last_charge_status || '').toLowerCase();
          return amount > 0 || status === 'active_patron' || charge === 'paid';
        });

        if (member) {
          isActivePatron = true;
          tierId = member.relationships?.currently_entitled_tiers?.data?.[0]?.id || null;
        }
      }

      if (!isActivePatron) {
        logger.warn('[RNK Auth Server] Patreon access denied', {
          patreonId: normalizedPatreonId,
          creatorMatch: configuredCreator
        });
        return res.status(403).type('html').send(`
          <!doctype html>
          <html>
          <body>
            <h2>Access Denied</h2>
            <p>You must be an active patron of RNK Enterprise to use this module.</p>
            <p>Patreon account ID: ${escapeHtml(normalizedPatreonId)}</p>
            <button onclick="window.close()">Close Window</button>
          </body>
          </html>
        `);
      }

      const signedToken = tokenSigner.sign({
        patreonId,
        tierId,
        tier: tierId,
        name: userData?.data?.attributes?.full_name || patreonId,
        isActive: true
      }, config.jwtSecret, { expiresIn: TOKEN_EXPIRY });

      const normalizedState = state ? String(state) : '';
      if (normalizedState) {
        pending.storeToken(normalizedState, signedToken, TOKEN_TTL_MS);
        logger.info('[RNK Auth Server] Token stored for polling/bridge fallback', {
          state: normalizedState
        });
      }

      noStore(res);
      return res.type('html').send(successPage(signedToken, normalizedState));
    } catch (callbackError) {
      const details = callbackError.response?.data || callbackError.message || 'Unknown error';
      logger.error('[RNK Auth Server] OAuth callback failed', details);
      return res.status(500).type('text').send('Authentication failed. Please try again later.');
    }
  }

  function redirectToPatreonAuth(req, res) {
    if (req.query.code || req.query.error) return handlePatreonCallback(req, res);
    const state = String(req.query.state || '');
    if (state) pending.markPending(state, TOKEN_TTL_MS);
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: 'identity campaigns.members'
    });
    if (state) query.set('state', state);
    return res.redirect(`https://www.patreon.com/oauth2/authorize?${query.toString()}`);
  }

  router.get('/health', (_req, res) => {
    noStore(res);
    res.json({
      status: 'online',
      service: 'patreon-auth',
      redirectUri: config.redirectUri,
      creatorBypassConfigured: config.creatorIds.length > 0,
      authVersion: 'bridge-disk-v1',
      bridge: true,
      poll: true
    });
  });

  router.get('/capabilities', (_req, res) => {
    noStore(res);
    res.json({
      bridge: true,
      poll: true,
      channel: CHANNEL_NAME,
      authVersion: 'bridge-disk-v1'
    });
  });

  router.get('/bridge', (req, res) => {
    const state = String(req.query.state || '');
    if (!state) {
      return res.status(400).type('html').send('<!doctype html><html><body><p>Missing state.</p></body></html>');
    }
    pending.markPending(state, TOKEN_TTL_MS);
    noStore(res);
    return res.type('html').send(bridgePage(state));
  });

  router.get('/authorize', redirectToPatreonAuth);
  router.get('/patreon/login', redirectToPatreonAuth);
  router.get('/patreon/callback', handlePatreonCallback);
  router.get('/token/:state', (req, res) => {
    noStore(res);
    const state = String(req.params.state || '');
    const token = pending.takeToken(state);
    if (token) {
      return res.json({ token, pending: false });
    }
    if (pending.hasPendingState(state)) {
      return res.status(202).json({ pending: true });
    }
    return res.status(404).json({ error: 'not_found' });
  });

  return router;
}

function successPage(signedToken, state = '') {
  const serializedToken = JSON.stringify(String(signedToken));
  const serializedState = JSON.stringify(String(state || ''));
  const serializedChannel = JSON.stringify(CHANNEL_NAME);
  const serializedStoragePrefix = JSON.stringify(STORAGE_KEY_PREFIX);
  return `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta http-equiv="Cache-Control" content="no-store" />
      <title>Authentication Successful</title>
      <style>
        body { font-family: sans-serif; text-align: center; padding-top: 50px; background: #17191d; color: #f2f4f8; }
        .success { color: #4fba6f; font-size: 24px; margin-bottom: 20px; }
        .info { color: #a6adbb; font-size: 14px; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="success">✓ Authentication Successful!</div>
      <p>You can now close this window and return to Foundry VTT.</p>
      <p class="info" id="status">Connecting to Foundry VTT...</p>
      <script>
        const token = ${serializedToken};
        const state = ${serializedState};
        const channelName = ${serializedChannel};
        const storagePrefix = ${serializedStoragePrefix};
        const payload = { type: 'PATREON_AUTH_SUCCESS', token, state };
        const payloadAlt = { type: 'rnk-patreon-auth', token, state };
        let sent = false;

        function notifySameOrigin() {
          try {
            const channel = new BroadcastChannel(channelName);
            channel.postMessage(payload);
            channel.postMessage(payloadAlt);
            channel.close();
          } catch (_error) {}
          try {
            const key = storagePrefix + (state || 'token');
            localStorage.setItem(key, JSON.stringify({ token, state, at: Date.now() }));
            localStorage.removeItem(key);
          } catch (_error) {}
        }

        function tryPostMessage(attempt) {
          if (sent) return;
          notifySameOrigin();
          const targets = [];
          if (window.opener && !window.opener.closed) targets.push(window.opener);
          try {
            if (window.opener?.opener && !window.opener.opener.closed) targets.push(window.opener.opener);
          } catch (_error) {}
          for (const target of targets) {
            try {
              target.postMessage(payload, '*');
              target.postMessage(payloadAlt, '*');
              sent = true;
            } catch (_error) {}
          }
          if (sent) {
            document.getElementById('status').textContent = 'Connected. This window will close shortly.';
            setTimeout(() => window.close(), 1500);
            return;
          }
          if (attempt < 10) {
            setTimeout(() => tryPostMessage(attempt + 1), 250 + attempt * 150);
          } else {
            document.getElementById('status').textContent = 'Token ready. You may close this window.';
          }
        }
        tryPostMessage(0);
      </script>
    </body>
    </html>
  `;
}

function bridgePage(state) {
  const serializedState = JSON.stringify(String(state));
  const serializedChannel = JSON.stringify(CHANNEL_NAME);
  const serializedStoragePrefix = JSON.stringify(STORAGE_KEY_PREFIX);
  return `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta http-equiv="Cache-Control" content="no-store" />
      <title>RNK Patreon Login</title>
      <style>
        body { font-family: sans-serif; text-align: center; padding-top: 48px; background: #17191d; color: #f2f4f8; }
        .info { color: #a6adbb; font-size: 14px; margin-top: 12px; }
      </style>
    </head>
    <body>
      <h2>Patreon Login</h2>
      <p>Complete sign-in in the Patreon window.</p>
      <p class="info" id="status">Waiting for Patreon...</p>
      <script>
        const state = ${serializedState};
        const channelName = ${serializedChannel};
        const storagePrefix = ${serializedStoragePrefix};
        let finished = false;
        let child = null;

        function forward(token) {
          if (finished || !token) return;
          finished = true;
          const messages = [
            { type: 'PATREON_AUTH_SUCCESS', token, state },
            { type: 'rnk-patreon-auth', token, state }
          ];
          try {
            if (window.opener && !window.opener.closed) {
              for (const message of messages) window.opener.postMessage(message, '*');
            }
          } catch (_error) {}
          document.getElementById('status').textContent = 'Connected. This window will close shortly.';
          try { if (child && !child.closed) child.close(); } catch (_error) {}
          setTimeout(() => window.close(), 1200);
        }

        function onData(data) {
          if (!data || typeof data.token !== 'string') return;
          if (data.state && data.state !== state) return;
          if (data.type === 'PATREON_AUTH_SUCCESS' || data.type === 'rnk-patreon-auth') {
            forward(data.token);
          }
        }

        try {
          const channel = new BroadcastChannel(channelName);
          channel.onmessage = (event) => onData(event.data);
        } catch (_error) {}

        window.addEventListener('message', (event) => onData(event.data));
        window.addEventListener('storage', (event) => {
          if (!event.key || !event.key.startsWith(storagePrefix) || !event.newValue) return;
          try { onData(JSON.parse(event.newValue)); } catch (_error) {}
        });

        const authorizeUrl = new URL('/auth/authorize', window.location.origin);
        authorizeUrl.searchParams.set('state', state);
        child = window.open(authorizeUrl.toString(), 'rnk-patreon-oauth', 'width=520,height=760');
        if (!child) {
          document.getElementById('status').textContent = 'Popup blocked — allow popups, then reload this page.';
        }

        // Polling backup if BroadcastChannel / child opener is unavailable.
        const started = Date.now();
        const timer = setInterval(async () => {
          if (finished) { clearInterval(timer); return; }
          if (Date.now() - started > 10 * 60 * 1000) {
            clearInterval(timer);
            document.getElementById('status').textContent = 'Login timed out. Close this window and try again.';
            return;
          }
          try {
            const response = await fetch('/auth/token/' + encodeURIComponent(state), {
              cache: 'no-store',
              credentials: 'omit'
            });
            if (!response.ok) return;
            const data = await response.json();
            if (data?.token) forward(data.token);
          } catch (_error) {}
        }, 1000);
      </script>
    </body>
    </html>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  dotenv.config();
  const app = express();
  const port = Number(process.env.AUTH_PORT || process.env.PORT || 3000);
  const router = createPatreonAuthRouter();
  app.use(cors());
  app.use('/auth', router);
  const server = app.listen(port, () => {
    console.log(`[RNK Auth Server] Listening on port ${port}`);
    console.log(`[RNK Auth Server] Callback URL: ${resolvePatreonAuthConfig().redirectUri}`);
  });

  const shutdown = () => {
    router.dispose?.();
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
