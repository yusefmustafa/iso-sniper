import './style.css';
import { config } from './config';
import { createTuningPanel } from './dev/tuning';
import { KeyboardMouse } from './input/keyboardMouse';
import { InputManager } from './input/manager';
import { Sfx } from './render/audio';
import { AimCursor } from './render/cursor';
import { Hud } from './render/hud';
import { GameRenderer } from './render/scene';
import { createGame, restartMatch, step } from './sim/sim';
import type { GameState, SimEvent } from './sim/types';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const renderer = new GameRenderer(canvas);
const kbm = new KeyboardMouse(canvas, renderer.screenToWorld);
const input = new InputManager(kbm);
const hud = new Hud(document.querySelector<HTMLElement>('#hud')!);
const sfx = new Sfx();
const cursor = new AimCursor(document.querySelector('#hud')!);
createTuningPanel();

for (const ev of ['keydown', 'mousedown', 'touchstart'] as const) window.addEventListener(ev, () => sfx.unlock());

let mode: 'join' | 'game' = 'join';
let state: GameState = createGame(); // rendered behind the join screen
let prev = state.players.map((p) => ({ x: p.x, z: p.z }));
let labels = ['P1', 'P2'];
let acc = 0;
let last = performance.now();

function start(dummy: boolean) {
  state = createGame({ seed: (Math.random() * 2 ** 31) | 0, dummyP2: dummy });
  prev = state.players.map((p) => ({ x: p.x, z: p.z }));
  labels = ['P1', dummy ? 'DUMMY' : 'P2'];
  mode = 'game';
  kbm.lockEnabled = true;
  document.body.classList.add('playing');
  hud.hideJoin();
  handleEvents(state.events);
}

function handleEvents(events: SimEvent[]) {
  renderer.onEvents(events, state);
  sfx.play(events);
  for (const e of events) {
    if (e.type === 'roundStart') hud.flash(`ROUND ${e.round}`, '', 0.9);
    if (e.type === 'countdown') hud.flash(e.secondsLeft === 0 ? 'DUEL' : String(e.secondsLeft), '', e.secondsLeft === 0 ? 0.6 : 0.9);
    if (e.type === 'roundWon') hud.flash(`${labels[e.player]} TAKES THE ROUND`, `${e.score[0]} - ${e.score[1]}`, 2);
    if (e.type === 'matchWon') hud.flash(`${labels[e.player]} WINS`, 'Press Enter or Start for a rematch', 9999);
  }
}

function tick() {
  if (mode === 'join') {
    input.tryJoin();
    const names = input.slots.map((d) => d?.label ?? null);
    hud.showJoin(names);
    if (input.slots[0] && input.slots[1]) start(false);
    else if (input.slots[0] && input.anyStart()) start(true);
    input.endTick();
    return;
  }
  if (state.phase === 'matchEnd' && input.anyStart()) {
    restartMatch(state);
    handleEvents(state.events);
  }
  prev = state.players.map((p) => ({ x: p.x, z: p.z }));
  const cmds = input.commands(state.players);
  step(state, cmds);
  input.endTick();
  handleEvents(state.events);
}

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const TICK = 1 / config.tickRate;
  const timeScale = mode === 'game' && state.slowmoTicks > 0 ? config.finalShotSlowmo : 1;
  acc += dt * timeScale;
  let steps = 0;
  while (acc >= TICK && steps < 5) { tick(); acc -= TICK; steps++; }
  if (steps === 5) acc = 0;

  renderer.render(state, prev, Math.min(1, acc / TICK), dt, state.hitstop > 0);
  if (mode === 'game') {
    const toScreen = (x: number, y: number, z: number) => renderer.worldToScreen(x, y, z);
    hud.update(state, toScreen, labels);
    const sources = input.slots.map((d) => (d ? { mouse: d === kbm ? kbm.cursor : null } : null));
    cursor.draw(state, renderer.positions, sources, toScreen, renderer.screenToWorld, dt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handle for automated smoke tests and debugging in the console.
(window as unknown as { __iso: unknown }).__iso = { get state() { return state; }, get mode() { return mode; }, config, renderer };
