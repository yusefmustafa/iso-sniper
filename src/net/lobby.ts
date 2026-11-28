import type { Config } from '../config';
import { MAX_PLAYERS } from '../sim/types';
import { PROTOCOL_VERSION, type BotLevelName, type NetMessage, type StartSlot, type WireSlot } from './channel';
import type { Mesh } from './mesh';
import { cleanName, nameError, sameName } from './names';

export interface MatchSetup {
  seed: number;
  config: Config;
  slots: StartSlot[]; // players in slot order; slot i plays color i
  self: string;
  host: string;
  local: number; // this peer's own slot
}

/** A seat. `linked`: connected to every other player (always true for the host and bots). */
export type LobbySlot = WireSlot;

export interface LobbyState {
  local: number | null; // our seat, null until the host gives us one
  slots: (LobbySlot | null)[]; // MAX_PLAYERS seats; slot 0 is the host
  nameTaken: boolean; // our name matches someone else's: pick another
  hostFound: boolean; // guests: the host answered
}

export interface LobbyCallbacks {
  onState(s: LobbyState): void;
  onStart(setup: MatchSetup): void;
  onError(why: string, full?: boolean): void;
}

export const BOT_NAMES = ['Claude Bot', 'Claude Bot 2', 'Claude Bot 3', 'Claude Bot 4'];
export const FULL_MESSAGE = 'This match already has four players. Ask for a new link, or create your own match.';
export const PLAYING_MESSAGE = 'That match has already started. Ask for a new link, or create your own match.';

/**
 * The pre-match room for up to four players. The player who created the link
 * hosts and owns the room: the seats, names, ready flags, bots, and the match
 * start (seed + config). The host counts as always ready and starts the match
 * once every guest is ready and connected to every other guest. Guests only
 * propose their name and ready flag. Bots are played by the host's browser.
 */
export class MatchLobby {
  readonly state: LobbyState = { local: null, slots: Array(MAX_PLAYERS).fill(null), nameTaken: false, hostFound: false };
  private hostId: string | null = null;
  private started = false;
  private seed = (Math.random() * 2 ** 31) | 0;
  private links = new Map<string, string[]>(); // host: each guest's direct connections
  private gone = new Set<string>(); // host: guests that said go
  private startMsg: NetMessage | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private name: string;
  private unsub: () => void;

  constructor(private mesh: Mesh, private opts: { creator: boolean; name: string; config: Config }, private cb: LobbyCallbacks) {
    this.name = cleanName(opts.name);
    this.unsub = mesh.onMessage((from, m) => this.receive(from, m));
    mesh.onPeerJoin((id) => { this.hello(id); this.reportLinks(); if (this.isHost) this.broadcast(); });
    mesh.onPeerLeave((id) => this.left(id));
    if (opts.creator) {
      this.hostId = mesh.selfId;
      this.state.local = 0;
      this.state.hostFound = true;
      this.state.slots[0] = { name: this.name, peer: mesh.selfId, bot: null, ready: true, linked: true };
    }
    for (const id of mesh.peers()) this.hello(id);
    // Say hello again now and then until a host answers (a message can pass a peer that is still connecting).
    this.timers.push(setInterval(() => { if (!this.hostId) for (const id of mesh.peers()) this.hello(id); }, 1000));
    queueMicrotask(() => this.emit());
  }

  get isHost() { return this.opts.creator; }
  get host() { return this.hostId; }
  private get humans() { return this.state.slots.filter((s): s is LobbySlot => !!s && !s.bot); }
  get filled() { return this.state.slots.filter(Boolean).length; }
  get canStart() {
    if (!this.isHost || this.started || this.filled < 2) return false;
    return this.state.slots.every((s) => !s || (!!s.name && s.ready && s.linked));
  }

  stop() { this.timers.forEach(clearInterval); this.timers = []; }
  /** Stop listening entirely (leaving the room). */
  close() { this.stop(); this.unsub(); }

  setReady(ready: boolean) {
    if (this.state.local === null || this.started || this.isHost || !this.hostId) return;
    this.state.slots[this.state.local]!.ready = ready;
    this.mesh.sendReliable(this.hostId, { t: 'ready', ready });
    this.emit();
  }

  /** Guest only: try another name after the host refused one. */
  rename(name: string) {
    this.name = cleanName(name);
    this.state.nameTaken = false;
    if (this.hostId) this.mesh.sendReliable(this.hostId, { t: 'rename', name: this.name });
    this.emit();
  }

