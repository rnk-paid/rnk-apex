/**
 * Foundry client metrics for optimize-core (FPS, jitter, heap, stack weight).
 */
export class ApexMetrics {
  constructor() {
    this._frameMs = [];
    this._rafHandle = null;
    this._sampling = false;
  }

  /** Start lightweight RAF sampler (keeps last ~120 frame deltas). */
  startSampler() {
    if (this._sampling || typeof requestAnimationFrame !== 'function') return;
    this._sampling = true;
    let last = performance.now();
    const tick = (now) => {
      if (!this._sampling) return;
      const dt = now - last;
      last = now;
      if (dt > 0 && dt < 250) {
        this._frameMs.push(dt);
        if (this._frameMs.length > 120) this._frameMs.shift();
      }
      this._rafHandle = requestAnimationFrame(tick);
    };
    this._rafHandle = requestAnimationFrame(tick);
  }

  stopSampler() {
    this._sampling = false;
    if (this._rafHandle && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafHandle);
    }
    this._rafHandle = null;
  }

  jitterMs() {
    const frames = this._frameMs;
    if (frames.length < 4) return 0;
    const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
    const variance = frames.reduce((a, b) => a + (b - mean) ** 2, 0) / frames.length;
    return Math.round(Math.sqrt(variance) * 100) / 100;
  }

  async measureRafFps(durationMs = 600) {
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

  modCount() {
    try {
      return game?.modules?.filter?.((m) => m.active)?.size
        ?? [...(game?.modules?.values?.() || [])].filter((m) => m?.active).length
        ?? 0;
    } catch {
      return 0;
    }
  }

  heapMB() {
    try {
      if (performance.memory?.usedJSHeapSize) {
        return Math.round((performance.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10;
      }
    } catch {
      /* ignore */
    }
    return 0;
  }

  heapLimitMB() {
    try {
      if (performance.memory?.jsHeapSizeLimit) {
        return Math.round((performance.memory.jsHeapSizeLimit / (1024 * 1024)) * 10) / 10;
      }
    } catch {
      /* ignore */
    }
    return 0;
  }

  canvasStats() {
    const out = {
      tokens: 0,
      lights: 0,
      layers: 0,
      textures: 0,
      gpuMemoryMB: 0,
      drawCallsPerFrame: 0
    };
    try {
      out.tokens = canvas?.tokens?.placeables?.length ?? 0;
      out.lights = canvas?.lighting?.placeables?.length ?? canvas?.effects?.lightSources?.size ?? 0;
      out.layers = canvas?.layers?.length ?? 0;
      const renderer = canvas?.app?.renderer;
      if (renderer?.texture?.managedTextures) {
        out.textures = renderer.texture.managedTextures.length ?? 0;
      } else if (renderer?.texture?.boundTextures) {
        out.textures = renderer.texture.boundTextures.filter(Boolean).length;
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  packs() {
    try {
      return game?.packs?.size ?? 0;
    } catch {
      return 0;
    }
  }

  softShadows() {
    try {
      return game?.settings?.settings?.has?.('core.softShadows')
        ? game.settings.get('core', 'softShadows') === true
        : null;
    } catch {
      return null;
    }
  }

  async collect({ rafMs = 600 } = {}) {
    this.startSampler();
    const rafFps = await this.measureRafFps(rafMs);
    const canvas = this.canvasStats();
    const modCount = this.modCount();
    return {
      rafFps: rafFps ?? 0,
      fps: rafFps ?? 0,
      jitterMs: this.jitterMs(),
      heapUsedMB: this.heapMB(),
      heapLimitMB: this.heapLimitMB(),
      modCount,
      tokens: canvas.tokens,
      lights: canvas.lights,
      layers: canvas.layers,
      textures: canvas.textures,
      gpuMemoryMB: canvas.gpuMemoryMB,
      drawCallsPerFrame: canvas.drawCallsPerFrame,
      packs: this.packs(),
      softShadows: this.softShadows(),
      frameMs: this._frameMs.slice(-60)
    };
  }
}

export const apexMetrics = new ApexMetrics();
