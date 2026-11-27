import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { loopbackPair } from '../src/net/channel';
import { MatchLobby, type LobbyState, type MatchSetup } from '../src/net/lobby';
import { nameError, sameName } from '../src/net/names';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function pair(hostName: string, guestName: string) {
  const link = loopbackPair({ latencyMs: 40 });
  const st: (LobbyState | null)[] = [null, null];
  const started: (MatchSetup | null)[] = [null, null];
  const mk = (i: number, creator: boolean, name: string) => new MatchLobby(i === 0 ? link.a : link.b, { creator, name, config: { ...config } }, {
    onState: (s) => { st[i] = s; }, onStart: (s) => { started[i] = s; }, onError: () => {},
  });
  const host = mk(0, true, hostName), guest = mk(1, false, guestName);
  const run = (ms = 600) => { for (let t = 0; t < ms; t += 20) { link.advance(20); vi.advanceTimersByTime(20); } };
  return { host, guest, st, started, run };
}

describe('names', () => {
  it('rejects emoji, too short and too long, allows letters in any language', () => {
    expect(nameError('Yu😀')).not.toBeNull();
    expect(nameError('a')).not.toBeNull();
    expect(nameError('x'.repeat(17))).not.toBeNull();
    expect(nameError('José-Ångström')).toBeNull();
    expect(nameError('  Blue   Hawk ')).toBeNull();
    expect(nameError('<b>hi</b>')).not.toBeNull();
    expect(sameName('Yusef', ' yusef ')).toBe(true);
  });
});

describe('lobby', () => {
  it('syncs names, needs both ready, then starts both peers with the same seed', () => {
    const { host, guest, st, started, run } = pair('Yusef', 'Rival');
    run();
    expect(st[0]!.names).toEqual(['Yusef', 'Rival']);
    expect(st[1]!.names).toEqual(['Yusef', 'Rival']);
    host.start();
    run();
    expect(started[0]).toBeNull(); // nobody ready yet
    guest.setReady(true);
    run();
    expect(host.canStart).toBe(false);
    host.setReady(true);
    run();
    expect(st[1]!.ready).toEqual([true, true]);
    host.start();
    run();
    expect(started[0]!.localPlayer).toBe(0);
    expect(started[1]!.localPlayer).toBe(1);
    expect(started[1]!.seed).toBe(started[0]!.seed);
    expect(started[1]!.names).toEqual(['Yusef', 'Rival']);
  });

  it('refuses a guest name the host already uses, then accepts a new one', () => {
    const { guest, st, run } = pair('Yusef', 'YUSEF');
    run();
    expect(st[1]!.nameTaken).toBe(true);
    expect(st[0]!.names[1]).toBeNull();
    guest.rename('Blue');
    run();
    expect(st[0]!.names[1]).toBe('Blue');
    expect(st[1]!.nameTaken).toBe(false);
  });
});
