# RNK Apex™ Optimizer

Patreon-gated Foundry VTT optimizer powered by the dual Vortex Quantum stack (**Prometheus** + **Oracle**) through the Apex bridge.

Public repo: [github.com/rnk-paid/rnk-apex](https://github.com/rnk-paid/rnk-apex)  
Patreon: [patreon.com/RagNaroks](https://www.patreon.com/RagNaroks)

## What it does

- Sense FPS / RAF / jitter / heap / mod stack
- Ask Oracle to analyze + plan; apply safe Foundry tweaks
- Load-share turbo/library work across Prometheus + Oracle
- Cleanup old chat + inactive combats; warm compendium indexes
- Auto-run on a timer after a GM completes Patreon login

## Access control

The module is publicly installable. **Optimizer actions require an active Patreon login.**

1. Open Apex (token bolt / Module Settings → Open Apex)
2. Click **Patreon Login**
3. Complete OAuth in the popup
4. Optimize Now / Dry Run / auto-pilot unlock for that world (shared GM token)

Default auth host: `https://mapgen-api.rnkstudios.uk` (same RNK Patreon auth used by MapGen).

## Install

Raw manifest URL:

```text
https://raw.githubusercontent.com/rnk-paid/rnk-apex/main/module.json
```

Or download the release `module.zip` and extract into `Data/modules/rnk-apex/`.

## Settings

| Setting | Purpose |
|--------|---------|
| Auto-optimize | Run on ready + interval after Patreon auth |
| Apex bridge URL | HTTPS bridge (default `https://foundry.rnkstudios.uk/rnk-apex`) |
| Patreon auth server URL | Host serving `/auth/*` |
| Apex / VQ API key | Optional bridge key (often injected by same-origin proxy) |

## Bridge (operators)

```bash
cd Apex
npm install
npm start
```

See `.env.example` and `docs/PATREON_AUTH_DEPLOYMENT.md`.

## License

Proprietary — see `LICENSE.md`. Public GitHub hosting does not grant redistribution rights.
