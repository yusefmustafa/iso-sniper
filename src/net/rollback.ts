import { config as defaultConfig, type Config } from '../config';
import { step } from '../sim/sim';
import { emptyCommand, type Command, type GameState, type SimEvent } from '../sim/types';
import type { NetMessage } from './channel';
import { decodeCommand, EMPTY_WIRE, encodeCommand, wireEq, type WireCmd } from './codec';
import type { Mesh } from './mesh';
import { cloneState, hashState } from './snapshot';

/**
 * Rollback netcode for 2 to 4 players over a full mesh (the GGPO model).
 *
 * Every peer runs the full deterministic sim. Each tick a peer:
 *  1. stamps its own players' inputs for frame `frame + inputDelay` and sends
 *     them straight to every other peer,
 *  2. simulates the next frame with every other player's real input when it
 *     has arrived, or a prediction (their last known input) when it has not,
 *  3. when a real input arrives that differs from what was predicted, rewinds
 *     to that frame and re-simulates up to the present.
 *
 * Nobody waits for the network until they run `maxPrediction` frames ahead of
 * the slowest player's inputs. Hitscan shots are resolved inside the sim on
 * the frame they were fired, so the shooter's laser is the truth.
 *
 * Keeping one bad connection from ruining the match for everyone:
 *  - Input delay is per peer. A peer whose links are all slow (the laggy one)
 *    takes up to `maxSelfDelay` frames of delay itself, so the others rarely
 *    have to guess its inputs. A peer with just one slow link stays at
 *    `maxInputDelay` or below.
 *  - Time sync only slows a peer that runs ahead of the others' clocks.
 *  - The host drops a player whose inputs keep the others waiting (or who
 *    went silent or left). From an agreed frame on, the host plays that slot
 *    with a bot, and every peer rolls back to that frame. The drop list rides
 *    on every host message, so all peers apply the same drops at the same frames.
 */

export interface RollbackOptions {
  inputDelay?: number; // starting frames of local input delay
  /** Most input delay a peer takes because of one slow link. */
  maxInputDelay?: number;
  /** Most input delay a peer takes when its links to everyone are slow (it's the laggy one). */
  maxSelfDelay?: number;
  maxPrediction?: number; // frames we may run ahead of the slowest confirmed input before waiting
  hashInterval?: number; // frames between desync checks
  /** Host only: replace players who stall the match or go silent with a bot. */
  dropLaggers?: boolean;
  /** Seconds of waiting on one player (inside a short window) before they are dropped. */
  dropAfterStall?: number;
  /** Seconds without a packet before a player is dropped. */
  dropAfterSilence?: number;
  /** Seconds at the start of a match when nobody is dropped for being slow (browsers are still loading). */
  dropGrace?: number;
  clock?: () => number; // ms; injectable for tests
}

export interface SessionSetup {
  self: string; // this peer's id
  host: string; // the peer that decides drops
  owners: string[]; // per player slot: the peer that sends its inputs
  local: number; // the slot this peer's human plays, or -1
}

export interface PeerStats { id: string; rttMs: number; lastHeardMs: number; inputDelay: number }

export interface NetStats {
  rttMs: number; // worst round trip to any peer still in the match
  rollbackFrames: number; // depth of the last rollback
  rollbacks: number; // total rollbacks so far
  rollbacksPerSec: number;
  stalled: boolean;
  waitingFor: number | null; // slot whose inputs we are waiting on
  advantage: number; // frames we are ahead of the furthest-behind peer (smoothed)
  desyncFrame: number | null;
  lastHeardMs: number; // longest silence of a peer still in the match
  inputDelay: number; // frames of local input delay right now
  stalls: number; // ticks spent waiting for inputs
  droppedSelf: boolean; // the host replaced us with a bot
  drops: number;
}

interface Peer {
  id: string;
  ack: number[]; // what they have confirmed, per slot
  d: number; // drops they have applied
  frame: number; frameAt: number; // their last reported frame and when we heard it
  ts: number; tsAt: number; // their last clock stamp, for the rtt echo
  rtt: number;
  heardAt: number;
  advantage: number;
  hashes: Map<number, number>;
  inputDelay: number;
}

