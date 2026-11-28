import { config as defaultConfig, type Config } from '../config';
import { step } from '../sim/sim';
import type { Command, GameState, SimEvent } from '../sim/types';
import type { Channel, NetMessage } from './channel';
import { decodeCommand, EMPTY_WIRE, encodeCommand, wireEq, type WireCmd } from './codec';
import { cloneState, hashState } from './snapshot';

/**
 * Rollback netcode for a two-player match (the GGPO model).
 *
 * Both peers run the full deterministic sim. Each tick a peer:
 *  1. stamps its local input for frame `frame + inputDelay` and streams it,
 *  2. simulates the next frame using the remote player's real input when it
 *     has arrived, or a prediction (their last known input) when it has not,
 *  3. when a real remote input arrives that differs from what was predicted,
 *     rewinds to that frame and re-simulates up to the present.
 *
 * The local player never waits for the network, so movement, aim and the
 * trigger feel exactly like offline play. The remote player's actions show up
 * corrected after a rollback. Hitscan shots are resolved inside the sim on
 * the frame they were fired, against where the target really was on that
 * frame, so the shooter's laser is the truth: that is the lag compensation.
 */

export interface RollbackOptions {
  inputDelay?: number; // starting frames of local input delay; trades a little latency for fewer rollbacks
  /** Raise the input delay with the ping (up to this many frames), so fewer guesses about the other player are wrong. Set to `inputDelay` to keep it fixed. */
  maxInputDelay?: number;
  maxPrediction?: number; // frames we may run ahead of the last confirmed remote input before stalling
  hashInterval?: number; // frames between desync checks
  clock?: () => number; // ms; injectable for tests
}

export interface NetStats {
  rttMs: number;
  rollbackFrames: number; // depth of the last rollback
  rollbacks: number; // total rollbacks so far
  rollbacksPerSec: number;
  stalled: boolean;
  advantage: number; // frames we are ahead of the remote (smoothed)
  desyncFrame: number | null;
  lastHeardMs: number; // ms since the last packet
  inputDelay: number; // frames of local input delay right now
  stalls: number; // ticks spent waiting for the remote's inputs
}

const keyOf = (frame: number, e: SimEvent) => `${frame}:${e.type}:${'player' in e ? e.player : ''}`;

export class RollbackSession {
  state: GameState;
  /** Player positions one frame before `state`, for render interpolation. */
  prevPositions: { x: number; z: number }[];
  readonly local: number;
  readonly remote: number;
  readonly stats: NetStats = { rttMs: 0, rollbackFrames: 0, rollbacks: 0, rollbacksPerSec: 0, stalled: false, advantage: 0, desyncFrame: null, lastHeardMs: 0, inputDelay: 0, stalls: 0 };

  private cfg: Config;
  private inputDelay: number;
  private minInputDelay: number;
  private maxInputDelay: number;
  private delayCooldown = 0;
  private lastStamped: number; // newest frame that has a local input
  private latched = { fire: false, roll: false, start: false }; // presses seen on ticks that stamped nothing
  private maxPrediction: number;
  private hashInterval: number;
  private inputs: Map<number, WireCmd>[] = [new Map(), new Map()];
  private predicted = new Map<number, WireCmd>(); // remote inputs we guessed, by frame
  private snapshots = new Map<number, GameState>(); // state at the start of each frame
  private lastRemote = -1; // highest contiguous confirmed remote frame
  private remoteAck = -1; // highest local frame the remote has confirmed
  private rollbackFrom = Infinity;
  private fired = new Set<string>();
  private latestLocalHash: [number, number] | undefined;
  private remoteFrame = 0;
  private remoteFrameAt = 0;
  private lastRemoteTs = 0;
  private lastRemoteTsAt = 0;
  private lastHeardAt = 0;
  private skipCooldown = 0;
  private rollbackTimes: number[] = [];
  private clock: () => number;
  /** Inputs each frame was last simulated with (debug only, see `?debug`). */
  history: Map<number, WireCmd[]> | null = null;
  readonly hashes = { local: new Map<number, number>(), remote: new Map<number, number>() };

