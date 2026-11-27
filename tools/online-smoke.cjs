/**
 * Two-browser online smoke test over real WebRTC.
 *
 *   npm run dev                      # terminal 1
 *   node tools/nostr-relay.cjs       # terminal 2: local signaling relay on :7777
 *   node tools/online-smoke.cjs      # terminal 3
 *
 * Opens two isolated browser contexts, creates a match in one, opens the link
 * in the other, plays a few seconds of scripted input and checks that both
 * peers' state hashes agree. Pass `local` as the first argument to use
 * BroadcastChannel between two tabs instead of WebRTC (no relay needed).
 */
const { chromium } = require('playwright');
const net = process.argv[2] || 'webrtc';
const base = process.env.URL || 'http://localhost:5173/';
(async () => {
  const browser = await chromium.launch({ args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const vp = { viewport: { width: 640, height: 360 } };
  const ctxA = await browser.newContext(vp);
  const ctxB = net === 'local' ? ctxA : await browser.newContext(vp);
  const a = await ctxA.newPage(), b = await ctxB.newPage();
  const q = net === 'local' ? '?net=local&debug' : '?relay=ws://localhost:7777&debug';
  const shots = process.env.SHOTS; // optional folder for screenshots
  const shot = (p, n) => (shots ? p.screenshot({ path: `${shots}/${n}.png` }) : null);
  await a.goto(base + q);
  await a.fill('input.name', 'Orange Ace');
  await shot(a, '1-menu');
  await a.click('button[data-id=create]');
  const link = await a.inputValue('.link input');
  await b.goto(link);
  // The joiner first tries the host's name (refused, case-insensitive), then a free one.
  await b.fill('input.name', 'orange ace');
  await shot(b, '2-invite');
  await b.click('button[data-id=join]');
  await b.waitForSelector('button[data-id=rename]', { timeout: 30000 });
  await shot(b, '3-name-taken');
  await b.fill('input.name', 'Blue Hawk');
  await b.click('button[data-id=rename]');
  await a.waitForFunction(() => window.__iso.lobby.kind === 'room' && window.__iso.lobby.names[1] === 'Blue Hawk', null, { timeout: 30000 });
  if (await a.isEnabled('button[data-id=start]')) throw new Error('start enabled before anyone is ready');
  await b.click('button[data-id=ready]');
  await a.click('button[data-id=ready]');
  await a.waitForFunction(() => !document.querySelector('button[data-id=start]').disabled, null, { timeout: 10000 });
  await shot(a, '4-room-ready');
  await a.click('button[data-id=start]');
  const mode = (p) => p.evaluate(() => window.__iso.mode);
  for (let i = 0; i < 120 && ((await mode(a)) !== 'online' || (await mode(b)) !== 'online'); i++) await a.waitForTimeout(250);
  if ((await mode(a)) !== 'online') throw new Error('peers never connected');
  await a.waitForTimeout(3500); // countdown
  await a.keyboard.down('KeyD'); await b.keyboard.down('KeyW');
  await a.waitForTimeout(800);
  await a.keyboard.up('KeyD'); await b.keyboard.up('KeyW');
  await a.mouse.down({ button: 'right' }); await a.waitForTimeout(900);
  await a.mouse.down(); await a.waitForTimeout(80); await a.mouse.up(); await a.mouse.up({ button: 'right' });
  await b.keyboard.down('Space'); await b.waitForTimeout(80); await b.keyboard.up('Space');
  await a.waitForTimeout(2000);
  const info = (p) => p.evaluate(() => { const s = window.__iso.session; return { frame: s.frame, rtt: Math.round(s.stats.rttMs), rollbacks: s.stats.rollbacks, desync: s.stats.desyncFrame, hashes: [...s.hashes.local.entries()] }; });
  const ia = await info(a), ib = await info(b);
  console.log('A', JSON.stringify(ia));
  console.log('B', JSON.stringify(ib));
  const hb = new Map(ib.hashes);
  const common = ia.hashes.filter(([f]) => hb.has(f));
  const ok = ia.desync === null && ib.desync === null && common.length >= 3 && common.every(([f, h]) => hb.get(f) === h);
  await shot(a, '5-match');
  // A third person opening the same link is turned away.
  const c = await (net === 'local' ? ctxA : await browser.newContext(vp)).newPage();
  await c.goto(link);
  await c.fill('input.name', 'Third Wheel');
  await c.click('button[data-id=join]');
  await c.waitForFunction(() => window.__iso.lobby.kind === 'menu' && /two players/.test(window.__iso.lobby.message || ''), null, { timeout: 30000 });
  console.log('third player: lobby full');
  const stillOnline = (await mode(a)) === 'online' && (await mode(b)) === 'online';
  if (!stillOnline) throw new Error('the third player disturbed the match');
  console.log(ok ? `OK: ${common.length} matching state hashes` : 'FAIL: peers disagree');
  // The host leaves: the guest is told and the room closes.
  await a.close({ runBeforeUnload: true });
  await b.waitForFunction(() => window.__iso.mode === 'lobby' && /left/.test(window.__iso.lobby.message || ''), null, { timeout: 30000 });
  console.log('host left: guest back at menu:', await b.evaluate(() => window.__iso.lobby.message));
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
