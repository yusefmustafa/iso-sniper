import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/bot/brain';
import { createGame, step } from '../src/sim/sim';

describe('bot', () => {
  it('two bots fight to a match result, using rolls and empowered shots', () => {
    const g = createGame({ seed: 7 });
    const bots = [new BotBrain('normal'), new BotBrain('hard')];
    let rolls = 0, kneels = 0;
    for (let t = 0; t < 60 * 180 && g.phase !== 'matchEnd'; t++) {
      step(g, [bots[0].think(g, 0), bots[1].think(g, 1)]);
      for (const e of g.events) { if (e.type === 'roll') rolls++; if (e.type === 'kneel') kneels++; }
    }
    console.log('bot vs bot', { tick: g.tick, score: g.score, stats: g.stats, rolls, kneels });
    expect(g.phase).toBe('matchEnd');
    expect(g.stats.shots[0] + g.stats.shots[1]).toBeGreaterThan(5);
    expect(rolls).toBeGreaterThan(0);
  });
});
