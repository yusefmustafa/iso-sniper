import { config as defaultConfig, type Config } from '../config';
import { defaultArena, rayToCircle, rayToWorld, resolveCircle } from './arena';
import { nextRandom } from './rng';
import type { Command, GameState, PlayerState } from './types';

/**
 * The game rules. step() is a pure function of (state, commands, config):
 * no clocks, no Math.random, no DOM. That makes it deterministic, testable
 * headless, and runnable on a server later for online play.
 */

const DEG = Math.PI / 180;
export const MUZZLE_OFFSET = 0.6; // muzzle distance in front of the body center

export const secToTicks = (s: number, cfg: Config = defaultConfig) => Math.round(s * cfg.tickRate);

function newPlayer(id: number, state: GameState, dummy: boolean, cfg: Config): PlayerState {
  const s = state.arena.spawns[id];
  return {
    id, x: s.x, z: s.z, vx: 0, vz: 0, aim: s.aim, hp: cfg.maxHp,
    stance: 'normal', ads: false, adsTicks: 0, boltTicks: 0, gunRaiseTicks: 0,
    rollTicks: 0, rollDirX: 0, rollDirZ: 0, rollCooldownTicks: 0, sinceRollTicks: 9999,
    fireBuffer: 0, rollBuffer: 0, knockX: 0, knockZ: 0, knockTicks: 0, sprintRamp: 0,
    prevFire: false, prevRoll: false, dummy,
  };
}

export function createGame(opts: { seed?: number; dummyP2?: boolean } = {}, cfg: Config = defaultConfig): GameState {
  const state: GameState = {
    tick: 0, seed: opts.seed ?? 12345, phase: 'countdown', phaseTicks: secToTicks(cfg.countdownTime, cfg),
    round: 1, score: [0, 0], hitstop: 0, slowmoTicks: 0, players: [], arena: defaultArena(), events: [],
  };
  state.players = [newPlayer(0, state, false, cfg), newPlayer(1, state, !!opts.dummyP2, cfg)];
  state.events.push({ type: 'roundStart', round: 1 });
  return state;
}

function resetRound(state: GameState, cfg: Config) {
  state.players = state.players.map((p) => newPlayer(p.id, state, p.dummy, cfg));
  state.phase = 'countdown';
  state.phaseTicks = secToTicks(cfg.countdownTime, cfg);
  state.events.push({ type: 'roundStart', round: state.round });
}

export const hitRadius = (p: PlayerState, cfg: Config = defaultConfig) =>
  p.stance === 'kneel' ? cfg.kneelRadius : cfg.playerRadius;

export const chargeTicksFor = (p: PlayerState, cfg: Config = defaultConfig) =>
  secToTicks(p.stance === 'kneel' ? cfg.kneelChargeTime : cfg.chargeTime, cfg);

export const isCharged = (p: PlayerState, cfg: Config = defaultConfig) =>
  p.ads && p.adsTicks >= chargeTicksFor(p, cfg);

/** Can this player's gun fire or aim right now (ignoring the bolt)? */
const gunUp = (p: PlayerState) => p.stance !== 'roll' && p.stance !== 'sprint' && p.gunRaiseTicks === 0;

