import { config } from '../config';
import type { GameState } from '../sim/types';
import { escapeHtml, nameError, NAME_MAX } from '../net/names';
import { PLAYER_COLORS } from './scene';

type On = (id: string, value?: string) => void;
export type LobbyView =
  | { kind: 'menu'; name: string; message?: string; on: On }
  | { kind: 'invite'; name: string; message?: string; on: On } // opened someone's link
  | { kind: 'waiting'; link: string; copied: boolean; message?: string; on: On }
  | { kind: 'connecting'; status: string; on: On }
  | {
      kind: 'room'; link: string | null; local: number; names: [string | null, string | null]; ready: [boolean, boolean];
      isHost: boolean; canStart: boolean; nameTaken: boolean; name: string; copied: boolean; on: On;
    };

const CONTROLS: [string, string, string][] = [
  ['Move', 'WASD', 'Left stick'],
  ['Aim', 'Mouse', 'Right stick'],
  ['ADS', 'Hold right click', 'Hold LT'],
  ['Shoot', 'Left click', 'RT'],
  ['Sprint', 'Hold Shift', 'Hold LB'],
  ['Roll', 'Space', 'A'],
  // Roll, keep holding roll, and ADS as you land: kneel and charge the 2-damage shot.
  ['Empowered shot', 'Roll + hold Space + right click', 'Roll + hold A + LT'],
];

export type ControlScheme = 'kbm' | 'pad';

/** Controls for one scheme at a time, with tabs to switch. Both tables are in the DOM; `data-scheme` picks one. */
const controlsHtml = () => {
  const table = (scheme: ControlScheme, col: 1 | 2) => `<table data-for="${scheme}">
    ${CONTROLS.filter((r) => r[col]).map((r) => `<tr><td>${r[0]}</td><td><kbd>${r[col]}</kbd></td></tr>`).join('')}</table>`;
  return `<div class="controls-head"><h2>Controls</h2><div class="tabs" role="tablist">
      <button role="tab" data-scheme="kbm">Mouse &amp; keyboard</button><button role="tab" data-scheme="pad">Controller</button></div></div>
    ${table('kbm', 1)}${table('pad', 2)}`;
};