  constructor(initial: GameState, localPlayer: number, private channel: Channel, cfg: Config = defaultConfig, opts: RollbackOptions = {}) {
    this.state = initial;
    this.local = localPlayer;
    this.remote = 1 - localPlayer;
    this.cfg = cfg;
    this.inputDelay = this.minInputDelay = opts.inputDelay ?? 2;
    this.maxInputDelay = Math.max(this.inputDelay, opts.maxInputDelay ?? 4);
    this.stats.inputDelay = this.inputDelay;
    // 12 frames (200 ms) of guessing before the game waits: a short freeze is worse than a correction.
    this.maxPrediction = opts.maxPrediction ?? 12;
    this.hashInterval = opts.hashInterval ?? 60;
    this.clock = opts.clock ?? (() => performance.now());
    this.prevPositions = initial.players.map((p) => ({ x: p.x, z: p.z }));
    // The first inputDelay frames have no local input yet: both sides agree they are empty.
    for (let f = 0; f < this.inputDelay; f++) { this.inputs[0].set(f, EMPTY_WIRE); this.inputs[1].set(f, EMPTY_WIRE); }
    this.lastRemote = this.inputDelay - 1;
    this.remoteAck = this.inputDelay - 1;
    this.lastStamped = this.inputDelay - 1;
    channel.onMessage((m) => this.receive(m));
  }

  get frame() { return this.state.tick; }

  /**
   * Call once per fixed tick. Returns the sim events produced this tick
   * (including events from re-simulated frames that were not shown before).
   */
  tick(localCommand: Command): SimEvent[] {
    const now = this.clock();
    const events: SimEvent[] = [];
    this.stats.lastHeardMs = this.lastHeardAt ? now - this.lastHeardAt : 0;

    // 1. Roll back if a confirmed remote input contradicted a prediction.
    if (this.rollbackFrom < this.frame) this.rollback(this.rollbackFrom, events, now);
    this.rollbackFrom = Infinity;

    // 2. Decide whether to advance.
    const ahead = this.frame - this.lastRemote;
    this.stats.stalled = ahead > this.maxPrediction;
    let advance = !this.stats.stalled;
    if (advance && this.shouldWaitForRemote(now)) advance = false;

    if (advance) {
      this.adaptInputDelay();
      this.stamp(localCommand);
      this.simulateFrame(events);
    } else {
      // Nothing new to show: hold everyone still rather than replaying the last step's motion.
      this.prevPositions = this.state.players.map((p) => ({ x: p.x, z: p.z }));
      this.latch(localCommand);
      this.stats.stalls++;
    }

    this.checkHashes();
    this.send(now);
    this.prune();
    return events;
  }

  /** Record the local input for frame + inputDelay (filling any frames a delay increase skipped). */
  private stamp(cmd: Command) {
    const target = this.frame + this.inputDelay;
    if (target <= this.lastStamped) { this.latch(cmd); return; } // the delay just went down: this tick's frame is already taken
    const l = this.latched;
    const c = { ...cmd, fire: cmd.fire || l.fire, roll: cmd.roll || l.roll, start: cmd.start || l.start };
    this.latched = { fire: false, roll: false, start: false };
    const w = encodeCommand(c);
    for (let f = this.lastStamped + 1; f <= target; f++) this.inputs[this.local].set(f, w);
    this.lastStamped = target;
  }

  /** A click or tap on a tick that records no input still counts on the next one. */
  private latch(cmd: Command) {
    this.latched.fire ||= cmd.fire;
    this.latched.roll ||= cmd.roll;
    this.latched.start ||= cmd.start;
  }

