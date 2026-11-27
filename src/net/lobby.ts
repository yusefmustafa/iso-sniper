import type { Config } from '../config';
import { PROTOCOL_VERSION, type Channel, type NetMessage } from './channel';
import { cleanName, nameError, sameName } from './names';

export interface MatchSetup {
  localPlayer: number; // 0 = host (orange), 1 = guest (blue)
  seed: number;
  config: Config;
  names: [string, string];
}

export interface LobbyState {
  local: number | null; // null until roles are agreed
  names: [string | null, string | null]; // by player slot; a guest whose name was refused is null
  ready: [boolean, boolean];
  nameTaken: boolean; // the guest's name matches the host's: pick another
}

export interface LobbyCallbacks {
  onState(s: LobbyState): void;
  onStart(setup: MatchSetup): void;
  onError(why: string): void;
}

/**
 * The pre-match room, over the reliable channel. The player who created the
 * link hosts and owns the room state: names, ready flags, and the match start
 * (seed + config). The guest only proposes its name and its ready flag.
 */
export class MatchLobby {
  readonly state: LobbyState = { local: null, names: [null, null], ready: [false, false], nameTaken: false };
  private nonce = (Math.random() * 2 ** 31) | 0;
  private role: 'host' | 'guest' | null = null;
  private started = false;
  private seed = (Math.random() * 2 ** 31) | 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private name: string;

  constructor(private ch: Channel, private opts: { creator: boolean; name: string; config: Config }, private cb: LobbyCallbacks) {
    this.name = cleanName(opts.name);
    ch.onMessage((m) => this.receive(m));
    this.hello();
    this.timers.push(setInterval(() => { if (!this.role) this.hello(); }, 500));
  }

  get isHost() { return this.role === 'host'; }
  get canStart() {
    const s = this.state;
    return this.isHost && !this.started && !!s.names[0] && !!s.names[1] && s.ready[0] && s.ready[1];
  }

  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  setReady(ready: boolean) {
    if (this.state.local === null || this.started) return;
    if (this.isHost) { this.state.ready[0] = ready; this.broadcast(); }
    else { this.state.ready[1] = ready; this.ch.sendReliable({ t: 'ready', ready }); this.emit(); }
  }

  /** Guest only: try another name after the host refused one. */
  rename(name: string) {
    this.name = cleanName(name);
    this.state.nameTaken = false;
    this.ch.sendReliable({ t: 'rename', name: this.name });
    this.emit();
  }

  /** Host only, once both are ready. */
  start() {
    if (!this.canStart) return;
    this.started = true;
    const names = this.state.names as [string, string];
    const send = () => this.ch.sendReliable({ t: 'start', v: PROTOCOL_VERSION, seed: this.seed, config: this.opts.config, names });
    send();
    this.timers.push(setInterval(send, 500));
  }

  private hello() {
    this.ch.sendReliable({ t: 'hello', v: PROTOCOL_VERSION, host: this.opts.creator, nonce: this.nonce, name: this.name });
  }

  private emit() { this.cb.onState({ ...this.state, names: [...this.state.names], ready: [...this.state.ready] }); }

  private broadcast() {
    this.ch.sendReliable({ t: 'lobby', names: this.state.names, ready: this.state.ready });
    this.emit();
  }

  /** Host: accept or refuse the guest's proposed name. */
  private takeGuestName(name: string) {
    const n = cleanName(name);
    if (nameError(n) || sameName(n, this.name)) {
      this.state.names[1] = null;
      this.state.ready[1] = false;
      this.ch.sendReliable({ t: 'nameTaken' });
    } else {
      this.state.names[1] = n;
    }
    this.broadcast();
  }

  private receive(m: NetMessage) {
    switch (m.t) {
      case 'hello': {
        if (m.v !== PROTOCOL_VERSION) { this.stop(); this.cb.onError('Your opponent is on a different version of the game. Both of you reload the page.'); return; }
        if (!this.role) {
          const iHost = this.opts.creator !== m.host ? this.opts.creator : this.nonce > m.nonce;
          this.role = iHost ? 'host' : 'guest';
          this.state.local = iHost ? 0 : 1;
          this.hello(); // make sure they have ours too
          if (iHost) this.state.names[0] = this.name;
        }
        if (this.isHost && !this.started) this.takeGuestName(m.name);
        else this.emit();
        return;
      }
      case 'rename':
        if (this.isHost && !this.started) this.takeGuestName(m.name);
        return;
      case 'ready':
        if (this.isHost && !this.started && this.state.names[1]) { this.state.ready[1] = m.ready; this.broadcast(); }
        return;
      case 'nameTaken':
        if (!this.isHost) { this.state.nameTaken = true; this.state.ready[1] = false; this.emit(); }
        return;
      case 'lobby':
        if (this.isHost) return;
        // Never trust the other side's strings: show nothing for a name that breaks the rules.
        this.state.names = m.names.map((n) => (n && !nameError(n) ? cleanName(n) : null)) as [string | null, string | null];
        this.state.ready = [!!m.ready[0], !!m.ready[1]];
        this.emit();
        return;
      case 'start': {
        if (this.isHost) return;
        this.ch.sendReliable({ t: 'go' });
        if (this.started) return;
        this.started = true;
        this.stop();
        const names = m.names.map((n, i) => (n && !nameError(n) ? cleanName(n) : i === 0 ? 'Orange' : 'Blue')) as [string, string];
        this.cb.onStart({ localPlayer: 1, seed: m.seed, config: m.config, names });
        return;
      }
      case 'go':
        if (!this.isHost || !this.started || this.timers.length === 0) return;
        this.stop();
        this.cb.onStart({ localPlayer: 0, seed: this.seed, config: this.opts.config, names: this.state.names as [string, string] });
        return;
    }
  }
}
