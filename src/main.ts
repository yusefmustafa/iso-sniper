import './style.css';
import { config, type Config } from './config';
import { createTuningPanel } from './dev/tuning';
import { KeyboardMouse } from './input/keyboardMouse';
import { InputManager } from './input/manager';
import { broadcastChannel, type Channel } from './net/channel';
import { handshake } from './net/handshake';
import { RollbackSession } from './net/rollback';
import { decodeCommand } from './net/codec';
import { hashState } from './net/snapshot';
import { connectOnline } from './net/webrtc';
import { Sfx } from './render/audio';
import { AimCursor } from './render/cursor';
import { SettingsUi } from './settings';
import { Hud, type LobbyView } from './render/hud';
import { GameRenderer } from './render/scene';
import { createGame, step } from './sim/sim';
import { emptyCommand, type GameState, type SimEvent } from './sim/types';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const renderer = new GameRenderer(canvas);
const kbm = new KeyboardMouse(canvas, renderer.screenToWorld);
const input = new InputManager(kbm);
const hud = new Hud(document.querySelector<HTMLElement>('#hud')!);
const sfx = new Sfx();
const cursor = new AimCursor(document.querySelector('#hud')!);
const settingsUi = new SettingsUi(document.body);
// Live tuning is for practice only: online, both sims must run on identical numbers.
const tuning = createTuningPanel(() => mode === 'online');
let savedConfig: Config | null = null; // our own values, restored after an online match imports the host's

for (const ev of ['keydown', 'mousedown', 'touchstart'] as const) window.addEventListener(ev, () => sfx.unlock());

// ?net=local connects two tabs of the same browser instead of going online (dev and tests).
const params = new URLSearchParams(location.search);
const LOCAL_NET = params.get('net') === 'local';
const INPUT_DELAY = Number(params.get('delay') ?? 2);
const RELAYS = params.get('relay')?.split(','); // override the public Nostr relays (testing)

type Mode = 'lobby' | 'practice' | 'online';
let mode: Mode = 'lobby';
let lobby: LobbyView = { kind: 'menu', on: onLobby };
let state: GameState = createGame(); // rendered behind the lobby
let prev = state.players.map((p) => ({ x: p.x, z: p.z }));
let labels = ['P1', 'P2'];
let session: RollbackSession | null = null;
let matchSeed = 0;
let channel: Channel | null = null;
let disconnect: (() => void) | null = null;
let stopHandshake: (() => void) | null = null;
let acc = 0;
let last = performance.now();
// Rollback corrections are blended out over a few frames instead of snapping.
const offsets = [{ x: 0, z: 0 }, { x: 0, z: 0 }];

// ---------------------------------------------------------------- lobby

