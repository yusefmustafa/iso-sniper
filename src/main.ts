import './style.css';
import { config, type Config } from './config';
import { createTuningPanel } from './dev/tuning';
import { KeyboardMouse } from './input/keyboardMouse';
import { InputManager } from './input/manager';
import { broadcastChannel, type Channel } from './net/channel';
import { MatchLobby, type LobbyState } from './net/lobby';
import { cleanName, nameError } from './net/names';
import { RollbackSession } from './net/rollback';
import { decodeCommand } from './net/codec';
import { hashState } from './net/snapshot';
import { connectOnline } from './net/webrtc';
import { Sfx } from './render/audio';
import { AimCursor } from './render/cursor';
import { settings, SettingsUi } from './settings';
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
const NAME_KEY = 'snipefight:name';
let myName = (() => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } })();
const saveName = (n: string) => { myName = cleanName(n); try { localStorage.setItem(NAME_KEY, myName); } catch { /* not saved */ } };
let lobby: LobbyView = { kind: 'menu', name: myName, on: onLobby };
let room: MatchLobby | null = null;
let roomId: string | null = null;
let creator = false;
let names: [string, string] = ['Orange', 'Blue'];
let menuOpen = false; // the Esc menu during a match
let state: GameState = createGame(); // rendered behind the lobby
let prev = state.players.map((p) => ({ x: p.x, z: p.z }));
let labels = ['P1', 'P2'];
let session: RollbackSession | null = null;
let matchSeed = 0;
let channel: Channel | null = null;
let disconnect: (() => void) | null = null;
let acc = 0;
let last = performance.now();
// Rollback corrections are blended out over a few frames instead of snapping.
const offsets = [{ x: 0, z: 0 }, { x: 0, z: 0 }];

// ---------------------------------------------------------------- lobby

