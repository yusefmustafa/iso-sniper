/**
 * Merge the four players' stats from a stress test (one folder each, as the
 * workflow downloads them) into a Markdown summary, and check that every
 * machine computed the same game state.
 *
 *   node tools/stress-report.cjs results/ > summary.md
 */
const fs = require('fs');
const path = require('path');
const dir = process.argv[2] || 'results';
const runs = fs.readdirSync(dir).map((d) => path.join(dir, d, 'stats.json')).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
runs.sort((a, b) => (a.final?.local ?? 9) - (b.final?.local ?? 9));
const lines = ['# Free-for-all stress test', ''];
if (!runs.length) { console.log('No results.'); process.exit(1); }
const maps = runs.map((r) => new Map(r.hashes));
let common = 0, bad = 0, firstBad = null;
for (const [f, h] of maps[0]) {
  if (!maps.every((m) => m.has(f))) continue;
  common++;
  if (!maps.every((m) => m.get(f) === h)) { bad++; firstBad ??= f; }
}
lines.push(`**State check:** ${bad === 0 ? `all ${runs.length} machines agree on ${common} sampled frames (no desync)` : `${bad} of ${common} sampled frames differ, first at frame ${firstBad}`}.`, '');
lines.push('| Player | Frames | Input delay | Rollbacks | Rollbacks/s (avg) | Deepest rollback seen | Ticks waited | Worst ping | Drops | Desync |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
for (const r of runs) {
  const f = r.final ?? {};
  const s = r.samples.filter((x) => x.t > 0);
  const secs = s.length ? s.at(-1).t : 0;
  const rtts = s.flatMap((x) => x.peers.map((p) => p.rttMs));
  const deepest = Math.max(0, ...s.map((x) => x.rollbackFrames));
  lines.push(`| ${r.name} | ${f.frame ?? '–'} | ${[...new Set(s.map((x) => x.inputDelay))].join('→') || '–'} | ${f.rollbacks ?? '–'} | ${secs ? (f.rollbacks / secs).toFixed(1) : '–'} | ${deepest} f | ${f.stalls ?? '–'} (${f.frame ? ((100 * f.stalls) / (f.frame + f.stalls)).toFixed(1) : 0}%) | ${rtts.length ? Math.round(Math.max(...rtts)) : '–'} ms | ${f.drops ?? 0} | ${f.desyncFrame ?? 'none'} |`);
}
lines.push('', '## Ping between players (ms, average over the match)', '');
const slotNames = runs[0].names ?? runs.map((r) => r.name);
lines.push(`| | ${slotNames.join(' | ')} |`, `|---|${slotNames.map(() => '---').join('|')}|`);
for (const r of runs) {
  const owners = r.final?.owners ?? [];
  const sum = new Map();
  for (const x of r.samples) for (const p of x.peers) { if (!p.rttMs) continue; const a = sum.get(p.id) ?? []; a.push(p.rttMs); sum.set(p.id, a); }
  const cell = (i) => {
    if (i === r.final?.local) return '–';
    const a = sum.get(owners[i]);
    return a ? String(Math.round(a.reduce((x, y) => x + y, 0) / a.length)) : '';
  };
  lines.push(`| ${r.name} | ${slotNames.map((_, i) => cell(i)).join(' | ')} |`);
}
lines.push('', `Final score: ${runs[0].samples.at(-1)?.score.join(' - ') ?? '–'} (${(runs[0].names ?? []).join(', ')})`);
console.log(lines.join('\n'));
process.exit(bad ? 1 : 0);
