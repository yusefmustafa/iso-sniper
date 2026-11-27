import { joinRoom } from 'trystero';
import type { Channel, NetMessage } from './channel';

/**
 * Online transport: a direct WebRTC connection between the two browsers.
 *
 * Trystero finds the other player through public Nostr relays (free, no
 * server of our own) and sets up the RTCPeerConnection. Its own data channel
 * is reliable and ordered, which we use for the handshake. For the 60 Hz input
 * stream we open a second, unordered channel with no retransmits, so one lost
 * packet never holds up the ones behind it (rollback inputs are redundant).
 */

const APP_ID = 'snipefight.v1';
const FAST_CHANNEL_ID = 7;

export type OnlineStatus = 'searching' | 'connected' | 'full' | 'failed';

export function connectOnline(roomId: string, onStatus: (s: OnlineStatus, ch?: Channel) => void, relayUrls?: string[]): () => void {
  const room = joinRoom({ appId: APP_ID, maxUsers: 2, ...(relayUrls ? { relayConfig: { urls: relayUrls } } : {}) }, roomId);
  const action = room.makeAction<NetMessage>('m');
  const handlers: ((m: NetMessage) => void)[] = [];
  const closers: ((r: string) => void)[] = [];
  let peerId: string | null = null;
  let fast: RTCDataChannel | null = null;
  let closed = false;

  const deliver = (m: NetMessage) => handlers.forEach((h) => h(m));

  action.onMessage((data, ctx) => {
    if (ctx.peerId !== peerId) return;
    if ((data as NetMessage).t === 'full') { onStatus('full'); return; }
    deliver(data as NetMessage);
  });

  const ch: Channel = {
    sendReliable: (msg) => { if (peerId) void action.send(msg, { target: peerId }).catch(() => {}); },
    sendFast: (msg) => {
      if (fast?.readyState === 'open') fast.send(JSON.stringify(msg));
      else if (peerId) void action.send(msg, { target: peerId }).catch(() => {});
    },
    onMessage: (cb) => handlers.push(cb),
    onClose: (cb) => closers.push(cb),
    close: () => { closed = true; void room.leave(); },
  };

  room.onPeerJoin(({ peerId: id }) => {
    // Two players per link. Anyone else who opens it is told the match is full.
    if (peerId) { void action.send({ t: 'full' }, { target: id }).catch(() => {}); return; }
    peerId = id;
    const pc = room.getPeers()[id]?.connection;
    if (pc) {
      try {
        // Both sides create the same pre-negotiated channel; no extra signaling needed.
        fast = pc.createDataChannel('fast', { negotiated: true, id: FAST_CHANNEL_ID, ordered: false, maxRetransmits: 0 });
        fast.onmessage = (e) => deliver(JSON.parse(e.data as string) as NetMessage);
      } catch {
        fast = null; // fall back to the reliable channel
      }
    }
    onStatus('connected', ch);
  });

  room.onPeerLeave(({ peerId: id }) => {
    if (id !== peerId || closed) return;
    closers.forEach((c) => c('left'));
  });

  room.onError((e) => {
    if (e.code === 'room-full') onStatus('full');
    else if (e.code === 'peer-connect-failed') onStatus('failed');
  });

  onStatus('searching');
  return () => ch.close();
}
