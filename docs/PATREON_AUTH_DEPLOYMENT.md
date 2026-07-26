# Patreon Auth Deployment (Apex)

Apex uses the shared RNK Patreon auth host also used by MapGen.

## Production defaults

| Item | Value |
|------|--------|
| Auth base (module setting) | `https://mapgen-api.rnkstudios.uk` |
| Alternate health host | `https://auth.rnk-enterprise.us` |
| Redirect URI (Patreon app) | `https://mapgen-api.rnkstudios.uk/auth/authorize` |
| Local process | `pm2` app `rnk-patreon-auth` → `127.0.0.1:3000` |

Cloudflare Tunnel (`/etc/cloudflared/config.yaml`) routes:

- `api.rnk-enterprise.us` path `/auth` → `127.0.0.1:3000`
- `auth.rnk-enterprise.us` → `127.0.0.1:3000`

## Server `.env` (auth process)

```dotenv
PATREON_CLIENT_ID=
PATREON_CLIENT_SECRET=
REDIRECT_URI=https://mapgen-api.rnkstudios.uk/auth/authorize
PATREON_REDIRECT_URI=https://mapgen-api.rnkstudios.uk/auth/authorize
RNK_CAMPAIGN_ID=
JWT_SECRET=
PORT=3000
```

## Module client flow

1. GM opens Apex → Patreon Login
2. Client probes `{authBase}/auth/capabilities` — if `bridge: true`, opens
   `{authBase}/auth/bridge?state=…` (same-origin shell that keeps `window.opener`)
3. Bridge opens Patreon via `{authBase}/auth/authorize?state=…`
4. Patreon callback → auth server issues JWT, stores it (memory + disk) for polling
5. Token returns to Foundry via, in order:
   - bridge `postMessage` to Foundry (preferred)
   - `BroadcastChannel` / `localStorage` from success page → bridge → Foundry
   - `GET /auth/token/:state` polling fallback
6. Token stored in world setting `patreonSharedToken` (all GMs in that world)

### Why patrons see "Authentication Successful" but Apex stays locked

Patreon OAuth redirects clear `window.opener` in many browsers / Electron builds.
The success page then shows **Token ready. You may close this window.** — that
means `postMessage` already failed. The module must receive the JWT through the
bridge or `/auth/token/:state`. Deploy auth server `bridge-disk-v1` (or newer)
so those paths work across multi-process / Cloudflare setups.

## Verification

```text
GET https://mapgen-api.rnkstudios.uk/health
GET https://mapgen-api.rnkstudios.uk/auth/capabilities   # { bridge: true, poll: true }
GET https://mapgen-api.rnkstudios.uk/auth/authorize?state=test   # 302 to Patreon
GET https://mapgen-api.rnkstudios.uk/auth/token/test             # 202 while pending, 404 unknown
```

## Optional Apex-local router

`patreon-auth-server.js` in this repo can be mounted on the Apex bridge when
Patreon env vars are present. Prefer the shared MapGen auth host so the Patreon
redirect URI does not need a second registration.
