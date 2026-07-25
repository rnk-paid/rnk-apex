/**
 * Apex dual bridge + optimizer control plane
 * Self-contained inside Apex/ — fronts Prometheus + Oracle
 */
import express from 'express';
import helmet from 'helmet';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DualBalancer, proxyDual } from './load-balancer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APEX_ROOT = path.resolve(__dirname, '..');

function loadEnv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

function loadConfig() {
  loadEnv(path.join(APEX_ROOT, '.env'));
  const cfgPath = path.join(APEX_ROOT, 'config', 'apex.json');
  const file = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  return {
    id: 'APEX',
    name: 'Apex',
    port: Number(process.env.APEX_PORT || process.env.PORT || file.port || 3002),
    host: process.env.APEX_HOST || file.host || '0.0.0.0',
    prometheusUrl: process.env.PROMETHEUS_URL || file.prometheusUrl || 'http://127.0.0.1:3000',
    oracleUrl: process.env.ORACLE_URL || file.oracleUrl || 'http://127.0.0.1:3001',
    balanceMode: process.env.APEX_BALANCE_MODE || file.balanceMode || 'affinity-least-load',
    autoOptimize: process.env.APEX_AUTO_OPTIMIZE !== 'false' && file.autoOptimize !== false,
    autoIntervalMs: Math.max(15000, Number(process.env.APEX_AUTO_INTERVAL_MS || file.autoIntervalMs || 60000)),
    requestTimeoutMs: Number(file.requestTimeoutMs || 30000),
    healthIntervalMs: Number(file.healthIntervalMs || 5000),
    apiKey: String(process.env.APEX_API_KEY || process.env.VQ_API_KEY || '').trim(),
    maxFailures: file.failover?.maxConsecutiveFailures ?? 3,
    cooldownMs: file.failover?.cooldownMs ?? 15000
  };
}

const cfg = loadConfig();
const log = (msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'apex', msg, ...extra }));

const balancer = new DualBalancer(
  [
    {
      id: 'PROMETHEUS',
      url: cfg.prometheusUrl,
      role: 'primary',
      affinity: [
        'foundry.performance',
        'foundry.cleanup',
        'foundry.apply',
        'optimize.apply-policy',
        'optimize.foundry-apply',
        'catalog.warm',
        'foundry.optimize.fire'
      ]
    },
    {
      id: 'ORACLE',
      url: cfg.oracleUrl,
      role: 'secondary',
      affinity: [
        'optimize.analyze',
        'optimize.plan',
        'optimize.recommend',
        'foundry.compendium',
        'foundry.optimize.analyze'
      ]
    }
  ],
  { mode: cfg.balanceMode, maxFailures: cfg.maxFailures, cooldownMs: cfg.cooldownMs }
);

const state = {
  createdAt: Date.now(),
  updatedAt: Date.now(),
  stateVersion: 0,
  autoApply: cfg.autoOptimize,
  turboMode: { mode: 'balanced' },
  lastAutoRun: null,
  lastAutoReport: null,
  dispatches: [],
  audit: [],
  metricsHistory: []
};

const ACTION_CATALOG = [
  { type: 'set-turbo-mode', label: 'Turbo Mode', params: ['mode'] },
  { type: 'rebalance-cluster', label: 'Rebalance Cluster', params: ['mode'] },
  { type: 'run-auto-optimize', label: 'Run Auto Optimize', params: [] },
  { type: 'catalog-warm', label: 'Warm Catalog', params: ['topN'] },
  { type: 'failover-node', label: 'Failover Node', params: ['nodeId'] },
  { type: 'latency-reduction', label: 'Latency Reduction', params: ['targetLatency', 'priority'] }
];

