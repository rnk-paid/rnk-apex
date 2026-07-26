/**
 * RNK Apex™ — Foundry entry point
 * Patreon-gated optimizer + Prometheus/Oracle dual client
 */
import { ApexSettings } from './settings.js';
import { apexAutoPilot } from './auto-pilot.js';
import { ApexDashboard } from './dashboard.js';
import { ensureApexAuth, getApexAuth, isApexAuthenticated } from './apex-auth.js';

const MODULE_ID = 'rnk-apex';

Hooks.once('init', () => {
  console.log(`${MODULE_ID} | Initializing Apex Optimizer`);
  ApexSettings.register(ApexDashboard);
  globalThis.RNKApex = {
    ApexDashboard,
    apexAutoPilot,
    getApexAuth,
    isApexAuthenticated,
    version: '4.2.3'
  };
});

Hooks.once('ready', async () => {
  ApexSettings.register(ApexDashboard);

  if (!game.user?.isGM) {
    console.log(`${MODULE_ID} | Ready (non-GM — auto-pilot idle)`);
    return;
  }

  console.log(`${MODULE_ID} | Ready — dual-aware auto-pilot (Patreon gated)`);

  // Warm auth capabilities so Patreon Login can open the popup in the same click turn.
  try {
    await getApexAuth().prefetchCapabilities?.();
  } catch {
    /* ignore */
  }

  if (ApexSettings.get('autoOptimize') === false) {
    apexAutoPilot.log('auto-optimize disabled in settings');
    return;
  }

  // Prompt once if no shared world token yet, then arm scheduler / first run.
  const ok = await ensureApexAuth({ prompt: true });
  if (!ok) {
    apexAutoPilot.log('auto-optimize armed after Patreon login — open Apex and sign in');
    ui.notifications?.warn?.('Apex: Patreon login required before auto-optimize runs.');
    return;
  }

  setTimeout(() => {
    apexAutoPilot.runOnce({ reason: 'ready' }).catch((e) => {
      console.error(`${MODULE_ID} | ready optimize failed`, e);
    });
  }, 2000);
  apexAutoPilot.startScheduler();
});

Hooks.on('getSceneControlButtons', (controls) => {
  if (!game.user?.isGM) return;

  const arr = Array.isArray(controls)
    ? controls
    : Array.isArray(controls?.controls)
      ? controls.controls
      : Array.isArray(controls?.sceneControls)
        ? controls.sceneControls
        : null;
  if (!arr) return;

  const token = arr.find((c) => c?.name === 'token');
  if (!token) return;
  if (!Array.isArray(token.tools)) token.tools = [];
  if (token.tools.some((t) => t?.name === 'rnk-apex')) return;

  token.tools.push({
    name: 'rnk-apex',
    title: 'Apex Optimizer',
    icon: 'fas fa-bolt',
    button: true,
    onClick: async () => {
      try {
        if (!isApexAuthenticated()) {
          await ensureApexAuth({ prompt: true });
        }
        const app = new ApexDashboard();
        if (typeof app.render === 'function') {
          const r = app.render(true);
          Promise.resolve(r).catch((e) => console.error(`${MODULE_ID} | render failed`, e));
        }
      } catch (e) {
        console.error(`${MODULE_ID} | open failed`, e);
        ui.notifications?.error?.('Apex failed to open — see console');
      }
    }
  });
});
