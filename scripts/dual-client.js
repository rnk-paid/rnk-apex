/**
 * Apex dual client — Foundry → Apex bridge → Prometheus + Oracle optimize-core
 */
const DEFAULT_BRIDGE = 'https://foundry.rnkstudios.uk/rnk-apex';

export class ApexDualClient {
  constructor({ baseUrl, apiKey = '' } = {}) {
    this.baseUrl = ApexDualClient.upgradeBridgeUrl(baseUrl || DEFAULT_BRIDGE);
    this.apiKey = String(apiKey || '').trim();
  }

  /**
   * HTTPS Foundry cannot call http:// bridges (mixed content).
   * Also rewrite bare-IP / :3002|:3102 URLs to same-origin /rnk-apex.
   */
  static upgradeBridgeUrl(url) {
    const sameOrigin =
      typeof window !== 'undefined' && window.location?.origin
        ? `${window.location.origin}/rnk-apex`
        : DEFAULT_BRIDGE;
    let u = String(url || sameOrigin).replace(/\/$/, '');
    try {
      if (typeof window !== 'undefined' && window.location?.protocol === 'https:') {
        const insecure =
          u.startsWith('http://') ||
          /^https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/i.test(u) ||
          /:(?:3002|3102)(?:\/|$)/.test(u);
        if (insecure) return sameOrigin;
      }
    } catch {
      /* ignore */
    }
    return u || sameOrigin;
  }

  _headers() {
    const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (this.apiKey) h['X-VQ-API-Key'] = this.apiKey;
    return h;
  }

  async request(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const init = {
      method,
      headers: this._headers(),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  health() {
    return this.request('/health');
  }

  cluster() {
    return this.request('/api/cluster/status');
  }

  optimizerHealth() {
    return this.request('/api/optimizer/health');
  }

  recommendations() {
    return this.request('/api/optimizer/recommendations');
  }

  metrics() {
    return this.request('/api/optimizer/metrics/current');
  }

  analysis() {
    return this.request('/api/optimizer/analysis');
  }

  apply(type, parameters = {}) {
    return this.request('/api/optimizer/apply', {
      method: 'POST',
      body: {
        type,
        parameters,
        context: { source: 'apex-foundry', auditContext: { userId: game?.user?.id || 'gm' } }
      }
    });
  }

  process(task) {
    return this.request('/api/process', { method: 'POST', body: task });
  }

  analyze(metrics) {
    return this.request('/api/optimize/analyze', { method: 'POST', body: { metrics } });
  }

  plan(metrics, profile = 'balanced') {
    return this.request('/api/optimize/plan', { method: 'POST', body: { metrics, profile } });
  }

  /** Full optimize-core pass: recommend → plan → fire foundry.optimize → warm */
  foundryOptimize(metrics = {}) {
    return this.request('/api/optimize/foundry', {
      method: 'POST',
      body: { metrics },
      timeoutMs: 45000
    });
  }

  runClusterAuto(metrics = null) {
    return this.apply('run-auto-optimize', metrics ? { metrics } : {});
  }

  setAutoApply(enabled) {
    return this.request('/api/optimizer/auto-apply', {
      method: 'PATCH',
      body: { enabled: enabled !== false }
    });
  }

  registryCount() {
    return this.request('/api/registry/count');
  }
}
