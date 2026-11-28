import './style.css';
import { config, type Config } from './config';
import { BotBrain, type BotLevel } from './bot/brain';
import { createTuningPanel } from './dev/tuning';
import { KeyboardMouse } from './input/keyboardMouse';
import { InputManager } from './input/manager';
import { broadcastMesh, type Mesh } from './net/mesh';
import { FULL_MESSAGE, MatchLobby, type LobbyState, type MatchSetup } from './net/lobby';
import { cleanName, nameError } from './net/names';
import { RollbackSession } from './net/rollback';
import { decodeCommand } from './net/codec';
import { hashState } from './net/snapshot';
import { connectMesh } from './net/webrtc';
import { Sfx } from './render/audio';
import { AimCursor } from './render/cursor';
import { settings, SettingsUi } from './settings';
import { escapeHtml } from './net/names';
import { Hud, type LobbyView } from './render/hud';
import { PLAYER_COLORS } from './render/scene';
import { GameRenderer } from './render/scene';
import { createGame, step } from './sim/sim';
import { emptyCommand, MAX_PLAYERS, type Command, type GameState, type SimEvent } from './sim/types';

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
// `?delay=N` pins the input delay at N frames; by default it starts at 2 and rises with the ping (up to 4).
const FIXED_DELAY = params.has('delay') ? Number(params.get('delay')) : null;
const RELAYS = params.get('relay')?.split(','); // override the public Nostr relays (testing)

// `?bot` (or `?bot=easy|normal|hard`) turns this tab into a bot opponent: it joins the room in the
// link, readies up and plays with scripted AI through the real netcode. It draws no 3D scene.
const BOT = params.has('bot');
// Test and demo knobs for a bot tab: `&watch` draws the game as a player would see it (for recording),
// `&host=N` makes it create the room in the link and start once N players are in (`&fill` tops up with
// bots it plays itself), `&name=` names it. `?netstats` shows per-peer network numbers in any tab.
const WATCH = BOT && params.has('watch');
const BOT_HOST = BOT && params.has('host') ? Math.max(2, Math.min(MAX_PLAYERS, Number(params.get('host')) || MAX_PLAYERS)) : 0;
const NETSTATS = params.has('netstats') || WATCH;
const BOT_LEVELS: BotLevel[] = ['easy', 'normal', 'hard'];
const levelOf = (v: string | null): BotLevel => (BOT_LEVELS.includes(v as BotLevel) ? (v as BotLevel) : settings.botLevel);

type Mode = 'lobby' | 'practice' | 'online';
let mode: Mode = 'lobby';
const NAME_KEY = 'snipefight:name';
let myName = BOT ? (params.get('name') && !nameError(params.get('name')!) ? cleanName(params.get('name')!) : 'Claude Bot') : (() => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } })();
// The bot shares the player's browser storage when it runs in a popup: never overwrite their name.
const saveName = (n: string) => { myName = cleanName(n); if (BOT) return; try { localStorage.setItem(NAME_KEY, myName); } catch { /* not saved */ } };
type PracticeKind = 'dummy' | 'bot' | 'ffa';
let practiceKind: PracticeKind = 'dummy';
let lobby: LobbyView = { kind: 'menu', name: myName, on: onLobby };
let room: MatchLobby | null = null;
let roomId: string | null = null;
let roomMessage: string | undefined; // shown in the room, e.g. "Ann left"
let creator = false;
let names: string[] = ['Orange', 'Blue'];
/** Bots this browser plays: practice opponents, bots the host added online, and players the host replaced. */
let brains = new Map<number, BotBrain>();
let setup: MatchSetup | null = null;
const gone = new Set<string>(); // peers that left the current match
let dropsSeen = 0;
let menuOpen = false; // the Esc menu during a match
let state: GameState = createGame(); // rendered behind the lobby
let prev = state.players.map((p) => ({ x: p.x, z: p.z }));
let labels = ['P1', 'P2'];
let session: RollbackSession | null = null;
let matchSeed = 0;
let mesh: Mesh | null = null;
let acc = 0;
let last = performance.now();
// Rollback corrections are blended out over a few frames instead of snapping.
const offsets = Array.from({ length: MAX_PLAYERS }, () => ({ x: 0, z: 0 }));

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
      // A popup copies the opener's sessionStorage, so the bot would think it created the room.
      if (r) goOnline(r, !BOT && sessionStorage.getItem('snipefight:created') === r);
    }
  } else if (id === 'practice' || id === 'practicebot' || id === 'practiceffa') {
    if (value !== undefined && !nameError(value)) saveName(value);
    startPractice(id === 'practice' ? 'dummy' : id === 'practicebot' ? 'bot' : 'ffa');
  } else if (id === 'addbot' && room) {
    // The host's browser plays the bot; it needs no window or connection of its own.
    room.addBot(settings.botLevel);
  } else if (id === 'removebot' && room && value !== undefined) {
    room.removeBot(Number(value));
  } else if (id === 'copy' && lobby.kind === 'room' && roomId) {
    void navigator.clipboard?.writeText(linkFor(roomId)).catch(() => {});
    lobby = { ...lobby, copied: true };
  } else if (id === 'ready' && room && room.state.local !== null) {
    room.setReady(!room.state.slots[room.state.local]?.ready);
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
  const copied = lobby.kind === 'room' ? lobby.copied : false;
  return {
    kind: 'room', link: creator && roomId ? linkFor(roomId) : null, local: s.local, slots: s.slots, hostFound: s.hostFound,
    isHost: !!room?.isHost, canStart: !!room?.canStart, nameTaken: s.nameTaken, name: myName, copied, message: roomMessage, on: onLobby,
  };
}