  /**
   * Match the input delay to the ping. Each frame of delay is a frame the
   * other side doesn't have to guess, so on a slow link a little delay means
   * the opponent you aim at is where they really are, instead of a guess that
   * gets corrected (and a shot that looked on target misses).
   */
  private adaptInputDelay() {
    if (this.delayCooldown > 0) { this.delayCooldown--; return; }
    if (this.stats.rttMs <= 0 || this.minInputDelay === this.maxInputDelay) return;
    const oneWay = this.stats.rttMs / 2 / (1000 / this.cfg.tickRate);
    // Hysteresis: go up while more than a frame would still be guessed, down once the ping is well under the delay.
    let want = this.inputDelay;
    if (oneWay > this.inputDelay + 1) want = this.inputDelay + 1;
    else if (oneWay < this.inputDelay - 1) want = this.inputDelay - 1;
    want = Math.max(this.minInputDelay, Math.min(this.maxInputDelay, want));
    if (want === this.inputDelay) return;
    this.inputDelay = want;
    this.stats.inputDelay = want;
    this.delayCooldown = 30;
  }

  private commandsFor(frame: number): Command[] {
    const cmds: Command[] = [];
    for (let p = 0; p < 2; p++) {
      let w = this.inputs[p].get(frame);
      if (!w && p === this.remote) {
        // Predict: the remote player keeps doing what they last did.
        w = this.inputs[p].get(this.lastRemote) ?? EMPTY_WIRE;
        this.predicted.set(frame, w);
      } else if (p === this.remote) {
        this.predicted.delete(frame);
      }
      cmds.push(decodeCommand(w ?? EMPTY_WIRE));
    }
    return cmds;
  }

  private simulateFrame(events: SimEvent[]) {
    const f = this.frame;
    this.snapshots.set(f, cloneState(this.state));
    this.prevPositions = this.state.players.map((p) => ({ x: p.x, z: p.z }));
    const cmds = this.commandsFor(f);
    this.history?.set(f, cmds.map(encodeCommand));
    step(this.state, cmds, this.cfg);
    for (const e of this.state.events) {
      const k = keyOf(this.state.tick, e);
      if (this.fired.has(k)) continue;
      this.fired.add(k);
      events.push(e);
    }
  }

  private rollback(from: number, events: SimEvent[], now: number) {
    const snap = this.snapshots.get(from);
    if (!snap) { if (this.history) console.warn('missing snapshot', from, this.frame, this.lastRemote); return; }
    const to = this.frame;
    if (this.history && this.latestLocalHash && from < this.latestLocalHash[0]) console.warn('rollback into hashed frame', from, this.latestLocalHash[0], this.lastRemote);
    this.state = cloneState(snap);
    while (this.frame < to) this.simulateFrame(events);
    this.stats.rollbackFrames = to - from;
    this.stats.rollbacks++;
    this.rollbackTimes.push(now);
  }

  /**
   * Time sync. If we are consistently ahead of the remote, our inputs reach
   * them late and *they* roll back a lot. The peer that is ahead idles for
   * a single tick now and then, which is invisible but keeps both in step.
   */
  private shouldWaitForRemote(now: number): boolean {
    if (this.remoteFrameAt === 0) return false;
    const frameMs = 1000 / this.cfg.tickRate;
    const remoteNow = this.remoteFrame + (this.stats.rttMs / 2 + (now - this.remoteFrameAt)) / frameMs;
    const adv = this.frame - remoteNow;
    this.stats.advantage += (adv - this.stats.advantage) * 0.1;
    if (this.skipCooldown > 0) { this.skipCooldown--; return false; }
    if (this.stats.advantage > 1) {
      this.skipCooldown = 6;
      this.stats.advantage -= 1;
      return true;
    }
    return false;
  }