const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newRoomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
const roomFromHash = () => (/^#([a-z0-9]{4,32})$/.exec(location.hash)?.[1] ?? null);
const linkFor = (room: string) => `${location.origin}${location.pathname}${location.search}#${room}`;

function onLobby(id: string) {
  if (id === 'create') {
    const room = newRoomId();
    history.replaceState(null, '', `#${room}`);
    sessionStorage.setItem('iso-sniper:created', room);
    goOnline(room, true);
  } else if (id === 'practice') {
    startPractice();
  } else if (id === 'copy' && lobby.kind === 'waiting') {
    void navigator.clipboard?.writeText(lobby.link).catch(() => {});
    lobby = { ...lobby, copied: true };
  } else if (id === 'cancel') {
    leaveOnline();
    history.replaceState(null, '', location.pathname + location.search);
    lobby = { kind: 'menu', on: onLobby };
  }
}

function goOnline(room: string, creator: boolean) {
  leaveOnline();
  mode = 'lobby';
  lobby = creator
    ? { kind: 'waiting', link: linkFor(room), status: 'Waiting for your opponent to open the link…', copied: false, on: onLobby }
    : { kind: 'connecting', status: 'Connecting to your opponent…', on: onLobby };

  const opened = (ch: Channel) => {
    channel = ch;
    lobby = { kind: 'connecting', status: 'Connected. Starting…', on: onLobby };
    ch.onClose(() => endOnline('Your opponent left the match.'));
    stopHandshake = handshake(ch, { creator, config: { ...config } }, (setup) => {
      savedConfig = { ...config };
      Object.assign(config, setup.config);
      startOnline(ch, setup.localPlayer, setup.seed);
    }, (why) => endOnline(why));
  };

  if (LOCAL_NET) {
    disconnect = broadcastChannel(room, opened);
    return;
  }
  disconnect = connectOnline(room, (status, ch) => {
    if (status === 'connected' && ch) opened(ch);
    else if (status === 'full') endOnline('That match already has two players. Create a new one.');
    else if (status === 'failed') endOnline('Could not connect directly to your opponent (a strict network or firewall can block this). Try another network.');
  }, RELAYS);
}

function leaveOnline() {
  stopHandshake?.(); stopHandshake = null;
  channel?.sendReliable({ t: 'bye' });
  channel?.close(); channel = null;
  disconnect?.(); disconnect = null;
  session = null;
  if (savedConfig) { Object.assign(config, savedConfig); savedConfig = null; }
}

/** Capture the mouse and hide the OS cursor while a match runs. */
function setPlaying(on: boolean) {
  kbm.lockEnabled = on;
  document.body.classList.toggle('playing', on);
  if (!on) document.exitPointerLock?.();
}

function toMenu(message?: string) {
  mode = 'lobby';
  setPlaying(false);
  lobby = { kind: 'menu', message, on: onLobby };
}

function endOnline(message: string) {
  leaveOnline();
  mode = 'lobby';
  setPlaying(false);
  history.replaceState(null, '', location.pathname + location.search);
  lobby = { kind: 'menu', message, on: onLobby };
}

// ---------------------------------------------------------------- matches

function startOnline(ch: Channel, localPlayer: number, seed: number) {
  matchSeed = seed;
  state = createGame({ seed });
  session = new RollbackSession(state, localPlayer, ch, config, { inputDelay: INPUT_DELAY });
  if (params.has('debug')) session.history = new Map();
  labels = localPlayer === 0 ? ['YOU', 'RIVAL'] : ['RIVAL', 'YOU'];
  prev = state.players.map((p) => ({ x: p.x, z: p.z }));
  offsets.forEach((o) => { o.x = 0; o.z = 0; });
  mode = 'online';
  setPlaying(true);
  tuning.hide();
  hud.hideJoin();
  handleEvents(state.events);
}

function startPractice() {
  leaveOnline();
  state = createGame({ seed: (Math.random() * 2 ** 31) | 0, dummyP2: true });
  prev = state.players.map((p) => ({ x: p.x, z: p.z }));
  labels = ['YOU', 'DUMMY'];
  mode = 'practice';
  setPlaying(true);
  hud.hideJoin();
  handleEvents(state.events);
}

function handleEvents(events: SimEvent[]) {
  renderer.onEvents(events, state);
  sfx.play(events);
  const rematch = 'Press Enter or Start for a rematch';
  for (const e of events) {
    if (e.type === 'roundStart') hud.flash(`ROUND ${e.round}`, '', 0.9);
    if (e.type === 'countdown') hud.flash(e.secondsLeft === 0 ? 'DUEL' : String(e.secondsLeft), '', e.secondsLeft === 0 ? 0.6 : 0.9);
    if (e.type === 'roundWon') hud.flash(`${labels[e.player]} TAKE${labels[e.player] === 'YOU' ? '' : 'S'} THE ROUND`, `${e.score[0]} - ${e.score[1]}`, 2);
    if (e.type === 'matchWon') hud.flash(labels[e.player] === 'YOU' ? 'YOU WIN' : `${labels[e.player]} WINS`, rematch, 9999);
  }
}

// Esc frees the mouse (browser pointer lock); while it is free a "Leave match" button shows.
const leaveMatch = () => (mode === 'online' ? endOnline('You left the match.') : toMenu());

function tick() {
  if (mode === 'online' && session) {
    const me = session.state.players[session.local];
    const cmd = input.command(me);
    input.endTick();
    const before = session.state.players.map((p) => ({ x: p.x, z: p.z }));
    const frameBefore = session.frame;
    const rollbacksBefore = session.stats.rollbacks;
    const events = session.tick(cmd);
    state = session.state;
    // A rollback can move a player between two rendered frames. Keep them
    // visually where they were and let the offset blend out.
    if (session.stats.rollbacks !== rollbacksBefore) {
      const from = session.frame > frameBefore ? session.prevPositions : state.players;
      from.forEach((p, i) => { offsets[i].x += before[i].x - p.x; offsets[i].z += before[i].z - p.z; });
    }
    prev = session.prevPositions;
    handleEvents(events);
    return;
  }
  if (mode === 'practice') {
    prev = state.players.map((p) => ({ x: p.x, z: p.z }));
    const cmd = input.command(state.players[0]);
    input.endTick();
    step(state, [cmd, emptyCommand()]);
    handleEvents(state.events);
    return;
  }
  input.endTick();
}

function displayState(dt: number): { s: GameState; p: { x: number; z: number }[] } {
  const k = 1 - Math.exp(-dt / 0.06);
  for (const o of offsets) {
    o.x -= o.x * k; o.z -= o.z * k;
    if (Math.abs(o.x) > 3 || Math.abs(o.z) > 3) { o.x = 0; o.z = 0; } // big corrections (round reset) just snap
  }
  if (mode !== 'online') return { s: state, p: prev };
  return {
    s: { ...state, players: state.players.map((pl, i) => ({ ...pl, x: pl.x + offsets[i].x, z: pl.z + offsets[i].z })) },
    p: prev.map((q, i) => ({ x: q.x + offsets[i].x, z: q.z + offsets[i].z })),
  };
}

function updateNetHud() {
  if (mode !== 'online' || !session) { hud.setNet(''); return; }
  const s = session.stats;
  if (s.desyncFrame !== null) hud.setNet(`DESYNC at frame ${s.desyncFrame}. Please report this.`, true);
  else if (s.lastHeardMs > 1500) hud.setNet('Connection lost… waiting', true);
  else if (s.stalled) hud.setNet(`${Math.round(s.rttMs)} ms · waiting for opponent`, true);
  else hud.setNet(`${Math.round(s.rttMs)} ms`, s.rttMs > 150);
  if (s.lastHeardMs > 10000) endOnline('Lost connection to your opponent.');
}

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const TICK = 1 / config.tickRate;
  acc += dt;
  let steps = 0;
  while (acc >= TICK && steps < 5) { tick(); acc -= TICK; steps++; }
  if (steps === 5) acc = 0;

  if (mode === 'lobby') {
    hud.showLobby(lobby);
    cursor.clear();
    renderer.render(state, prev, 1, dt, false);
  } else {
    const { s, p } = displayState(dt);
    renderer.render(s, p, Math.min(1, acc / TICK), dt, state.hitstop > 0);
    const toScreen = (x: number, y: number, z: number) => renderer.worldToScreen(x, y, z);
    hud.update(s, toScreen, labels);
    const me = mode === 'online' && session ? session.local : 0;
    const sources = s.players.map((_, i) => (i === me ? { mouse: input.active === kbm ? kbm.cursor : null } : null));
    cursor.draw(s, renderer.positions, sources, toScreen, renderer.screenToWorld, dt);
  }
  hud.setLeave(mode !== 'lobby' && !kbm.locked, leaveMatch);
  settingsUi.setAvailable(mode === 'lobby' || !kbm.locked);
  updateNetHud();
  requestAnimationFrame(frame);
}

// Opening a match link joins it directly.
const linkedRoom = roomFromHash();
if (linkedRoom) goOnline(linkedRoom, sessionStorage.getItem('iso-sniper:created') === linkedRoom);
window.addEventListener('hashchange', () => {
  const room = roomFromHash();
  if (room && mode === 'lobby' && !channel) goOnline(room, false);
});

requestAnimationFrame(frame);

// Handle for automated smoke tests and debugging in the console.
(window as unknown as { __iso: unknown }).__iso = {
  get state() { return state; }, get mode() { return mode; }, get session() { return session; }, get lobby() { return lobby; }, config, renderer,
  /** Replay a session's recorded inputs offline and hash the state at `frame` (desync debugging). */
  replayState(frame: number) {
    if (!session?.history) return null;
    const g = createGame({ seed: matchSeed });
    for (let f = 0; f < frame; f++) step(g, session.history.get(f)!.map(decodeCommand), config);
    return { ...g, arena: null, cmd: session.history.get(frame) };
  },
  replayHash(frame: number) {
    if (!session?.history) return null;
    const g = createGame({ seed: matchSeed });
    for (let f = 0; f < frame; f++) step(g, session.history.get(f)!.map(decodeCommand), config);
    return hashState(g);
  },
};
