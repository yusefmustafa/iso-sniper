import type { Config } from '../config';
import { PROTOCOL_VERSION, type Channel } from './channel';

export interface MatchSetup {
  localPlayer: number; // 0 = host (orange), 1 = guest (blue)
  seed: number;
  config: Config;
}

/**
 * Agree on who is player 1, the RNG seed and the tuning values before the
 * first tick. The player who created the link hosts; the host's config wins
 * so both sims run on identical numbers.
 */
export function handshake(ch: Channel, opts: { creator: boolean; config: Config }, onReady: (s: MatchSetup) => void, onError: (why: string) => void) {
  const nonce = (Math.random() * 2 ** 31) | 0;
  let role: 'host' | 'guest' | null = null;
  let done = false;
  let seed = (Math.random() * 2 ** 31) | 0;
  const timers: ReturnType<typeof setInterval>[] = [];
  const stop = () => timers.forEach(clearInterval);
  const hello = () => ch.sendReliable({ t: 'hello', v: PROTOCOL_VERSION, host: opts.creator, nonce });

  ch.onMessage((m) => {
    if (m.t === 'hello') {
      if (m.v !== PROTOCOL_VERSION) { stop(); onError('Your friend is on a different version. Both of you reload the page.'); return; }
      if (role) return;
      const iHost = opts.creator !== m.host ? opts.creator : nonce > m.nonce;
      role = iHost ? 'host' : 'guest';
      hello(); // make sure they have ours too
      if (iHost) {
        const sendStart = () => ch.sendReliable({ t: 'start', v: PROTOCOL_VERSION, seed, config: opts.config, hostIsP1: true });
        sendStart();
        timers.push(setInterval(sendStart, 500));
      }
    } else if (m.t === 'start' && role !== 'host') {
      ch.sendReliable({ t: 'go' });
      if (done) return;
      done = true;
      role = 'guest';
      seed = m.seed;
      stop();
      onReady({ localPlayer: 1, seed, config: m.config });
    } else if (m.t === 'go' && role === 'host' && !done) {
      done = true;
      stop();
      onReady({ localPlayer: 0, seed, config: opts.config });
    }
  });
  hello();
  timers.push(setInterval(() => { if (!role) hello(); }, 500));
  return stop;
}
