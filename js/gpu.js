// gpu.js — WebGPU device manager. Feature-detects, initializes a device, and
// holds a reference for compute pipelines built in later phases.
//
// Phase 4b only sets up plumbing — actual compute shaders ship in 4c/4d.
// Until then, the simulation still runs entirely on the CPU; this module's
// role is to expose `gpu.available`, an init() that resolves with a device,
// and a status string surfaced in the UI.

export class GPU {
  constructor() {
    this.available = !!(typeof navigator !== 'undefined' && navigator.gpu);
    this.device = null;
    this.adapter = null;
    this.queue = null;
    this.status = this.available ? 'detected' : 'unavailable';
    this.enabled = false;            // user-toggle — only true after init succeeds
    this.errors = [];
    this._initPromise = null;
  }

  async init() {
    if (!this.available) {
      this.status = 'unavailable (browser has no navigator.gpu)';
      return false;
    }
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        this.adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!this.adapter) {
          this.status = 'no adapter';
          return false;
        }
        this.device = await this.adapter.requestDevice();
        this.queue = this.device.queue;
        this.device.lost.then(info => {
          this.status = `lost: ${info.reason}`;
          this.enabled = false;
          this.errors.push(info.message);
        });
        this.device.onuncapturederror = (e) => {
          this.errors.push(e.error?.message || String(e));
          console.error('[gpu]', e.error);
        };
        const lim = this.adapter.limits;
        this.status = `ready · ${this.adapter.info?.vendor || 'gpu'} · ` +
                      `maxStorageBuffer ${lim.maxStorageBufferBindingSize}`;
        return true;
      } catch (err) {
        this.status = `init failed: ${err.message || err}`;
        this.errors.push(String(err));
        return false;
      }
    })();
    return this._initPromise;
  }

  setEnabled(enabled) {
    if (enabled && !this.device) {
      // Try to initialize on demand; caller should await detect/init first.
      this.enabled = false;
      return false;
    }
    this.enabled = !!enabled;
    return this.enabled;
  }

  describe() {
    return {
      available: this.available,
      enabled: this.enabled,
      status: this.status,
      errors: this.errors.slice(-3),
    };
  }
}

// Singleton instance — lazy init via main.js
export const gpu = new GPU();
