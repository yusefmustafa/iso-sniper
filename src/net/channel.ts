/**
 * A connection to the one other player. Implementations: WebRTC (online,
 * see webrtc.ts), BroadcastChannel (two tabs on one machine, for dev) and an
 * in-memory link with fake latency (tests).
 */
export interface Channel {
  /** Ordered and guaranteed. Used for the lobby and the match start. */
  sendReliable(msg: NetMessage): void;
  /** May drop or reorder. Used for the 60 Hz input stream, which carries its own redundancy. */
  sendFast(msg: NetMessage): void;
  onMessage(cb: (msg: NetMessage) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

import type { WireCmd } from './codec';
import type { Config } from '../config';

export const PROTOCOL_VERSION = 2;

export type NetMessage =
  // Pre-match room (see lobby.ts). The host owns names and ready flags.
  | { t: 'hello'; v: number; host: boolean; nonce: number; name: string }
  | { t: 'rename'; name: string }
  | { t: 'nameTaken' }
  | { t: 'ready'; ready: boolean }
  | { t: 'lobby'; names: [string | null, string | null]; ready: [boolean, boolean] }
  | { t: 'start'; v: number; seed: number; config: Config; names: [string, string] }
  | { t: 'go' }
  | { t: 'full' } // sent to a third person who opens the same link
  | {
      t: 'in';
      f: number; // frame of c[0]
      c: WireCmd[]; // inputs for frames f, f+1, ...
      ack: number; // highest contiguous frame received from the other side
      fr: number; // sender's current frame, for time sync
      ts: number; // sender's clock (ms)
      echo: number; // the last ts received from the other side
      hold: number; // ms between receiving `echo` and sending this
      h?: [number, number]; // [frame, state hash] for desync detection
    }
  | { t: 'bye' };

/** Two connected in-memory channels with configurable one-way latency, jitter and loss. Driven by a manual clock. */
export function loopbackPair(opts: { latencyMs: number; jitterMs?: number; loss?: number; random?: () => number }) {
  const rnd = opts.random ?? Math.random;
  let now = 0;
  type Pending = { at: number; msg: NetMessage; to: number };
  const queue: Pending[] = [];
  const handlers: ((m: NetMessage) => void)[][] = [[], []];
  const closers: ((r: string) => void)[][] = [[], []];
  const lastReliableAt = [0, 0];
  const make = (self: number): Channel => {
    const other = 1 - self;
    const delay = () => opts.latencyMs + (opts.jitterMs ? (rnd() - 0.5) * 2 * opts.jitterMs : 0);
    return {
      sendReliable(msg) {
        // Reliable and ordered: never dropped, never delivered before an earlier reliable message.
        const at = Math.max(now + delay(), lastReliableAt[self]);
        lastReliableAt[self] = at;
        queue.push({ at, msg: JSON.parse(JSON.stringify(msg)), to: other });
      },
      sendFast(msg) {
        if (opts.loss && rnd() < opts.loss) return;
        queue.push({ at: now + delay(), msg: JSON.parse(JSON.stringify(msg)), to: other });
      },
      onMessage(cb) { handlers[self].push(cb); },
      onClose(cb) { closers[self].push(cb); },
      close() { closers[other].forEach((c) => c('closed')); },
    };
  };
  return {
    a: make(0),
    b: make(1),
    /** Advance the fake clock and deliver everything due. */
    advance(ms: number) {
      now += ms;
      queue.sort((x, y) => x.at - y.at);
      while (queue.length && queue[0].at <= now) {
        const p = queue.shift()!;
        handlers[p.to].forEach((h) => h(p.msg));
      }
    },
    get now() { return now; },
    /** Change the one-way latency from now on (tests). */
    setLatency(ms: number) { opts.latencyMs = ms; },
  };
}

/** Two browser tabs on the same machine, joined by room name. Dev and automated tests only. */
export function broadcastChannel(room: string, onOpen: (ch: Channel) => void, onFull: () => void = () => {}): () => void {
  const bc = new BroadcastChannel(`snipefight:${room}`);
  const me = Math.random().toString(36).slice(2);
  let peer: string | null = null;
  const handlers: ((m: NetMessage) => void)[] = [];
  const closers: ((r: string) => void)[] = [];
  const ch: Channel = {
    sendReliable: (msg) => bc.postMessage({ from: me, to: peer, msg }),
    sendFast: (msg) => bc.postMessage({ from: me, to: peer, msg }),
    onMessage: (cb) => handlers.push(cb),
    onClose: (cb) => closers.push(cb),
    close: () => { bc.postMessage({ from: me, to: peer, bye: true }); bc.close(); },
  };
  bc.onmessage = (e) => {
    const d = e.data as { from: string; to: string | null; hi?: boolean; bye?: boolean; msg?: NetMessage };
    if (d.hi) {
      if (peer === null) { peer = d.from; bc.postMessage({ from: me, hi: true }); onOpen(ch); }
      else if (d.from !== peer) bc.postMessage({ from: me, to: d.from, msg: { t: 'full' } }); // a third tab
      return;
    }
    if (d.to === me && d.msg?.t === 'full' && peer === null) { onFull(); return; }
    if (d.from !== peer || d.to !== me) return;
    if (d.bye) closers.forEach((c) => c('left'));
    else if (d.msg) handlers.forEach((h) => h(d.msg!));
  };
  bc.postMessage({ from: me, hi: true });
  return () => bc.close();
}
