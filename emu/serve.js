// Minimal static server + ROM library: node serve.js [folder] [port] [--name=videopoker | --no-mdns]
// Also announces <name>.local on the local network (mdns.js) so other devices can open the site by name.
// Serves the VideoPoker folder, and /api/library lists the ROM sets it can find.
const http = require('http'), fs = require('fs'), path = require('path');
const direct = require.main === module;
const args = direct ? process.argv.slice(2) : [], pos = args.filter(a => !a.startsWith('--'));
const root = path.resolve(pos[0] || path.join(__dirname, '..')), port = +pos[1] || 8960;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

// Player's Edge (Plus) sets: a folder holding a .u58/.u68 program ROM; graphics and colour PROM
// may live in the same folder or any parent up to the library root.
function scanPE() {
  const out = [];
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    const prog = ents.filter(e => e.isFile() && /\.u(58|68)$/i.test(e.name) || /^(xp|xs|xk|xmp)\d+\.u67$/i.test(e.name) || /^pp\d+_[^_]*\.u67$/i.test(e.name) || /^\w*\d+v[yz]\.u65$/i.test(e.name));
    for (const p of prog) {
      const files = [];
      let d = dir;
      for (let i = 0; i < 4; i++) {
        const has = re => files.some(f => re.test(path.basename(f).toLowerCase()));
        const needCg = !has(/-c[gf]/), needCap = !has(/^cap[x\d]/), needSuper = !has(/^x(m?\d+)[a-z]\.u66$|_data_.*\.u66$/);
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (!e.isFile()) continue;
          const n = e.name.toLowerCase();
          if ((needCg && /^m[rgbx][o0]-c[gf]/.test(n)) || (needCap && /^cap[x\d]/.test(n)) || (needSuper && /^x(m?\d+)[a-z]\.u66$|_data_.*\.u66$/.test(n)) || (d === dir && e.name === p.name)) files.push(path.relative(root, path.join(d, e.name)).split(path.sep).join('/'));
        }
        if (has(/-c[gf]/) && has(/^cap[x\d]/)) break;
        d = path.dirname(d);
      }
      out.push({ kind: 'peplus', name: /^pe[a-z]+\d+/i.test(path.basename(dir)) ? path.basename(path.dirname(dir)) + ' · ' + path.basename(dir) : path.basename(dir), dir: path.relative(root, dir).split(path.sep).join('/'), prog: p.name, files });
    }
    if (depth < 4) for (const e of ents) if (e.isDirectory() && !e.name.startsWith('_')) walk(path.join(dir, e.name), depth + 1);
  };
  walk(path.join(root, 'ROMs'), 0);
  return out;
}

// IGT set chip (sets the denomination of programs that refuse to run without one): ROMs/Player's Edge Plus/_Set chips/<chip>
function scanSetChip() {
  const base = path.join(root, 'ROMs', "Player's Edge Plus", '_Set chips');
  let d; try { d = fs.readdirSync(base, { withFileTypes: true }).find(e => e.isDirectory()); } catch (e) { return null; }
  if (!d) return null;
  const dir = path.join(base, d.name);
  return { name: d.name, files: fs.readdirSync(dir).map(f => path.relative(root, path.join(dir, f)).split(path.sep).join('/')) };
}

// Draw 80 Poker: a folder holding pm0.u81 / pm1.u82 (program), cg0/cg1 (characters), cap13 (colour PROM)
function scanD80() {
  const out = [];
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    if (ents.some(e => e.isFile() && /^pm0\.u81$/i.test(e.name))) {
      out.push({ kind: 'draw80', name: path.basename(dir), dir: path.relative(root, dir).split(path.sep).join('/'),
        files: ents.filter(e => e.isFile()).map(e => path.relative(root, path.join(dir, e.name)).split(path.sep).join('/')) });
    }
    if (depth < 3) for (const e of ents) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  };
  walk(path.join(root, 'ROMs'), 0);
  return out;
}

// Game King sets: match the chip files of each set (see gkroms.js) anywhere under the ROM folder.
function scanGK() {
  const { SETS, patterns } = require('./gkroms.js');
  const all = [];
  const walk = d => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(p); } };
  walk(path.join(root, 'ROMs', 'Game King'));
  const out = [];
  for (const [id, s] of Object.entries(SETS)) {
    const files = {}; let ok = true;
    for (const [chip, re] of Object.entries(patterns(id))) {
      const f = all.find(p => re.test(path.basename(p)));
      if (f) files[chip] = path.relative(root, f).split(path.sep).join('/'); else if (!chip.startsWith('snd')) ok = false;
    }
    if (ok) out.push({ id, title: s.title, year: s.year, files, nv: fs.existsSync(path.join(__dirname, 'nv', id + '.nv')) ? 'emu/nv/' + id + '.nv' : null });
  }
  return out;
}

if (require.main !== module) { module.exports = { scanPE, scanD80, scanGK, scanSetChip, root }; return; }
http.createServer((q, r) => {
  const url = q.url.split('?')[0];
  if (url === '/api/library') {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    return r.end(JSON.stringify({ peplus: scanPE(), gameking: scanGK(), draw80: scanD80(), setchip: scanSetChip() }));
  }
  // the site's front page is emu/index.html; send the bare address there
  if (url === '/' && fs.existsSync(path.join(root, 'emu', 'index.html'))) { r.writeHead(302, { Location: '/emu/index.html' }); return r.end(); }
  const p = path.join(root, decodeURIComponent(url));
  if (!p.startsWith(root)) { r.writeHead(403); return r.end(); }
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); r.end(d); });
}).listen(port, () => {
  console.log('serving', root, 'on', port);
  if (args.includes('--no-mdns')) return;
  const name = (args.find(a => a.startsWith('--name=')) || '--name=videopoker').slice(7);
  const { host } = require('./mdns').announce(name);
  console.log('open http://' + host + (port === 80 ? '' : ':' + port) + '/');
});
