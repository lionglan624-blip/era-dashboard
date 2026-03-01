const pty = require('node-pty');
const path = require('path');
const fs = require('fs');

// Minimal VtScreenBuffer (same as ratelimitService.js)
class VtScreenBuffer {
  constructor(cols, rows, { retainText = false } = {}) {
    this.cols = cols; this.rows = rows; this.retainText = retainText;
    this.buffer = []; this.cx = 0; this.cy = 0;
    for (let i = 0; i < rows; i++) this.buffer.push(new Array(cols).fill(' '));
  }
  feed(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') { i = this._parseEscape(data, i + 1); }
      else if (ch === '\r') { this.cx = 0; i++; }
      else if (ch === '\n') { this.cy = Math.min(this.cy + 1, this.rows - 1); i++; }
      else if (ch === '\t') { this.cx = Math.min(this.cx + (8 - this.cx % 8), this.cols - 1); i++; }
      else if (ch === '\x07' || ch === '\x08') { if (ch === '\x08') this.cx = Math.max(0, this.cx - 1); i++; }
      else if (ch.charCodeAt(0) < 32) { i++; }
      else {
        if (this.cx < this.cols && this.cy < this.rows) {
          if (!this.retainText || ch !== ' ' || this.buffer[this.cy][this.cx] === ' ') {
            this.buffer[this.cy][this.cx] = ch;
          }
          this.cx++;
        }
        i++;
      }
    }
  }
  _parseEscape(data, i) {
    if (i >= data.length) return i;
    if (data[i] === '[') return this._parseCSI(data, i + 1);
    if (data[i] === ']') return this._skipOSC(data, i + 1);
    return i + 1;
  }
  _parseCSI(data, i) {
    let params = '';
    while (i < data.length && data[i] >= '\x20' && data[i] <= '\x3f') { params += data[i]; i++; }
    if (i < data.length) { this._handleCSI(params, data[i]); i++; }
    return i;
  }
  _skipOSC(data, i) {
    while (i < data.length) {
      if (data[i] === '\x07') return i + 1;
      if (data[i] === '\x1b' && i + 1 < data.length && data[i + 1] === '\\') return i + 2;
      i++;
    }
    return i;
  }
  _handleCSI(params, cmd) {
    const parts = params.replace(/\?/g, '').split(';').map(s => parseInt(s) || 0);
    switch (cmd) {
      case 'A': this.cy = Math.max(0, this.cy - (parts[0] || 1)); break;
      case 'B': this.cy = Math.min(this.rows - 1, this.cy + (parts[0] || 1)); break;
      case 'C': this.cx = Math.min(this.cols - 1, this.cx + (parts[0] || 1)); break;
      case 'D': this.cx = Math.max(0, this.cx - (parts[0] || 1)); break;
      case 'H': case 'f':
        this.cy = Math.max(0, Math.min(this.rows - 1, (parts[0] || 1) - 1));
        this.cx = Math.max(0, Math.min(this.cols - 1, (parts[1] || 1) - 1));
        break;
      case 'G': this.cx = Math.max(0, Math.min(this.cols - 1, (parts[0] || 1) - 1)); break;
      case 'J':
        if (this.retainText) break;
        if (parts[0] === 2 || parts[0] === 3) { for (let r = 0; r < this.rows; r++) this.buffer[r].fill(' '); }
        else if (parts[0] === 0 || params === '') {
          for (let c = this.cx; c < this.cols; c++) this.buffer[this.cy][c] = ' ';
          for (let r = this.cy + 1; r < this.rows; r++) this.buffer[r].fill(' ');
        }
        break;
      case 'K':
        if (this.retainText) break;
        if ((parts[0] || 0) === 0) { for (let c = this.cx; c < this.cols; c++) this.buffer[this.cy][c] = ' '; }
        else if (parts[0] === 2) { this.buffer[this.cy].fill(' '); }
        break;
    }
  }
  getText() {
    return this.buffer.map(row => row.join('').trimEnd()).filter(l => l.length > 0).join('\n');
  }
}

// --- Main ---
const mode = process.argv[2] || 'usage';  // 'usage' (default) or 'banner'
const profile = process.argv[3] || 'google';
const configDir = path.join(process.env.USERPROFILE, '.ccs', 'instances', profile);
console.log(`Mode: ${mode} | Profile: ${profile}`);
console.log(`Spawning claude via node-pty...`);