/** Advance the game by one tick. Mutates state; read state.events afterwards for effects. */
export function step(state: GameState, commands: Command[], cfg: Config = defaultConfig): void {
  state.events = [];
  state.tick++;

  if (state.slowmoTicks > 0) state.slowmoTicks--;

  // Hitstop freezes the whole world for a few frames on impact. Input presses
  // still land in the buffer, so nothing the player does is lost.
  if (state.hitstop > 0) {
    state.hitstop--;
    state.players.forEach((p, i) => bufferPresses(p, commands[i], cfg));
    return;
  }

  switch (state.phase) {
    case 'countdown': {
      const before = Math.ceil(state.phaseTicks / cfg.tickRate);
      state.phaseTicks--;
      const after = Math.ceil(state.phaseTicks / cfg.tickRate);
      if (after !== before && after > 0) state.events.push({ type: 'countdown', secondsLeft: after });
      // Players can aim during the countdown but not move or shoot.
      state.players.forEach((p, i) => {
        const c = commands[i];
        if (!p.dummy && c && c.aimActive) p.aim = c.aim;
        if (c) { p.prevFire = c.fire; p.prevRoll = c.roll; }
      });
      if (state.phaseTicks <= 0) {
        state.phase = 'playing';
        state.events.push({ type: 'countdown', secondsLeft: 0 });
      }
      return;
    }
    case 'roundEnd': {
      state.phaseTicks--;
      state.players.forEach((p) => integrate(state, p, cfg, true));
      if (state.phaseTicks <= 0) {
        state.round++;
        resetRound(state, cfg);
      }
      return;
    }
    case 'matchEnd':
      state.players.forEach((p) => integrate(state, p, cfg, true));
      return;
    case 'playing':
      break;
  }

  state.players.forEach((p, i) => updatePlayer(state, p, p.dummy ? undefined : commands[i], cfg));
  separatePlayers(state, cfg);
}

function bufferPresses(p: PlayerState, c: Command | undefined, cfg: Config) {
  if (!c || p.dummy) return;
  if (c.fire && !p.prevFire) p.fireBuffer = secToTicks(cfg.inputBuffer, cfg);
  if (c.roll && !p.prevRoll) p.rollBuffer = secToTicks(cfg.inputBuffer, cfg);
  p.prevFire = c.fire;
  p.prevRoll = c.roll;
}