function requireKey(req, res, next) {
  if (!cfg.apiKey) return next();
  const got = String(req.headers['x-vq-api-key'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== cfg.apiKey) return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}

function fwdHeaders(req) {
  const h = {};
  for (const k of ['content-type', 'authorization', 'x-vq-api-key']) {
    if (req.headers[k]) h[k] = req.headers[k];
  }
  return h;
}

async function proxy(req, res, targetPath, type = null) {
  const r = await proxyDual(balancer, {
    method: req.method,
    path: targetPath || req.originalUrl,
    headers: fwdHeaders(req),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    type,
    timeoutMs: cfg.requestTimeoutMs
  });
  res.setHeader('X-VQ-Node', r.nodeId || 'none');
  if (!r.ok && !r.data) {
    return res.status(r.status || 502).json({ success: false, error: r.error, cluster: balancer.snapshot() });
  }
  return res.status(r.status || 200).json(r.data);
}

function avg(nums) {
  const v = nums.filter((n) => Number.isFinite(n));
  if (!v.length) return 0;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

async function gatherNodeMetrics() {
  const nodes = [];
  for (const n of balancer.nodes) {
    try {
      const r = await fetch(`${n.url}/api/metrics`, { signal: AbortSignal.timeout(4000) });
      const data = await r.json();
      nodes.push({ id: n.id, ok: r.ok, metrics: data.latest || null });
    } catch (e) {
      nodes.push({ id: n.id, ok: false, error: e.message });
    }
  }
  return nodes;
}

async function runFoundryOptimizeCore(metrics = {}, source = 'api') {
  const report = {
    source,
    startedAt: Date.now(),
    metrics,
    steps: [],
    via: {},
    recommendations: [],
    policy: null,
    ranked: null,
    quality: null
  };

  const analyze = await proxyDual(balancer, {
    method: 'POST',
    path: '/api/optimize/analyze',
    headers: { 'Content-Type': 'application/json' },
    body: { metrics },
    type: 'optimize.analyze'
  });
  report.steps.push({ step: 'analyze', node: analyze.nodeId, ok: analyze.ok });
  report.via.analyze = analyze.nodeId;
  report.recommendations =
    analyze.data?.result?.recommendations ||
    analyze.data?.recommendations ||
    [];

  const plan = await proxyDual(balancer, {
    method: 'POST',
    path: '/api/optimize/plan',
    headers: { 'Content-Type': 'application/json' },
    body: { metrics, profile: state.turboMode.mode },
    type: 'optimize.plan'
  });
  report.steps.push({ step: 'plan', node: plan.nodeId, ok: plan.ok });
  report.via.plan = plan.nodeId;
  report.ranked = plan.data?.result?.ranked || plan.data?.ranked || null;
  report.policy = plan.data?.result?.policy || plan.data?.policy || null;
  report.quality = plan.data?.result?.quality || plan.data?.quality || null;

  const mode =
    Number(metrics.modCount) >= 100
      ? 'throughput'
      : Number(metrics.jitterMs) > 2
        ? 'throughput'
        : Number(metrics.rafFps || metrics.fps) < 45
          ? 'throughput'
          : 'balanced';

  const apply = await proxyDual(balancer, {
    method: 'POST',
    path: '/api/optimize/apply-policy',
    headers: { 'Content-Type': 'application/json' },
    body: { policy: mode, metrics },
    type: 'optimize.apply-policy'
  });
  state.turboMode = { mode };
  report.steps.push({ step: 'apply-policy', node: apply.nodeId, ok: apply.ok, mode });
  report.via.apply = apply.nodeId;

  const fire = await proxyDual(balancer, {
    method: 'POST',
    path: '/api/trigger/foundry.optimize',
    headers: { 'Content-Type': 'application/json' },
    body: { payload: { metrics }, timeoutMs: 2500 },
    type: 'foundry.optimize.fire',
    timeoutMs: 12000
  });
  report.steps.push({
    step: 'foundry.optimize',
    node: fire.nodeId,
    ok: fire.ok,
    subscribers: fire.data?.subscribers
  });
  report.via.fire = fire.nodeId;

  const warm = await proxyDual(balancer, {
    method: 'POST',
    path: '/api/catalog/warm',
    headers: { 'Content-Type': 'application/json' },
    body: { topN: 12, kinds: ['libraries', 'engines', 'turbos'] },
    type: 'catalog.warm'
  });
  report.steps.push({ step: 'catalog-warm', node: warm.nodeId, ok: warm.ok });

  // Dual-share real optimize-core work across both nodes
  const share = await Promise.all(
    [
      { component: 'heavy-stack-policy', command: 'optimize', params: { metrics } },
      { component: 'adaptive-quality-ladder', command: 'optimize', params: { metrics } },
      { component: 'foundry-turbo-2-turbo-modular', command: 'boost', params: metrics },
      { component: 'canvas-turbo-1-turbo-modular', command: 'boost', params: metrics }
    ].map((body) =>
      proxyDual(balancer, {
        method: 'POST',
        path: '/api/process',
        headers: { 'Content-Type': 'application/json' },
        body,
        type: null
      })
    )
  );
  report.steps.push({
    step: 'dual-share',
    nodes: share.map((j) => j.nodeId),
    ok: share.every((j) => j.ok)
  });

  report.finishedAt = Date.now();
  report.durationMs = report.finishedAt - report.startedAt;
  return report;
}

async function runAutoOptimize(source = 'agent', metricsIn = null) {
  const report = { source, startedAt: Date.now(), steps: [], nodes: [] };
  report.nodes = await gatherNodeMetrics();

  const merged = {
    cpuPercent: avg(report.nodes.map((n) => n.metrics?.cpuPercent)),
    memPercent: avg(report.nodes.map((n) => n.metrics?.memPercent)),
    eventLoopLagMs: avg(report.nodes.map((n) => n.metrics?.eventLoopLagMs)),
    fps: Number(metricsIn?.rafFps || metricsIn?.fps || 60),
    rafFps: Number(metricsIn?.rafFps || metricsIn?.fps || 60),
    jitterMs: Number(metricsIn?.jitterMs || 0),
    heapUsedMB: Number(metricsIn?.heapUsedMB || 0),
    modCount: Number(metricsIn?.modCount || 0),
    tokens: Number(metricsIn?.tokens || 0),
    lights: Number(metricsIn?.lights || 0),
    packs: Number(metricsIn?.packs || 0),
    ...(metricsIn || {})
  };

  const core = await runFoundryOptimizeCore(merged, source);
  Object.assign(report, {
    metrics: merged,
    via: core.via,
    recommendations: core.recommendations,
    policy: core.policy,
    ranked: core.ranked,
    quality: core.quality,
    steps: [...report.steps, ...core.steps]
  });

  report.finishedAt = Date.now();
  report.durationMs = report.finishedAt - report.startedAt;
  state.lastAutoRun = report.finishedAt;
  state.lastAutoReport = report;
  state.stateVersion += 1;
  state.updatedAt = Date.now();

  try {
    fs.mkdirSync(path.join(APEX_ROOT, 'data'), { recursive: true });
    fs.writeFileSync(path.join(APEX_ROOT, 'data', 'last-auto-optimize.json'), JSON.stringify(report, null, 2));
  } catch {
    /* ignore */
  }

  log('auto-optimize complete', {
    durationMs: report.durationMs,
    mode: state.turboMode.mode,
    source,
    mods: merged.modCount
  });
  return report;
}

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.VQ_ALLOWED_ORIGINS || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-VQ-API-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (_req, res) => {
  const snap = balancer.snapshot();
  res.json({
    success: true,
    status: snap.healthyCount === 0 ? 'down' : snap.healthyCount < 2 ? 'degraded' : 'online',
    service: 'apex',
    id: cfg.id,
    name: cfg.name,
    cluster: snap,
    optimizer: {
      autoApply: state.autoApply,
      lastAutoRun: state.lastAutoRun,
      stateVersion: state.stateVersion,
      turboMode: state.turboMode
    },
    endpoints: {
      prometheus: cfg.prometheusUrl,
      oracle: cfg.oracleUrl,
      apex: `http://127.0.0.1:${cfg.port}`
    },
    timestamp: Date.now()
  });
});

app.get('/api/cluster/status', (_req, res) => {
  res.json({
    success: true,
    topology: 'prometheus-oracle-apex',
    vq1: 'PROMETHEUS',
    vq2: 'ORACLE',
    optimizer: 'APEX',
    cluster: balancer.snapshot(),
    lastAutoReport: state.lastAutoReport
      ? {
          finishedAt: state.lastAutoReport.finishedAt,
          durationMs: state.lastAutoReport.durationMs,
          steps: state.lastAutoReport.steps
        }
      : null,
    timestamp: Date.now()
  });
});

app.post('/api/cluster/mode', requireKey, (req, res) => {
  const mode = req.body?.mode;
  if (!['round-robin', 'least-load', 'affinity-least-load', 'primary-first'].includes(mode)) {
    return res.status(400).json({ success: false, error: 'invalid mode' });
  }
  balancer.mode = mode;
  res.json({ success: true, mode: balancer.mode, cluster: balancer.snapshot() });
});

// Dual work — pure least-load (no exclusive affinity)
app.post('/api/process', requireKey, async (req, res) => {
  const r = await proxyDual(balancer, {
    method: 'POST',
    path: '/api/process',
    headers: fwdHeaders(req),
    body: req.body,
    type: null,
    timeoutMs: cfg.requestTimeoutMs
  });
  res.setHeader('X-VQ-Node', r.nodeId || 'none');
  if (!r.ok && !r.data) {
    return res.status(r.status || 502).json({ success: false, error: r.error, cluster: balancer.snapshot() });
  }
  return res.status(r.status || 200).json(r.data);
});

app.post('/api/optimize/analyze', requireKey, (req, res) => proxy(req, res, '/api/optimize/analyze', 'optimize.analyze'));
app.post('/api/optimize/plan', requireKey, (req, res) => proxy(req, res, '/api/optimize/plan', 'optimize.plan'));
app.post('/api/catalog/warm', requireKey, (req, res) => proxy(req, res, '/api/catalog/warm', 'catalog.warm'));

app.post('/api/optimize/foundry', requireKey, async (req, res) => {
  try {
    const metrics = req.body?.metrics || req.body || {};
    const report = await runFoundryOptimizeCore(metrics, 'foundry-client');
    state.lastAutoRun = report.finishedAt;
    state.lastAutoReport = report;
    state.stateVersion += 1;
    res.json({ success: true, ...report, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Foundry-compatible optimizer API
app.get('/api/optimizer/health', async (_req, res) => {
  const snap = balancer.snapshot();
  const nodes = await gatherNodeMetrics();
  res.json({
    success: true,
    status: snap.healthyCount ? 'online' : 'degraded',
    optimizer: 'ready',
    service: 'apex',
    autoApply: state.autoApply,
    healthScore: snap.healthyCount === 2 ? 100 : snap.healthyCount === 1 ? 60 : 20,
    cluster: snap,
    nodeMetrics: nodes,
    state: {
      turboMode: state.turboMode,
      stateVersion: state.stateVersion,
      lastAutoRun: state.lastAutoRun
    },
    supportedActions: ACTION_CATALOG,
    timestamp: Date.now()
  });
});

app.get('/api/optimizer/recommendations', async (_req, res) => {
  const r = await proxyDual(balancer, {
    method: 'POST',
    path: '/api/optimize/analyze',
    headers: { 'Content-Type': 'application/json' },
    body: { metrics: {} },
    type: 'optimize.analyze'
  });
  const recs =
    r.data?.result?.recommendations ||
    r.data?.result?.result?.recommendations ||
    ACTION_CATALOG.map((a) => ({ type: a.type, priority: 'low', reason: 'catalog' }));
  res.json({ success: true, recommendations: recs, via: r.nodeId, timestamp: Date.now() });
});

app.get('/api/optimizer/state', (_req, res) => {
  res.json({
    success: true,
    state: {
      autoApply: state.autoApply,
      turboMode: state.turboMode,
      stateVersion: state.stateVersion,
      lastAutoRun: state.lastAutoRun,
      recentDispatches: state.dispatches.slice(-20)
    },
    cluster: balancer.snapshot(),
    timestamp: Date.now()
  });
});

app.get('/api/optimizer/metrics/current', async (_req, res) => {
  const nodes = await gatherNodeMetrics();
  res.json({ success: true, nodes, cluster: balancer.snapshot(), timestamp: Date.now() });
});

app.get('/api/optimizer/metrics/history', (_req, res) => {
  res.json({
    success: true,
    history: state.metricsHistory.slice(-(Number(_req.query.limit) || 60)),
    timestamp: Date.now()
  });
});

app.get('/api/optimizer/analysis', async (_req, res) => {
  const snap = balancer.snapshot();
  res.json({
    success: true,
    analysis: {
      healthScore: snap.healthyCount === 2 ? 100 : snap.healthyCount === 1 ? 60 : 20,
      healthStatus: snap.healthyCount === 2 ? 'healthy' : snap.healthyCount === 1 ? 'degraded' : 'critical',
      cluster: snap,
      lastAuto: state.lastAutoReport
    },
    timestamp: Date.now()
  });
});

app.get('/api/optimizer/thresholds', (_req, res) => {
  res.json({
    success: true,
    rules: [
      { metric: 'cpuPercent', warn: 70, critical: 90 },
      { metric: 'memPercent', warn: 80, critical: 92 },
      { metric: 'clusterHealthy', warn: 1, critical: 0 }
    ],
    recentAlerts: [],
    timestamp: Date.now()
  });
});

app.post('/api/optimizer/apply', requireKey, async (req, res) => {
  const type = req.body?.type || req.body?.action;
  const parameters = req.body?.parameters || {};
  const dispatchId = randomUUID();
  let response = {};

  try {
    if (type === 'set-turbo-mode') {
      state.turboMode = { mode: parameters.mode || 'balanced' };
      const r = await proxyDual(balancer, {
        method: 'POST',
        path: '/api/optimize/apply-policy',
        headers: { 'Content-Type': 'application/json', ...fwdHeaders(req) },
        body: { policy: parameters.mode || 'balanced' },
        type: 'optimize.apply-policy'
      });
      response = { applied: true, node: r.nodeId, data: r.data, mode: state.turboMode.mode };
    } else if (type === 'rebalance-cluster') {
      if (parameters.mode) balancer.mode = parameters.mode;
      for (const n of balancer.nodes) {
        n.failures = 0;
        n.disabledUntil = 0;
        n.healthy = true;
      }
      response = { rebalanced: true, cluster: balancer.snapshot() };
    } else if (type === 'run-auto-optimize') {
      response = await runAutoOptimize('api', parameters.metrics || parameters);
    } else if (type === 'foundry-optimize') {
      response = await runFoundryOptimizeCore(parameters.metrics || parameters, 'api');
    } else if (type === 'catalog-warm') {
      const r = await proxyDual(balancer, {
        method: 'POST',
        path: '/api/catalog/warm',
        headers: { 'Content-Type': 'application/json' },
        body: { topN: parameters.topN || 15 },
        type: 'catalog.warm'
      });
      response = r.data;
    } else if (type === 'failover-node') {
      const node = balancer.nodes.find((n) => n.id === parameters.nodeId);
      if (!node) return res.status(404).json({ success: false, error: 'unknown node' });
      node.healthy = false;
      node.disabledUntil = Date.now() + balancer.cooldownMs;
      node.failures = balancer.maxFailures;
      response = { failedOver: parameters.nodeId, cluster: balancer.snapshot() };
    } else if (type === 'latency-reduction') {
      balancer.mode = 'least-load';
      state.turboMode = { mode: 'throughput' };
      response = { applied: true, mode: 'least-load', turbo: 'throughput' };
    } else {
      const r = await proxyDual(balancer, {
        method: 'POST',
        path: '/api/process',
        headers: { 'Content-Type': 'application/json' },
        body: { type, ...parameters },
        type: null
      });
      response = r.data;
    }

    state.stateVersion += 1;
    state.updatedAt = Date.now();
    state.dispatches.push({ dispatchId, type, at: Date.now() });
    if (state.dispatches.length > 100) state.dispatches.shift();
    state.audit.push({ dispatchId, type, parameters, at: Date.now() });
    if (state.audit.length > 500) state.audit.shift();

    res.json({ success: true, dispatchId, type, response, data: response, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, dispatchId });
  }
});

app.patch('/api/optimizer/auto-apply', requireKey, (req, res) => {
  state.autoApply = req.body?.enabled !== false;
  res.json({ success: true, enabled: state.autoApply, timestamp: Date.now() });
});

app.get('/api/registry/count', async (_req, res) => {
  try {
    const r = await fetch(`${cfg.prometheusUrl}/api/engines?limit=1`, { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    res.json({
      success: true,
      engines: data.components?.engines ?? 0,
      turbos: data.components?.turbos ?? 0,
      libraries: data.components?.libraries ?? 0,
      total: data.components?.total ?? 0,
      timestamp: Date.now()
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

app.get('/api/audit/export', requireKey, (req, res) => {
  let rows = state.audit;
  if (req.query.userId) rows = rows.filter((r) => r.userId === req.query.userId);
  res.json({ success: true, count: rows.length, entries: rows, timestamp: Date.now() });
});

app.get('/quantum-bridge/components', (req, res) => proxy(req, res, '/quantum-bridge/components'));
app.post('/quantum-bridge/3d-tokens', requireKey, (req, res) => proxy(req, res, '/quantum-bridge/3d-tokens', null));

async function probe() {
  for (const n of balancer.nodes) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${n.url}/health`, { signal: AbortSignal.timeout(4000) });
      balancer.markHealth(n.id, r.ok, Date.now() - t0, r.ok ? null : `HTTP ${r.status}`);
    } catch (e) {
      balancer.markHealth(n.id, false, Date.now() - t0, e.message);
    }
  }
  const nodes = await gatherNodeMetrics();
  state.metricsHistory.push({ at: Date.now(), nodes, cluster: balancer.snapshot() });
  if (state.metricsHistory.length > 240) state.metricsHistory.shift();
}

const server = http.createServer(app);
await probe();
const probeTimer = setInterval(probe, cfg.healthIntervalMs);
probeTimer.unref?.();

let autoTimer = null;
if (cfg.autoOptimize) {
  setTimeout(() => {
    if (state.autoApply) runAutoOptimize('startup').catch((e) => log('startup auto failed', { error: e.message }));
  }, 5000);
  autoTimer = setInterval(() => {
    if (state.autoApply) runAutoOptimize('interval').catch((e) => log('interval auto failed', { error: e.message }));
  }, cfg.autoIntervalMs);
  autoTimer.unref?.();
}

server.listen(cfg.port, cfg.host, () => {
  log('Apex online', {
    port: cfg.port,
    prometheus: cfg.prometheusUrl,
    oracle: cfg.oracleUrl,
    auto: cfg.autoOptimize
  });
});

process.on('SIGINT', () => {
  clearInterval(probeTimer);
  if (autoTimer) clearInterval(autoTimer);
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  clearInterval(probeTimer);
  if (autoTimer) clearInterval(autoTimer);
  server.close(() => process.exit(0));
});