const keyOf = (frame: number, e: SimEvent) => `${frame}:${e.type}:${'player' in e ? e.player : ''}`;
/** Frames of history kept for rolling back past confirmed inputs (a drop can rewind to an agreed frame). */
const SNAP_KEEP = 180;

export class RollbackSession {
  state: GameState;
  /** Player positions one frame before `state`, for render interpolation. */
  prevPositions: { x: number; z: number }[];
  readonly local: number;
  readonly self: string;
  readonly host: string;
  readonly stats: NetStats = {
    rttMs: 0, rollbackFrames: 0, rollbacks: 0, rollbacksPerSec: 0, stalled: false, waitingFor: null, advantage: 0,
    desyncFrame: null, lastHeardMs: 0, inputDelay: 0, stalls: 0, droppedSelf: false, drops: 0,
  };
  /** The original owner of each slot (owners after a drop: see ownerAt). */
  readonly owners: string[];
  /** [slot, frame] of every drop so far, in order. */
  readonly drops: [number, number][] = [];

  private n: number;
  private cfg: Config;
  private inputDelay: number;
  private minInputDelay: number;
  private maxInputDelay: number;
  private maxSelfDelay: number;
  private delayCooldown = 0;
  private lastStamped: number[]; // per owned slot: newest frame with an input
  private stampedTo: number; // newest frame stamped for our own slots
  private latched = { fire: false, roll: false, start: false }; // presses seen on ticks that stamped nothing
  private maxPrediction: number;
  private hashInterval: number;
  private nextHashFrame: number;
  private inputs: Map<number, WireCmd>[];
  private confirmed: number[]; // per slot: highest contiguous frame with a real input
  private predicted: Map<number, WireCmd>[];
  private snapshots = new Map<number, GameState>(); // state at the start of each frame
  private dropAt: number[]; // per slot: frame the host took it over, or Infinity
  private peers = new Map<string, Peer>();
  private rollbackFrom = Infinity;
  private fired = new Set<string>();
  private latestLocalHash: [number, number] | undefined;
  private skipCooldown = 0;
  private rollbackTimes: number[] = [];
  private stallScore: number[]; // host: recent ticks someone waited on each slot
  private readonly startedAt: number;
  private opts: RollbackOptions;
  private clock: () => number;
  private unsubscribe: () => void;
  /** Inputs each frame was last simulated with (debug only, see `?debug`). */
  history: Map<number, WireCmd[]> | null = null;
  readonly hashes = { local: new Map<number, number>(), remote: new Map<number, number>() };

  constructor(initial: GameState, setup: SessionSetup, private mesh: Mesh, cfg: Config = defaultConfig, opts: RollbackOptions = {}) {
    this.state = initial;
    this.n = initial.players.length;
    this.local = setup.local;
    this.self = setup.self;
    this.host = setup.host;
    this.owners = [...setup.owners];
    this.cfg = cfg;
    this.opts = opts;
    this.inputDelay = this.minInputDelay = opts.inputDelay ?? 2;
    this.maxInputDelay = Math.max(this.inputDelay, opts.maxInputDelay ?? 4);
    this.maxSelfDelay = Math.max(this.maxInputDelay, opts.maxSelfDelay ?? 7);
    this.stats.inputDelay = this.inputDelay;
    // 12 frames (200 ms) of guessing before the game waits: a short freeze is worse than a correction.
    this.maxPrediction = opts.maxPrediction ?? 12;
    this.hashInterval = opts.hashInterval ?? 60;
    this.nextHashFrame = this.hashInterval;
    this.clock = opts.clock ?? (() => performance.now());
    this.prevPositions = initial.players.map((p) => ({ x: p.x, z: p.z }));
    this.inputs = Array.from({ length: this.n }, () => new Map());
    this.predicted = Array.from({ length: this.n }, () => new Map());
    this.dropAt = Array(this.n).fill(Infinity);
    this.stallScore = Array(this.n).fill(0);
    // The first inputDelay frames have no input yet: everyone agrees they are empty.
    for (const m of this.inputs) for (let f = 0; f < this.inputDelay; f++) m.set(f, EMPTY_WIRE);
    this.confirmed = Array(this.n).fill(this.inputDelay - 1);
    this.lastStamped = Array(this.n).fill(this.inputDelay - 1);
    this.stampedTo = this.inputDelay - 1;
    const now = this.clock();
    this.startedAt = now;
    for (const id of new Set(this.owners)) {
      if (id === this.self) continue;
      this.peers.set(id, {
        id, ack: Array(this.n).fill(this.inputDelay - 1), d: 0, frame: 0, frameAt: 0, ts: 0, tsAt: 0, rtt: 0,
        heardAt: now, advantage: 0, hashes: new Map(), inputDelay: this.inputDelay,
      });
    }
    this.unsubscribe = mesh.onMessage((from, m) => this.receive(from, m));
  }