function updatePlayer(state: GameState, p: PlayerState, c: Command | undefined, cfg: Config) {
  // Timers
  if (p.fireBuffer > 0) p.fireBuffer--;
  if (p.rollBuffer > 0) p.rollBuffer--;
  if (p.rollCooldownTicks > 0) p.rollCooldownTicks--;
  if (p.gunRaiseTicks > 0) p.gunRaiseTicks--;
  if (p.boltTicks > 0) {
    p.boltTicks--;
    if (p.boltTicks === 0) state.events.push({ type: 'boltReady', player: p.id });
  }
  if (p.stance !== 'roll') p.sinceRollTicks++;

  bufferPresses(p, c, cfg);

  // Move input, clamped to the unit circle
  let mx = c?.moveX ?? 0, mz = c?.moveZ ?? 0;
  const mlen = Math.hypot(mx, mz);
  if (mlen > 1) { mx /= mlen; mz /= mlen; }
  const moving = mlen > 0.15;
  const wantsAds = !!c?.ads;

  // Aim: explicit aim input wins. A gamepad with an idle right stick faces the move direction.
  if (c && p.stance !== 'roll') {
    if (c.aimActive) p.aim = c.aim;
    else if (moving && !wantsAds && p.stance !== 'kneel') p.aim = Math.atan2(mz, mx);
  }

  // Roll start (buffered press)
  if (p.rollBuffer > 0 && p.rollCooldownTicks === 0 && p.stance !== 'roll') {
    p.rollBuffer = 0;
    const dx = moving ? mx / Math.max(mlen, 1e-6) : Math.cos(p.aim);
    const dz = moving ? mz / Math.max(mlen, 1e-6) : Math.sin(p.aim);
    const n = Math.hypot(dx, dz) || 1;
    p.rollDirX = dx / n; p.rollDirZ = dz / n;
    p.stance = 'roll';
    p.rollTicks = secToTicks(cfg.rollTime, cfg);
    p.ads = false; p.adsTicks = 0;
    p.gunRaiseTicks = 0;
    state.events.push({ type: 'roll', player: p.id });
  }

  // Roll end: ADS held (or pressed shortly after) drops you into a kneel.
  if (p.stance === 'roll' && p.rollTicks === 0) {
    p.stance = 'normal';
    p.sinceRollTicks = 0;
    p.rollCooldownTicks = secToTicks(cfg.rollCooldown, cfg);
  }
  if (p.stance === 'normal' && wantsAds && !p.ads && p.sinceRollTicks <= secToTicks(cfg.kneelWindow, cfg)) {
    p.stance = 'kneel';
    state.events.push({ type: 'kneel', player: p.id });
  }

  // Kneel exit: letting go of ADS stands you up. Move input is ignored while
  // kneeling, so a player still holding the stick after a roll stays planted.
  if (p.stance === 'kneel' && !wantsAds) p.stance = 'normal';

  // Sprint: needs movement, and ADS overrides it.
  if (p.stance === 'normal' && c?.sprint && moving && !wantsAds) p.stance = 'sprint';
  else if (p.stance === 'sprint' && (!c?.sprint || !moving || wantsAds)) {
    p.stance = 'normal';
    p.gunRaiseTicks = secToTicks(cfg.gunRaiseTime, cfg);
  }
  p.sprintRamp = p.stance === 'sprint'
    ? Math.min(1, p.sprintRamp + 1 / Math.max(1, secToTicks(cfg.sprintRampTime, cfg)))
    : 0;

  // ADS and charge
  const canAds = wantsAds && gunUp(p);
  if (canAds) {
    if (!p.ads) { p.ads = true; p.adsTicks = 0; }
    const wasCharged = p.adsTicks >= chargeTicksFor(p, cfg);
    // The charge only builds while the chamber is loaded.
    if (p.boltTicks === 0) p.adsTicks++;
    if (!wasCharged && p.adsTicks >= chargeTicksFor(p, cfg)) state.events.push({ type: 'charged', player: p.id });
  } else {
    p.ads = false; p.adsTicks = 0;
  }

  // Fire (buffered press)
  if (p.fireBuffer > 0 && p.boltTicks === 0 && gunUp(p)) {
    p.fireBuffer = 0;
    fire(state, p, cfg);
  }

  // Movement velocity
  let speed = cfg.walkSpeed;
  if (p.stance === 'sprint') speed = cfg.walkSpeed + (cfg.sprintSpeed - cfg.walkSpeed) * p.sprintRamp;
  if (p.ads) speed = cfg.adsSpeed;
  if (p.stance === 'kneel') speed = 0;

  const dt = 1 / cfg.tickRate;
  if (p.stance === 'roll') {
    const total = secToTicks(cfg.rollTime, cfg);
    const t = (total - p.rollTicks) / total; // 0..1 through the roll
    // Full speed for the first two thirds, then ease out to rollEndSpeedFactor.
    const end = cfg.rollEndSpeedFactor;
    const peak = cfg.rollDistance / (cfg.rollTime * (2 / 3 + (1 / 3) * (1 + end) / 2));
    const f = t < 2 / 3 ? 1 : 1 - (1 - end) * ((t - 2 / 3) * 3);
    p.vx = p.rollDirX * peak * f;
    p.vz = p.rollDirZ * peak * f;
    p.rollTicks--;
  } else {
    const tx = mx * speed, tz = mz * speed;
    const accelerating = tx * p.vx + tz * p.vz >= 0 && Math.hypot(tx, tz) > 1e-6;
    const rate = (accelerating ? cfg.walkSpeed / cfg.accelTime : cfg.walkSpeed / cfg.stopTime) * dt;
    const dx = tx - p.vx, dz = tz - p.vz;
    const dl = Math.hypot(dx, dz);
    if (dl <= rate) { p.vx = tx; p.vz = tz; }
    else { p.vx += (dx / dl) * rate; p.vz += (dz / dl) * rate; }
  }

  integrate(state, p, cfg, false);
}

function integrate(state: GameState, p: PlayerState, cfg: Config, frictionOnly: boolean) {
  const dt = 1 / cfg.tickRate;
  if (frictionOnly) {
    // Outside of play, players slide to a stop but keep their knockback.
    const k = Math.max(0, 1 - (cfg.walkSpeed / cfg.stopTime) * dt / Math.max(Math.hypot(p.vx, p.vz), 1e-6));
    p.vx *= k; p.vz *= k;
  }
  let kx = 0, kz = 0;
  if (p.knockTicks > 0) {
    const f = p.knockTicks / secToTicks(cfg.knockbackTime, cfg);
    kx = p.knockX * f * 2; kz = p.knockZ * f * 2; // linear decay, integrates to the knockback distance
    p.knockTicks--;
  }
  p.x += (p.vx + kx) * dt;
  p.z += (p.vz + kz) * dt;
  resolveCircle(state.arena, p, hitRadius(p, cfg));
}

