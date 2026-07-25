/**
 * RNK System Optimizer
 * Patreon OAuth authentication router and optional standalone server.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';

const TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN_EXPIRY = '30d';

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
  const pendingTokens = new Map();
  const pendingStates = new Map();

  router.use(cors());
  router.use(express.json());

  const cleanupTimer = setInterval(() => {
    const timestamp = now();
    for (const [state, entry] of pendingTokens) {
      if (entry.expires <= timestamp) pendingTokens.delete(state);
    }
    for (const [state, expires] of pendingStates) {
      if (expires <= timestamp) pendingStates.delete(state);
    }
  }, 60000);
  cleanupTimer.unref?.();

  router.dispose = () => {
    clearInterval(cleanupTimer);
    pendingTokens.clear();
    pendingStates.clear();
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

      if (state) {
        const normalizedState = String(state);
        pendingStates.set(normalizedState, now() + TOKEN_TTL_MS);
        pendingTokens.set(normalizedState, {
          token: signedToken,
          expires: now() + TOKEN_TTL_MS
        });
      }

      return res.type('html').send(successPage(signedToken));
    } catch (callbackError) {
      const details = callbackError.response?.data || callbackError.message || 'Unknown error';
      logger.error('[RNK Auth Server] OAuth callback failed', details);
      return res.status(500).type('text').send('Authentication failed. Please try again later.');
    }
  }

  function redirectToPatreonAuth(req, res) {
    if (req.query.code || req.query.error) return handlePatreonCallback(req, res);
    const state = String(req.query.state || '');
    if (state) pendingStates.set(state, now() + TOKEN_TTL_MS);
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
    res.json({
      status: 'online',
      service: 'patreon-auth',
      redirectUri: config.redirectUri,
      creatorBypassConfigured: config.creatorIds.length > 0,
      authVersion: 'creator-id-v2'
    });
  });
  router.get('/authorize', redirectToPatreonAuth);
  router.get('/patreon/login', redirectToPatreonAuth);
  router.get('/patreon/callback', handlePatreonCallback);
  router.get('/token/:state', (req, res) => {
    const state = String(req.params.state || '');
    const entry = pendingTokens.get(state);
    if (entry && entry.expires > now()) {
      pendingTokens.delete(state);
      pendingStates.delete(state);
      return res.json({ token: entry.token });
    }
    pendingTokens.delete(state);
    const pendingUntil = pendingStates.get(state) || 0;
    if (pendingUntil > now()) {
      return res.status(202).json({ pending: true });
    }
    pendingStates.delete(state);
    return res.status(404).json({ error: 'not_found' });
  });

  return router;
}

function successPage(signedToken) {
  const serializedToken = JSON.stringify(String(signedToken));
  return `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Authentication Successful</title>
      <style>
        body { font-family: sans-serif; text-align: center; padding-top: 50px; background: #17191d; color: #f2f4f8; }
        .success { color: #4fba6f; font-size: 24px; margin-bottom: 20px; }
        .info { color: #a6adbb; font-size: 14px; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="success">Authentication Successful</div>
      <p>You can now close this window and return to Foundry VTT.</p>
      <p class="info" id="status">Connecting to Foundry VTT...</p>
      <script>
        const token = ${serializedToken};
        const messages = [
          { type: 'PATREON_AUTH_SUCCESS', token },
          { type: 'rnk-patreon-auth', token }
        ];
        let sent = false;
        function tryPostMessage(attempt) {
          if (sent) return;
          if (window.opener && !window.opener.closed) {
            try {
              for (const message of messages) window.opener.postMessage(message, '*');
              sent = true;
              document.getElementById('status').textContent = 'Connected. This window will close shortly.';
              setTimeout(() => window.close(), 1500);
              return;
            } catch (_error) {}
          }
          if (attempt < 8) {
            setTimeout(() => tryPostMessage(attempt + 1), 300 + attempt * 200);
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