const SCHEME_KEY = 'snipefight:controls';

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
  private pause: HTMLElement;
  private lobbyWrap: HTMLElement;
  private pauseKey: string | null = null; // null = nothing rendered yet (a note of '' is a real value)
  private results: HTMLElement;
  private resultsKey = '';
  private lobbyKey = '';
  private scheme: ControlScheme = 'kbm';
  private schemePicked = false; // a tab click wins over following the last-used device
  private controlBoxes: HTMLElement[] = [];

  constructor(parent: HTMLElement) {
    try {
      const saved = localStorage.getItem(SCHEME_KEY);
      if (saved === 'kbm' || saved === 'pad') { this.scheme = saved; this.schemePicked = true; }
    } catch { /* no storage */ }
    this.root = el('div', 'hud', parent);
    this.score = el('div', 'score', this.root);
    this.banner = el('div', 'banner', this.root);
    this.sub = el('div', 'banner-sub', this.root);
    this.lobbyWrap = el('div', 'lobby-wrap', this.root);
    this.join = el('div', 'join', this.lobbyWrap);
    this.wireControls(el('div', 'controls', this.lobbyWrap));
    this.net = el('div', 'net', this.root);
    this.pause = el('div', 'pause', this.root);
    this.results = el('div', 'results', this.root);
    for (let i = 0; i < 2; i++) {
      const p = el('div', 'pips', this.root);
      p.style.setProperty('--c', hex(PLAYER_COLORS[i]));
      this.pips.push(p);
    }
  }

  /** The front screen: name, create a match link or join one, the ready-up room, or practice. */
  showLobby(view: LobbyView) {
    this.lobbyWrap.style.display = 'flex';
    this.join.classList.add('lobby');
    this.score.style.display = 'none';
    this.pips.forEach((p) => (p.style.display = 'none'));
    this.net.style.display = 'none';
    // Re-render only when something other than the typed name changes, so the text box keeps focus.
    const key = JSON.stringify(view, (k, v) => (typeof v === 'function' || k === 'name' ? undefined : v));
    if (key === this.lobbyKey) return;
    this.lobbyKey = key;
    const btn = (id: string, label: string, primary = false) => `<button data-id="${id}" class="${primary ? 'primary' : ''}">${label}</button>`;
    const nameBox = (name: string, action: string, label: string) => `
      <label class="name-label" for="name">Your name</label>
      <input id="name" class="name" maxlength="${NAME_MAX + 4}" autocomplete="nickname" spellcheck="false" placeholder="Type a name" value="${escapeHtml(name)}" data-action="${action}" />
      <p class="name-error"></p>${btn(action, label, true)}`;
    const linkBox = (link: string, copied: boolean) => `<div class="link"><input readonly value="${escapeHtml(link)}" />${btn('copy', copied ? 'Copied' : 'Copy', true)}</div>`;
    let body = '';
    if (view.kind === 'menu') {
      body = `${nameBox(view.name, 'create', 'Create online match')}${btn('practice', 'Practice')}${btn('practicebot', 'Practice vs bot')}
        ${view.message ? `<p class="hint warn">${escapeHtml(view.message)}</p>` : ''}`;
    } else if (view.kind === 'invite') {
      body = `<p class="hint invite">You've been invited to a match.</p>${nameBox(view.name, 'join', 'Join match')}${btn('cancel', 'Back')}
        ${view.message ? `<p class="hint warn">${escapeHtml(view.message)}</p>` : ''}`;
    } else if (view.kind === 'waiting') {
      body = `${view.message ? `<p class="hint warn">${escapeHtml(view.message)}</p>` : ''}<p class="hint">Send this link to your opponent:</p>${linkBox(view.link, view.copied)}
        <p class="status"><span class="wait">Waiting for your opponent to open the link…</span></p>
        ${btn('addbot', 'No one around? Add a bot')}${btn('cancel', 'Cancel')}`;
    } else if (view.kind === 'connecting') {
      body = `<p class="status"><span class="wait">${escapeHtml(view.status)}</span></p>${btn('cancel', 'Back')}`;
    } else {
      const slot = (i: number) => {
        const n = view.names[i];
        const you = i === view.local ? ' <em>(you)</em>' : '';
        const state = !n ? '<span class="wait">joining…</span>' : i === 0 ? '<span class="ok">HOST</span>'
          : view.ready[i] ? '<span class="ok">READY</span>' : '<span class="wait">not ready</span>';
        return `<div class="slot" style="--c:${hex(PLAYER_COLORS[i])}"><b>${n ? escapeHtml(n) : '…'}</b>${you}${state}</div>`;
      };
      const meReady = view.ready[view.local];
      let actions = '';
      if (view.nameTaken) {
        actions = `<p class="hint warn">Your opponent already uses that name. Pick another.</p>${nameBox(view.name, 'rename', 'Use this name')}`;
      } else {
        // The host is always ready and starts the match; the guest readies up.
        const guestReady = !!view.names[1] && view.ready[1];
        if (view.isHost) actions = `<button data-id="start" class="primary start" ${view.canStart ? '' : 'disabled'}>Start match</button>`;
        else actions = btn('ready', meReady ? 'Not ready' : 'Ready', !meReady);
        actions += `<p class="hint">${view.isHost
          ? (guestReady ? 'Your opponent is ready. Start when you like.' : view.names[1] ? 'Waiting for your opponent to ready up…' : 'Waiting for your opponent…')
          : (guestReady ? 'Waiting for the host to start…' : 'Ready up, then the host starts the match.')}</p>`;
      }
      body = `${slot(0)}${slot(1)}${actions}${view.link && !view.names[1] ? linkBox(view.link, view.copied) : ''}${btn('cancel', 'Leave')}`;
    }
    this.join.innerHTML = `<h1>SNIPEFIGHT</h1>${body}`;
    this.join.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((b) => b.addEventListener('click', () => {
      const name = this.join.querySelector<HTMLInputElement>('input.name')?.value;
      view.on(b.dataset.id!, name);
    }));
    this.join.querySelector<HTMLInputElement>('.link input')?.addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
    const input = this.join.querySelector<HTMLInputElement>('input.name');
    if (input) {
      const action = this.join.querySelector<HTMLButtonElement>(`button[data-id="${input.dataset.action}"]`)!;
      const err = this.join.querySelector<HTMLElement>('.name-error')!;
      const check = (showError: boolean) => {
        const e = nameError(input.value);
        action.disabled = !!e;
        err.textContent = showError && e && input.value.trim() ? e : '';
      };
      input.addEventListener('input', () => { check(true); view.on('name', input.value); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !action.disabled) action.click(); });
      check(false);
      if (!input.value) input.focus();
    }
  }

  /** End-of-match card: winner, final score and each player's stats. */
  setResults(r: { names: [string, string]; state: GameState; rematch: string } | null) {
    this.results.style.display = r ? 'flex' : 'none';
    if (!r) { this.resultsKey = ''; return; }
    const { stats, score } = r.state;
    const winner = score[0] > score[1] ? 0 : 1;
    const key = JSON.stringify([r.names, score, stats, r.rematch]);
    if (key === this.resultsKey) return;
    this.resultsKey = key;
    const pct = (i: number) => (stats.shots[i] ? `${Math.round((100 * stats.hits[i]) / stats.shots[i])}%` : '–');
    const col = (i: number) => `style="--c:${hex(PLAYER_COLORS[i])}"`;
    const row = (label: string, f: (i: number) => string, main = false) =>
      `<tr class="${main ? 'main' : ''}"><td ${col(0)}>${f(0)}</td><th>${label}</th><td ${col(1)}>${f(1)}</td></tr>`;
    this.results.innerHTML = `<div class="card">
      <p class="eyebrow">MATCH OVER</p>
      <h1 ${col(winner)}>${escapeHtml(r.names[winner].toUpperCase())} WINS</h1>
      <div class="final"><span ${col(0)}>${score[0]}</span><i>–</i><span ${col(1)}>${score[1]}</span></div>
      <table>
        <tr class="who"><td ${col(0)}>${escapeHtml(r.names[0])}</td><th></th><td ${col(1)}>${escapeHtml(r.names[1])}</td></tr>
        ${row('Accuracy', pct, true)}
        ${row('Shots landed', (i) => `${stats.hits[i]} / ${stats.shots[i]}`)}
        ${row('Empowered hits', (i) => String(stats.charged[i]))}
        ${row('Longest hit', (i) => (stats.hits[i] ? `${stats.longest[i].toFixed(1)} m` : '–'))}
      </table>
      <p class="hint">${escapeHtml(r.rematch)}</p></div>`;
  }

  /** The Esc menu: big and centered while the mouse is free during a match. */
  setPause(view: { note: string; on: (id: string) => void } | null) {
    this.pause.style.display = view ? 'flex' : 'none';
    if (!view) { this.pauseKey = null; return; }
    if (this.pauseKey === view.note) return;
    this.pauseKey = view.note;
    this.pause.innerHTML = `<div class="card"><h1>MENU</h1>${view.note ? `<p class="hint">${escapeHtml(view.note)}</p>` : ''}
      <button data-id="resume" class="primary">Resume</button><button data-id="settings">Settings</button><button data-id="leave">Leave match</button></div>
      <div class="controls"></div>`;
    this.wireControls(this.pause.querySelector<HTMLElement>('.controls')!);
    this.pause.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((b) => b.addEventListener('click', () => view.on(b.dataset.id!)));
  }

  private wireControls(box: HTMLElement) {
    box.innerHTML = controlsHtml();
    box.querySelectorAll<HTMLButtonElement>('[data-scheme]').forEach((b) => b.addEventListener('click', () => {
      this.schemePicked = true;
      try { localStorage.setItem(SCHEME_KEY, b.dataset.scheme!); } catch { /* not saved */ }
      this.setControlScheme(b.dataset.scheme as ControlScheme, true);
    }));
    this.controlBoxes = this.controlBoxes.filter((b) => b.isConnected).concat(box);
    this.applyScheme();
  }

  /**
   * Which controls to show. Follows the device used last (`manual` false)
   * until the player picks a tab; that choice is remembered.
   */
  setControlScheme(scheme: ControlScheme, manual = false) {
    if (!manual && this.schemePicked) return;
    if (scheme === this.scheme) return;
    this.scheme = scheme;
    this.applyScheme();
  }

  private applyScheme() {
    for (const box of this.controlBoxes) {
      box.dataset.scheme = this.scheme;
      box.querySelectorAll<HTMLButtonElement>('[data-scheme]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.scheme === this.scheme)));
    }
  }

  /** Ping and connection warnings during an online match. */
  setNet(text: string, warn = false) {
    this.net.style.display = text ? 'block' : 'none';
    this.net.textContent = text;
    this.net.classList.toggle('warn', warn);
  }

  hideJoin() {
    this.lobbyKey = '';
    this.lobbyWrap.style.display = 'none';
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
    this.score.innerHTML = `<div class="side" style="--c:${hex(PLAYER_COLORS[0])}">${escapeHtml(labels[0])} ${dots(state.score[0], PLAYER_COLORS[0])}</div>
      <div class="round">ROUND ${state.round}</div>
      <div class="side" style="--c:${hex(PLAYER_COLORS[1])}">${dots(state.score[1], PLAYER_COLORS[1])} ${escapeHtml(labels[1])}</div>`;

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