const p = pty.spawn('cmd.exe', ['/c', 'claude'], {
  cols: 120, rows: 30,
  env: (() => { const e = { ...process.env, FORCE_COLOR: '0', CLAUDE_CONFIG_DIR: configDir }; delete e.CLAUDECODE; return e; })()
});
console.log('PID:', p.pid);

let rawOutput = '';
const screen = new VtScreenBuffer(120, 30, { retainText: true });
let tuiDetected = false;
let usageSent = false;

p.onData(d => {
  rawOutput += d;
  screen.feed(d);

  if (mode !== 'usage' || usageSent) return;

  const text = screen.getText();
  // Detect TUI loaded
  if (!tuiDetected && (/Context:\d+%/.test(text) || /\d+%\s+of\s+your\s+(weekly|session)\s+limit/i.test(text))) {
    tuiDetected = true;
    console.log('[TUI detected] Waiting 1.5s to stabilize...');
    setTimeout(() => {
      if (!usageSent) {
        usageSent = true;
        console.log('[Typing /usage]');
        p.write('/usage');
        // Wait 800ms for autocomplete to settle, then press Enter
        setTimeout(() => {
          console.log('[Pressing Enter]');
          p.write('\r');
        }, 800);
      }
    }, 1500);
  }
});
p.onExit(({ exitCode }) => { console.log('Process exited:', exitCode); });

// /usage mode: wait 15s total (TUI startup + /usage response)
// banner mode: wait 12s (original)
const totalTimeout = mode === 'usage' ? 15000 : 12000;

setTimeout(() => {
  const text = screen.getText();
  const tmpDir = path.resolve(__dirname, '..', '..', '_out', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, `pty-raw-${profile}.txt`), rawOutput, 'utf8');
  fs.writeFileSync(path.join(tmpDir, `pty-screen-${profile}.txt`), text, 'utf8');

  console.log('=== SCREEN BUFFER OUTPUT ===');
  console.log(text);

  console.log('\n=== RATE LIMIT BANNER ===');
  const bannerMatch = text.match(/(\d+)%\s+of\s+your\s+(weekly|session)\s+limit/i);
  console.log(bannerMatch ? `YES: ${bannerMatch[1]}% ${bannerMatch[2]}` : 'NO');

  console.log('\n=== /USAGE OUTPUT (positional parse) ===');
  // Find section headers
  const sessionIdx = text.search(/Current\s*t?session/i);
  const weekAllIdx = text.search(/Current\s+week\s*\(all/i);
  const sonnetIdx = text.search(/Sonnet\s+only/i);
  console.log(`Section positions: session=${sessionIdx}, weekAll=${weekAllIdx}, sonnet=${sonnetIdx}`);

  // Find all "XX% used" (tolerant of retainText artifacts)
  const pctPattern = /(\d+)%[^\d%]{0,15}used/gi;
  let m;
  const pcts = [];
  while ((m = pctPattern.exec(text)) !== null) pcts.push({ pct: m[1], idx: m.index });
  console.log('Percent matches:', pcts.map(p => `${p.pct}% @${p.idx}`).join(', ') || 'NONE');

  // Find all "Resets ..." lines
  const rstPattern = /Resets\s+(.+?)(?:\s*\(|$)/gim;
  const rsts = [];
  while ((m = rstPattern.exec(text)) !== null) rsts.push({ val: m[1].trim(), idx: m.index });
  console.log('Resets matches:', rsts.map(r => `"${r.val}" @${r.idx}`).join(', ') || 'NONE');

  // Map to sections
  const sections = [
    { type: 'Session', idx: sessionIdx },
    { type: 'Week(all)', idx: weekAllIdx },
    { type: 'Week(Sonnet)', idx: sonnetIdx },
  ].filter(s => s.idx >= 0).sort((a, b) => a.idx - b.idx);

  for (const sec of sections) {
    const nextSecIdx = sections.find(s => s.idx > sec.idx)?.idx ?? Infinity;
    const pct = pcts.find(p => p.idx > sec.idx && p.idx < nextSecIdx);
    const rst = rsts.find(r => r.idx > sec.idx && r.idx < nextSecIdx);
    console.log(`${sec.type}: ${pct ? pct.pct + '%' : 'NOT FOUND'} (resets ${rst?.val || 'N/A'})`);
  }

  console.log(`\nFiles saved to _out/tmp/pty-raw-${profile}.txt and _out/tmp/pty-screen-${profile}.txt`);

  try { p.kill(); } catch {}
  try { require('child_process').execSync(`taskkill /F /T /PID ${p.pid}`, { windowsHide: true, stdio: 'ignore' }); } catch {}
  process.exit(0);
}, totalTimeout);
