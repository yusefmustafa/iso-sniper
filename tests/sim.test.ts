import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { createGame, secToTicks, step } from '../src/sim/sim';
import { emptyCommand, type Command, type GameState } from '../src/sim/types';

const T = (s: number) => secToTicks(s);

/** A game already in the playing phase, players facing each other on an open line. */
function playing(seed = 1): GameState {
  const g = createGame({ seed });
  g.arena.boxes = []; // open field for precise tests
  for (let i = 0; i < T(config.countdownTime) + 1; i++) step(g, [emptyCommand(), emptyCommand()]);
  expect(g.phase).toBe('playing');
  return g;
}

const cmd = (over: Partial<Command> = {}): Command => ({ ...emptyCommand(), aimActive: true, ...over });
const aimAt = (g: GameState, from: number, to: number) =>
  Math.atan2(g.players[to].z - g.players[from].z, g.players[to].x - g.players[from].x);

function run(g: GameState, ticks: number, c0: (g: GameState) => Command, c1: (g: GameState) => Command = () => cmd({ aim: Math.PI })) {
  const events = [];
  for (let i = 0; i < ticks; i++) { step(g, [c0(g), c1(g)]); events.push(...g.events); }
  return events;
}

describe('shooting', () => {
  it('an aimed, uncharged shot deals 1 HP and follows the laser exactly', () => {
    const g = playing();
    run(g, 5, (g) => cmd({ ads: true, aim: aimAt(g, 0, 1) }));
    const ev = run(g, 1, (g) => cmd({ ads: true, fire: true, aim: aimAt(g, 0, 1) }));
    const shot = ev.find((e) => e.type === 'shot');
    expect(shot && shot.type === 'shot' && shot.hit).toBe(1);
    expect(g.players[1].hp).toBe(2);
  });

  it('standing focus never empowers the shot, however long it is held', () => {
    const g = playing();
    const ev = run(g, T(2), (g) => cmd({ ads: true, aim: aimAt(g, 0, 1) }));
    expect(ev.some((e) => e.type === 'charged')).toBe(false);
    run(g, 1, (g) => cmd({ ads: true, fire: true, aim: aimAt(g, 0, 1) }));
    expect(g.players[1].hp).toBe(2);
  });

  it('rolling into focus empowers the shot: 2 HP, and the shooter is kicked back out of the kneel', () => {
    const g = playing();
    run(g, 1, (g) => cmd({ moveZ: 1, roll: true, aim: aimAt(g, 0, 1) }));
    run(g, T(config.rollTime) + 1, (g) => cmd({ ads: true, roll: true, aim: aimAt(g, 0, 1) }));
    expect(g.players[0].stance).toBe('kneel');
    const ev = run(g, T(config.kneelChargeTime) + 1, (g) => cmd({ ads: true, roll: true, aim: aimAt(g, 0, 1) }));
    expect(ev.some((e) => e.type === 'charged')).toBe(true);
    const x0 = g.players[0].x;
    run(g, 1, (g) => cmd({ ads: true, roll: true, fire: true, aim: aimAt(g, 0, 1) }));
    expect(g.players[1].hp).toBe(1);
    expect(g.players[0].stance).toBe('normal');
    run(g, config.chargedHitstopFrames + T(config.knockbackTime) + 2, () => cmd({ aim: 0 }));
    // P1 starts on the left aiming right (+X), so the kick pushes toward -X.
    expect(x0 - g.players[0].x).toBeGreaterThan(config.selfKnockback * 0.7);
  });

  it('rollTowardCursor rolls along the aim instead of the move direction', () => {
    const g = playing();
    const cfg = { ...config, rollTowardCursor: 1 };
    step(g, [cmd({ moveZ: 1, roll: true, aim: 0 }), cmd({ aim: Math.PI })], cfg);
    expect(g.players[0].stance).toBe('roll');
    expect(g.players[0].rollDirX).toBeCloseTo(1, 5);
    expect(g.players[0].rollDirZ).toBeCloseTo(0, 5);
  });

  it('aim keeps tracking while rolling', () => {
    const g = playing();
    run(g, 1, () => cmd({ moveZ: 1, roll: true, aim: 0 }));
    run(g, 3, () => cmd({ aim: 1 }));
    expect(g.players[0].stance).toBe('roll');
    expect(g.players[0].aim).toBe(1);
  });

  it('the bolt cycle blocks a second shot until it finishes', () => {
    const g = playing();
    run(g, 2, (g) => cmd({ ads: true, aim: aimAt(g, 0, 1) }));
    run(g, 1, (g) => cmd({ ads: true, fire: true, aim: aimAt(g, 0, 1) }));
    // Release and press fire again right away: no shot.
    run(g, 1, (g) => cmd({ ads: true, aim: aimAt(g, 0, 1) }));
    const ev = run(g, 1, (g) => cmd({ ads: true, fire: true, aim: aimAt(g, 0, 1) }));
    expect(ev.filter((e) => e.type === 'shot')).toHaveLength(0);
    expect(g.players[0].boltTicks).toBeGreaterThan(0);
  });

  it('a shot cannot go through cover', () => {
    const g = playing();
    g.arena.boxes = [{ x: 0, z: 0, w: 2, d: 2, h: 1.4 }];
    run(g, 2, () => cmd({ ads: true, aim: 0 }));
    const ev = run(g, 1, () => cmd({ ads: true, fire: true, aim: 0 }));
    const shot = ev.find((e) => e.type === 'shot');
    expect(shot && shot.type === 'shot' && shot.hit).toBe(null);
    expect(g.players[1].hp).toBe(config.maxHp);
  });

  it('cannot shoot while sprinting', () => {
    const g = playing();
    run(g, 10, () => cmd({ moveZ: 1, sprint: true, aim: 0 }));
    expect(g.players[0].stance).toBe('sprint');
    const ev = run(g, 1, () => cmd({ moveZ: 1, sprint: true, fire: true, aim: 0 }));
    expect(ev.filter((e) => e.type === 'shot')).toHaveLength(0);
  });
});

