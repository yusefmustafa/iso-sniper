import type { Command } from '../sim/types';

/**
 * Every physical device implements InputDevice and turns its raw state into a
 * Command once per tick. The sim never sees a device. Online play later adds a
 * NetworkDevice that returns commands received from the other player.
 */
export interface InputDevice {
  readonly id: string; // 'kbm' or 'pad:<index>'
  readonly label: string;
  /** Build this tick's command. `playerPos` lets mouse aim be relative to the character. */
  poll(playerPos: { x: number; z: number }): Command;
  /** True on the tick any button was pressed (used to join the match). */
  anyPressed(): boolean;
  /** True on the tick the confirm/start button was pressed (restart, add dummy). */
  startPressed(): boolean;
  /** Called once per tick after polling, so edge detection works. */
  endTick(): void;
}

/** Maps a screen position to the point on the aim plane, provided by the renderer. */
export type ScreenToWorld = (clientX: number, clientY: number) => { x: number; z: number } | null;

/**
 * The camera is isometric: screen "up" points along world (-X, -Z) at 45 degrees.
 * Rotate stick/WASD input so pushing up moves the character up the screen.
 */
export const CAMERA_YAW = Math.PI / 4;
export function screenToWorldDir(sx: number, sy: number): { x: number; z: number } {
  // sx: right, sy: up on screen.
  const c = Math.cos(CAMERA_YAW), s = Math.sin(CAMERA_YAW);
  return { x: sx * c - sy * s, z: -sx * s - sy * c };
}
