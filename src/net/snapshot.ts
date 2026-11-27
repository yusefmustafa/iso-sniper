import type { GameState, Phase, Stance } from '../sim/types';

/** Copy everything the sim mutates. The arena is static during a match, so it is shared. */
export function cloneState(s: GameState): GameState {
  return { ...s, score: [...s.score], players: s.players.map((p) => ({ ...p })), events: [] };
}

const PHASES: Phase[] = ['countdown', 'playing', 'roundEnd', 'matchEnd'];
const STANCES: Stance[] = ['normal', 'sprint', 'roll', 'kneel'];

/** 32-bit FNV-1a over every simulated number, used to detect desyncs between peers. */
export function hashState(s: GameState): number {
  const nums: number[] = [s.tick, s.seed, PHASES.indexOf(s.phase), s.phaseTicks, s.round, ...s.score, s.hitstop, s.slowmoTicks];
  for (const p of s.players) {
    nums.push(p.x, p.z, p.vx, p.vz, p.aim, p.hp, STANCES.indexOf(p.stance), +p.ads, p.adsTicks, p.boltTicks, p.gunRaiseTicks,
      p.rollTicks, p.rollDirX, p.rollDirZ, p.rollCooldownTicks, p.sinceRollTicks, p.fireBuffer, p.rollBuffer,
      p.knockX, p.knockZ, p.knockTicks, p.stunTicks, p.invulnTicks, +p.adsLock, p.sprintRamp, +p.prevFire, +p.prevRoll);
  }
  const bytes = new Uint8Array(new Float64Array(nums).buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