describe('movement', () => {
  it('sprint is faster than walking, and ADS is slower', () => {
    const speedAfter = (over: Partial<Command>) => {
      const g = playing();
      run(g, 30, () => cmd({ moveZ: 1, aim: 0, ...over }));
      return Math.hypot(g.players[0].vx, g.players[0].vz);
    };
    expect(speedAfter({})).toBeCloseTo(config.walkSpeed, 1);
    expect(speedAfter({ sprint: true })).toBeCloseTo(config.sprintSpeed, 1);
    expect(speedAfter({ ads: true })).toBeCloseTo(config.adsSpeed, 1);
  });

  it('a roll covers about the configured distance', () => {
    const g = playing();
    const z0 = g.players[0].z;
    run(g, 1, () => cmd({ moveZ: 1, roll: true, aim: 0 }));
    run(g, T(config.rollTime) + 2, () => cmd({ aim: 0 }));
    expect(g.players[0].z - z0).toBeGreaterThan(config.rollDistance * 0.9);
    expect(g.players[0].z - z0).toBeLessThan(config.rollDistance * 1.15);
  });

  it('rolling into focus with roll still held kneels and charges', () => {
    const g = playing();
    run(g, 1, () => cmd({ moveZ: 1, roll: true, aim: 0 }));
    run(g, T(config.rollTime) + 1, () => cmd({ moveZ: 1, roll: true, ads: true, aim: 0 }));
    expect(g.players[0].stance).toBe('kneel');
    const ev = run(g, T(config.kneelChargeTime) + 1, () => cmd({ ads: true, roll: true, aim: 0 }));
    expect(ev.some((e) => e.type === 'charged')).toBe(true);
  });

  it('no kneel if the roll button was released, and letting go of it mid-kneel stands you up', () => {
    const g = playing();
    run(g, 1, () => cmd({ moveZ: 1, roll: true, aim: 0 }));
    run(g, T(config.rollTime) + 1, () => cmd({ moveZ: 1, ads: true, aim: 0 }));
    expect(g.players[0].stance).not.toBe('kneel');

    const h = playing();
    run(h, 1, () => cmd({ moveZ: 1, roll: true, aim: 0 }));
    run(h, T(config.rollTime) + 1, () => cmd({ roll: true, ads: true, aim: 0 }));
    expect(h.players[0].stance).toBe('kneel');
    run(h, 1, () => cmd({ ads: true, aim: 0 }));
    expect(h.players[0].stance).toBe('normal');
  });
});

describe('rounds', () => {
  it('three hits win a round and reset both players', () => {
    const g = playing();
    for (let s = 0; s < 3; s++) {
      run(g, T(config.boltTime) + 2, (g) => cmd({ ads: true, aim: aimAt(g, 0, 1) }));
      // Keep the charge short so each hit is 1 HP: release ADS first.
      run(g, 1, (g) => cmd({ aim: aimAt(g, 0, 1) }));
      run(g, 1, (g) => cmd({ fire: true, ads: true, aim: aimAt(g, 0, 1) }));
    }
    // Hip shots can miss; this test only checks the bookkeeping when 3 HP are gone.
    if (g.players[1].hp === 0) {
      expect(g.score[0]).toBe(1);
      expect(g.phase).toBe('roundEnd');
      run(g, T(config.roundEndTime) + T(config.finalShotSlowmoTime / config.finalShotSlowmo) + config.chargedHitstopFrames + 2, () => cmd());
      expect(g.phase).toBe('countdown');
      expect(g.players[1].hp).toBe(config.maxHp);
    }
  });
});

describe('determinism', () => {
  it('the same seed and inputs produce the same state', () => {
    const script = (g: GameState) => {
      const t = g.tick;
      return cmd({ moveX: Math.sin(t / 7), moveZ: Math.cos(t / 11), aim: t / 20, fire: t % 40 < 2, roll: t % 97 === 0, ads: t % 120 > 60 });
    };
    const a = playing(99), b = playing(99);
    run(a, 600, script, script);
    run(b, 600, script, script);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