  get frame() { return this.state.tick; }
  get isHost() { return this.self === this.host; }

  /** Who sends slot `s`'s input for frame `f`. */
  ownerAt(s: number, f: number) { return f >= this.dropAt[s] ? this.host : this.owners[s]; }

  /** Slots this peer sends inputs for right now (its human, plus bots and dropped players on the host). */
  ownedSlots(): number[] {
    const out: number[] = [];
    for (let s = 0; s < this.n; s++) if (this.ownerAt(s, this.stampedTo + 1) === this.self) out.push(s);
    return out;
  }

  /** Slots the host plays with a bot because their player was dropped. */
  droppedSlots(): number[] { return this.drops.map(([s]) => s); }

  /** Peers still in the match. */
  private livePeers(): Peer[] { return [...this.peers.values()].filter((p) => this.owners.some((o, s) => o === p.id && this.dropAt[s] === Infinity) || p.id === this.host); }

  peerStats(): PeerStats[] {
    const now = this.clock();
    return this.livePeers().map((p) => ({ id: p.id, rttMs: p.rtt, lastHeardMs: now - p.heardAt, inputDelay: p.inputDelay }));
  }

  stop() { this.unsubscribe(); }

  /**
   * Call once per fixed tick with this peer's human input. `botFor` gives the
   * input for any other slot this peer owns (bots, and dropped players on the host).
   * Returns the sim events produced this tick (including events from
   * re-simulated frames that were not shown before).
   */
  tick(localCommand: Command, botFor?: (slot: number) => Command): SimEvent[] {
    const now = this.clock();
    const events: SimEvent[] = [];
    this.updateLiveness(now);

    // 1. Roll back if a confirmed input contradicted a prediction (or a drop rewrote the past).
    if (this.rollbackFrom < this.frame) this.rollback(this.rollbackFrom, events, now);
    this.rollbackFrom = Infinity;

    // 2. Decide whether to advance.
    const [slowest, slowestFrame] = this.slowestRemote();
    const ahead = this.frame - slowestFrame;
    this.stats.stalled = ahead > this.maxPrediction;
    this.stats.waitingFor = this.stats.stalled ? slowest : null;
    let advance = !this.stats.stalled;
    if (advance && this.shouldWaitForRemote(now)) advance = false;

    if (advance) {
      this.adaptInputDelay();
      this.stamp(localCommand, botFor);
      this.simulateFrame(events);
    } else {
      // Nothing new to show: hold everyone still rather than replaying the last step's motion.
      this.prevPositions = this.state.players.map((p) => ({ x: p.x, z: p.z }));
      this.latch(localCommand);
      this.stats.stalls++;
    }

    if (this.isHost && this.opts.dropLaggers) this.checkLaggers(now);
    this.checkHashes();
    this.send(now);
    this.prune();
    return events;
  }

  /** Host: a peer left the room. Replace its players with a bot right away. */
  peerLeft(id: string) {
    if (!this.isHost || id === this.self) return;
    this.dropPeer(id);
  }