  /** Host: fill the first free seat with a bot this browser plays. */
  addBot(level: BotLevelName) {
    if (!this.isHost || this.started) return;
    const i = this.state.slots.findIndex((s) => !s);
    if (i < 0) return;
    const name = BOT_NAMES.find((n) => !this.state.slots.some((s) => s?.name && sameName(s.name, n)))!;
    this.state.slots[i] = { name, peer: null, bot: level, ready: true, linked: true };
    this.broadcast();
  }

  /** Host: empty a bot's seat. */
  removeBot(i: number) {
    if (!this.isHost || this.started || !this.state.slots[i]?.bot) return;
    this.state.slots[i] = null;
    this.compact();
    this.broadcast();
  }

  /** Host only, once everyone is ready. */
  start() {
    if (!this.canStart) return;
    this.started = true;
    // Seats are packed in order, so a 3-player match is slots 0..2.
    const slots: StartSlot[] = this.state.slots.filter((s): s is LobbySlot => !!s)
      .map((s) => ({ name: s.name, owner: s.bot ? this.mesh.selfId : s.peer!, bot: s.bot }));
    this.startMsg = { t: 'start', v: PROTOCOL_VERSION, seed: this.seed, config: this.opts.config, slots };
    this.gone.clear();
    const send = () => { for (const h of this.humans) if (h.peer !== this.mesh.selfId && !this.gone.has(h.peer!)) this.mesh.sendReliable(h.peer!, this.startMsg!); };
    send();
    this.timers.push(setInterval(send, 500));
    this.maybeGo();
  }

  private hello(to: string) {
    this.mesh.sendReliable(to, { t: 'hello', v: PROTOCOL_VERSION, host: this.opts.creator, name: this.name });
  }

  private emit() {
    this.cb.onState({ ...this.state, slots: this.state.slots.map((s) => (s ? { ...s } : null)) });
  }

  /** Host: send the seats to every guest. */
  private broadcast() {
    this.refresh();
    const slots: (WireSlot | null)[] = this.state.slots.map((s) => (s ? { ...s } : null));
    for (const h of this.humans) if (h.peer !== this.mesh.selfId) this.mesh.sendReliable(h.peer!, { t: 'lobby', slots });
    this.emit();
  }

  /** Host: work out which guests are connected to everyone (from their reports and our own links). */
  private refresh() {
    if (!this.isHost) return;
    const mine = new Set(this.mesh.peers());
    const guests = this.humans.map((h) => h.peer!).filter((p) => p !== this.mesh.selfId);
    for (const s of this.state.slots) {
      if (!s || s.bot || s.peer === this.mesh.selfId) { if (s) s.linked = true; continue; }
      const theirs = new Set(this.links.get(s.peer!) ?? []);
      s.linked = mine.has(s.peer!) && guests.every((p) => p === s.peer || theirs.has(p));
    }
  }

  /** Host: close gaps so seats (and colors) stay in join order. */
  private compact() {
    const filled = this.state.slots.filter(Boolean);
    this.state.slots = Array.from({ length: MAX_PLAYERS }, (_, i) => filled[i] ?? null);
  }

  /** Guest: tell the host who we can reach directly. */
  private reportLinks() {
    if (this.hostId && !this.isHost) this.mesh.sendReliable(this.hostId, { t: 'mesh', peers: this.mesh.peers() });
  }

  /** Host: accept or refuse a guest's proposed name. */
  private takeName(peer: string, raw: string) {
    const i = this.state.slots.findIndex((s) => s?.peer === peer);
    if (i < 0) return;
    const n = cleanName(raw);
    const taken = this.state.slots.some((s, k) => k !== i && s?.name && sameName(s.name, n));
    const slot = this.state.slots[i]!;
    if (nameError(n) || taken) {
      slot.name = '';
      slot.ready = false;
      this.mesh.sendReliable(peer, { t: 'nameTaken' });
    } else {
      slot.name = n;
    }
    this.broadcast();
  }

  private left(id: string) {
    if (this.isHost) {
      this.links.delete(id);
      const i = this.state.slots.findIndex((s) => s?.peer === id);
      if (i >= 0 && !this.started) { this.state.slots[i] = null; this.compact(); }
      this.broadcast();
      this.maybeGo();
    } else if (id === this.hostId) {
      if (!this.started) { this.close(); this.cb.onError(`${this.state.slots[0]?.name || 'The host'} left, so the match was closed.`); }
    } else {
      this.reportLinks();
    }
  }

