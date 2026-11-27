import { emptyCommand, type Command } from '../sim/types';
import type { InputDevice } from './devices';
import { Gamepad } from './gamepad';
import { KeyboardMouse } from './keyboardMouse';

/**
 * Tracks connected devices and which player slot each one controls.
 * The first device to press a button becomes P1, the next P2.
 */
export class InputManager {
  readonly kbm: KeyboardMouse;
  private pads = new Map<number, Gamepad>();
  slots: (InputDevice | null)[] = [null, null];

  constructor(kbm: KeyboardMouse) {
    this.kbm = kbm;
    window.addEventListener('gamepadconnected', (e) => this.addPad(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => {
      const pad = this.pads.get(e.gamepad.index);
      this.pads.delete(e.gamepad.index);
      this.slots = this.slots.map((s) => (s === pad ? null : s));
    });
  }

  private addPad(gp: globalThis.Gamepad) {
    if (!this.pads.has(gp.index)) this.pads.set(gp.index, new Gamepad(gp.index, gp.id));
  }

  get devices(): InputDevice[] {
    // Some browsers only fire gamepadconnected after a press; poll as a fallback.
    for (const gp of navigator.getGamepads?.() ?? []) if (gp) this.addPad(gp);
    return [this.kbm, ...this.pads.values()];
  }

  /** Join any unassigned device that pressed something. Returns the slot that just joined, if any. */
  tryJoin(): number | null {
    for (const d of this.devices) {
      if (this.slots.includes(d) || !d.anyPressed()) continue;
      const free = this.slots.indexOf(null);
      if (free === -1) return null;
      this.slots[free] = d;
      return free;
    }
    return null;
  }

  anyStart(): boolean {
    return this.devices.some((d) => d.startPressed());
  }

  commands(positions: { x: number; z: number }[]): Command[] {
    return this.slots.map((d, i) => (d ? d.poll(positions[i]) : emptyCommand()));
  }

  endTick() {
    for (const d of this.devices) d.endTick();
  }
}
