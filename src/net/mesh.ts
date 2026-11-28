import type { NetMessage } from './channel';

/**
 * Everyone in a match room, addressed by peer id. The match runs as a full
 * mesh: every browser talks to every other one directly, and each one sends
 * only its own players' inputs. Implementations: WebRTC (online, webrtc.ts),
 * BroadcastChannel (tabs on one machine, dev), and an in-memory mesh with
 * per-link latency (tests).
 *
 * Nothing above this layer cares how a message gets to a peer, so a central
 * relay server (for players whose networks block direct connections) can be
 * added later as one more implementation that forwards through the server.
 */
export interface Mesh {
  readonly selfId: string;
  /** Peers we are connected to right now. */
  peers(): string[];
  /** Ordered and guaranteed. The lobby and the match start. */
  sendReliable(to: string, msg: NetMessage): void;
  /** May drop or reorder. The 60 Hz input stream, which carries its own redundancy. */
  sendFast(to: string, msg: NetMessage): void;
  /** Returns a function that removes the handler. */
  onMessage(cb: (from: string, msg: NetMessage) => void): () => void;
  onPeerJoin(cb: (id: string) => void): void;
  onPeerLeave(cb: (id: string) => void): void;
  close(): void;
}

/** Fan-out helpers shared by the implementations. */
export class Handlers {
  msg = new Set<(from: string, m: NetMessage) => void>();
  join: ((id: string) => void)[] = [];
  leave: ((id: string) => void)[] = [];
  deliver(from: string, m: NetMessage) { for (const h of [...this.msg]) h(from, m); }
  onMessage(cb: (from: string, m: NetMessage) => void) { this.msg.add(cb); return () => { this.msg.delete(cb); }; }
}

export interface LinkOpts { latencyMs: number; jitterMs?: number; loss?: number }

/**
 * N in-memory peers, every pair linked with its own latency, jitter and loss.
 * Driven by a manual clock. `setLink` changes one pair, `kill` cuts a peer off
 * as if its tab closed.
 */
export function loopbackMesh(n: number, opts: LinkOpts & { random?: () => number }) {
  const rnd = opts.random ?? Math.random;
  let now = 0;
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  type Pending = { at: number; from: number; to: number; msg?: NetMessage; leave?: boolean };
  const queue: Pending[] = [];
  const handlers = ids.map(() => new Handlers());
  const links = new Map<string, LinkOpts>();
  const lastReliableAt = new Map<string, number>();
  const dead = new Set<number>();
  const linkOf = (a: number, b: number) => links.get(a < b ? `${a}-${b}` : `${b}-${a}`) ?? opts;
  const delay = (a: number, b: number) => {
    const l = linkOf(a, b);
    return l.latencyMs + (l.jitterMs ? (rnd() - 0.5) * 2 * l.jitterMs : 0);
  };
  const make = (self: number): Mesh => {
    const h = handlers[self];
    const idx = (id: string) => ids.indexOf(id);
    return {
      selfId: ids[self],
      peers: () => ids.filter((_, i) => i !== self && !dead.has(i)),
      sendReliable(to, msg) {
        const t = idx(to);
        if (t < 0 || dead.has(self)) return;
        const key = `${self}>${t}`;
        const at = Math.max(now + delay(self, t), lastReliableAt.get(key) ?? 0);
        lastReliableAt.set(key, at);
        queue.push({ at, from: self, to: t, msg: JSON.parse(JSON.stringify(msg)) });
      },
      sendFast(to, msg) {
        const t = idx(to);
        if (t < 0 || dead.has(self)) return;
        const l = linkOf(self, t);
        if (l.loss && rnd() < l.loss) return;
        queue.push({ at: now + delay(self, t), from: self, to: t, msg: JSON.parse(JSON.stringify(msg)) });
      },
      onMessage: (cb) => h.onMessage(cb),
      onPeerJoin: (cb) => { h.join.push(cb); },
      onPeerLeave: (cb) => { h.leave.push(cb); },
      close() { kill(self); },
    };
  };
  const kill = (i: number, noticeMs = 0) => {
    if (dead.has(i)) return;
    dead.add(i);
    for (let j = 0; j < n; j++) if (j !== i && !dead.has(j)) queue.push({ at: now + noticeMs, from: i, to: j, leave: true });
  };
  const meshes = ids.map((_, i) => make(i));
  return {
    meshes,
    ids,
    /** Advance the fake clock and deliver everything due. */
    advance(ms: number) {
      now += ms;
      queue.sort((x, y) => x.at - y.at);
      while (queue.length && queue[0].at <= now) {
        const p = queue.shift()!;
        if (dead.has(p.to) || (dead.has(p.from) && !p.leave)) continue;
        if (p.leave) handlers[p.to].leave.forEach((c) => c(ids[p.from]));
        else handlers[p.to].deliver(ids[p.from], p.msg!);
      }
    },
    get now() { return now; },
    /** Change the link between two peers from now on. */
    setLink(a: number, b: number, l: LinkOpts) { links.set(a < b ? `${a}-${b}` : `${b}-${a}`, l); },
    /** Change every link from now on. */
    setLatency(ms: number) { opts.latencyMs = ms; for (const l of links.values()) l.latencyMs = ms; },
    /** Cut a peer off. The others hear it left after `noticeMs` (a closed tab can take a while to notice). */
    kill,
  };
}

/** Tabs of one browser, joined by room name. Dev and automated tests only (`?net=local`). */
export function broadcastMesh(room: string): Mesh {
  const bc = new BroadcastChannel(`snipefight:${room}`);
  const me = Math.random().toString(36).slice(2, 10);
  const h = new Handlers();
  const known = new Set<string>();
  const send = (to: string, msg: NetMessage) => bc.postMessage({ from: me, to, msg });
  bc.onmessage = (e) => {
    const d = e.data as { from: string; to?: string; hi?: boolean; bye?: boolean; msg?: NetMessage };
    if (d.from === me) return;
    if (d.hi) {
      if (!known.has(d.from)) { known.add(d.from); bc.postMessage({ from: me, hi: true }); h.join.forEach((c) => c(d.from)); }
      return;
    }
    if (d.bye) { if (known.delete(d.from)) h.leave.forEach((c) => c(d.from)); return; }
    if (d.to !== me || !d.msg) return;
    if (!known.has(d.from)) return;
    h.deliver(d.from, d.msg);
  };
  bc.postMessage({ from: me, hi: true });
  return {
    selfId: me,
    peers: () => [...known],
    sendReliable: send,
    sendFast: send,
    onMessage: (cb) => h.onMessage(cb),
    onPeerJoin: (cb) => { h.join.push(cb); },
    onPeerLeave: (cb) => { h.leave.push(cb); },
    close: () => { bc.postMessage({ from: me, bye: true }); bc.close(); },
  };
}
