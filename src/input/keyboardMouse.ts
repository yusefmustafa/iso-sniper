import { emptyCommand, type Command } from '../sim/types';
import { screenToWorldDir, type InputDevice, type ScreenToWorld } from './devices';

export class KeyboardMouse implements InputDevice {
  readonly id = 'kbm';
  readonly label = 'Keyboard + mouse';
  private keys = new Set<string>();
  private buttons = new Set<number>();
  private pressedThisTick = false;
  private startThisTick = false;
  private mouseX = 0;
  private mouseY = 0;
  private hasMouse = false;
  private lastAim = 0;

  constructor(target: HTMLElement, private screenToWorld: ScreenToWorld) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Backquote') return; // dev panel toggle
      if (['Space', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.pressedThisTick = true;
      if (e.code === 'Enter') this.startThisTick = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });
    target.addEventListener('mousedown', (e) => {
      this.buttons.add(e.button);
      this.pressedThisTick = true;
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX; this.mouseY = e.clientY; this.hasMouse = true;
    });
  }

  poll(playerPos: { x: number; z: number }): Command {
    const c = emptyCommand();
    const k = (code: string) => this.keys.has(code);
    const sx = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);
    const sy = (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0);
    const len = Math.hypot(sx, sy) || 1;
    const d = screenToWorldDir(sx / len, sy / len);
    c.moveX = d.x; c.moveZ = d.z;
    c.sprint = k('ShiftLeft') || k('ShiftRight');
    c.roll = k('Space');
    c.fire = this.buttons.has(0);
    c.ads = this.buttons.has(2);
    if (this.hasMouse) {
      const p = this.screenToWorld(this.mouseX, this.mouseY);
      if (p) {
        const dx = p.x - playerPos.x, dz = p.z - playerPos.z;
        if (dx * dx + dz * dz > 0.01) this.lastAim = Math.atan2(dz, dx);
      }
    }
    c.aim = this.lastAim;
    c.aimActive = this.hasMouse;
    return c;
  }

  anyPressed() { return this.pressedThisTick; }
  startPressed() { return this.startThisTick; }
  endTick() { this.pressedThisTick = false; this.startThisTick = false; }
}
