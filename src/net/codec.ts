import { emptyCommand, type Command } from '../sim/types';

/**
 * Commands on the wire: [moveX, moveZ, aim, flags] as small integers.
 * Both peers simulate with the *decoded* command (including the local player's
 * own input), so a value never differs between machines by a rounding error.
 */
export type WireCmd = [number, number, number, number];

const TAU = Math.PI * 2;
const AIM_STEPS = 65536;

export function encodeCommand(c: Command): WireCmd {
  const mx = Math.max(-127, Math.min(127, Math.round(c.moveX * 127)));
  const mz = Math.max(-127, Math.min(127, Math.round(c.moveZ * 127)));
  let a = c.aim % TAU;
  if (a < 0) a += TAU;
  const aim = Math.round((a / TAU) * AIM_STEPS) % AIM_STEPS;
  const flags = (c.aimActive ? 1 : 0) | (c.sprint ? 2 : 0) | (c.ads ? 4 : 0) | (c.fire ? 8 : 0) | (c.roll ? 16 : 0) | (c.start ? 32 : 0);
  // `| 0` also turns -0 into 0. JSON sends -0 as 0, so without it the local
  // peer would simulate with -0 and the remote with 0, and they drift apart.
  return [mx | 0, mz | 0, aim | 0, flags];
}

export function decodeCommand(w: WireCmd): Command {
  const c = emptyCommand();
  c.moveX = w[0] / 127;
  c.moveZ = w[1] / 127;
  c.aim = w[2] * (TAU / AIM_STEPS);
  c.aimActive = (w[3] & 1) !== 0;
  c.sprint = (w[3] & 2) !== 0;
  c.ads = (w[3] & 4) !== 0;
  c.fire = (w[3] & 8) !== 0;
  c.roll = (w[3] & 16) !== 0;
  c.start = (w[3] & 32) !== 0;
  return c;
}

export const wireEq = (a: WireCmd, b: WireCmd) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
export const EMPTY_WIRE: WireCmd = [0, 0, 0, 0];