function goOnline(r: string, isCreator: boolean, message?: string) {
  leaveOnline();
  roomId = r;
  creator = isCreator;
  roomMessage = message;
  mode = 'lobby';
  setPlaying(false);
  lobby = { kind: 'connecting', status: 'Connecting to the match…', on: onLobby };

  const m = LOCAL_NET ? broadcastMesh(r) : connectMesh(r, (status) => {
    if (status === 'full') endOnline(FULL_MESSAGE);
    else if (status === 'failed') endOnline('Could not connect directly to the other players (a strict network or firewall can block this). Try another network.');
  }, RELAYS);
  mesh = m;
  m.onPeerLeave((id) => peerLeft(id));
  // 'bye' arrives at once when someone leaves or closes the tab; the transport can take a while to notice a dead tab.
  m.onMessage((from, msg) => { if (msg.t === 'bye' && mesh === m) peerLeft(from); });
  room = new MatchLobby(m, { creator: isCreator, name: myName, config: { ...config } }, {
    onState: (st) => { if (mode === 'lobby' && room) lobby = st.hostFound ? roomView(st) : { kind: 'connecting', status: 'Looking for the match host…', on: onLobby }; },
    onStart: (s) => startOnline(s),
    onError: (why) => endOnline(why),
  });
}

/** Someone left the room or the match. */
function peerLeft(id: string) {
  if (gone.has(id) || !mesh) return;
  gone.add(id);
  if (mode !== 'online' || !session || !setup) { if (mode === 'lobby') gone.delete(id); return; } // the room handles it
  const who = setup.slots.find((s) => s.owner === id && !s.bot)?.name ?? 'A player';
  if (id === session.host) { endOnline(`${who} left, so the match was closed.`); return; }
  const humansLeft = new Set(setup.slots.filter((s) => !s.bot && !gone.has(s.owner)).map((s) => s.owner)).size;
  if (humansLeft >= 2) {
    // Everyone else plays on; the host's browser takes the empty seat with a bot.
    session.peerLeft(id);
    return;
  }
  // Only the host is left. Back to the room, where the link still works.
  if (creator && roomId) goOnline(roomId, true, `${who} left. Your link still works: send it again.`);
  else endOnline(`${who} left, so the match was closed.`);
}

