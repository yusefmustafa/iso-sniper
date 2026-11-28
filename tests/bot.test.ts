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

describe('free-for-all', () => {
  it('four bots play a full match: last one standing wins each round', () => {
    const g = createGame({ seed: 11, players: 4 });
    const bots = ['easy', 'normal', 'hard', 'normal'].map((l) => new BotBrain(l as 'easy'));
    let elims = 0, rounds = 0;
    for (let t = 0; t < 60 * 400 && g.phase !== 'matchEnd'; t++) {
      step(g, bots.map((b, i) => b.think(g, i)));
      for (const e of g.events) {
        if (e.type === 'eliminated') elims++;
        if (e.type === 'roundWon') { rounds++; expect(g.players.filter((p) => p.hp > 0).map((p) => p.id)).toEqual([e.player]); }
      }
    }
    console.log('4 bots', { tick: g.tick, score: g.score, kills: g.stats.kills, rounds, elims });
    expect(g.phase).toBe('matchEnd');
    expect(Math.max(...g.score)).toBe(3);
    expect(elims).toBe(rounds * 3);
  });
});
