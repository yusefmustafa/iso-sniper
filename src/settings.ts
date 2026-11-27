/**
 * Player preferences (display only, never sent to the sim or the other player).
 * Saved in this browser's localStorage when it is available.
 */
export interface Settings {
  /** 'cursor': the hip-fire cone ends at the cursor. 'full': it runs on to the first wall, as the bullet does. */
  coneLength: 'cursor' | 'full';
}

const KEY = 'iso-sniper:settings';
const defaults: Settings = { coneLength: 'cursor' };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* storage unavailable: use defaults */ }
  return { ...defaults };
}

export const settings: Settings = load();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* not saved, still applies this session */ }
}

interface Choice<K extends keyof Settings> { key: K; label: string; hint: string; options: { value: Settings[K]; label: string }[] }

const choices: Choice<keyof Settings>[] = [
  {
    key: 'coneLength', label: 'Hip-fire cone',
    hint: 'Hip shots can land anywhere inside the cone, all the way to the wall.',
    options: [{ value: 'cursor', label: 'Stop at cursor' }, { value: 'full', label: 'Full range' }],
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
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape') this.toggle(false); });
    this.render();
  }

  get open() { return !this.panel.hidden; }

  /** Show the button only while the mouse is free (lobby, or Esc during a match). */
  setAvailable(on: boolean) {
    this.button.style.display = on && this.panel.hidden ? 'block' : 'none';
    if (!on) this.toggle(false);
  }

  private toggle(open: boolean) {
    this.panel.hidden = !open;
    if (open) this.render();
  }

  private render() {
    const rows = choices.map((c) => `
      <div class="row"><div class="label">${c.label}<small>${c.hint}</small></div>
        <div class="seg">${c.options.map((o) => `<button data-key="${c.key}" data-value="${o.value}" class="${settings[c.key] === o.value ? 'on' : ''}">${o.label}</button>`).join('')}</div>
      </div>`).join('');
    this.panel.innerHTML = `<h2>Settings</h2>${rows}<button class="done">Done</button>`;
    this.panel.querySelectorAll<HTMLButtonElement>('button[data-key]').forEach((b) => b.addEventListener('click', () => {
      (settings as unknown as Record<string, string>)[b.dataset.key!] = b.dataset.value!;
      save();
      this.render();
    }));
    this.panel.querySelector('.done')!.addEventListener('click', () => this.toggle(false));
  }
}
