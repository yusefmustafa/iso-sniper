import { config } from '../config';
import type { GameState } from '../sim/types';
import { PLAYER_COLORS } from './scene';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** DOM overlay: score, banners, join screen, HP pips over heads. */
export class Hud {
  private root: HTMLElement;
  private score: HTMLElement;
  private banner: HTMLElement;
  private sub: HTMLElement;
  private join: HTMLElement;
  private pips: HTMLElement[] = [];
  private bannerUntil = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.score = el('div', 'score', this.root);
    this.banner = el('div', 'banner', this.root);
    this.sub = el('div', 'banner-sub', this.root);
    this.join = el('div', 'join', this.root);
    for (let i = 0; i < 2; i++) {
      const p = el('div', 'pips', this.root);
      p.style.setProperty('--c', hex(PLAYER_COLORS[i]));
      this.pips.push(p);
    }
    el('div', 'help', this.root).innerHTML =
      'WASD move · Mouse aim · RMB focus · LMB shoot · Shift sprint · Space roll · F fullscreen · Esc free mouse &nbsp;|&nbsp; Pad: LS move · RS aim · LT focus · RT shoot · LB sprint · A roll &nbsp;|&nbsp; ` tuning';
  }

  showJoin(slots: (string | null)[]) {
    this.join.style.display = 'block';
    this.score.style.display = 'none';
    this.pips.forEach((p) => (p.style.display = 'none'));
    const row = (i: number) => {
      const c = hex(PLAYER_COLORS[i]);
      return `<div class="slot" style="--c:${c}"><b>P${i + 1}</b> ${slots[i] ? `${slots[i]} <span class="ok">ready</span>` : '<span class="wait">press any button</span>'}</div>`;
    };
    this.join.innerHTML = `<h1>ISO SNIPERS</h1><p class="tag">First playable · couch 1v1</p>${row(0)}${row(1)}
      <p class="hint">${slots[0] && !slots[1] ? 'Solo? Press <b>Enter</b> or <b>Start</b> to practice against a dummy.' : 'Keyboard + mouse and controllers can mix freely.'}</p>`;
  }

  hideJoin() {
    this.join.style.display = 'none';
    this.score.style.display = 'flex';
  }

  flash(text: string, sub = '', seconds = 1.2, now = performance.now()) {
    this.banner.textContent = text;
    this.sub.textContent = sub;
    this.banner.classList.remove('pop'); void this.banner.offsetWidth; this.banner.classList.add('pop');
    this.bannerUntil = now + seconds * 1000;
  }

  update(state: GameState, toScreen: (x: number, y: number, z: number) => { x: number; y: number }, labels: string[]) {
    const now = performance.now();
    const visible = now < this.bannerUntil;
    this.banner.style.opacity = this.sub.style.opacity = visible ? '1' : '0';

    const dots = (n: number, c: number) => Array.from({ length: config.roundsToWin }, (_, i) =>
      `<span class="dot" style="--c:${hex(c)}" data-on="${i < n}"></span>`).join('');
    this.score.innerHTML = `<div class="side" style="--c:${hex(PLAYER_COLORS[0])}">${labels[0]} ${dots(state.score[0], PLAYER_COLORS[0])}</div>
      <div class="round">ROUND ${state.round}</div>
      <div class="side" style="--c:${hex(PLAYER_COLORS[1])}">${dots(state.score[1], PLAYER_COLORS[1])} ${labels[1]}</div>`;

    state.players.forEach((p, i) => {
      const s = toScreen(p.x, 2.2, p.z);
      const el = this.pips[i];
      el.style.display = 'flex';
      el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
      const html = Array.from({ length: config.maxHp }, (_, h) => `<span data-on="${h < p.hp}"></span>`).join('');
      if (el.innerHTML !== html) el.innerHTML = html;
    });
  }
}

function el(tag: string, cls: string, parent: HTMLElement) {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}
