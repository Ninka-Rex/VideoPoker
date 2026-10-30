// Minimal mDNS responder: makes <name>.local resolve to this PC on the local network, so phones and other
// computers can open the site by name. No packages needed.
//   node mdns.js [name]                announce on its own (default name: videopoker)
//   require('./mdns').announce(name)   used by serve.js
// It answers with the IPv4 and IPv6 addresses of the network adapter the question arrived on. Giving an IPv6
// address matters: Windows asks for both and, when there is no IPv6 answer, waits ~14 s before using the IPv4 one.
const dgram = require('dgram'), os = require('os');
const GROUP = '224.0.0.251', PORT = 5353, A = 1, AAAA = 28, NSEC = 47, ANY = 255;

// this PC's adapters that have a LAN IPv4 address: [{ v4: [{address, netmask}], v6: [address] }]
function adapters() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    const v4 = (list || []).filter(a => (a.family === 'IPv4' || a.family === 4) && !a.internal);
    const v6 = (list || []).filter(a => (a.family === 'IPv6' || a.family === 6) && !a.internal).map(a => a.address);
    if (v4.length) out.push({ v4, v6 });
  }
  return out;
}
const toInt = ip => ip.split('.').reduce((n, b) => (n << 8 | +b) >>> 0, 0);
// the adapter on the asker's subnet (all adapters if none matches)
function pick(from) {
  const all = adapters();
  const same = from ? all.filter(n => n.v4.some(a => ((toInt(a.address) ^ toInt(from)) & toInt(a.netmask)) === 0)) : [];
  const use = same.length ? same : all;
  return { v4: [].concat(...use.map(n => n.v4.map(a => a.address))), v6: [].concat(...use.map(n => n.v6)) };
}

const encName = name => Buffer.concat(name.split('.').map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])).concat([Buffer.from([0])]));
function v6bytes(ip) {
  ip = ip.split('%')[0];
  const [l, r = ''] = ip.split('::'), L = l ? l.split(':') : [], R = r ? r.split(':') : [];
  const words = ip.includes('::') ? L.concat(Array(8 - L.length - R.length).fill('0'), R) : L;
  const b = Buffer.alloc(16); words.forEach((w, i) => b.writeUInt16BE(parseInt(w, 16) || 0, i * 2)); return b;
}

// read a (possibly compressed) name at offset; returns [name, offset after it]
function readName(buf, off) {
  const labels = []; let end = -1, jumps = 0;
  for (;;) {
    if (off >= buf.length || jumps > 20) throw new Error('bad name');
    const len = buf[off];
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) { if (end < 0) end = off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; jumps++; continue; }
    labels.push(buf.toString('latin1', off + 1, off + 1 + len)); off += 1 + len;
  }
  return [labels.join('.'), end < 0 ? off : end];
}

function record(host, type, ttl, data) {
  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(type, 0);
  rr.writeUInt16BE(0x8001, 2);   // class IN, cache-flush (we are the only owner of this name)
  rr.writeUInt32BE(ttl, 4);
  rr.writeUInt16BE(data.length, 8);
  return Buffer.concat([encName(host), rr, data]);
}
// NSEC: "this name has these record types and no others", so nobody waits for a type we don't have (RFC 6762 6.1)
const nsec = (host, ttl, has6) => record(host, NSEC, ttl, Buffer.concat([encName(host), Buffer.from(has6 ? [0, 4, 0x40, 0, 0, 0x08] : [0, 1, 0x40])]));
function packet(id, question, answers, extra) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0); h.writeUInt16BE(0x8400, 2);   // response, authoritative
  h.writeUInt16BE(question ? 1 : 0, 4); h.writeUInt16BE(answers.length, 6); h.writeUInt16BE(extra.length, 10);
  return Buffer.concat([h].concat(question ? [question] : [], answers, extra));
}
// records for a question type: [answers, additional]
function reply(host, type, ttl, ips) {
  const a = ips.v4.map(ip => record(host, A, ttl, Buffer.from(ip.split('.').map(Number))));
  const aaaa = ips.v6.map(ip => record(host, AAAA, ttl, v6bytes(ip)));
  const no = nsec(host, ttl, aaaa.length > 0);
  if (type === A) return [a, aaaa.concat(no)];
  if (type === AAAA) return aaaa.length ? [aaaa, a.concat(no)] : [[no], a];
  if (type === ANY) return [a.concat(aaaa), [no]];
  return [[no], []];
}

function announce(name = 'videopoker', log = console.log) {
  const host = name.replace(/\.local\.?$/i, '').toLowerCase() + '.local';
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg, from) => {
    try {
      if (msg.length < 12 || (msg.readUInt16BE(2) & 0x8000)) return;   // ignore responses
      let off = 12;
      const n = msg.readUInt16BE(4);
      for (let i = 0; i < n; i++) {
        const [qname, next] = readName(msg, off);
        const qtype = msg.readUInt16BE(next), qclass = msg.readUInt16BE(next + 2); off = next + 4;
        if (qname.toLowerCase() !== host) continue;
        const ips = pick(from.address);
        if (!ips.v4.length) return;
        const legacy = from.port !== PORT;
        const [ans, extra] = reply(host, qtype, legacy ? 10 : 120, ips);
        if (legacy) {
          // one-shot query from an ordinary resolver: reply straight back, echoing its id and question
          const q = Buffer.concat([encName(host), msg.subarray(next, next + 4)]);
          sock.send(packet(msg.readUInt16BE(0), q, ans, extra), from.port, from.address);
        } else if (qclass & 0x8000) {
          sock.send(packet(0, null, ans, extra), from.port, from.address);   // asked for a unicast reply
        } else {
          // multicast back out of the adapter the question came in on
          try { sock.setMulticastInterface(ips.v4[0]); } catch (e) {}
          sock.send(packet(0, null, ans, extra), PORT, GROUP);
        }
        return;
      }
    } catch (e) { /* malformed packet */ }
  });

  // unsolicited announcement, sent twice as the mDNS spec asks; ttl 0 tells everyone the name is gone
  const shout = ttl => {
    for (const ad of adapters()) {
      const ips = { v4: ad.v4.map(a => a.address), v6: ad.v6 }, [ans, extra] = reply(host, ANY, ttl, ips);
      try { sock.setMulticastInterface(ad.v4[0].address); sock.send(packet(0, null, ans, extra), PORT, GROUP); } catch (e) {}
    }
  };
  sock.on('error', e => log('mDNS: ' + e.message + ' (' + host + ' will not resolve on other devices)'));
  sock.bind(PORT, () => {
    for (const ad of adapters()) for (const a of ad.v4) try { sock.addMembership(GROUP, a.address); } catch (e) {}
    sock.setMulticastTTL(255); sock.setMulticastLoopback(true);
    shout(120); setTimeout(() => shout(120), 1000).unref();
    log('mDNS: announcing ' + host + ' on ' + [].concat(...adapters().map(ad => ad.v4.map(a => a.address))).join(', '));
  });
  let bye = false;
  const stop = () => { if (bye) return; bye = true; shout(0); setTimeout(() => process.exit(), 100); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return { host, close: () => sock.close() };
}

module.exports = { announce };
if (require.main === module) announce(process.argv[2]);
