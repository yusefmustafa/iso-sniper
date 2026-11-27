import { config } from '../config';
import type { GameState } from '../sim/types';
import { PLAYER_COLORS } from './scene';

export type LobbyView =
  | { kind: 'menu'; message?: string; on: (id: string) => void }
  | { kind: 'waiting'; link: string; status: string; copied: boolean; on: (id: string) => void }
  | { kind: 'connecting'; status: string; on: (id: string) => void };

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
  private net: HTMLElement;
  private leave: HTMLElement;
  private lobbyKey = '';

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.score = el('div', 'score', this.root);
    this.banner = el('div', 'banner', this.root);
    this.sub = el('div', 'banner-sub', this.root);
    this.join = el('div', 'join', this.root);
    this.net = el('div', 'net', this.root);
    this.leave = el('button', 'leave', this.root);
    this.leave.textContent = 'Leave match';
    for (let i = 0; i < 2; i++) {
      const p = el('div', 'pips', this.root);
      p.style.setProperty('--c', hex(PLAYER_COLORS[i]));
      this.pips.push(p);
    }
    el('div', 'help', this.root).innerHTML =
      'WASD move · Mouse aim · RMB focus · LMB shoot · Shift sprint · Space roll · F fullscreen · Esc free mouse &nbsp;|&nbsp; Pad: LS move · RS aim · LT focus · RT shoot · LB sprint · A roll &nbsp;|&nbsp; ` tuning (practice)';
  }

  /** The front screen: create a match link, join one, or practice. */
  showLobby(view: LobbyView) {
    this.join.style.display = 'block';
    this.join.classList.add('lobby');
    this.score.style.display = 'none';
    this.pips.forEach((p) => (p.style.display = 'none'));
    this.net.style.display = 'none';
    const key = JSON.stringify(view, (_k, v) => (typeof v === 'function' ? undefined : v));
    if (key === this.lobbyKey) return;
    this.lobbyKey = key;
    const btn = (id: string, label: string, primary = false) => `<button data-id="${id}" class="${primary ? 'primary' : ''}">${label}</button>`;
    let body = '';
    if (view.kind === 'menu') {
      body = `${btn('create', 'Create online match', true)}${btn('practice', 'Practice vs dummy')}
        ${view.message ? `<p class="hint warn">${view.message}</p>` : '<p class="hint">Create a match and send the link to a friend. They click it and you duel.</p>'}`;
    } else if (view.kind === 'waiting') {
      body = `<p class="hint">Send this link to your opponent:</p>
        <div class="link"><input readonly value="${view.link}" />${btn('copy', view.copied ? 'Copied' : 'Copy', true)}</div>
        <p class="status"><span class="wait">${view.status}</span></p>${btn('cancel', 'Cancel')}`;
    } else {
      body = `<p class="status"><span class="wait">${view.status}</span></p>${btn('cancel', 'Back')}`;
    }
    this.join.innerHTML = `<h1>SNIPEFIGHT</h1><p class="tag">Online 1v1 sniper duels</p>${body}`;
    this.join.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => view.on(b.dataset.id!)));
    this.join.querySelector<HTMLInputElement>('input')?.addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
  }

  /** "Leave match" button, shown while the mouse is free (Esc) during a match. */
  setLeave(visible: boolean, onLeave: () => void) {
    this.leave.style.display = visible ? 'block' : 'none';
    this.leave.onclick = onLeave;
  }

  /** Ping and connection warnings during an online match. */
  setNet(text: string, warn = false) {
    this.net.style.display = text ? 'block' : 'none';
    this.net.textContent = text;
    this.net.classList.toggle('warn', warn);
  }

  hideJoin() {
    this.lobbyKey = '';
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
