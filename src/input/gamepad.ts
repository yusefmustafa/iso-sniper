import { emptyCommand, type Command } from '../sim/types';
import { screenToWorldDir, type InputDevice } from './devices';

// Standard Gamepad mapping (Xbox names / PlayStation names)
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11 };
const DEADZONE = 0.2;
const AIM_DEADZONE = 0.35;

/** Radial deadzone with rescale, so small stick drift is ignored but full range is kept. */
function stick(x: number, y: number, dz: number): { x: number; y: number; mag: number } {
  const m = Math.hypot(x, y);
  if (m < dz) return { x: 0, y: 0, mag: 0 };
  const scaled = Math.min(1, (m - dz) / (1 - dz));
  return { x: (x / m) * scaled, y: (y / m) * scaled, mag: scaled };
}

export class Gamepad implements InputDevice {
  readonly id: string;
  readonly label: string;
  private prevButtons: boolean[] = [];
  private nowButtons: boolean[] = [];
  private lastAim = 0;

  constructor(readonly index: number, name: string) {
    this.id = `pad:${index}`;
    this.label = name.toLowerCase().includes('playstation') || name.toLowerCase().includes('dualsense') || name.includes('054c')
      ? 'PlayStation controller' : 'Controller';
  }

  private pad(): globalThis.Gamepad | null {
    return navigator.getGamepads?.()[this.index] ?? null;
  }

  private read() {
    const p = this.pad();
    this.nowButtons = p ? p.buttons.map((b) => b.pressed || b.value > 0.5) : [];
    return p;
  }

  poll(): Command {
    const c = emptyCommand();
    const p = this.read();
    if (!p) return c;
    const l = stick(p.axes[0] ?? 0, p.axes[1] ?? 0, DEADZONE);
    const r = stick(p.axes[2] ?? 0, p.axes[3] ?? 0, AIM_DEADZONE);
    const move = screenToWorldDir(l.x, -l.y);
    c.moveX = move.x; c.moveZ = move.z;
    if (r.mag > 0) {
      const a = screenToWorldDir(r.x, -r.y);
      this.lastAim = Math.atan2(a.z, a.x);
      c.aimActive = true;
    }
    c.aim = this.lastAim;
    const b = (i: number) => this.nowButtons[i] ?? false;
    const trigger = (i: number, t: number) => (p.buttons[i]?.value ?? 0) > t || b(i);
    c.ads = trigger(BTN.LT, 0.3);
    c.fire = trigger(BTN.RT, 0.5);
    c.sprint = b(BTN.LB) || b(BTN.L3);
    c.roll = b(BTN.A);
    return c;
  }

  anyPressed() {
    this.read();
    return this.nowButtons.some((v, i) => v && !this.prevButtons[i]);
  }

  startPressed() {
    this.read();
    return !!this.nowButtons[BTN.START] && !this.prevButtons[BTN.START];
  }

  endTick() { this.prevButtons = this.nowButtons.slice(); }
}
