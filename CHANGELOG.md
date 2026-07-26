# Changelog

## v4.2.1 — 2026-07-26

- Fix Patreon login succeeding in the browser while Apex stayed locked
- Prefer `/auth/bridge` when the auth host supports it (keeps `window.opener`)
- Harden token polling after Patreon clears the opener; refresh dashboard on auth change

## v4.2.0 — 2026-07-25

- Add Patreon OAuth gate (MapGen-shared auth controller + world token)
- Block auto-pilot, Optimize Now, and Dry Run until an active patron logs in
- Dashboard auth chip + login/logout actions
- Public packaging under `rnk-paid/rnk-apex`
- Default auth host: `https://mapgen-api.rnkstudios.uk`

## v4.1.0

- Dual Prometheus/Oracle optimize-core path
- Same-origin HTTPS bridge via Foundry `/rnk-apex`
- Dashboard last-run / dry-run display fixes