  /** The remote slot whose confirmed inputs are furthest behind. */
  private slowestRemote(): [number | null, number] {
    let slot: number | null = null, frame = Infinity;
    for (let s = 0; s < this.n; s++) {
      if (this.ownerAt(s, this.confirmed[s] + 1) === this.self) continue;
      if (this.confirmed[s] < frame) { frame = this.confirmed[s]; slot = s; }
    }
    return [slot, frame];
  }

  /** Record our slots' inputs for frame + inputDelay (filling any frames a delay increase skipped). */
  private stamp(cmd: Command, botFor?: (slot: number) => Command) {
    const target = this.frame + this.inputDelay;
    if (target <= this.stampedTo) { this.latch(cmd); return; } // the delay just went down: this tick's frame is already taken
    const l = this.latched;
    const human = { ...cmd, fire: cmd.fire || l.fire, roll: cmd.roll || l.roll, start: cmd.start || l.start };
    this.latched = { fire: false, roll: false, start: false };
    for (let s = 0; s < this.n; s++) {
      if (this.ownerAt(s, target) !== this.self) continue;
      const w = encodeCommand(s === this.local ? human : botFor?.(s) ?? emptyCommand());
      for (let f = this.lastStamped[s] + 1; f <= target; f++) this.inputs[s].set(f, w);
      this.lastStamped[s] = target;
      this.confirmed[s] = target;
    }
    this.stampedTo = target;
  }

  /** A click or tap on a tick that records no input still counts on the next one. */
  private latch(cmd: Command) {
    this.latched.fire ||= cmd.fire;
    this.latched.roll ||= cmd.roll;
    this.latched.start ||= cmd.start;
  }

  /**
   * Match the input delay to the ping. Each frame of delay is a frame the
   * others don't have to guess. A peer only goes past `maxInputDelay` when
   * even its best link is slow: then it is the laggy one, and the extra delay
   * is felt by it alone instead of as corrections on everyone else's screen.
   */
  private adaptInputDelay() {
    if (this.delayCooldown > 0) { this.delayCooldown--; return; }
    if (this.minInputDelay === this.maxInputDelay) return;
    const rtts = this.livePeers().map((p) => p.rtt).filter((r) => r > 0);
    if (!rtts.length) return;
    const frameMs = 1000 / this.cfg.tickRate;
    const worst = Math.max(...rtts) / 2 / frameMs, best = Math.min(...rtts) / 2 / frameMs;
    // With one other peer there is no telling whose link is slow, so a duel stays at maxInputDelay.
    const selfMax = rtts.length >= 2 ? this.maxSelfDelay : this.maxInputDelay;
    // Hysteresis: go up while more than a frame would still be guessed, down once the ping is well under the delay.
    const toward = (oneWay: number, max: number) => {
      let w = this.inputDelay;
      if (oneWay > w + 1) w++;
      else if (oneWay < w - 1) w--;
      return Math.max(this.minInputDelay, Math.min(max, w));
    };
    const want = Math.max(toward(worst, this.maxInputDelay), toward(best, selfMax));
    if (want === this.inputDelay) return;
    this.inputDelay = want;
    this.stats.inputDelay = want;
    this.delayCooldown = 30;
  }

