/**
 * Apex module settings — auto-everything defaults + Patreon gate
 */
import { DEFAULT_PATREON_AUTH_URL } from './apex-auth.js';

const MODULE_ID = 'rnk-apex';

export class ApexSettings {
  static isRegistered(key) {
    try {
      return !!game?.settings?.settings?.has?.(`${MODULE_ID}.${key}`);
    } catch {
      return false;
    }
  }

  static register(DashboardApp = null) {
    if (!game?.settings?.register) return;

    if (DashboardApp && game.settings.registerMenu && !game.settings.menus?.has?.(`${MODULE_ID}.apexMenu`)) {
      try {
        game.settings.registerMenu(MODULE_ID, 'apexMenu', {
          name: 'Open Apex Optimizer',
          label: 'Open Apex',
          hint: 'Opens the Apex dual-VQ optimizer dashboard.',
          icon: 'fas fa-bolt',
          type: DashboardApp,
          restricted: true
        });
      } catch (e) {
        console.warn(`${MODULE_ID} | registerMenu failed`, e);
      }
    }

    const defs = [
      ['autoOptimize', {
        name: 'Auto-optimize (no user action)',
        hint: 'Run world + dual VQ optimization automatically on load and on a timer.',
        scope: 'world', config: true, type: Boolean, default: true
      }],
      ['autoIntervalMinutes', {
        name: 'Auto interval (minutes)',
        hint: 'How often Apex re-runs while the world is open.',
        scope: 'world', config: true, type: Number, default: 15,
        range: { min: 1, max: 180, step: 1 }
      }],
      ['doCleanupChat', {
        name: 'Cleanup old chat messages',
        scope: 'world', config: true, type: Boolean, default: true
      }],
      ['chatRetentionDays', {
        name: 'Chat retention (days)',
        scope: 'world', config: true, type: Number, default: 30
      }],
      ['doCleanupInactiveCombats', {
        name: 'Cleanup inactive combats',
        scope: 'world', config: true, type: Boolean, default: true
      }],
      ['doRebuildCompendiumIndexes', {
        name: 'Rebuild / warm compendium indexes',
        scope: 'world', config: true, type: Boolean, default: true
      }],
      ['doCorePerformanceTweaks', {
        name: 'Apply performance tweaks (FPS, soft shadows)',
        scope: 'world', config: true, type: Boolean, default: true
      }],
      ['useDualCluster', {
        name: 'Use Prometheus + Oracle dual cluster',
        hint: 'When enabled, Apex load-shares through the Apex bridge.',
        scope: 'world', config: true, type: Boolean, default: true
      }],
      ['apexBridgeUrl', {
        name: 'Apex bridge URL',
        hint: 'URL of the Apex stack bridge (default https://foundry.rnkstudios.uk/rnk-apex).',
        scope: 'world', config: true, type: String, default: 'https://foundry.rnkstudios.uk/rnk-apex'
      }],
      ['apexApiKey', {
        name: 'Apex / VQ API key',
        hint: 'Optional. Must match APEX_API_KEY / VQ_API_KEY on the bridge if set.',
        scope: 'world', config: true, type: String, default: '',
        onChange: () => {}
      }],
      ['patreonAuthUrl', {
        name: 'Patreon auth server URL',
        hint: 'Public HTTPS host that serves /auth/* (default MapGen auth). Active Patreon required.',
        scope: 'world', config: true, type: String, default: DEFAULT_PATREON_AUTH_URL
      }],
      ['patreonSharedToken', {
        name: 'Patreon shared token',
        hint: 'Internal world-scoped JWT after a GM logs in with Patreon. Do not edit manually.',
        scope: 'world', config: false, type: String, default: ''
      }]
    ];

    for (const [key, data] of defs) {
      if (this.isRegistered(key)) continue;
      try {
        game.settings.register(MODULE_ID, key, data);
      } catch (e) {
        console.warn(`${MODULE_ID} | settings ${key}`, e);
      }
    }
  }

  static get(key) {
    try {
      return game.settings.get(MODULE_ID, key);
    } catch {
      return undefined;
    }
  }

  static optionsFromSettings() {
    return {
      doCleanupChat: this.get('doCleanupChat') !== false,
      chatRetentionDays: Number(this.get('chatRetentionDays')) || 30,
      doCleanupInactiveCombats: this.get('doCleanupInactiveCombats') !== false,
      doRebuildCompendiumIndexes: this.get('doRebuildCompendiumIndexes') !== false,
      doCorePerformanceTweaks: this.get('doCorePerformanceTweaks') !== false,
      useDualCluster: this.get('useDualCluster') !== false
    };
  }
}
