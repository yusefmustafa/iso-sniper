import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { loopbackMesh } from '../src/net/mesh';
import { FULL_MESSAGE, MatchLobby, type LobbyState, type MatchSetup } from '../src/net/lobby';
import { nameError, sameName } from '../src/net/names';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function room(names: string[]) {
  const net = loopbackMesh(names.length, { latencyMs: 40 });
  const st: (LobbyState | null)[] = names.map(() => null);
  const started: (MatchSetup | null)[] = names.map(() => null);
  const errors: string[] = [];
  const lobbies = names.map((name, i) => new MatchLobby(net.meshes[i], { creator: i === 0, name, config: { ...config } }, {
    onState: (s) => { st[i] = s; }, onStart: (s) => { started[i] = s; }, onError: (e) => { errors.push(e); },
  }));
  const run = (ms = 600) => { for (let t = 0; t < ms; t += 20) { net.advance(20); vi.advanceTimersByTime(20); } };
  return { lobbies, st, started, run, errors, net };
}

function pair(hostName: string, guestName: string) {
  const r = room([hostName, guestName]);
  return { ...r, host: r.lobbies[0], guest: r.lobbies[1] };
}

const namesOf = (s: LobbyState | null) => s!.slots.map((x) => x?.name ?? null);

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
  it('syncs names, the host starts once the guest is ready, same seed on both peers', () => {
    const { host, guest, st, started, run } = pair('Yusef', 'Rival');
    run();
    expect(namesOf(st[0])).toEqual(['Yusef', 'Rival', null, null]);
    expect(namesOf(st[1])).toEqual(['Yusef', 'Rival', null, null]);
    host.start();
    run();
    expect(started[0]).toBeNull(); // the guest isn't ready yet
    expect(host.canStart).toBe(false);
    guest.setReady(true);
    run();
    expect(st[1]!.slots.slice(0, 2).map((x) => x!.ready)).toEqual([true, true]); // the host counts as always ready
    expect(host.canStart).toBe(true);
    host.start();
    run();
    expect(started[0]!.local).toBe(0);
    expect(started[1]!.local).toBe(1);
    expect(started[1]!.seed).toBe(started[0]!.seed);
    expect(started[1]!.slots.map((x) => x.name)).toEqual(['Yusef', 'Rival']);
    expect(started[1]!.host).toBe(started[0]!.self);
  });

  it('refuses a guest name the host already uses, then accepts a new one', () => {
    const { guest, st, run } = pair('Yusef', 'YUSEF');
    run();
    expect(st[1]!.nameTaken).toBe(true);
    expect(st[0]!.slots[1]!.name).toBe('');
    guest.rename('Blue');
    run();
    expect(st[0]!.slots[1]!.name).toBe('Blue');
    expect(st[1]!.nameTaken).toBe(false);
  });

  it('four players: seats fill in join order, a fifth is turned away, start waits for everyone', () => {
    const { lobbies, st, started, run, errors } = room(['Host', 'Ann', 'Bo', 'Cy', 'Dee']);
    run();
    expect(errors).toEqual([FULL_MESSAGE]);
    const seated = st[0]!.slots.map((x) => x!.name);
    expect(seated[0]).toBe('Host');
    const guests = [1, 2, 3, 4].filter((i) => seated.includes(['Host', 'Ann', 'Bo', 'Cy', 'Dee'][i]));
    expect(guests.length).toBe(3);
    lobbies[guests[0]].setReady(true); lobbies[guests[1]].setReady(true);
    run();
    expect(lobbies[0].canStart).toBe(false);
    lobbies[guests[2]].setReady(true);
    run();
    expect(lobbies[0].canStart).toBe(true);
    lobbies[0].start();
    run();
    const all = [0, ...guests].map((i) => started[i]!);
    expect(new Set(all.map((s) => s.seed)).size).toBe(1);
    expect(all.map((s) => s.local).sort()).toEqual([0, 1, 2, 3]);
    for (const s of all) expect(s.slots.length).toBe(4);
  });

  it('the host fills seats with bots and plays them', () => {
    const { lobbies, st, started, run } = room(['Host', 'Ann']);
    run();
    lobbies[0].addBot('hard');
    lobbies[0].addBot('easy');
    run();
    expect(namesOf(st[1])).toEqual(['Host', 'Ann', 'Claude Bot', 'Claude Bot 2']);
    lobbies[0].removeBot(2);
    run();
    expect(namesOf(st[1])).toEqual(['Host', 'Ann', 'Claude Bot 2', null]);
    lobbies[1].setReady(true);
    run();
    lobbies[0].start();
    run();
    const slots = started[1]!.slots;
    expect(slots.map((s) => s.bot)).toEqual([null, null, 'easy']);
    expect(slots[2].owner).toBe(started[0]!.self);
  });

  it('a host alone with a bot can start right away', () => {
    const { lobbies, started, run } = room(['Host']);
    lobbies[0].addBot('normal');
    run();
    expect(lobbies[0].canStart).toBe(true);
    lobbies[0].start();
    run();
    expect(started[0]!.slots.length).toBe(2);
  });
});
