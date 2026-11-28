import { config } from '../config';
import type { LobbySlot } from '../net/lobby';
import { MAX_PLAYERS, type GameState } from '../sim/types';
import { escapeHtml, nameError, NAME_MAX } from '../net/names';
import { PLAYER_COLORS } from './scene';

type On = (id: string, value?: string) => void;
export type LobbyView =
  | { kind: 'menu'; name: string; message?: string; on: On }
  | { kind: 'invite'; name: string; message?: string; on: On } // opened someone's link
  | { kind: 'connecting'; status: string; on: On }
  | {
      kind: 'room'; link: string | null; local: number | null; slots: (LobbySlot | null)[]; hostFound: boolean;
      isHost: boolean; canStart: boolean; nameTaken: boolean; name: string; copied: boolean; message?: string; on: On;
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
  private feedEl: HTMLElement;
  private scoreKey = '';

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
    this.feedEl = el('div', 'feed', this.root);
    for (let i = 0; i < MAX_PLAYERS; i++) {
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
      body = `${nameBox(view.name, 'create', 'Create online match')}${btn('practice', 'Practice')}${btn('practicebot', 'Practice vs bot')}${btn('practiceffa', 'Practice free-for-all (3 bots)')}
        ${view.message ? `<p class="hint warn">${escapeHtml(view.message)}</p>` : ''}`;
    } else if (view.kind === 'invite') {
      body = `<p class="hint invite">You've been invited to a match.</p>${nameBox(view.name, 'join', 'Join match')}${btn('cancel', 'Back')}
        ${view.message ? `<p class="hint warn">${escapeHtml(view.message)}</p>` : ''}`;
    } else if (view.kind === 'connecting') {
      body = `<p class="status"><span class="wait">${escapeHtml(view.status)}</span></p>${btn('cancel', 'Back')}`;
    } else {
      const filled = view.slots.filter(Boolean).length;
      const slot = (i: number) => {
        const s = view.slots[i];
        if (!s) return `<div class="slot open" style="--c:${hex(PLAYER_COLORS[i])}"><b>Open seat</b><span class="wait"></span></div>`;
        const you = i === view.local ? ' <em>(you)</em>' : '';
        const level = s.bot ? ` <em>${s.bot}</em>` : '';
        const state = !s.name ? '<span class="wait">joining…</span>' : i === 0 ? '<span class="ok">HOST</span>'
          : s.bot ? '<span class="ok">BOT</span>' : !s.linked ? '<span class="wait">connecting…</span>'
          : s.ready ? '<span class="ok">READY</span>' : '<span class="wait">not ready</span>';
        const remove = view.isHost && s.bot ? `<button class="x" data-id="removebot" data-slot="${i}" title="Remove bot" aria-label="Remove bot">✕</button>` : '';
        return `<div class="slot" style="--c:${hex(PLAYER_COLORS[i])}"><b>${s.name ? escapeHtml(s.name) : '…'}</b>${you}${level}${state}${remove}</div>`;
      };
      const me = view.local !== null ? view.slots[view.local] : null;
      let actions = '';
      if (!view.hostFound) {
        actions = '<p class="status"><span class="wait">Looking for the host…</span></p>';
      } else if (view.nameTaken) {
        actions = `<p class="hint warn">Someone in this match already uses that name. Pick another.</p>${nameBox(view.name, 'rename', 'Use this name')}`;
      } else if (view.isHost) {
        // The host is always ready and starts the match; guests ready up.
        const waiting = view.slots.filter((s, i) => s && i > 0 && !s.bot && (!s.ready || !s.linked)).length;
        actions = `<button data-id="start" class="primary start" ${view.canStart ? '' : 'disabled'}>Start match</button>`;
        actions += `<p class="hint">${filled < 2 ? 'Send the link to up to three friends, or add bots.'
          : waiting ? `Waiting for ${waiting === 1 ? 'a player' : `${waiting} players`} to ready up…` : 'Everyone is ready. Start when you like.'}</p>`;
        if (filled < MAX_PLAYERS) actions += btn('addbot', filled < 2 ? 'No one around? Add a bot' : 'Add a bot');
      } else if (me) {
        actions = btn('ready', me.ready ? 'Not ready' : 'Ready', !me.ready);
        actions += `<p class="hint">${me.ready ? 'Waiting for the host to start…' : 'Ready up, then the host starts the match.'}</p>`;
      }
      const link = view.link && filled < MAX_PLAYERS ? `<p class="hint">Send this link (up to 4 players):</p>${linkBox(view.link, view.copied)}` : '';
      body = `${view.message ? `<p class="hint warn">${escapeHtml(view.message)}</p>` : ''}${view.slots.map((_, i) => slot(i)).join('')}${actions}${link}${btn('cancel', 'Leave')}`;
    }
    this.join.innerHTML = `<h1>SNIPEFIGHT</h1>${body}`;
    this.join.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((b) => b.addEventListener('click', () => {
      const name = this.join.querySelector<HTMLInputElement>('input.name')?.value;
      view.on(b.dataset.id!, b.dataset.slot ?? name);
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
  setResults(r: { names: string[]; state: GameState; rematch: string } | null) {
    this.results.style.display = r ? 'flex' : 'none';
    if (!r) { this.resultsKey = ''; return; }
    const { stats, score } = r.state;
    const n = score.length;
    const winner = score.indexOf(Math.max(...score));
    const key = JSON.stringify([r.names, score, stats, r.rematch]);
    if (key === this.resultsKey) return;
    this.resultsKey = key;
    const pct = (i: number) => (stats.shots[i] ? `${Math.round((100 * stats.hits[i]) / stats.shots[i])}%` : '–');
    const col = (i: number) => `style="--c:${hex(PLAYER_COLORS[i])}"`;
    const rows: [string, (i: number) => string, boolean?][] = [
      ['Accuracy', pct, true],
      ['Shots landed', (i) => `${stats.hits[i]} / ${stats.shots[i]}`],
      ['Empowered hits', (i) => String(stats.charged[i])],
      ['Longest hit', (i) => (stats.hits[i] ? `${stats.longest[i].toFixed(1)} m` : '–')],
    ];
    let table: string;
    if (n === 2) {
      const row = ([label, f, main]: (typeof rows)[number]) =>
        `<tr class="${main ? 'main' : ''}"><td ${col(0)}>${f(0)}</td><th>${label}</th><td ${col(1)}>${f(1)}</td></tr>`;
      table = `<table>
        <tr class="who"><td ${col(0)}>${escapeHtml(r.names[0])}</td><th></th><td ${col(1)}>${escapeHtml(r.names[1])}</td></tr>
        ${rows.map(row).join('')}</table>`;
    } else {
      // Free-for-all: one column per player, best first.
      const order = [...score.keys()].sort((a, b) => score[b] - score[a] || stats.kills[b] - stats.kills[a]);
      const ffaRows: (typeof rows) = [['Rounds won', (i) => String(score[i]), true], ['Eliminations', (i) => String(stats.kills[i])], ...rows.slice(0, 1).map(([l, f]) => [l, f] as (typeof rows)[number]), ...rows.slice(1)];
      table = `<table class="ffa">
        <tr class="who"><th></th>${order.map((i) => `<td ${col(i)}>${escapeHtml(r.names[i])}</td>`).join('')}</tr>
        ${ffaRows.map(([label, f, main]) => `<tr class="${main ? 'main' : ''}"><th>${label}</th>${order.map((i) => `<td ${col(i)}>${f(i)}</td>`).join('')}</tr>`).join('')}</table>`;
    }
    this.results.innerHTML = `<div class="card${n > 2 ? ' wide' : ''}">
      <p class="eyebrow">MATCH OVER</p>
      <h1 ${col(winner)}>${escapeHtml(r.names[winner].toUpperCase())} WINS</h1>
      ${n === 2 ? `<div class="final"><span ${col(0)}>${score[0]}</span><i>–</i><span ${col(1)}>${score[1]}</span></div>` : ''}
      ${table}
      <p class="hint">${escapeHtml(r.rematch)}</p></div>`;
  }

  /** A short line in the corner when someone is knocked out of a free-for-all round. */
  feed(html: string, seconds = 3.5) {
    const line = el('div', 'line', this.feedEl);
    line.innerHTML = html;
    setTimeout(() => line.classList.add('out'), seconds * 1000);
    setTimeout(() => line.remove(), seconds * 1000 + 400);
    while (this.feedEl.children.length > 4) this.feedEl.firstElementChild!.remove();
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
    this.net.classList.toggle('stats', text.includes('\n'));
    this.net.textContent = text;
    this.net.classList.toggle('warn', warn);
  }

  hideJoin() {
    this.lobbyKey = '';
    this.scoreKey = '';
    this.feedEl.replaceChildren();
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
    // Players on the left show name then dots; on the right, dots then name. A duel is one each side.
    const n = state.players.length, half = Math.ceil(n / 2);
    const side = (i: number, right: boolean) => `<div class="side" style="--c:${hex(PLAYER_COLORS[i])}">${right
      ? `${dots(state.score[i], PLAYER_COLORS[i])} <span class="name">${escapeHtml(labels[i] ?? '')}</span>` : `<span class="name">${escapeHtml(labels[i] ?? '')}</span> ${dots(state.score[i], PLAYER_COLORS[i])}`}</div>`;
    const html = `${state.players.slice(0, half).map((p) => side(p.id, false)).join('')}<div class="round">ROUND ${state.round}</div>${state.players.slice(half).map((p) => side(p.id, true)).join('')}`;
    if (this.scoreKey !== html) { this.scoreKey = html; this.score.innerHTML = html; }
    this.score.classList.toggle('many', n > 2);

    this.pips.forEach((el, i) => { if (i >= n) el.style.display = 'none'; });
    state.players.forEach((p, i) => {
      const s = toScreen(p.x, 2.2, p.z);
      const el = this.pips[i];
      // Someone knocked out of a free-for-all round has no body to hang pips over.
      el.style.display = p.hp > 0 || n === 2 ? 'flex' : 'none';
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