  private commandsFor(frame: number): Command[] {
    const cmds: Command[] = [];
    for (let s = 0; s < this.n; s++) {
      let w = this.inputs[s].get(frame);
      if (!w) {
        // Predict: the player keeps doing what they last did.
        w = this.inputs[s].get(this.confirmed[s]) ?? EMPTY_WIRE;
        this.predicted[s].set(frame, w);
      } else {
        this.predicted[s].delete(frame);
      }
      cmds.push(decodeCommand(w));
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
    if (!snap) {
      // Can't rewind that far: our state can no longer match the others'.
      if (this.stats.desyncFrame === null) this.stats.desyncFrame = from;
      return;
    }
    const to = this.frame;
    this.state = cloneState(snap);
    while (this.frame < to) this.simulateFrame(events);
    this.stats.rollbackFrames = to - from;
    this.stats.rollbacks++;
    this.rollbackTimes.push(now);
  }

  /**
   * Time sync. If we are consistently ahead of another peer, our inputs reach
   * them late and *they* roll back a lot. A peer that is ahead of anyone idles
   * for a single tick now and then, which is invisible but keeps everyone in step.
   */
  private shouldWaitForRemote(now: number): boolean {
    const frameMs = 1000 / this.cfg.tickRate;
    let adv = -Infinity;
    for (const p of this.livePeers()) {
      if (p.frameAt === 0) continue;
      const remoteNow = p.frame + (p.rtt / 2 + (now - p.frameAt)) / frameMs;
      p.advantage += (this.frame - remoteNow - p.advantage) * 0.1;
      adv = Math.max(adv, p.advantage);
    }
    if (adv === -Infinity) return false;
    this.stats.advantage = adv;
    if (this.skipCooldown > 0) { this.skipCooldown--; return false; }
    if (adv > 1) {
      this.skipCooldown = 6;
      for (const p of this.livePeers()) p.advantage -= 1;
      return true;
    }
    return false;
  }

  private receive(from: string, m: NetMessage) {
    if (m.t !== 'in') return;
    const peer = this.peers.get(from);
    if (!peer) return;
    const now = this.clock();
    peer.heardAt = now;
    if (from === this.host && m.drops) for (let i = this.drops.length; i < m.drops.length; i++) this.applyDrop(m.drops[i][0], m.drops[i][1]);
    for (const [s, f0, cmds] of m.c) {
      if (s < 0 || s >= this.n) continue;
      const before = this.confirmed[s];
      cmds.forEach((w, i) => {
        const f = f0 + i;
        if (f > this.confirmed[s] && this.ownerAt(s, f) === from && !this.inputs[s].has(f)) this.inputs[s].set(f, w);
      });
      while (this.inputs[s].has(this.confirmed[s] + 1)) this.confirmed[s]++;
      for (let f = before + 1; f <= this.confirmed[s]; f++) {
        const guess = this.predicted[s].get(f);
        if (guess && f < this.frame && !wireEq(guess, this.inputs[s].get(f)!)) this.rollbackFrom = Math.min(this.rollbackFrom, f);
        this.predicted[s].delete(f);
      }
    }
    if (Array.isArray(m.ack) && m.ack.length === this.n) peer.ack = m.ack.map((a, s) => Math.max(peer.d === m.d ? peer.ack[s] : -1, a));
    peer.d = m.d;
    if (m.fr >= peer.frame) { peer.frame = m.fr; peer.frameAt = now; }
    if (m.echo > 0) {
      const rtt = now - m.echo - m.hold;
      if (rtt >= 0) peer.rtt = peer.rtt === 0 ? rtt : peer.rtt + (rtt - peer.rtt) * 0.1;
    }
    peer.ts = m.ts;
    peer.tsAt = now;
    if (m.h && m.d === this.drops.length) {
      peer.hashes.set(m.h[0], m.h[1]);
      this.hashes.remote.set(m.h[0], m.h[1]);
      this.compareHash(m.h[0]);
    }
  }

  /**
   * From frame `f` on, the host plays slot `s`. Inputs anyone had for it from
   * then on are thrown away, and the state is rebuilt from `f`.
   */
  private applyDrop(s: number, f: number) {
    if (this.dropAt[s] !== Infinity) return;
    this.drops.push([s, f]);
    this.stats.drops = this.drops.length;
    this.dropAt[s] = f;
    if (this.owners[s] === this.self) this.stats.droppedSelf = true;
    for (const k of [...this.inputs[s].keys()]) if (k >= f) this.inputs[s].delete(k);
    for (const k of [...this.predicted[s].keys()]) if (k >= f) this.predicted[s].delete(k);
    if (this.isHost) {
      // The frames we already stamped for our own slots: the dropped player stands still for those.
      for (let k = f; k <= this.stampedTo; k++) this.inputs[s].set(k, EMPTY_WIRE);
      this.lastStamped[s] = this.confirmed[s] = Math.max(f - 1, this.stampedTo);
    } else {
      this.confirmed[s] = Math.min(this.confirmed[s], f - 1);
    }
    if (f < this.frame) this.rollbackFrom = Math.min(this.rollbackFrom, f);
    // Hashes from f on were made with the old inputs.
    for (const map of [this.hashes.local, this.hashes.remote, ...[...this.peers.values()].map((p) => p.hashes)]) {
      for (const k of [...map.keys()]) if (k >= f) map.delete(k);
    }
    if (this.latestLocalHash && this.latestLocalHash[0] >= f) this.latestLocalHash = undefined;
    this.nextHashFrame = Math.min(this.nextHashFrame, Math.ceil(f / this.hashInterval) * this.hashInterval);
  }

  /** Host: drop every slot a peer owns, at the newest frame everyone still in the match has its inputs for. */
  private dropPeer(id: string) {
    const slots = this.owners.map((o, s) => (o === id && this.dropAt[s] === Infinity ? s : -1)).filter((s) => s >= 0);
    for (const s of slots) {
      let f = this.confirmed[s];
      for (const p of this.livePeers()) {
        if (p.id === id) continue;
        f = Math.min(f, p.ack[s]);
      }
      this.applyDrop(s, Math.max(this.inputDelay, f + 1));
    }
  }

  /**
   * Host: drop a player who went silent, or whose inputs have kept someone
   * waiting for `dropAfterStall` seconds within the last few seconds.
   * Only the player furthest behind is blamed: the others are often just
   * waiting on them too. Nobody is dropped while the match is still loading.
   */
  private checkLaggers(now: number) {
    const grace = (this.opts.dropGrace ?? 10) * 1000;
    if (now - this.startedAt < grace) return;
    const silence = (this.opts.dropAfterSilence ?? 2.5) * 1000;
    const limit = (this.opts.dropAfterStall ?? 2.5) * this.cfg.tickRate;
    const slowBy = Array(this.n).fill(0);
    // How far behind each slot's inputs are, for us and as each peer last told us.
    for (let s = 0; s < this.n; s++) {
      if (this.ownerAt(s, this.frame) === this.self) continue;
      slowBy[s] = this.frame - this.confirmed[s];
    }
    for (const p of this.livePeers()) {
      if (now - p.heardAt > 500) continue; // a frozen peer's last report is stale: don't let it blame others
      for (let s = 0; s < this.n; s++) {
        const owner = this.ownerAt(s, p.frame);
        if (owner === p.id || owner === this.self) continue;
        slowBy[s] = Math.max(slowBy[s], p.frame - p.ack[s]);
      }
    }
    const playing = (s: number) => this.owners[s] !== this.self && this.dropAt[s] === Infinity;
    let worst = 0;
    for (let s = 0; s < this.n; s++) if (playing(s)) worst = Math.max(worst, slowBy[s]);
    for (let s = 0; s < this.n; s++) {
      const owner = this.owners[s];
      if (!playing(s)) { this.stallScore[s] = 0; continue; }
      const toBlame = slowBy[s] > this.maxPrediction && slowBy[s] > worst - this.maxPrediction;
      this.stallScore[s] = toBlame ? this.stallScore[s] + 1 : Math.max(0, this.stallScore[s] - 0.25);
      const peer = this.peers.get(owner);
      if (this.stallScore[s] > limit || (peer && now - peer.heardAt > silence)) this.dropPeer(owner);
    }
  }

  private updateLiveness(now: number) {
    let rtt = 0, heard = 0;
    for (const p of this.livePeers()) { rtt = Math.max(rtt, p.rtt); heard = Math.max(heard, now - p.heardAt); }
    this.stats.rttMs = rtt;
    this.stats.lastHeardMs = heard;
  }

  private send(now: number) {
    for (const p of this.peers.values()) {
      if (!this.mesh.peers().includes(p.id)) continue;
      const c: [number, number, WireCmd[]][] = [];
      for (let s = 0; s < this.n; s++) {
        const start = this.owners[s] === this.self ? 0 : this.dropAt[s] !== Infinity && this.isHost ? this.dropAt[s] : Infinity;
        if (start === Infinity) continue;
        const end = this.owners[s] === this.self ? Math.min(this.lastStamped[s], this.dropAt[s] - 1) : this.lastStamped[s];
        // A peer that hasn't applied a drop yet may count inputs from before it; resend from the drop frame.
        let ack = p.ack[s];
        if (this.dropAt[s] !== Infinity && p.d < this.drops.length) ack = Math.min(ack, this.dropAt[s] - 1);
        const from = Math.max(ack + 1, start);
        const cmds: WireCmd[] = [];
        for (let f = from; f <= end && cmds.length < 60; f++) {
          const w = this.inputs[s].get(f);
          if (!w) break;
          cmds.push(w);
        }
        if (cmds.length) c.push([s, from, cmds]);
      }
      this.mesh.sendFast(p.id, {
        t: 'in', c, ack: [...this.confirmed], fr: this.frame, ts: now,
        echo: p.ts, hold: p.ts ? now - p.tsAt : 0,
        h: this.latestLocalHash, d: this.drops.length,
        ...(this.isHost && this.drops.length ? { drops: this.drops } : {}),
      });
    }
  }

  /** Hash every Nth frame once all inputs before it are confirmed, and compare with the others' hashes. */
  private checkHashes() {
    if (this.rollbackFrom !== Infinity) return; // a drop this tick rewrote the past: hash after the re-simulation
    let minConfirmed = Infinity;
    for (let s = 0; s < this.n; s++) minConfirmed = Math.min(minConfirmed, this.confirmed[s]);
    const limit = Math.min(minConfirmed + 1, this.frame); // state at this frame depends only on confirmed inputs
    for (let f = this.nextHashFrame; f <= limit; f += this.hashInterval) {
      this.nextHashFrame = f + this.hashInterval;
      const s = f === this.frame ? this.state : this.snapshots.get(f);
      if (!s) continue;
      const h = hashState(s);
      this.hashes.local.set(f, h);
      this.latestLocalHash = [f, h];
      this.compareHash(f);
    }
  }

  private compareHash(f: number) {
    const a = this.hashes.local.get(f);
    if (a === undefined) return;
    for (const p of this.peers.values()) {
      const b = p.hashes.get(f);
      if (b !== undefined && a !== b && this.stats.desyncFrame === null) this.stats.desyncFrame = f;
    }
  }

  private prune() {
    let minConfirmed = Infinity;
    for (let s = 0; s < this.n; s++) if (this.ownerAt(s, this.confirmed[s] + 1) !== this.self) minConfirmed = Math.min(minConfirmed, this.confirmed[s]);
    if (minConfirmed === Infinity) minConfirmed = this.frame;
    // Keep snapshots from the oldest frame we might still roll back to (a drop can rewind a little past it).
    const keepFrom = Math.min(minConfirmed + 1, this.frame - SNAP_KEEP);
    for (const f of this.snapshots.keys()) if (f < keepFrom - 1) this.snapshots.delete(f);
    let minAck = Infinity;
    for (const p of this.livePeers()) for (const a of p.ack) minAck = Math.min(minAck, a);
    const old = Math.min(minConfirmed, minAck, this.frame - SNAP_KEEP) - 120;
    this.inputs.forEach((m, s) => { for (const f of m.keys()) if (f < old && f !== this.confirmed[s]) m.delete(f); });
    if (this.fired.size > 4000) {
      for (const k of this.fired) if (parseInt(k, 10) < keepFrom - 30) this.fired.delete(k);
    }
    for (const map of [this.hashes.local, this.hashes.remote, ...[...this.peers.values()].map((p) => p.hashes)]) {
      for (const f of map.keys()) if (f < this.frame - 600) map.delete(f);
    }
    const now = this.rollbackTimes.at(-1) ?? 0;
    while (this.rollbackTimes.length && this.rollbackTimes[0] < now - 1000) this.rollbackTimes.shift();
    this.stats.rollbacksPerSec = this.rollbackTimes.length;
  }
}