  private maybeGo() {
    if (!this.isHost || !this.startMsg || this.timers.length === 0) return;
    if (!this.humans.every((h) => h.peer === this.mesh.selfId || this.gone.has(h.peer!) || !this.mesh.peers().includes(h.peer!))) return;
    this.stop();
    const m = this.startMsg as Extract<NetMessage, { t: 'start' }>;
    this.cb.onStart({ seed: m.seed, config: m.config, slots: m.slots, self: this.mesh.selfId, host: this.mesh.selfId, local: 0 });
  }

  private receive(from: string, m: NetMessage) {
    switch (m.t) {
      case 'hello': {
        if (m.v !== PROTOCOL_VERSION) {
          // The host stays put; a guest on another version is told by the host's hello.
          if (!this.isHost && m.host) { this.close(); this.cb.onError('The host is on a different version of the game. Both of you reload the page.'); }
          return;
        }
        if (!this.isHost) {
          if (m.host && !this.hostId) {
            this.hostId = from;
            this.state.hostFound = true;
            this.hello(from); // make sure the host has ours
            this.reportLinks();
            this.emit();
          }
          return;
        }
        if (this.started) { this.mesh.sendReliable(from, { t: 'full', playing: true }); return; }
        if (!this.state.slots.some((s) => s?.peer === from)) {
          const i = this.state.slots.findIndex((s) => !s);
          if (i < 0) { this.mesh.sendReliable(from, { t: 'full' }); return; }
          this.state.slots[i] = { name: '', peer: from, bot: null, ready: false, linked: false };
        }
        this.takeName(from, m.name);
        return;
      }
      case 'rename':
        if (this.isHost && !this.started) this.takeName(from, m.name);
        return;
      case 'ready': {
        const s = this.state.slots.find((x) => x?.peer === from);
        if (this.isHost && !this.started && s?.name) { s.ready = m.ready; this.broadcast(); }
        return;
      }
      case 'mesh':
        if (this.isHost && Array.isArray(m.peers)) { this.links.set(from, m.peers.map(String)); this.broadcast(); }
        return;
      case 'nameTaken':
        if (from === this.hostId) { this.state.nameTaken = true; this.emit(); }
        return;
      case 'full':
        if (from === this.hostId || (!this.hostId && !this.isHost)) { this.close(); this.cb.onError(m.playing ? PLAYING_MESSAGE : FULL_MESSAGE, true); }
        return;
      case 'lobby': {
        if (from !== this.hostId || this.isHost || !Array.isArray(m.slots)) return;
        // Never trust the other side's strings: show nothing for a name that breaks the rules.
        this.state.slots = Array.from({ length: MAX_PLAYERS }, (_, i) => {
          const s = m.slots[i];
          if (!s) return null;
          const name = s.name && !nameError(s.name) ? cleanName(s.name) : '';
          return { name, peer: s.peer ? String(s.peer) : null, bot: s.bot ? (['easy', 'normal', 'hard'].includes(s.bot) ? s.bot : 'normal') : null, ready: !!s.ready, linked: !!s.linked };
        });
        const i = this.state.slots.findIndex((s) => s?.peer === this.mesh.selfId);
        this.state.local = i >= 0 ? i : null;
        if (i >= 0 && this.state.slots[i]!.name) this.state.nameTaken = false;
        this.emit();
        return;
      }
      case 'start': {
        if (from !== this.hostId || this.isHost) return;
        this.mesh.sendReliable(from, { t: 'go' });
        if (this.started) return;
        const local = m.slots.findIndex((s) => s.owner === this.mesh.selfId && !s.bot);
        if (local < 0) return;
        this.started = true;
        this.stop();
        const slots = m.slots.slice(0, MAX_PLAYERS).map((s, i) => ({
          name: s.name && !nameError(s.name) ? cleanName(s.name) : `Player ${i + 1}`, owner: String(s.owner), bot: s.bot,
        }));
        this.cb.onStart({ seed: m.seed, config: m.config, slots, self: this.mesh.selfId, host: from, local });
        return;
      }
      case 'go':
        if (this.isHost && this.startMsg) { this.gone.add(from); this.maybeGo(); }
        return;
    }
  }
}
