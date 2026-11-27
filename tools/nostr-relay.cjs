/** Minimal in-memory Nostr relay for testing online play without the public relays (npm run relay). */
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: 7777 });
const subs = new Map(); // ws -> Map(subId, filters)
const store = [];
const match = (f, e) => {
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.since && e.created_at < f.since) return false;
  if (f.until && e.created_at > f.until) return false;
  for (const k of Object.keys(f)) if (k[0] === '#') { const vals = f[k]; if (!e.tags.some(t => t[0] === k.slice(1) && vals.includes(t[1]))) return false; }
  return true;
};
wss.on('connection', (ws) => {
  subs.set(ws, new Map());
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m[0] === 'EVENT') {
      const e = m[1]; store.push(e); if (store.length > 500) store.shift();
      ws.send(JSON.stringify(['OK', e.id, true, '']));
      for (const [c, s] of subs) for (const [id, fs] of s) if (fs.some(f => match(f, e))) c.send(JSON.stringify(['EVENT', id, e]));
    } else if (m[0] === 'REQ') {
      const [, id, ...fs] = m; subs.get(ws).set(id, fs);
      for (const e of store) if (fs.some(f => match(f, e))) ws.send(JSON.stringify(['EVENT', id, e]));
      ws.send(JSON.stringify(['EOSE', id]));
    } else if (m[0] === 'CLOSE') subs.get(ws).delete(m[1]);
  });
  ws.on('close', () => subs.delete(ws));
});
console.log('relay on 7777');