const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newRoomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
const roomFromHash = () => (/^#([a-z0-9]{4,32})$/.exec(location.hash)?.[1] ?? null);
const linkFor = (room: string) => `${location.origin}${location.pathname}${location.search}#${room}`;

const menu = (message?: string): LobbyView => ({ kind: 'menu', name: myName, message, on: onLobby });

function onLobby(id: string, value?: string) {
  if (id === 'name') {
    if (value !== undefined) myName = value; // typed, not yet validated or saved
  } else if (id === 'create' || id === 'join') {
    if (value === undefined || nameError(value)) return;
    saveName(value);
    if (id === 'create') {
      const r = newRoomId();
      history.replaceState(null, '', `#${r}`);
      sessionStorage.setItem('snipefight:created', r);
      goOnline(r, true);
    } else {
      const r = roomFromHash();
      if (r) goOnline(r, sessionStorage.getItem('snipefight:created') === r);
    }
  } else if (id === 'practice') {
    if (value !== undefined && !nameError(value)) saveName(value);
    startPractice();
  } else if (id === 'copy' && (lobby.kind === 'waiting' || lobby.kind === 'room') && roomId) {
    void navigator.clipboard?.writeText(linkFor(roomId)).catch(() => {});
    lobby = { ...lobby, copied: true };
  } else if (id === 'ready' && room && room.state.local !== null) {
    room.setReady(!room.state.ready[room.state.local]);
  } else if (id === 'start' && room) {
    room.start();
  } else if (id === 'rename' && room && value !== undefined && !nameError(value)) {
    saveName(value);
    room.rename(value);
  } else if (id === 'cancel') {
    leaveOnline();
    roomId = null;
    history.replaceState(null, '', location.pathname + location.search);
    lobby = menu();
  }
}

function roomView(s: LobbyState): LobbyView {
  const copied = lobby.kind === 'room' || lobby.kind === 'waiting' ? lobby.copied : false;
  return {
    kind: 'room', link: creator && roomId ? linkFor(roomId) : null, local: s.local ?? 1, names: s.names, ready: s.ready,
    isHost: !!room?.isHost, canStart: !!room?.canStart, nameTaken: s.nameTaken, name: myName, copied, on: onLobby,
  };
}

const FULL = 'This match already has two players. Ask for a new link, or create your own match.';

function goOnline(r: string, isCreator: boolean) {
  leaveOnline();
  roomId = r;
  creator = isCreator;
  mode = 'lobby';
  setPlaying(false);
  lobby = isCreator
    ? { kind: 'waiting', link: linkFor(r), copied: false, on: onLobby }
    : { kind: 'connecting', status: 'Connecting to your opponent…', on: onLobby };

  const opened = (ch: Channel) => {
    channel = ch;
    lobby = { kind: 'connecting', status: 'Connected…', on: onLobby };
    ch.onClose(() => opponentLeft());
    // 'bye' arrives at once when they leave or close the tab; onClose can take a while after a tab dies.
    ch.onMessage((m) => { if (m.t === 'bye' && channel === ch) opponentLeft(); });
    room = new MatchLobby(ch, { creator: isCreator, name: myName, config: { ...config } }, {
      onState: (st) => { if (mode === 'lobby') lobby = roomView(st); },
      onStart: (setup) => {
        savedConfig = { ...config };
        Object.assign(config, setup.config);
        names = setup.names;
        startOnline(ch, setup.localPlayer, setup.seed);
      },
      onError: (why) => endOnline(why),
    });
  };

  if (LOCAL_NET) {
    disconnect = broadcastChannel(r, opened, () => endOnline(FULL));
    return;
  }
  disconnect = connectOnline(r, (status, ch) => {
    if (status === 'connected' && ch) opened(ch);
    else if (status === 'full') endOnline(FULL);
    else if (status === 'failed') endOnline('Could not connect directly to your opponent (a strict network or firewall can block this). Try another network.');
  }, RELAYS);
}

/** The other player closed the tab or left. The creator keeps the link open for a new opponent. */
function opponentLeft() {
  const other = room?.isHost === false || (session && session.local === 1) ? 0 : 1;
  const who = (session ? names[other] : room?.state.names[other]) ?? 'Your opponent';
  const r = roomId;
  if (creator && r) {
    goOnline(r, true);
    if (lobby.kind === 'waiting') lobby = { ...lobby, message: `${who} left. Your link still works: send it again.` };
  } else {
    // The host owns the room: when they leave, it closes for the guest.
    endOnline(`${who} left, so the match was closed.`);
  }
}

function leaveOnline() {
  room?.stop(); room = null;
  channel?.sendReliable({ t: 'bye' });
  channel?.close(); channel = null;
  disconnect?.(); disconnect = null;
  session = null;
  if (savedConfig) { Object.assign(config, savedConfig); savedConfig = null; }
}

/** Capture the mouse and hide the OS cursor while a match runs. */
function setPlaying(on: boolean) {
  menuOpen = false;
  kbm.lockEnabled = on;
  document.body.classList.toggle('playing', on);
  if (!on) document.exitPointerLock?.();
}

function toMenu(message?: string) {
  mode = 'lobby';
  setPlaying(false);
  lobby = menu(message);
}

function endOnline(message: string) {
  leaveOnline();
  mode = 'lobby';
  setPlaying(false);
  roomId = null;
  history.replaceState(null, '', location.pathname + location.search);
  lobby = menu(message);
}

// ---------------------------------------------------------------- matches

function startOnline(ch: Channel, localPlayer: number, seed: number) {
  matchSeed = seed;
  state = createGame({ seed });
  session = new RollbackSession(state, localPlayer, ch, config, { inputDelay: INPUT_DELAY });
  if (params.has('debug')) session.history = new Map();
  labels = [...names];
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
  names = ['Orange', 'Blue'];
  mode = 'practice';
  setPlaying(true);
  hud.hideJoin();
  handleEvents(state.events);
}

function handleEvents(events: SimEvent[]) {
  renderer.onEvents(events, state);
  sfx.play(events);
  for (const e of events) {
    if (e.type === 'roundStart') hud.flash(`ROUND ${e.round}`, '', 0.9);
    if (e.type === 'countdown') hud.flash(e.secondsLeft === 0 ? 'FIGHT' : String(e.secondsLeft), '', e.secondsLeft === 0 ? 0.6 : 0.9);
    // Practice names the colors ("ORANGE WINS"); online uses the players' names.
    const winner = names[('player' in e ? e.player : 0) as number]?.toUpperCase();
    if (e.type === 'roundWon') hud.flash(`${winner} WINS`, `${e.score[0]} - ${e.score[1]}`, 2);
    if (e.type === 'matchWon') hud.flash(`${winner} WINS THE MATCH`, '', 2.8); // the results card follows
  }
}

// Esc frees the mouse (browser pointer lock) and opens the menu; Resume captures it again.
const leaveMatch = () => (mode === 'online' ? endOnline('You left the match.') : toMenu());
let wasLocked = false;
document.addEventListener('pointerlockchange', () => {
  if (kbm.locked) menuOpen = false;
  else if (wasLocked && mode !== 'lobby') menuOpen = true;
  wasLocked = kbm.locked;
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && mode !== 'lobby' && !kbm.locked && !settingsUi.open) menuOpen = !menuOpen;
});
function onPause(id: string) {
  if (id === 'resume') { menuOpen = false; kbm.capture(); }
  else if (id === 'settings') settingsUi.show();
  else if (id === 'leave') leaveMatch();
}

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
    // Dev toggle: the dummy focuses straight ahead (along its spawn direction) and fires whenever its bolt is ready.
    const dummyCmd = settings.dummyFires === 'on'
      ? { ...emptyCommand(), aimActive: true, aim: state.arena.spawns[1].aim, ads: true, fire: state.tick % 2 === 0 }
      : emptyCommand();
    step(state, [cmd, dummyCmd]);
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
  const over = mode !== 'lobby' && state.phase === 'matchEnd' && state.slowmoTicks === 0;
  hud.setResults(over ? { names, state, rematch: mode === 'online' ? 'Either player presses Enter or Start for a rematch.' : 'Press Enter or Start to play again.' } : null);
  const paused = mode !== 'lobby' && menuOpen && !kbm.locked && !settingsUi.open;
  hud.setPause(paused ? { note: mode === 'online' ? 'The match keeps running while this menu is open.' : '', on: onPause } : null);
  settingsUi.setAvailable(mode === 'lobby');
  // The roll direction setting is a game rule; online matches run on the host's copy of the config.
  if (mode !== 'online') config.rollTowardCursor = settings.rollDirection === 'cursor' ? 1 : 0;
  updateNetHud();
  requestAnimationFrame(frame);
}

// Opening a match link asks for a name first, then joins.
const showInvite = () => { lobby = { kind: 'invite', name: myName, on: onLobby }; };
if (roomFromHash()) {
  // The creator reloading their own tab goes straight back to waiting.
  if (sessionStorage.getItem('snipefight:created') === roomFromHash() && !nameError(myName)) goOnline(roomFromHash()!, true);
  else showInvite();
}
window.addEventListener('hashchange', () => {
  if (roomFromHash() && mode === 'lobby' && !channel) showInvite();
});

// Tell the other player right away when this tab closes.
window.addEventListener('pagehide', () => channel?.sendReliable({ t: 'bye' }));

requestAnimationFrame(frame);

// Handle for automated smoke tests and debugging in the console.
(window as unknown as { __iso: unknown }).__iso = {
  get state() { return state; }, get mode() { return mode; }, get session() { return session; }, get lobby() { return lobby; }, get room() { return room; }, config, renderer, settings,
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
