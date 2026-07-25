/**
 * Apex Auto-Pilot — Foundry sense → optimize-core (Prometheus/Oracle) → safe apply
 */
import { ApexSettings } from './settings.js';
import { ApexPerformance } from './performance.js';
import { ApexWorldCleanup } from './world-cleanup.js';
import { ApexDualClient } from './dual-client.js';
import { apexMetrics } from './metrics.js';
import { ApexPolicyApply } from './policy-apply.js';
import { requireApexAuth } from './apex-auth.js';

const MODULE_ID = 'rnk-apex';

export class ApexAutoPilot {
  constructor() {
    this.logs = [];
    this.lastReport = null;
    this.lastDryRun = null;
    this._timer = null;
    this._running = false;
    this.clusterStatus = null;
  }

  log(msg) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 250) this.logs.shift();
    console.log(`${MODULE_ID} | ${msg}`);
    try {
      Hooks.callAll('rnkApexLog', line);
    } catch {
      /* ignore */
    }
  }

  _client() {
    return new ApexDualClient({
      baseUrl: ApexSettings.get('apexBridgeUrl') || 'https://foundry.rnkstudios.uk/rnk-apex',
      apiKey: ApexSettings.get('apexApiKey') || ''
    });
  }

  async dryRun() {
    if (!game.user?.isGM) {
      this.log('dry-run skipped — not GM');
      return null;
    }
    if (!requireApexAuth()) {
      this.log('dry-run blocked — Patreon auth required');
      return null;
    }
    const options = ApexSettings.optionsFromSettings();
    const cleanup = new ApexWorldCleanup((m) => this.log(m));
    const perf = new ApexPerformance((m) => this.log(m));
    const metrics = await apexMetrics.collect({ rafMs: 400 });
    const report = {
      at: Date.now(),
      metrics,
      cleanup: await cleanup.dryRun(options),
      performance: { changes: perf.preview() },
      cluster: null
    };

    if (options.useDualCluster) {
      try {
        const client = this._client();
        report.cluster = await client.health();
        this.clusterStatus = report.cluster;
        try {
          report.preview = await client.analyze(metrics);
        } catch (e) {
          report.previewError = e.message;
        }
      } catch (e) {
        report.cluster = { status: 'offline', error: e.message };
      }
    }

    this.lastDryRun = report;
    this.log(
      `Dry run: mods=${metrics.modCount} fps~${metrics.rafFps} jitter=${metrics.jitterMs}ms heap=${metrics.heapUsedMB}MB; chat would delete ${report.cleanup.chat.wouldDelete}`
    );
    return report;
  }

  async runOnce({ reason = 'manual' } = {}) {
    if (this._running) {
      this.log('skip — already running');
      return this.lastReport;
    }
    if (!game.user?.isGM) {
      this.log('skip — not GM');
      return null;
    }
    if (!requireApexAuth()) {
      this.log(`skip (${reason}) — Patreon auth required`);
      return null;
    }

    this._running = true;
    const options = ApexSettings.optionsFromSettings();
    const report = {
      reason,
      startedAt: Date.now(),
      metrics: null,
      foundry: {},
      cluster: null,
      dual: [],
      errors: []
    };

    try {
      this.log(`auto-optimize start (${reason})`);

      // 1. Sense Foundry
      report.metrics = await apexMetrics.collect({ rafMs: 600 });
      this.log(
        `sense mods=${report.metrics.modCount} raf=${report.metrics.rafFps} jitter=${report.metrics.jitterMs}ms heap=${report.metrics.heapUsedMB}MB tokens=${report.metrics.tokens}`
      );

      // 2. Dual optimize-core (Oracle recommend/plan, Prometheus apply muscle)
      if (options.useDualCluster) {
        const client = this._client();
        try {
          report.cluster = await client.health();
          this.clusterStatus = report.cluster;
          const h = report.cluster.cluster?.healthyCount ?? 0;
          const t = report.cluster.cluster?.totalCount ?? 0;
          this.log(`cluster ${report.cluster.status} (${h}/${t} nodes)`);

          let core = null;
          try {
            core = await client.foundryOptimize(report.metrics);
            report.dual.push({
              step: 'foundry-optimize',
              ok: true,
              via: core.via,
              recommendations: core.recommendations?.length ?? 0
            });
            this.log(
              `optimize-core via ${JSON.stringify(core.via || {})} recs=${core.recommendations?.length ?? 0}`
            );
          } catch (e) {
            report.errors.push(`foundry-optimize: ${e.message}`);
            this.log(`foundry-optimize failed: ${e.message} — falling back`);
            try {
              const analysis = await client.analyze(report.metrics);
              report.dual.push({ step: 'analyze', node: analysis.node, ok: true });
              core = analysis;
            } catch (e2) {
              report.errors.push(`analyze: ${e2.message}`);
            }
          }

          // 3. Safe Foundry apply from cluster policy
          const policyApply = new ApexPolicyApply((m) => this.log(m));
          report.foundry.policy = await policyApply.applyFromCluster(core || {}, report.metrics);

          if (options.doCorePerformanceTweaks && !report.foundry.policy?.applied?.length) {
            const perf = new ApexPerformance((m) => this.log(m));
            report.foundry.performance = await perf.apply();
          }

          // 4. World cleanup + pack warmup (local)
          const cleanup = new ApexWorldCleanup((m) => this.log(m));
          report.foundry.cleanup = await cleanup.run(options);

          // 5. Dual turbo share on optimize-core components (not micro-benchmarks)
          const hits = [];
          const shareJobs = [
            { component: 'heavy-stack-policy', command: 'optimize', params: { metrics: report.metrics } },
            { component: 'map-load-warmup', command: 'optimize', params: { metrics: report.metrics } },
            { component: 'foundry-turbo-1-turbo-modular', command: 'boost', params: { modCount: report.metrics.modCount } },
            { component: 'optimization-turbo-1-turbo-modular', command: 'boost', params: { modCount: report.metrics.modCount } }
          ];
          for (const job of shareJobs) {
            try {
              const r = await client.process(job);
              hits.push(r.node || r.result?.node);
            } catch (e) {
              report.errors.push(`process ${job.component}: ${e.message}`);
            }
          }
          report.dual.push({ step: 'load-share', nodes: hits, unique: [...new Set(hits.filter(Boolean))] });
          this.log(`dual load-share: ${[...new Set(hits.filter(Boolean))].join(', ') || 'none'}`);

          try {
            report.registry = await client.registryCount();
            this.log(
              `registry engines=${report.registry.engines} turbos=${report.registry.turbos} libs=${report.registry.libraries}`
            );
          } catch {
            /* optional */
          }
        } catch (e) {
          report.errors.push(`cluster: ${e.message}`);
          this.log(`cluster unreachable (${e.message}) — Foundry-only optimize applied`);
          if (options.doCorePerformanceTweaks) {
            const perf = new ApexPerformance((m) => this.log(m));
            report.foundry.performance = await perf.apply();
          }
          const cleanup = new ApexWorldCleanup((m) => this.log(m));
          report.foundry.cleanup = await cleanup.run(options);
        }
      } else {
        if (options.doCorePerformanceTweaks) {
          const perf = new ApexPerformance((m) => this.log(m));
          report.foundry.performance = await perf.apply();
        }
        const cleanup = new ApexWorldCleanup((m) => this.log(m));
        report.foundry.cleanup = await cleanup.run(options);
      }

      // Post measure
      report.foundry.after = await apexMetrics.collect({ rafMs: 400 });
      this.log(
        `after raf=${report.foundry.after.rafFps} jitter=${report.foundry.after.jitterMs}ms heap=${report.foundry.after.heapUsedMB}MB`
      );

      report.finishedAt = Date.now();
      report.durationMs = report.finishedAt - report.startedAt;
      this.lastReport = report;
      this.log(
        `auto-optimize done in ${report.durationMs}ms` +
          (report.errors.length ? ` (${report.errors.length} warnings)` : '')
      );

      try {
        ui.notifications?.info?.(
          `Apex: optimized (${report.durationMs}ms) · ${report.metrics.modCount} mods · RAF ${report.foundry.after?.rafFps ?? 'n/a'}`
        );
      } catch {
        /* ignore */
      }

      try {
        Hooks.callAll('rnkApexOptimized', report);
      } catch {
        /* ignore */
      }

      return report;
    } catch (e) {
      report.errors.push(e.message);
      this.log(`auto-optimize failed: ${e.message}`);
      console.error(`${MODULE_ID} | auto-optimize`, e);
      try {
        ui.notifications?.error?.('Apex: optimization failed — see console');
      } catch {
        /* ignore */
      }
      return report;
    } finally {
      this._running = false;
    }
  }

  startScheduler() {
    this.stopScheduler();
    if (ApexSettings.get('autoOptimize') === false) {
      this.log('auto-optimize disabled in settings');
      return;
    }
    apexMetrics.startSampler();
    const mins = Math.max(1, Number(ApexSettings.get('autoIntervalMinutes')) || 15);
    this._timer = setInterval(() => {
      this.runOnce({ reason: 'interval' }).catch(() => {});
    }, mins * 60 * 1000);
    this.log(`scheduler armed every ${mins}m`);
  }

  stopScheduler() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

export const apexAutoPilot = new ApexAutoPilot();
