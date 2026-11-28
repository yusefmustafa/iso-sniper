/**
 * Run a Snipefight bot in a headless browser and send it into a match.
 *
 *   node tools/bot.cjs "https://snipefight.com/#abcd1234" [--level normal] [--minutes 30]
 *
 * The bot opens the link with `?bot`, joins as the guest, readies up and plays
 * through the real netcode. If the match closes (the host left or reloaded),
 * it opens the link again until the time is up. GitHub Actions runs this from
 * the "Summon a bot" workflow; it also works on any computer with Node and
 * Playwright (`npm i -D playwright && npx playwright install chromium`).
 */
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const link = args.find((a) => /^https?:\/\//.test(a));
if (!link || !/#[a-z0-9]{4,32}$/.test(link)) {
  console.error('Usage: node tools/bot.cjs "<match link ending in #room>" [--level easy|normal|hard] [--minutes 30]');
  process.exit(2);
}
const level = opt('level', 'normal');
const minutes = Number(opt('minutes', '30'));
const extra = opt('query', ''); // e.g. relay=ws://localhost:7777 for local testing

const u = new URL(link);
u.searchParams.set('bot', level);
for (const [k, v] of new URLSearchParams(extra)) u.searchParams.set(k, v);
const botUrl = u.toString().replace(/=(?=&|#|$)/g, ''); // ?bot&debug rather than ?bot=&debug=

(async () => {
  const browser = await chromium.launch({
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text()); });
  page.on('pageerror', (e) => console.log('[page exception]', e.message));
  const deadline = Date.now() + minutes * 60_000;
  console.log(`Bot (${level}) joining ${botUrl} for up to ${minutes} min`);
  await page.goto(botUrl);
  let lastLine = '', menuSince = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const s = await page.evaluate(() => {
      const g = window.__iso;
      const el = document.querySelector('.bot-status');
      const sess = g.session;
      return {
        mode: g.mode, lobby: g.lobby.kind, status: el ? el.textContent : '',
        rtt: sess ? Math.round(sess.stats.rttMs) : null, desync: sess ? sess.stats.desyncFrame : null, rollbacks: sess ? sess.stats.rollbacks : null,
      };
    }).catch(() => null);
    if (!s) continue;
    const line = `${s.status}${s.rtt !== null ? ` [${s.rtt} ms, ${s.rollbacks} rollbacks${s.desync !== null ? `, DESYNC at ${s.desync}` : ''}]` : ''}`;
    if (line !== lastLine) { console.log(new Date().toISOString().slice(11, 19), line); lastLine = line; }
    // Back at the menu (match closed): rejoin the same link after a short wait, in case the host returns.
    if (s.mode === 'lobby' && s.lobby === 'menu') {
      menuSince ||= Date.now();
      if (Date.now() - menuSince > 5000) { menuSince = 0; console.log('Rejoining…'); await page.goto('about:blank'); await page.goto(botUrl); }
    } else menuSince = 0;
  }
  console.log('Time is up. Bot leaving.');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
