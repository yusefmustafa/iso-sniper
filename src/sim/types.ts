/**
 * Plain-data simulation types. Everything here is serializable so the same
 * state can later be sent over the network, snapshotted, or rolled back.
 */

/** One player's input for one tick. Every device (keyboard+mouse, gamepad, network) produces this. */
export interface Command {
  moveX: number; // -1..1, world space
  moveZ: number; // -1..1, world space
  aim: number; // radians, world space, 0 = +X
  aimActive: boolean; // false when a gamepad's right stick is idle
  sprint: boolean;
  ads: boolean;
  fire: boolean; // held state; the sim detects presses
  roll: boolean; // held state; the sim detects presses
  start: boolean; // rematch request at the end of a match
}

export const emptyCommand = (): Command => ({
  moveX: 0, moveZ: 0, aim: 0, aimActive: false,
  sprint: false, ads: false, fire: false, roll: false, start: false,
});

export type Stance = 'normal' | 'sprint' | 'roll' | 'kneel';

export interface PlayerState {
  id: number; // player slot, 0..3
  x: number;
  z: number;
  vx: number;
  vz: number;
  aim: number;
  hp: number;
  stance: Stance;
  ads: boolean;
  adsTicks: number; // ticks spent in ADS since it started or since the last shot
  boltTicks: number; // >0 while the bolt cycles
  gunRaiseTicks: number; // >0 while the gun comes up after a sprint
  rollTicks: number; // ticks left in the current roll
  rollDirX: number;
  rollDirZ: number;
  rollCooldownTicks: number;
  sinceRollTicks: number; // ticks since the last roll ended (for the kneel window)
  fireBuffer: number; // ticks left on a buffered shot press
  rollBuffer: number; // ticks left on a buffered roll press
  knockX: number; // knockback velocity
  knockZ: number;
  knockTicks: number;
  stunTicks: number; // >0 right after being hit: no move, shoot or roll input
  invulnTicks: number;
  adsLock: boolean; // set by a hit: focus stays off until the focus button is released and pressed again // >0 after being hit: shots can't damage you (you can still shoot) // fractional during slow motion
  sprintRamp: number; // 0..1
  prevFire: boolean;
  prevRoll: boolean;
  dummy: boolean; // training dummy: ignores commands
}

export interface Box {
  x: number; // center
  z: number;
  w: number; // size along X
  d: number; // size along Z
  h: number; // height (render only for now)
}

export interface Arena {
  width: number; // along X
  depth: number; // along Z
  boxes: Box[];
  spawns: { x: number; z: number; aim: number }[];
}

export type Phase = 'countdown' | 'playing' | 'roundEnd' | 'matchEnd';

export type SimEvent =
  | { type: 'shot'; player: number; fromX: number; fromZ: number; toX: number; toZ: number; charged: boolean; aimed: boolean; hit: number | null; blocked: boolean }
  | { type: 'hit'; player: number; by: number; damage: number; dirX: number; dirZ: number }
  | { type: 'charged'; player: number }
  | { type: 'boltReady'; player: number }
  | { type: 'roll'; player: number }
  | { type: 'kneel'; player: number }
  | { type: 'roundStart'; round: number }
  | { type: 'countdown'; secondsLeft: number }
  | { type: 'eliminated'; player: number; by: number; left: number } // left = players still standing
  | { type: 'roundWon'; player: number; score: number[] }
  | { type: 'matchWon'; player: number };

/** Per-player match totals for the end screen, by player slot. Part of the sim, so rollback keeps them right. */
export interface MatchStats {
  shots: number[];
  hits: number[]; // shots that dealt damage
  charged: number[]; // empowered (kneel) hits
  longest: number[]; // longest hit, meters
  kills: number[]; // players eliminated (free-for-all)
}

export const MAX_PLAYERS = 4;

const zeros = (n: number) => Array.from({ length: n }, () => 0);
export const emptyStats = (n = 2): MatchStats => ({ shots: zeros(n), hits: zeros(n), charged: zeros(n), longest: zeros(n), kills: zeros(n) });

export interface GameState {
  tick: number;
  seed: number; // RNG state, advanced deterministically
  phase: Phase;
  phaseTicks: number; // ticks left in the current timed phase (fractional during slow motion)
  round: number;
  score: number[]; // round wins, by player slot
  hitstop: number; // ticks the whole sim is frozen for impact
  slowmoTicks: number; // ticks of slow motion left (render reads this)
  players: PlayerState[];
  stats: MatchStats;
  arena: Arena;
  events: SimEvent[]; // cleared at the start of every step
}
