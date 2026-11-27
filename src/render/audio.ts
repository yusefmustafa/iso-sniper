import type { SimEvent } from '../sim/types';

/**
 * Placeholder sounds synthesized with WebAudio, so every action has audio
 * from day one. Swap for recorded samples later without touching the sim.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  /** Browsers only allow audio after a user gesture. */
  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  private burst(opts: { dur: number; gain: number; freq: number; q?: number; type?: BiquadFilterType; delay?: number }) {
    const { ctx, master, noise } = this;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.value = opts.freq;
    f.Q.value = opts.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(opts.gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random() * 0.5, opts.dur + 0.05);
  }

  private tone(opts: { freq: number; to?: number; dur: number; gain: number; type?: OscillatorType; delay?: number }) {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(opts.freq, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + opts.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(opts.gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + opts.dur + 0.05);
  }

  play(events: SimEvent[]) {
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          // Crack + body + echo tail
          this.burst({ dur: 0.08, gain: 0.9, freq: 3200, q: 0.7, type: 'highpass' });
          this.tone({ freq: e.charged ? 120 : 180, to: 40, dur: e.charged ? 0.35 : 0.22, gain: 0.7, type: 'triangle' });
          this.burst({ dur: 0.6, gain: 0.12, freq: 900, q: 0.5, delay: 0.06 });
          if (e.hit === null) this.burst({ dur: 0.05, gain: 0.25, freq: 2500, q: 4, delay: 0.03 }); // wall impact
          break;
        case 'hit':
          this.tone({ freq: e.damage > 1 ? 70 : 110, to: 35, dur: e.damage > 1 ? 0.5 : 0.3, gain: 0.9, type: 'sine' });
          this.burst({ dur: 0.12, gain: 0.5, freq: 600, q: 1 });
          break;
        case 'charged':
          this.tone({ freq: 1320, dur: 0.18, gain: 0.18, type: 'sine' });
          this.tone({ freq: 1980, dur: 0.12, gain: 0.08, type: 'sine', delay: 0.04 });
          break;
        case 'boltReady':
          this.burst({ dur: 0.04, gain: 0.3, freq: 4200, q: 6 });
          this.burst({ dur: 0.05, gain: 0.25, freq: 2600, q: 6, delay: 0.09 });
          break;
        case 'roll':
          this.burst({ dur: 0.25, gain: 0.25, freq: 500, q: 0.6, type: 'lowpass' });
          break;
        case 'kneel':
          this.burst({ dur: 0.08, gain: 0.3, freq: 300, q: 1, type: 'lowpass' });
          break;
        case 'countdown':
          this.tone({ freq: e.secondsLeft === 0 ? 880 : 440, dur: e.secondsLeft === 0 ? 0.35 : 0.15, gain: 0.2, type: 'square' });
          break;
        case 'roundWon':
          this.tone({ freq: 523, dur: 0.2, gain: 0.15, type: 'triangle', delay: 0.3 });
          this.tone({ freq: 784, dur: 0.35, gain: 0.15, type: 'triangle', delay: 0.45 });
          break;
        default:
          break;
      }
    }
  }
}