function leaveOnline() {
  room?.close(); room = null;
  if (mesh) for (const p of mesh.peers()) mesh.sendReliable(p, { t: 'bye' });
  session?.stop();
  mesh?.close(); mesh = null;
  session = null;
  setup = null;
  gone.clear();
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

function startOnline(s: MatchSetup) {
  if (!mesh) return;
  setup = s;
  savedConfig = { ...config };
  Object.assign(config, s.config);
  names = s.slots.map((x) => x.name);
  matchSeed = s.seed;
  state = createGame({ seed: s.seed, players: s.slots.length });
  // With three or more people, one bad connection shouldn't hold everyone up: the host swaps them for a bot.
  const humans = new Set(s.slots.filter((x) => !x.bot).map((x) => x.owner)).size;
  const delay = FIXED_DELAY === null ? { inputDelay: 2, maxInputDelay: 4, maxSelfDelay: 7 } : { inputDelay: FIXED_DELAY, maxInputDelay: FIXED_DELAY, maxSelfDelay: FIXED_DELAY };
  session = new RollbackSession(state, { self: s.self, host: s.host, owners: s.slots.map((x) => x.owner), local: s.local }, mesh, config, { ...delay, dropLaggers: humans >= 3 });
  if (params.has('debug')) session.history = new Map();
  brains = new Map(s.slots.map((x, i) => [i, x] as const).filter(([, x]) => x.bot && x.owner === s.self).map(([i, x]) => [i, new BotBrain(x.bot!)]));
  if (BOT) brains.set(s.local, new BotBrain(levelOf(params.get('bot'))));
  dropsSeen = 0;
  labels = [...names];
  prev = state.players.map((p) => ({ x: p.x, z: p.z }));
  offsets.forEach((o) => { o.x = 0; o.z = 0; });
  mode = 'online';
  setPlaying(true);
  tuning.hide();
  hud.hideJoin();
  handleEvents(state.events);
}

const PRACTICE_LABELS: Record<PracticeKind, string[]> = { dummy: ['YOU', 'DUMMY'], bot: ['YOU', 'BOT'], ffa: ['YOU', 'BOT 1', 'BOT 2', 'BOT 3'] };

function startPractice(kind = practiceKind) {
  leaveOnline();
  practiceKind = kind;
  const players = kind === 'ffa' ? 4 : 2;
  state = createGame({ seed: (Math.random() * 2 ** 31) | 0, dummyP2: kind === 'dummy', players });
  brains = new Map();
  if (kind !== 'dummy') for (let i = 1; i < players; i++) brains.set(i, new BotBrain(settings.botLevel));
  prev = state.players.map((p) => ({ x: p.x, z: p.z }));
  labels = PRACTICE_LABELS[kind];
  names = kind === 'ffa' ? ['You', 'Bot 1', 'Bot 2', 'Bot 3'] : ['Orange', 'Blue'];
  mode = 'practice';
  setPlaying(true);
  hud.hideJoin();
  handleEvents(state.events);
}

const tag = (i: number) => `<b style="--c:#${PLAYER_COLORS[i].toString(16).padStart(6, '0')}">${escapeHtml(names[i] ?? '')}</b>`;

function handleEvents(events: SimEvent[]) {
  if (BOT && !WATCH) return; // the bot tab draws and plays nothing
  renderer.onEvents(events, state);
  sfx.play(events);
  const ffa = state.players.length > 2;
  for (const e of events) {
    if (e.type === 'roundStart') hud.flash(`ROUND ${e.round}`, '', 0.9);
    if (e.type === 'countdown') hud.flash(e.secondsLeft === 0 ? 'FIGHT' : String(e.secondsLeft), '', e.secondsLeft === 0 ? 0.6 : 0.9);
    // Practice names the colors ("ORANGE WINS"); online uses the players' names.
    const winner = names[('player' in e ? e.player : 0) as number]?.toUpperCase();
    if (e.type === 'eliminated' && ffa) hud.feed(`${tag(e.by)} eliminated ${tag(e.player)}`);
    if (e.type === 'roundWon') hud.flash(`${winner} WINS`, ffa ? 'LAST ONE STANDING' : `${e.score[0]} - ${e.score[1]}`, 2);
    if (e.type === 'matchWon') hud.flash(`${winner} WINS THE MATCH`, '', 2.8); // the results card follows
  }
}

/** Input for a bot seat this browser plays (a host-run bot, or a dropped player on the host). */
function botCommand(slot: number, s: GameState): Command {
  let b = brains.get(slot);
  if (!b) { b = new BotBrain(settings.botLevel); brains.set(slot, b); }
  return b.think(s, slot, config);
}

/** Watch for players the host replaced with a bot, and for being replaced ourselves. */
function checkDrops() {
  if (!session) return;
  if (session.stats.droppedSelf) { endOnline('Your connection fell too far behind the others, so a bot took over your player.'); return; }
  for (; dropsSeen < session.drops.length; dropsSeen++) {
    const [slot] = session.drops[dropsSeen];
    if (!BOT) hud.feed(`${tag(slot)} lost connection. A bot took over.`, 5);
    labels[slot] = `${names[slot]} (bot)`;
  }
}

// Esc frees the mouse (browser pointer lock) and opens the menu; Resume captures it again.
const leaveMatch = () => (mode === 'online' ? endOnline('You left the match.') : toMenu());
let wasLocked = false;
// Alt-tab (or any focus loss) also drops pointer lock. That isn't the player pressing Esc,
// so it doesn't open the menu: they just click back in to keep playing.
let blurAt = -1e9;
window.addEventListener('blur', () => { blurAt = performance.now(); });
document.addEventListener('pointerlockchange', () => {
  const lostFocus = !document.hasFocus() || document.hidden || performance.now() - blurAt < 500;
  if (kbm.locked) menuOpen = false;
  else if (wasLocked && mode !== 'lobby' && !lostFocus) menuOpen = true;
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
    const cmd = BOT ? botCommand(session.local, session.state) : input.command(me);
    // A hosting bot calls the rematch a few seconds after the results, so a stress test keeps going.
    if (BOT_HOST && session.state.phase === 'matchEnd' && session.state.slowmoTicks === 0) cmd.start = ++botResultsTicks > 5 * config.tickRate;
    else botResultsTicks = 0;
    input.endTick();
    const before = session.state.players.map((p) => ({ x: p.x, z: p.z }));
    const frameBefore = session.frame;
    const rollbacksBefore = session.stats.rollbacks;
    const sess = session;
    const events = session.tick(cmd, (slot) => botCommand(slot, sess.state));
    state = session.state;
    // A rollback can move a player between two rendered frames. Keep them
    // visually where they were and let the offset blend out.
    if (session.stats.rollbacks !== rollbacksBefore) {
      const from = session.frame > frameBefore ? session.prevPositions : state.players;
      from.forEach((p, i) => { offsets[i].x += before[i].x - p.x; offsets[i].z += before[i].z - p.z; });
    }
    prev = session.prevPositions;
    handleEvents(events);
    checkDrops();
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
    step(state, state.players.map((_, i) => (i === 0 ? cmd : brains.has(i) ? brains.get(i)!.think(state, i, config) : dummyCmd)));
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
  if (NETSTATS) {
    // Test overlay: this peer, then one line per other player.
    const owner = (id: string) => setup?.slots.findIndex((x) => x.owner === id && !x.bot) ?? -1;
    const lines = [`${names[session.local]} · frame ${session.frame} · delay ${s.inputDelay} · ${s.rollbacksPerSec} rollbacks/s (last ${s.rollbackFrames} f) · waited ${s.stalls} ticks${s.drops ? ` · ${s.drops} dropped` : ''}${s.desyncFrame !== null ? ` · DESYNC ${s.desyncFrame}` : ''}`];
    for (const p of session.peerStats()) lines.push(`↔ ${names[owner(p.id)] ?? p.id}: ${Math.round(p.rttMs)} ms`);
    hud.setNet(lines.join('\n'), s.desyncFrame !== null || s.stalled);
    return;
  }
  if (s.desyncFrame !== null) hud.setNet(`DESYNC at frame ${s.desyncFrame}. Please report this.`, true);
  else if (s.lastHeardMs > 1500) hud.setNet('Connection lost… waiting', true);
  else if (s.stalled) hud.setNet(`${Math.round(s.rttMs)} ms · waiting for ${s.waitingFor !== null ? names[s.waitingFor] : 'the others'}`, true);
  else hud.setNet(`${Math.round(s.rttMs)} ms`, s.rttMs > 150);
  if (s.lastHeardMs > 10000) endOnline('Lost connection to the other players.');
}

/** Run the fixed-tick sim up to `now`. Safe to call from more than one clock. */
function advance(now: number): number {
  // Online, a slow frame (a weak GPU, a busy machine) must not slow the sim: the others would
  // have to wait for us. Catch up on up to a quarter second of ticks per frame. Offline, a
  // hitch just drops time.
  const online = mode === 'online';
  const dt = Math.min(online ? 0.25 : 0.1, (now - last) / 1000);
  last = now;
  const TICK = 1 / config.tickRate;
  const maxSteps = online ? 15 : 5;
  acc += dt;
  let steps = 0;
  while (acc >= TICK && steps < maxSteps) { tick(); acc -= TICK; steps++; }
  if (steps === maxSteps) acc = 0;
  return dt;
}

let botResultsTicks = 0;

function frame(now: number) {
  if (BOT && !WATCH) { botFrame(now); requestAnimationFrame(frame); return; }
  const dt = advance(now);
  if (WATCH) botLobby(now);
  const TICK = 1 / config.tickRate;

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
  hud.setResults(over ? { names, state, rematch: mode === 'online' ? 'Anyone presses Enter or Start for a rematch.' : 'Press Enter or Start to play again.' } : null);
  const paused = mode !== 'lobby' && menuOpen && !kbm.locked && !settingsUi.open;
  hud.setPause(paused ? { note: mode === 'online' ? 'The match keeps running while this menu is open.' : '', on: onPause } : null);
  settingsUi.setAvailable(mode === 'lobby');
  // The roll direction setting is a game rule; online matches run on the host's copy of the config.
  if (mode !== 'online') config.rollTowardCursor = settings.rollDirection === 'cursor' ? 1 : 0;
  hud.setControlScheme(input.active === kbm ? 'kbm' : 'pad');
  updateNetHud();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- bot tab

let botStatusEl: HTMLElement | null = null;
let botMenuSince = 0;
let botRenames = 0;
let botRoomSince = 0;
// A hosting bot starts with whoever is there after `&wait=` seconds (default: wait for everyone).
const BOT_WAIT = params.has('wait') ? Number(params.get('wait')) * 1000 : Infinity;

/** The bot clicks through the lobby by itself and shows a one-line status instead of the game. */
function botFrame(now: number) {
  advance(now);
  botLobby(now);
  if (!botStatusEl) {
    botStatusEl = document.createElement('div');
    botStatusEl.className = 'bot-status';
    document.body.append(botStatusEl);
    document.body.classList.add('bot');
  }
  const text = mode === 'online'
    ? `${names[session?.local ?? 1]} in a ${state.players.length}-player match. Score ${state.score.join(' - ')}, round ${state.round}. Keep this window open.`
    : lobby.kind === 'menu' ? (lobby.message ?? 'Bot idle. Open a match link with ?bot to play.')
      : lobby.kind === 'connecting' ? lobby.status : 'Bot in the lobby, readying up…';
  if (botStatusEl.textContent !== text) botStatusEl.textContent = text;
}

function botLobby(now: number) {
  if (mode === 'lobby') {
    if (lobby.kind === 'invite') onLobby('join', myName);
    else if (lobby.kind === 'room') {
      const me = lobby.local !== null ? lobby.slots[lobby.local] : null;
      if (lobby.nameTaken) onLobby('rename', `Claude Bot ${++botRenames + 4}`);
      else if (!lobby.isHost && me?.name && !me.ready) onLobby('ready');
      else if (lobby.isHost && BOT_HOST && params.has('fill') && room && room.filled < BOT_HOST) onLobby('addbot');
      else if (lobby.isHost && lobby.canStart && ((room?.filled ?? 0) >= Math.max(2, BOT_HOST) || now - botRoomSince > BOT_WAIT)) onLobby('start');
    } else if (lobby.kind === 'menu') {
      // The match is over (the host left). A bot window this game opened closes itself.
      if (!botMenuSince) botMenuSince = now;
      if (now - botMenuSince > 2000 && window.opener) window.close();
    }
    if (lobby.kind !== 'menu') botMenuSince = 0;
    if (lobby.kind !== 'room') botRoomSince = now;
  }
}

if (BOT) {
  // Hidden or minimized windows pause requestAnimationFrame. A worker's timer keeps the bot
  // ticking so it doesn't freeze the match when its window is behind the game.
  const src = 'setInterval(() => postMessage(0), 8);';
  const ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  ticker.onmessage = () => { if (document.hidden) { if (WATCH) { advance(performance.now()); botLobby(performance.now()); } else botFrame(performance.now()); } };
}

// Opening a match link asks for a name first, then joins.
const showInvite = () => { lobby = { kind: 'invite', name: myName, on: onLobby }; };
if (roomFromHash() && BOT_HOST) goOnline(roomFromHash()!, true);
else if (roomFromHash()) {
  // The creator reloading their own tab goes straight back to waiting.
  if (!BOT && sessionStorage.getItem('snipefight:created') === roomFromHash() && !nameError(myName)) goOnline(roomFromHash()!, true);
  else showInvite();
}
window.addEventListener('hashchange', () => {
  if (roomFromHash() && mode === 'lobby' && !mesh) showInvite();
});

// Tell the others right away when this tab closes.
window.addEventListener('pagehide', () => { if (mesh) for (const p of mesh.peers()) mesh.sendReliable(p, { t: 'bye' }); });

requestAnimationFrame(frame);

// Handle for automated smoke tests and debugging in the console.
(window as unknown as { __iso: unknown }).__iso = {
  bot: BOT, get state() { return state; }, get names() { return names; }, get mesh() { return mesh; }, get mode() { return mode; }, get session() { return session; }, get lobby() { return lobby; }, get room() { return room; }, config, renderer, settings,
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
