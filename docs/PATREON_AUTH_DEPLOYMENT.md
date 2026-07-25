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
2. Popup: `{authBase}/auth/authorize?state=…`
3. Patreon callback → auth server issues JWT
4. Browser receives token via `postMessage` or `GET /auth/token/:state`
5. Token stored in world setting `patreonSharedToken` (all GMs in that world)

## Verification

```text
GET https://auth.rnk-enterprise.us/health
GET https://mapgen-api.rnkstudios.uk/auth/authorize?state=test   # 302 to Patreon
GET https://mapgen-api.rnkstudios.uk/auth/token/test             # 404 until login
```

## Optional Apex-local router

`patreon-auth-server.js` in this repo can be mounted on the Apex bridge when
Patreon env vars are present. Prefer the shared MapGen auth host so the Patreon
redirect URI does not need a second registration.
