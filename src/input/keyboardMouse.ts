import { emptyCommand, type Command } from '../sim/types';
import { screenToWorldDir, type InputDevice, type ScreenToWorld } from './devices';

export class KeyboardMouse implements InputDevice {
  readonly id = 'kbm';
  readonly label = 'Keyboard + mouse';
  /** When true, clicking the game captures the mouse (pointer lock). Set by main while a match runs. */
  lockEnabled = false;
  private keys = new Set<string>();
  private buttons = new Set<number>();
  private pressedThisTick = false;
  private startThisTick = false;
  private mouseX = 0;
  private mouseY = 0;
  private hasMouse = false;
  private lastAim = 0;

  constructor(private target: HTMLElement, private screenToWorld: ScreenToWorld) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // Typing in a text box (your name, the tuning panel) is not game input.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'Backquote') { document.exitPointerLock?.(); return; } // dev panel toggle needs the cursor
      if (['Space', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.pressedThisTick = true;
      if (e.code === 'Enter') this.startThisTick = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });
    target.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // A click that only re-captures the mouse (e.g. after alt-tabbing back) doesn't shoot or aim.
      if (this.lockEnabled && !this.locked) { this.requestLock(); return; }
      this.buttons.add(e.button);
      this.pressedThisTick = true;
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons.delete(e.button);
      if (e.button === 2) e.preventDefault();
    });
    // Block the browser menu everywhere, not just on the canvas: overlays sit on
    // top of it, and Firefox fires contextmenu wherever the button comes up.
    window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
    window.addEventListener('mousemove', (e) => {
      if (this.locked) {
        // Pointer lock hides the OS cursor; move a virtual one, kept on screen.
        this.mouseX = Math.min(window.innerWidth, Math.max(0, this.mouseX + e.movementX));
        this.mouseY = Math.min(window.innerHeight, Math.max(0, this.mouseY + e.movementY));
      } else {
        this.mouseX = e.clientX; this.mouseY = e.clientY;
      }
      this.hasMouse = true;
    });
  }

  get locked() { return document.pointerLockElement === this.target; }

  /** Where the mouse is on screen (virtual while pointer-locked), or null before it has moved. */
  get cursor() { return this.hasMouse ? { x: this.mouseX, y: this.mouseY } : null; }

  /** Capture the mouse again (the Esc menu's Resume button). */
  capture() { if (this.lockEnabled && !this.locked) this.requestLock(); }

  private requestLock() {
    try {
      const r = this.target.requestPointerLock?.() as unknown;
      if (r instanceof Promise) r.catch(() => {});
    } catch { /* not allowed here; the window-wide contextmenu block still applies */ }
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
