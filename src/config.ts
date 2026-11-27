/**
 * Every gameplay number lives here so it can be tuned live (press ` in game).
 * Times are in seconds, distances in meters, angles in degrees.
 * The simulation reads these values each tick, so both players must share the
 * same config (true for couch play; online will sync it from the server).
 */
export const config = {
  tickRate: 60,

  // Health and damage
  maxHp: 3,
  chargedDamage: 2,
  roundsToWin: 3,

  // Movement
  walkSpeed: 4.5,
  sprintSpeed: 7.5,
  adsSpeed: 1.5,
  accelTime: 0.08, // time to reach full speed from rest
  stopTime: 0.06, // time to stop from full speed
  sprintRampTime: 0.15,
  gunRaiseTime: 0.2, // after sprinting, before you can aim or shoot
  playerRadius: 0.4,
  kneelRadius: 0.3,

  // Roll
  rollDistance: 6,
  rollTime: 0.4,
  rollCooldown: 1.0,
  rollEndSpeedFactor: 0.3, // speed at the very end of the roll, relative to peak
  kneelWindow: 0.25, // ADS within this long after a roll ends = kneel

  // Shooting
  hipSpreadDeg: 14, // full cone width
  boltTime: 1.2,
  chargeTime: 0.75,
  kneelChargeTime: 0.5,
  shotRange: 60,
  inputBuffer: 0.12,

  // Hit feel
  hitstopFrames: 4,
  chargedHitstopFrames: 8,
  knockback: 1.5, // meters of push on hit
  knockbackTime: 0.15,

  // Round flow
  countdownTime: 3,
  roundEndTime: 2.2,
  finalShotSlowmo: 0.3, // time scale right after a round-winning shot
  finalShotSlowmoTime: 0.9,
};

export type Config = typeof config;
