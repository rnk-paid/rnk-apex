/**
 * Apply optimize-core policy safely on Foundry (core/rnk-apex only).
 */
export class ApexPolicyApply {
  constructor(log = () => {}) {
    this.log = log;
  }

  async applyFromCluster(clusterResult = {}, metrics = {}) {
    const report = { applied: [], skipped: [], failed: [] };
    const policy =
      clusterResult?.policy?.policy ||
      clusterResult?.policy ||
      clusterResult?.heavyStack?.policy ||
      {};
    const recommendations = clusterResult?.recommendations || [];

    const maxFPS = Number(policy.maxFPS ?? (metrics.modCount >= 20 ? 120 : 60));
    const softShadows = policy.softShadows;
    const wantDisableSoft =
      softShadows === false ||
      recommendations.some((r) => r.id === 'soft-shadow-policy' || r.action === 'disable-soft-shadows');

    try {
      await this._applyMaxFps(maxFPS, report);
    } catch (e) {
      report.failed.push({ setting: 'core.maxFPS', error: e.message });
    }

    if (wantDisableSoft) {
      try {
        await this._applySoftShadows(false, report);
      } catch (e) {
        report.failed.push({ setting: 'core.softShadows', error: e.message });
      }
    }

    try {
      if (globalThis.canvas?.app?.ticker) {
        globalThis.canvas.app.ticker.maxFPS = maxFPS;
        report.applied.push({ setting: 'ticker.maxFPS', to: maxFPS });
        this.log(`ticker maxFPS=${maxFPS}`);
      }
    } catch (e) {
      report.failed.push({ setting: 'ticker', error: e.message });
    }

    // Quality ladder (non-settings hints only — never patch other modules)
    const quality = clusterResult?.quality?.quality || clusterResult?.adaptive?.quality;
    if (quality) {
      report.applied.push({ setting: 'quality-ladder', to: quality, note: 'advisory' });
      this.log(`quality ladder rung applied (advisory): ${JSON.stringify(quality)}`);
    }

    return report;
  }

  async _applyMaxFps(desired, report) {
    if (!game?.settings?.settings?.has?.('core.maxFPS')) {
      report.skipped.push({ setting: 'core.maxFPS', reason: 'missing' });
      return;
    }
    const setting = game.settings.settings.get('core.maxFPS');
    if (setting?.range && Number.isFinite(setting.range.max) && setting.range.max < desired) {
      setting.range.max = desired;
    }
    const cur = Number(game.settings.get('core', 'maxFPS'));
    if (Number.isFinite(cur) && cur !== desired) {
      await game.settings.set('core', 'maxFPS', desired);
      report.applied.push({ setting: 'core.maxFPS', from: cur, to: desired });
      this.log(`core.maxFPS ${cur} -> ${desired}`);
    }
  }

  async _applySoftShadows(enabled, report) {
    if (!game?.settings?.settings?.has?.('core.softShadows')) {
      report.skipped.push({ setting: 'core.softShadows', reason: 'missing' });
      return;
    }
    const cur = game.settings.get('core', 'softShadows');
    if (cur !== enabled) {
      await game.settings.set('core', 'softShadows', enabled);
      report.applied.push({ setting: 'core.softShadows', from: cur, to: enabled });
      this.log(`core.softShadows ${cur} -> ${enabled}`);
    }
  }
}