function separatePlayers(state: GameState, cfg: Config) {
  const [a, b] = state.players;
  const ra = hitRadius(a, cfg), rb = hitRadius(b, cfg);
  const dx = b.x - a.x, dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  const min = ra + rb;
  if (d >= min || d < 1e-6) return;
  const push = (min - d) / 2;
  a.x -= (dx / d) * push; a.z -= (dz / d) * push;
  b.x += (dx / d) * push; b.z += (dz / d) * push;
  resolveCircle(state.arena, a, ra);
  resolveCircle(state.arena, b, rb);
}

function fire(state: GameState, p: PlayerState, cfg: Config) {
  const aimed = p.ads;
  const charged = isCharged(p, cfg);
  // Hip-fire spreads randomly inside the cone; an aimed shot goes exactly down the laser.
  const spread = aimed ? 0 : (nextRandom(state) - 0.5) * cfg.hipSpreadDeg * DEG;
  const ang = p.aim + spread;
  const dx = Math.cos(ang), dz = Math.sin(ang);
  const ox = p.x + Math.cos(p.aim) * MUZZLE_OFFSET * 0.5;
  const oz = p.z + Math.sin(p.aim) * MUZZLE_OFFSET * 0.5;

  const wallDist = rayToWorld(state.arena, ox, oz, dx, dz, cfg.shotRange);
  let hit: number | null = null;
  let dist = wallDist;
  for (const o of state.players) {
    if (o.id === p.id || o.hp <= 0) continue;
    const t = rayToCircle(ox, oz, dx, dz, o.x, o.z, hitRadius(o, cfg));
    if (t < dist) { dist = t; hit = o.id; }
  }

  state.events.push({
    type: 'shot', player: p.id, fromX: ox, fromZ: oz,
    toX: ox + dx * dist, toZ: oz + dz * dist, charged, aimed, hit,
  });

  p.boltTicks = secToTicks(cfg.boltTime, cfg);
  p.adsTicks = 0; // the next charge starts over

  if (hit !== null) {
    const o = state.players[hit];
    const damage = charged ? cfg.chargedDamage : 1;
    o.hp = Math.max(0, o.hp - damage);
    o.knockX = dx * cfg.knockback / cfg.knockbackTime;
    o.knockZ = dz * cfg.knockback / cfg.knockbackTime;
    o.knockTicks = secToTicks(cfg.knockbackTime, cfg);
    // Getting shot breaks your aim.
    o.ads = false; o.adsTicks = 0;
    if (o.stance === 'kneel') o.stance = 'normal';
    state.hitstop = charged ? cfg.chargedHitstopFrames : cfg.hitstopFrames;
    state.events.push({ type: 'hit', player: o.id, by: p.id, damage, dirX: dx, dirZ: dz });

    if (o.hp === 0) {
      state.score[p.id]++;
      state.slowmoTicks = secToTicks(cfg.finalShotSlowmoTime, cfg);
      state.events.push({ type: 'roundWon', player: p.id, score: [...state.score] });
      if (state.score[p.id] >= cfg.roundsToWin) {
        state.phase = 'matchEnd';
        state.events.push({ type: 'matchWon', player: p.id });
      } else {
        state.phase = 'roundEnd';
        state.phaseTicks = secToTicks(cfg.roundEndTime, cfg);
      }
    }
  }
}

/** Start a fresh match keeping the same players (and dummy setting). */
export function restartMatch(state: GameState, cfg: Config = defaultConfig): void {
  state.score = [0, 0];
  state.round = 1;
  state.hitstop = 0;
  state.slowmoTicks = 0;
  resetRound(state, cfg);
}
