/**
 * Apex dashboard — ApplicationV2 when available, FormApplication fallback
 */
import { apexAutoPilot } from './auto-pilot.js';
import { ApexDualClient } from './dual-client.js';
import { ApexSettings } from './settings.js';
import { getApexAuth, requireApexAuth } from './apex-auth.js';

const MODULE_ID = 'rnk-apex';

function hasAppV2() {
  return !!(foundry?.applications?.api?.ApplicationV2 && foundry?.applications?.api?.HandlebarsApplicationMixin);
}

function buildAppV2() {
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  return class ApexDashboardV2 extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
      id: 'rnk-apex-dashboard',
      classes: ['rnk-apex-window'],
      tag: 'form',
      window: {
        title: 'RNK Apex Optimizer',
        icon: 'fa-solid fa-bolt',
        resizable: true
      },
      position: { width: 720, height: 640 },
      actions: {
        run: ApexDashboardV2.#onRun,
        dryRun: ApexDashboardV2.#onDryRun,
        refresh: ApexDashboardV2.#onRefresh,
        'patreon-login': ApexDashboardV2.#onPatreonLogin,
        'patreon-logout': ApexDashboardV2.#onPatreonLogout
      }
    };

    static PARTS = {
      body: { template: `modules/${MODULE_ID}/templates/dashboard.html` }
    };

    async _prepareContext() {
      return prepareData();
    }

    static async #onRun(event, _target) {
      event.preventDefault();
      if (!requireApexAuth()) return;
      await apexAutoPilot.runOnce({ reason: 'ui' });
      this.render({ force: true });
    }

    static async #onDryRun(event, _target) {
      event.preventDefault();
      if (!requireApexAuth()) return;
      await apexAutoPilot.dryRun();
      this.render({ force: true });
    }

    static async #onRefresh(event, _target) {
      event.preventDefault();
      this.render({ force: true });
    }

    static async #onPatreonLogin(event, _target) {
      event.preventDefault();
      const token = await getApexAuth().login();
      if (token) {
        ui.notifications?.info?.('Apex: Patreon login complete.');
        if (ApexSettings.get('autoOptimize') !== false) {
          apexAutoPilot.startScheduler();
          apexAutoPilot.runOnce({ reason: 'patreon-login' }).catch(() => {});
        }
      }
      this.render({ force: true });
    }

    static async #onPatreonLogout(event, _target) {
      event.preventDefault();
      getApexAuth().logout();
      apexAutoPilot.stopScheduler();
      ui.notifications?.info?.('Apex: Patreon session cleared.');
      this.render({ force: true });
    }
  };
}

function buildFormApp() {
  return class ApexDashboardForm extends FormApplication {
    static get defaultOptions() {
      const merge = foundry?.utils?.mergeObject ?? globalThis.mergeObject;
      return merge(super.defaultOptions, {
        id: 'rnk-apex-dashboard',
        title: 'RNK Apex Optimizer',
        template: `modules/${MODULE_ID}/templates/dashboard.html`,
        width: 720,
        height: 640,
        classes: ['rnk-apex-window'],
        closeOnSubmit: false,
        resizable: true
      });
    }

    async getData() {
      return prepareData();
    }

    activateListeners(html) {
      super.activateListeners(html);
      const root = html[0] ?? html;
      getApexAuth().bindUI(root);

      root.querySelector('[data-action="run"]')?.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (!requireApexAuth()) return;
        await apexAutoPilot.runOnce({ reason: 'ui' });
        this.render(true);
      });
      root.querySelector('[data-action="dryRun"]')?.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (!requireApexAuth()) return;
        await apexAutoPilot.dryRun();
        this.render(true);
      });
      root.querySelector('[data-action="refresh"]')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        this.render(true);
      });
    }

    async _updateObject() {}
  };
}

/** Handlebars {{#if n}} hides 0 — pre-format so zeros still display. */
function dashNum(value, suffix = '') {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '—';
  return `${value}${suffix}`;
}

async function prepareData() {
  let cluster = null;
  let registry = null;
  const auth = getApexAuth().getSnapshot();

  try {
    const client = new ApexDualClient({
      baseUrl: ApexSettings.get('apexBridgeUrl') || 'https://foundry.rnkstudios.uk/rnk-apex',
      apiKey: ApexSettings.get('apexApiKey') || ''
    });
    cluster = await client.health();
    try {
      registry = await client.registryCount();
    } catch {
      registry = null;
    }
  } catch (e) {
    cluster = { success: false, status: 'offline', error: e.message };
  }

  const last = apexAutoPilot.lastReport;
  const dry = apexAutoPilot.lastDryRun;
  const lastFps = last?.foundry?.after?.rafFps ?? last?.metrics?.rafFps ?? null;
  const patreonName = auth.claims?.name || auth.claims?.patreonId || '';
  const patreonTier = auth.accessLevel || auth.claims?.tier || auth.claims?.tierId || '';

  return {
    auto: ApexSettings.get('autoOptimize') !== false,
    bridgeUrl: ApexSettings.get('apexBridgeUrl') || 'https://foundry.rnkstudios.uk/rnk-apex',
    authUrl: auth.authBaseUrl,
    patreonAuthenticated: auth.isAuthenticated,
    patreonLocked: !auth.isAuthenticated,
    patreonChip: auth.isAuthenticated
      ? `Patreon: ${patreonName || 'Patron'}${patreonTier ? ` (${patreonTier})` : ''}`
      : 'Patreon: locked',
    clusterStatus: cluster?.status || 'offline',
    clusterOk: cluster?.status === 'online',
    clusterDegraded: cluster?.status === 'degraded',
    healthyCount: cluster?.cluster?.healthyCount ?? 0,
    totalCount: cluster?.cluster?.totalCount ?? 0,
    prometheusHealthy: !!cluster?.cluster?.nodes?.find((n) => n.id === 'PROMETHEUS' && n.healthy),
    oracleHealthy: !!cluster?.cluster?.nodes?.find((n) => n.id === 'ORACLE' && n.healthy),
    engines: registry?.engines ?? '—',
    turbos: registry?.turbos ?? '—',
    libraries: registry?.libraries ?? '—',
    lastDuration: dashNum(last?.durationMs, 'ms'),
    lastFps: dashNum(lastFps),
    lastChatDeleted: dashNum(last?.foundry?.cleanup?.chat?.deleted),
    dryChat: dashNum(dry?.cleanup?.chat?.wouldDelete),
    dryCombats: dashNum(dry?.cleanup?.combats?.wouldDelete),
    logs: apexAutoPilot.logs.slice(-100).join('\n') || 'No activity yet.'
  };
}

export const ApexDashboard = hasAppV2() ? buildAppV2() : buildFormApp();
