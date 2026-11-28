import { joinRoom } from 'trystero';
import type { NetMessage } from './channel';
import { Handlers, type Mesh } from './mesh';

/**
 * Online transport: direct WebRTC connections between every pair of browsers
 * in a room (a full mesh, up to four).
 *
 * Trystero finds the other players through public Nostr relays (free, no
 * server of our own) and sets up each RTCPeerConnection. Its own data channel
 * is reliable and ordered, which we use for the lobby. For the 60 Hz input
 * stream we open a second, unordered channel per peer with no retransmits, so
 * one lost packet never holds up the ones behind it (rollback inputs are redundant).
 *
 * Peers are addressed by an id each browser picks for itself and announces
 * first thing, so every peer names every other one the same way.
 */

const APP_ID = 'snipefight.v1';
const FAST_CHANNEL_ID = 7;
export const MAX_ROOM = 4;

export type OnlineStatus = 'searching' | 'full' | 'failed';

type Wire = NetMessage | { t: 'id'; id: string };

export function connectMesh(roomId: string, onStatus: (s: OnlineStatus) => void, relayUrls?: string[]): Mesh {
  const room = joinRoom({ appId: APP_ID, maxUsers: MAX_ROOM, ...(relayUrls ? { relayConfig: { urls: relayUrls } } : {}) }, roomId);
  const action = room.makeAction<Wire>('m');
  const selfId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  const h = new Handlers();
  const byTransport = new Map<string, string>(); // trystero peer id -> our id
  const byId = new Map<string, { tid: string; fast: RTCDataChannel | null }>();
  let closed = false;

  const sendTo = (tid: string, msg: Wire) => { void action.send(msg, { target: tid }).catch(() => {}); };

  action.onMessage((data, ctx) => {
    const m = data as Wire;
    if (m.t === 'id') {
      if (typeof m.id !== 'string' || byTransport.has(ctx.peerId) || byId.has(m.id)) return;
      byTransport.set(ctx.peerId, m.id);
      const pc = room.getPeers()[ctx.peerId]?.connection;
      let fast: RTCDataChannel | null = null;
      if (pc) {
        try {
          // Both sides create the same pre-negotiated channel; no extra signaling needed.
          fast = pc.createDataChannel('fast', { negotiated: true, id: FAST_CHANNEL_ID, ordered: false, maxRetransmits: 0 });
          fast.onmessage = (e) => h.deliver(m.id, JSON.parse(e.data as string) as NetMessage);
        } catch { fast = null; } // fall back to the reliable channel
      }
      byId.set(m.id, { tid: ctx.peerId, fast });
      h.join.forEach((c) => c(m.id));
      return;
    }
    const id = byTransport.get(ctx.peerId);
    if (id) h.deliver(id, m);
  });

  room.onPeerJoin(({ peerId }) => sendTo(peerId, { t: 'id', id: selfId }));

  room.onPeerLeave(({ peerId }) => {
    const id = byTransport.get(peerId);
    byTransport.delete(peerId);
    if (!id) return;
    byId.delete(id);
    if (!closed) h.leave.forEach((c) => c(id));
  });

  room.onError((e) => {
    if (e.code === 'room-full') onStatus('full');
    else if (e.code === 'peer-connect-failed' && byId.size === 0) onStatus('failed');
  });

  onStatus('searching');
  return {
    selfId,
    peers: () => [...byId.keys()],
    sendReliable: (to, msg) => { const p = byId.get(to); if (p) sendTo(p.tid, msg); },
    sendFast: (to, msg) => {
      const p = byId.get(to);
      if (!p) return;
      if (p.fast?.readyState === 'open') p.fast.send(JSON.stringify(msg));
      else sendTo(p.tid, msg);
    },
    onMessage: (cb) => h.onMessage(cb),
    onPeerJoin: (cb) => { h.join.push(cb); },
    onPeerLeave: (cb) => { h.leave.push(cb); },
    close: () => { closed = true; void room.leave(); },
  };
}