  private receive(m: NetMessage) {
    if (m.t !== 'in') return;
    this.lastHeardAt = this.clock();
    const before = this.lastRemote;
    m.c.forEach((w, i) => {
      const f = m.f + i;
      if (f > this.lastRemote && !this.inputs[this.remote].has(f)) this.inputs[this.remote].set(f, w);
    });
    while (this.inputs[this.remote].has(this.lastRemote + 1)) this.lastRemote++;
    for (let f = before + 1; f <= this.lastRemote; f++) {
      const guess = this.predicted.get(f);
      if (guess && f < this.frame && !wireEq(guess, this.inputs[this.remote].get(f)!)) this.rollbackFrom = Math.min(this.rollbackFrom, f);
      this.predicted.delete(f);
    }
    if (m.ack > this.remoteAck) this.remoteAck = m.ack;
    if (m.fr >= this.remoteFrame) { this.remoteFrame = m.fr; this.remoteFrameAt = this.lastHeardAt; }
    if (m.echo > 0) {
      const rtt = this.lastHeardAt - m.echo - m.hold;
      if (rtt >= 0) this.stats.rttMs = this.stats.rttMs === 0 ? rtt : this.stats.rttMs + (rtt - this.stats.rttMs) * 0.1;
    }
    this.lastRemoteTs = m.ts;
    this.lastRemoteTsAt = this.lastHeardAt;
    if (m.h) {
      this.hashes.remote.set(m.h[0], m.h[1]);
      this.compareHash(m.h[0]);
    }
  }

  private send(now: number) {
    const from = this.remoteAck + 1;
    const to = this.lastStamped; // inclusive: the newest stamped local input
    const c: WireCmd[] = [];
    for (let f = from; f <= to && c.length < 60; f++) {
      const w = this.inputs[this.local].get(f);
      if (!w) break;
      c.push(w);
    }
    this.channel.sendFast({
      t: 'in', f: from, c, ack: this.lastRemote, fr: this.frame, ts: now,
      echo: this.lastRemoteTs, hold: this.lastRemoteTs ? now - this.lastRemoteTsAt : 0,
      h: this.latestLocalHash,
    });
  }

  /** Hash every Nth frame once all inputs before it are confirmed, and compare with the remote's hash. */
  private checkHashes() {
    const confirmedState = this.lastRemote + 1; // state at this frame depends only on confirmed inputs
    const limit = Math.min(confirmedState, this.frame);
    const start = this.latestLocalHash ? this.latestLocalHash[0] + this.hashInterval : this.hashInterval;
    for (let f = start; f <= limit; f += this.hashInterval) {
      const s = f === this.frame ? this.state : this.snapshots.get(f);
      if (!s) continue;
      const h = hashState(s);
      this.hashes.local.set(f, h);
      this.latestLocalHash = [f, h];
      this.compareHash(f);
    }
  }

  private compareHash(f: number) {
    const a = this.hashes.local.get(f), b = this.hashes.remote.get(f);
    if (a === undefined || b === undefined) return;
    if (a !== b && this.stats.desyncFrame === null) this.stats.desyncFrame = f;
  }

  private prune() {
    // Keep snapshots from the oldest frame we might still roll back to.
    const keepFrom = this.lastRemote + 1;
    for (const f of this.snapshots.keys()) if (f < keepFrom - 1) this.snapshots.delete(f);
    const old = Math.min(this.lastRemote, this.remoteAck) - 120;
    for (const m of this.inputs) for (const f of m.keys()) if (f < old && f !== this.lastRemote) m.delete(f);
    if (this.fired.size > 2000) {
      for (const k of this.fired) if (parseInt(k, 10) < this.lastRemote - 30) this.fired.delete(k);
    }
    for (const map of [this.hashes.local, this.hashes.remote]) for (const f of map.keys()) if (f < this.frame - 600) map.delete(f);
    const now = this.rollbackTimes.at(-1) ?? 0;
    while (this.rollbackTimes.length && this.rollbackTimes[0] < now - 1000) this.rollbackTimes.shift();
    this.stats.rollbacksPerSec = this.rollbackTimes.length;
  }
}
