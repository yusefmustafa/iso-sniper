/**
 * Turn a stress test's recordings (one folder per player with pov.webm and
 * stats.json) into MP4s: each player's view, plus all four side by side,
 * lined up on the moment each one's match started.
 *
 *   node tools/stress-video.cjs results/ videos/
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [dir = 'results', out = 'videos'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const runs = fs.readdirSync(dir).map((d) => path.join(dir, d)).filter((d) => fs.existsSync(path.join(d, 'pov.webm')) && fs.existsSync(path.join(d, 'stats.json')))
  .map((d) => ({ d, s: JSON.parse(fs.readFileSync(path.join(d, 'stats.json'), 'utf8')) }))
  .filter((r) => r.s.matchStart)
  .sort((a, b) => (a.s.final?.local ?? 9) - (b.s.final?.local ?? 9));
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-');
for (const r of runs) {
  r.skip = Math.max(0, (r.s.matchStart - r.s.videoStart) / 1000 - 3); // keep the countdown
  ff(['-ss', r.skip.toFixed(2), '-i', path.join(r.d, 'pov.webm'), ...enc, path.join(out, `pov-${slug(r.s.name)}.mp4`)]);
}
if (runs.length >= 2) {
  const inputs = runs.flatMap((r) => ['-ss', r.skip.toFixed(2), '-i', path.join(r.d, 'pov.webm')]);
  const labels = runs.map((r, i) => `[${i}:v]scale=960:540,setsar=1,drawtext=text='${r.s.name.replace(/[^A-Za-z0-9 ]/g, '')}':x=12:y=h-34:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=6[v${i}]`);
  const n = runs.length;
  const layout = n === 2 ? 'hstack=inputs=2' : n === 3 ? 'xstack=inputs=3:layout=0_0|w0_0|0_h0' : 'xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0';
  const filter = `${labels.join(';')};${runs.map((_, i) => `[v${i}]`).join('')}${layout}:shortest=1,scale=1920:-2[out]`;
  try {
    ff([...inputs, '-filter_complex', filter, '-map', '[out]', ...enc, path.join(out, 'all-four.mp4')]);
  } catch {
    // ffmpeg without drawtext: the same grid without names.
    const plain = `${runs.map((_, i) => `[${i}:v]scale=960:540,setsar=1[v${i}]`).join(';')};${runs.map((_, i) => `[v${i}]`).join('')}${layout}:shortest=1,scale=1920:-2[out]`;
    ff([...inputs, '-filter_complex', plain, '-map', '[out]', ...enc, path.join(out, 'all-four.mp4')]);
  }
}
console.log(fs.readdirSync(out).join('\n'));
