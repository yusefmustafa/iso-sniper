/**
 * One player of a free-for-all stress test: a bot in a headless browser that
 * joins (or hosts) a room over the real internet, records what it sees, and
 * writes its network numbers. The "FFA stress test" workflow runs four of
 * these on separate GitHub machines; it also works on any computer.
 *
 *   node tools/stress.cjs --room ffa123 --host 4 --name "Host Bot"   # creates the room, starts at 4 players
 *   node tools/stress.cjs --room ffa123 --name "Bot 2"                # joins it
 *
 * Options: --base URL (default http://localhost:4173/), --level, --minutes (of play,
 * default 5), --wait (seconds the host waits for everyone, default 300),
 * --out DIR (video + stats.json), --query "relay=ws://localhost:7777".
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const room = opt('room');
if (!room || !/^[a-z0-9]{4,32}$/.test(room)) { console.error('Usage: node tools/stress.cjs --room <a-z0-9> [--host N] [--name NAME]'); process.exit(2); }
const base = opt('base', 'http://localhost:4173/');
const host = Number(opt('host', '0'));
const name = opt('name', host ? 'Host Bot' : 'Bot');
const level = opt('level', 'normal');
const minutes = Number(opt('minutes', '5'));
const wait = Number(opt('wait', '300'));
const out = opt('out', 'stress-out');
const extra = opt('query', '');

const q = new URLSearchParams({ bot: level, name });
q.set('watch', '');
if (host) { q.set('host', String(host)); q.set('wait', String(wait)); }
for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);
const url = `${base}?${q.toString().replace(/=(?=&|$)/g, '')}#${room}`;

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required'],
  });
  // Small, so software rendering and recording on a CI machine don't eat the CPU the game needs.
  const size = { width: 640, height: 360 };
  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
  const videoStart = Date.now();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[page exception]', e.message));
  console.log(`${name}: ${url}`);
  await page.goto(url);
  const read = () => page.evaluate(() => {
    const g = window.__iso, s = g.session;
    return {
      mode: g.mode, lobby: g.lobby.kind, message: g.lobby.message ?? null, names: g.names, score: g.state.score, round: g.state.round,
      net: s ? { frame: s.frame, local: s.local, owners: s.owners, ...s.stats, peers: s.peerStats() } : null,
    };
  }).catch(() => null);
  const samples = [];
  const hashes = new Map(); // collected as we go: a dropped player's session is gone at the end
  let matchStart = 0;
  let names = null;
  const deadline = Date.now() + (wait + 60) * 1000 + minutes * 60_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    const s = await read();
    if (!s) continue;
    if (s.mode === 'online' && !matchStart) { matchStart = Date.now(); names = s.names; console.log('match started with', s.names.join(', ')); }
    for (const [f, h] of (await page.evaluate(() => [...(window.__iso.session?.hashes.local ?? new Map()).entries()]).catch(() => []))) hashes.set(f, h);
    if (s.net) {
      samples.push({ t: Math.round((Date.now() - matchStart) / 1000), ...s.net, score: s.score, round: s.round });
      const n = s.net;
      console.log(`${String(samples.at(-1).t).padStart(4)}s frame ${n.frame} delay ${n.inputDelay} rollbacks ${n.rollbacks} (${n.rollbacksPerSec}/s) waited ${n.stalls} drops ${n.drops} desync ${n.desyncFrame} | ${n.peers.map((p) => `${Math.round(p.rttMs)}ms`).join(' ')} | score ${s.score.join('-')}`);
    } else if (!matchStart) console.log('lobby:', s.lobby, s.message ?? '');
    if (matchStart && s.mode !== 'online') { console.log('match ended:', s.message); break; }
    if (matchStart && Date.now() - matchStart > minutes * 60_000) break;
  }
  for (const [f, h] of (await page.evaluate(() => [...(window.__iso.session?.hashes.local ?? new Map()).entries()]).catch(() => []))) hashes.set(f, h);
  const final = await read();
  const last = samples.at(-1) ?? null;
  const stats = {
    name, host: !!host, url, videoStart, matchStart, names: final?.net ? final.names : names, samples, hashes: [...hashes],
    final: final?.net ?? last, endedEarly: !final?.net, endMessage: final?.net ? null : final?.message ?? null,
  };
  fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify(stats, null, 1));
  const video = page.video();
  await ctx.close();
  if (video) fs.renameSync(await video.path(), path.join(out, 'pov.webm'));
  await browser.close();
  console.log(matchStart ? 'done' : 'the match never started');
  process.exit(matchStart ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
