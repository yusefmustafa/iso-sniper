/**
 * Player preferences (display only, never sent to the sim or the other player).
 * Saved in this browser's localStorage when it is available.
 */
export interface Settings {
  /** 'cursor': the hip-fire cone ends at the cursor. 'full': it runs on to the first wall, as the bullet does. */
  coneLength: 'cursor' | 'full';
  /** With the full cone (which always runs to the arena edge): grey out the part behind cover, or color all of it. */
  coneWalls: 'stop' | 'hatch' | 'cut' | 'percent' | 'through';
  /** Where the body faces while sprinting: snaps to the run direction, turns toward it, or keeps facing the cursor. */
  sprintFacing: 'snap' | 'turn' | 'aim';
  /** How the rifle is carried while sprinting. */
  sprintCarry: 'port' | 'low' | 'onehand';
  /**
   * Roll toward the move direction or the cursor. This one is a game rule: it is
   * copied into the sim config (online, the host's choice is used for both players).
   */
  rollDirection: 'move' | 'cursor';
  /** Practice only: the dummy shoots straight ahead, to test getting hit. */
  dummyFires: 'off' | 'on';
  /** How well the bot plays (Practice vs bot, and a bot added to an online room). */
  botLevel: 'easy' | 'normal' | 'hard';
}

const KEY = 'snipefight:settings:v4'; // bumped when a default changes (v2 full cone, v3 low-ready sprint, v4 cut cone)
const OLD_KEY = 'iso-sniper:settings:v4'; // key from before the rename, read so saved settings carry over
const defaults: Settings = { coneLength: 'full', coneWalls: 'cut', sprintFacing: 'turn', sprintCarry: 'low', rollDirection: 'move', dummyFires: 'off', botLevel: 'normal' };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* storage unavailable: use defaults */ }
  return { ...defaults };
}

export const settings: Settings = load();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* not saved, still applies this session */ }
}

interface Choice<K extends keyof Settings> { key: K; label: string; hint: string; dev?: boolean; options: { value: Settings[K]; label: string }[] }

const choices: Choice<keyof Settings>[] = [
  {
    key: 'coneLength', label: 'Hip-fire cone',
    hint: 'Hip shots can land anywhere inside the cone, all the way to the wall.',
    options: [{ value: 'full', label: 'Full range' }, { value: 'cursor', label: 'Stop at cursor' }],
  },
  {
    key: 'botLevel', label: 'Bot difficulty',
    hint: 'For Practice vs bot and for a bot you add to an online match.',
    options: [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }],
  },
  {
    key: 'coneWalls', label: 'Cone behind cover', dev: true,
    hint: 'How the part of the cone that cover blocks is drawn.',
    options: [
      { value: 'stop', label: 'A: Grey' }, { value: 'hatch', label: 'B: Red hatch' }, { value: 'cut', label: 'C: Cut + edge' },
      { value: 'percent', label: 'D: % clear' }, { value: 'through', label: 'Ignore cover' },
    ],
  },
  {
    key: 'rollDirection', label: 'Roll direction', dev: true,
    hint: 'Game rule. Online, the match creator\'s choice applies to both players.',
    options: [{ value: 'move', label: 'Where I move' }, { value: 'cursor', label: 'Toward cursor' }],
  },
  {
    key: 'dummyFires', label: 'Dummy shoots', dev: true,
    hint: 'Practice: the dummy aims straight ahead and fires whenever it can. Step into its laser to test getting hit.',
    options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }],
  },
  {
    key: 'sprintFacing', label: 'Sprint facing', dev: true,
    hint: 'Where your body points while sprinting (look only).',
    options: [{ value: 'snap', label: 'Snap' }, { value: 'turn', label: 'Turn' }, { value: 'aim', label: 'Cursor' }],
  },
  {
    key: 'sprintCarry', label: 'Sprint rifle carry', dev: true,
    hint: 'How the rifle is held while sprinting (look only).',
    options: [{ value: 'port', label: 'Across chest' }, { value: 'low', label: 'Low ready' }, { value: 'onehand', label: 'One hand' }],
  },
];

/** A Settings button (shown while the mouse is free) and its panel. */
export class SettingsUi {
  private button: HTMLButtonElement;
  private panel: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.button = document.createElement('button');
    this.button.className = 'settings-btn';
    this.button.textContent = 'Settings';
    this.button.addEventListener('click', () => this.toggle(true));
    this.panel = document.createElement('div');
    this.panel.className = 'settings-panel';
    this.panel.hidden = true;
    parent.append(this.button, this.panel);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') this.toggle(false);
      // F2 opens the panel any time, even mid-match (it frees the mouse).
      if (e.code === 'F2') {
        e.preventDefault();
        if (this.panel.hidden) document.exitPointerLock?.();
        this.toggle(this.panel.hidden);
      }
    });
    this.render();
  }

  get open() { return !this.panel.hidden; }

  show() { this.toggle(true); }

    /** The corner button shows on the front screen; during a match Settings is in the Esc menu. */
  setAvailable(on: boolean) {
    this.button.style.display = on && this.panel.hidden ? 'block' : 'none';
  }

  private toggle(open: boolean) {
    this.panel.hidden = !open;
    if (open) this.render();
  }

  private render() {
    const row = (c: Choice<keyof Settings>) => `
      <div class="row"><div class="label">${c.label}<small>${c.hint}</small></div>
        <div class="seg">${c.options.map((o) => `<button data-key="${c.key}" data-value="${o.value}" class="${settings[c.key] === o.value ? 'on' : ''}">${o.label}</button>`).join('')}</div>
      </div>`;
    const rows = (dev: boolean) => choices.filter((c) => !!c.dev === dev).map(row).join('');
    this.panel.innerHTML = `<h2>Settings</h2>${rows(false)}
      <h3>Dev: feel testing<small>Changes apply instantly. F2 opens this mid-match. For the numbers, press \` for the tuning panel.</small></h3>${rows(true)}
      <button class="done">Done</button>`;
    this.panel.querySelectorAll<HTMLButtonElement>('button[data-key]').forEach((b) => b.addEventListener('click', () => {
      (settings as unknown as Record<string, string>)[b.dataset.key!] = b.dataset.value!;
      save();
      this.render();
    }));
    this.panel.querySelector('.done')!.addEventListener('click', () => this.toggle(false));
  }
}
