import type { Command } from '../sim/types';
import type { InputDevice } from './devices';
import { Gamepad } from './gamepad';
import { KeyboardMouse } from './keyboardMouse';

/**
 * One local player. Keyboard + mouse and any connected controller all work;
 * whichever was touched last drives the player.
 */
export class InputManager {
  readonly kbm: KeyboardMouse;
  private pads = new Map<number, Gamepad>();
  active: InputDevice;

  constructor(kbm: KeyboardMouse) {
    this.kbm = kbm;
    this.active = kbm;
    window.addEventListener('gamepadconnected', (e) => this.addPad(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => {
      const pad = this.pads.get(e.gamepad.index);
      this.pads.delete(e.gamepad.index);
      if (this.active === pad) this.active = this.kbm;
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

  anyStart(): boolean {
    return this.devices.some((d) => d.startPressed());
  }

  command(position: { x: number; z: number }): Command {
    for (const d of this.devices) if (d !== this.active && d.anyPressed()) this.active = d;
    const c = this.active.poll(position);
    c.start = this.anyStart();
    return c;
  }

  endTick() {
    for (const d of this.devices) d.endTick();
  }
}
