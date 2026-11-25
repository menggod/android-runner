'use strict';

/** Track actual command boundaries; no estimated percentages or simulated stages. */
class OperationTracker {
  constructor(onChange, now = Date.now) {
    this.onChange = onChange;
    this.now = now;
    this.state = null;
  }

  get busy() { return !!this.state && this.state.status === 'running'; }
  snapshot() { return this.state ? JSON.parse(JSON.stringify(this.state)) : null; }
  changed() { this.onChange(); }

  async run(kind, steps, body, context = {}) {
    if (this.busy) throw new Error('已有任务正在进行，请等待完成。');
    this.state = Object.assign({}, context, {
      kind, status: 'running', startedAt: this.now(), endedAt: null,
      steps: steps.map(([key, label]) => ({ key, label, status: 'pending' }))
    });
    this.changed();
    try {
      const result = await body((key, task) => this.step(key, task), this.state);
      if (this.state.status === 'running') this.state.status = result === false ? 'cancelled' : 'success';
      return result;
    } catch (error) {
      this.state.status = 'failed';
      this.state.detail = error.message || String(error);
      throw error;
    } finally {
      this.state.endedAt = this.now();
      this.changed();
    }
  }

  async step(key, task) {
    const step = this.state.steps.find((item) => item.key === key);
    if (!step || this.state.status !== 'running') throw new Error('无效的运行阶段');
    step.status = 'running';
    step.startedAt = this.now();
    this.changed();
    try {
      const result = await task();
      const cancelled = !!(result && result.cancelled);
      const ok = typeof result === 'boolean' ? result : !!(result && result.ok);
      step.status = cancelled ? 'cancelled' : ok ? 'success' : 'failed';
      if (!ok) this.state.status = cancelled ? 'cancelled' : 'failed';
      return ok;
    } catch (error) {
      step.status = 'failed';
      step.detail = error.message || String(error);
      this.state.status = 'failed';
      throw error;
    } finally {
      step.endedAt = this.now();
      this.changed();
    }
  }
}

module.exports = { OperationTracker };
