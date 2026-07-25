/**
 * Foundry performance application
 */
export class ApexPerformance {
  constructor(log = () => {}) {
    this.log = log;
  }

  raiseMaxFpsCeiling(desired = 120) {
    try {
      const setting = game?.settings?.settings?.get?.('core.maxFPS');
      if (!setting) return false;
      let changed = false;
      if (setting.range && Number.isFinite(setting.range.max) && setting.range.max < desired) {
        setting.range.max = desired;
        changed = true;
      }
      if (setting.type?.options && Number.isFinite(setting.type.options.max) && setting.type.options.max < desired) {
        setting.type.options.max = desired;
        changed = true;
      }
      return changed;
    } catch {
      return false;
    }
  }

  async apply() {
    const report = { applied: [], failed: [], tickerMaxFPS: null };
    this.raiseMaxFpsCeiling(120);

    try {
      if (game.settings.settings?.has?.('core.maxFPS')) {
        const cur = Number(game.settings.get('core', 'maxFPS'));
        if (Number.isFinite(cur) && cur < 120) {
          await game.settings.set('core', 'maxFPS', 120);
          report.applied.push({ setting: 'core.maxFPS', from: cur, to: 120 });
          this.log(`core.maxFPS ${cur} -> 120`);
        }
      }
    } catch (e) {
      report.failed.push({ setting: 'core.maxFPS', error: e.message });
    }

    try {
      if (game.settings.settings?.has?.('core.softShadows')) {
        const cur = game.settings.get('core', 'softShadows');
        if (cur === true) {
          await game.settings.set('core', 'softShadows', false);
          report.applied.push({ setting: 'core.softShadows', from: true, to: false });
          this.log('core.softShadows disabled');
        }
      }
    } catch (e) {
      report.failed.push({ setting: 'core.softShadows', error: e.message });
    }

    try {
      if (globalThis.canvas?.app?.ticker) {
        globalThis.canvas.app.ticker.maxFPS = 120;
        if ((Number(globalThis.canvas.app.ticker.minFPS) || 0) < 30) {
          globalThis.canvas.app.ticker.minFPS = 30;
        }
        report.tickerMaxFPS = globalThis.canvas.app.ticker.maxFPS;
        this.log(`ticker maxFPS=${report.tickerMaxFPS}`);
      }
    } catch (e) {
      report.failed.push({ setting: 'ticker', error: e.message });
    }

    return report;
  }

  async measureFps(durationMs = 750) {
    if (typeof requestAnimationFrame !== 'function') return null;
    const dur = Math.max(250, durationMs);
    return new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      const tick = (t) => {
        frames += 1;
        if (t - t0 >= dur) {
          resolve(Math.round((frames / ((t - t0) / 1000)) * 10) / 10);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  preview() {
    const changes = [];
    try {
      if (game.settings.settings?.has?.('core.maxFPS')) {
        const cur = Number(game.settings.get('core', 'maxFPS'));
        if (Number.isFinite(cur) && cur < 120) changes.push({ setting: 'core.maxFPS', from: cur, to: 120 });
      }
      if (game.settings.settings?.has?.('core.softShadows')) {
        const cur = game.settings.get('core', 'softShadows');
        if (cur === true) changes.push({ setting: 'core.softShadows', from: true, to: false });
      }
    } catch {
      /* ignore */
    }
    return changes;
  }
}
