/**
 * Apex dual load balancer — Prometheus (VQ-1) + Oracle (VQ-2)
 */
export class DualBalancer {
  constructor(nodes, { mode = 'affinity-least-load', maxFailures = 3, cooldownMs = 15000 } = {}) {
    this.mode = mode;
    this.maxFailures = maxFailures;
    this.cooldownMs = cooldownMs;
    this.rr = 0;
    this.nodes = nodes.map((n) => ({
      id: n.id,
      url: String(n.url).replace(/\/$/, ''),
      role: n.role,
      affinity: n.affinity || [],
      healthy: true,
      inFlight: 0,
      completed: 0,
      failures: 0,
      disabledUntil: 0,
      lastLatencyMs: 0,
      lastError: null
    }));
  }

  eligible() {
    const now = Date.now();
    return this.nodes.filter((n) => n.healthy && n.disabledUntil <= now);
  }

  select({ type, preferId } = {}) {
    let pool = this.eligible();
    if (!pool.length) pool = this.nodes.slice();

    if (preferId) {
      const p = pool.find((n) => n.id === preferId);
      if (p) return p;
    }

    if (type && String(this.mode).includes('affinity')) {
      const t = String(type);
      const matches = pool.filter((n) =>
        n.affinity.some((a) => {
          const aff = String(a);
          // Exact or dotted-prefix only (prevents optimize.apply-policy matching optimize.analyze)
          return t === aff || t.startsWith(`${aff}.`) || aff.startsWith(`${t}.`);
        })
      );
      if (matches.length) pool = matches;
    }

    if (this.mode === 'round-robin') {
      this.rr = (this.rr + 1) % pool.length;
      return pool[this.rr];
    }

    return pool.slice().sort((a, b) => {
      if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;
      if (a.completed !== b.completed) return a.completed - b.completed;
      return (a.lastLatencyMs || 0) - (b.lastLatencyMs || 0);
    })[0];
  }

  markStart(id) {
    const n = this.nodes.find((x) => x.id === id);
    if (n) n.inFlight += 1;
  }

  markOk(id, ms) {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) return;
    n.inFlight = Math.max(0, n.inFlight - 1);
    n.completed += 1;
    n.failures = 0;
    n.healthy = true;
    n.lastLatencyMs = ms;
    n.lastError = null;
  }

  markFail(id, err) {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) return;
    n.inFlight = Math.max(0, n.inFlight - 1);
    n.failures += 1;
    n.lastError = err;
    if (n.failures >= this.maxFailures) {
      n.healthy = false;
      n.disabledUntil = Date.now() + this.cooldownMs;
    }
  }

  markHealth(id, ok, ms, err) {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) return;
    n.lastLatencyMs = ms;
    if (ok) {
      n.healthy = true;
      n.failures = 0;
      n.disabledUntil = 0;
      n.lastError = null;
    } else {
      n.failures += 1;
      n.lastError = err;
      if (n.failures >= this.maxFailures) {
        n.healthy = false;
        n.disabledUntil = Date.now() + this.cooldownMs;
      }
    }
  }

  snapshot() {
    return {
      mode: this.mode,
      nodes: this.nodes.map((n) => ({ ...n })),
      healthyCount: this.nodes.filter((n) => n.healthy).length,
      totalCount: this.nodes.length
    };
  }
}

export async function proxyDual(balancer, { method, path, headers = {}, body, type, timeoutMs = 30000 }) {
  const tried = new Set();
  let lastErr = null;

  for (let i = 0; i < balancer.nodes.length; i++) {
    let node = balancer.select({ type });
    if (!node || tried.has(node.id)) {
      node = balancer.nodes.find((n) => !tried.has(n.id));
    }
    if (!node) break;
    tried.add(node.id);

    const r = await attempt(balancer, node, { method, path, headers, body, timeoutMs });
    if (r.ok || (r.status && r.status < 500)) return r;
    lastErr = r.error;
  }

  return { ok: false, status: 502, error: lastErr || 'No healthy VQ nodes', data: null, nodeId: null };
}

async function attempt(balancer, node, { method, path, headers, body, timeoutMs }) {
  const url = `${node.url}${path.startsWith('/') ? path : `/${path}`}`;
  const t0 = Date.now();
  balancer.markStart(node.id);
  try {
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (body != null && method !== 'GET' && method !== 'HEAD') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!init.headers['Content-Type'] && !init.headers['content-type']) {
        init.headers['Content-Type'] = 'application/json';
      }
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    const ms = Date.now() - t0;
    if (res.status >= 500) {
      balancer.markFail(node.id, `HTTP ${res.status}`);
      return { ok: false, status: res.status, data, error: `HTTP ${res.status}`, nodeId: node.id, latencyMs: ms };
    }
    balancer.markOk(node.id, ms);
    return { ok: true, status: res.status, data, nodeId: node.id, latencyMs: ms };
  } catch (e) {
    balancer.markFail(node.id, e.message);
    return { ok: false, status: 502, data: null, error: e.message, nodeId: node.id };
  }
}
