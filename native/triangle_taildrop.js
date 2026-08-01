#!/usr/bin/env node
// Triangle Downloader — Taildrop bridge (Chrome native messaging host), Node build.
// Functionally identical to triangle_taildrop.py — pick whichever runtime you
// prefer at install time. Python 3 ships with macOS; Node does not, but if you
// already have it this avoids depending on the system python.
//
// Protocol: little-endian uint32 length + UTF-8 JSON, on stdin/stdout.
//   {"cmd":"ping"}                                    -> {ok, tailscale, version}
//   {"cmd":"devices"}                                 -> {ok, devices:[{name,host,online}]}
//   {"cmd":"send","path":"...","target":"host"}       -> {ok} | {ok:false, error}

'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The CLI lives in different places depending on how Tailscale was installed.
// The Mac App Store build is sandboxed and has no `file cp`.
const CANDIDATES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale',
  '/usr/sbin/tailscale',
];

function findTailscale() {
  for (const p of CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) {}
  }
  return null;
}

function run(bin, args, timeout) {
  return new Promise((resolve) => {
    // stdio 'pipe' keeps the child off our stdin — that is the native-messaging
    // channel, and a child that prompts (smbutil without -N) would corrupt it.
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      (err, stdout, stderr) => {
      resolve({ code: err ? (err.code == null ? -1 : err.code) : 0, stdout, stderr, killed: !!(err && err.killed) });
    });
  });
}

function writeMessage(obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([len, buf]));
}

async function cmdPing(ts) {
  const r = await run(ts, ['version'], 15000);
  return { ok: true, tailscale: ts, version: String(r.stdout || '').trim().split('\n').slice(0, 1) };
}

async function cmdDevices(ts) {
  const r = await run(ts, ['status', '--json'], 20000);
  if (r.code !== 0) return { ok: false, error: String(r.stderr || 'tailscale status failed').trim() };
  let st;
  try { st = JSON.parse(r.stdout); } catch (e) { return { ok: false, error: 'не разобрать ответ tailscale' }; }
  const me = st.Self || {};
  const devices = [];
  for (const peer of Object.values(st.Peer || {})) {
    // Taildrop only works between devices owned by the same user
    if (me.UserID != null && peer.UserID !== me.UserID) continue;
    const dns = String(peer.DNSName || '').replace(/\.$/, '');
    const host = peer.HostName || dns.split('.')[0];
    devices.push({ name: host, host: dns.split('.')[0] || host, online: !!peer.Online, self: false });
  }
  devices.sort((a, b) => (a.online === b.online ? a.name.localeCompare(b.name) : (a.online ? -1 : 1)));
  return { ok: true, devices, self: me.HostName };
}

async function cmdSend(ts, msg) {
  const p = msg.path || '';
  const target = String(msg.target || '').trim();
  if (!p || !target) return { ok: false, error: 'не указан файл или устройство' };

  let real;
  try { real = fs.realpathSync(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p); }
  catch (e) { return { ok: false, error: 'файл не найден: ' + p }; }

  const home = fs.realpathSync(os.homedir());
  if (!real.startsWith(home + path.sep)) return { ok: false, error: 'путь вне домашней папки — отклонено' };
  if (!fs.statSync(real).isFile()) return { ok: false, error: 'это не файл: ' + real };

  // the target must be a real peer, never a free-form string
  const known = await cmdDevices(ts);
  if (!known.ok) return known;
  const names = new Set(known.devices.flatMap((d) => [d.host, d.name]));
  if (!names.has(target)) return { ok: false, error: 'устройство не найдено в сети: ' + target };

  const r = await run(ts, ['file', 'cp', real, target + ':'], 3600 * 1000);
  if (r.code !== 0) {
    if (r.killed) return { ok: false, error: 'tailscale не ответил вовремя' };
    return { ok: false, error: String(r.stderr || r.stdout || '').trim() || ('код ' + r.code) };
  }
  return { ok: true, sent: path.basename(real), target };
}

// ---- SMB -------------------------------------------------------------------
// Mounting needs credentials, which this helper deliberately never handles:
// mount the share once in Finder (⌘K) and it appears here as a folder under
// /Volumes. Discovery is Bonjour-only — it just reports what exists.
const { spawn } = require('child_process');

function cmdSmbMounted() {
  return new Promise((resolve) => {
    execFile('/sbin/mount', [], { timeout: 10000 }, (err, stdout) => {
      const out = [];
      for (const line of String(stdout || '').split('\n')) {
        if (!line.includes('smbfs') || !line.includes(' on ')) continue;
        const i = line.indexOf(' on ');
        const src = line.slice(0, i);
        const rest = line.slice(i + 4);
        const mnt = rest.slice(0, rest.lastIndexOf(' ('));
        if (!mnt) continue;
        let writable = false;
        try { fs.accessSync(mnt, fs.constants.W_OK); writable = true; } catch (e) {}
        out.push({ path: mnt, name: path.basename(mnt) || mnt, url: src, freeMb: null, writable });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      resolve({ ok: true, mounted: out });
    });
  });
}

// dns-sd never exits on its own — let it collect, then stop it.
function browse(args, seconds) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn('/usr/bin/dns-sd', args, { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { return resolve(''); }
    let buf = '';
    p.stdout.on('data', (d) => { buf += d.toString(); });
    p.on('error', () => resolve(''));
    setTimeout(() => { try { p.kill(); } catch (e) {} resolve(buf); }, seconds * 1000);
  });
}

async function cmdSmbDiscover(seconds) {
  const text = await browse(['-B', '_smb._tcp', 'local.'], seconds || 4);
  const names = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    // Timestamp A/R Flags if Domain Service-Type Instance-Name...
    if (parts.length >= 7 && parts[1] === 'Add' && parts[5].startsWith('_smb')) {
      const name = parts.slice(6).join(' ').trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  const servers = [];
  for (const name of names.slice(0, 8)) { // each resolve costs another wait
    const res = await browse(['-L', name, '_smb._tcp', 'local.'], 2);
    let host = null;
    for (const line of res.split('\n')) {
      const k = line.indexOf('can be reached at');
      if (k >= 0) { host = line.slice(k + 17).trim().split(':')[0].replace(/\.$/, ''); break; }
    }
    servers.push({ name, host });
  }
  return { ok: true, servers,
           hint: 'смонтируйте нужную шару в Finder (⌘K), после этого она появится в списке папок' };
}

async function cmdSmbShares(msg) {
  const host = String(msg.host || '').trim();
  if (!host) return { ok: false, error: 'не указан сервер' };
  if (!/^[A-Za-z0-9.\-_]+$/.test(host)) return { ok: false, error: 'недопустимое имя сервера' };
  // -N: never prompt for a password. The guest flag spelling varies between macOS
  // releases, so try the guest form first and fall back to plain -N.
  let r = null;
  for (const flags of [['-N', '-g'], ['-N']]) {
    r = await run('/usr/bin/smbutil', ['view', ...flags, '//' + host], 20000);
    if (r.code === 0) break;
  }
  if (r.code !== 0) {
    return { ok: false, error: String(r.stderr || r.stdout || '').trim() ||
      'не удалось получить список — вероятно, нужен вход, смонтируйте шару в Finder' };
  }
  const shares = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && /^(disk|диск)$/i.test(parts[1])) shares.push(parts[0]);
  }
  return { ok: true, host, shares };
}

async function cmdSmbSave(msg) {
  const src = msg.path || '';
  const dstDir = msg.dir || '';
  if (!src || !dstDir) return { ok: false, error: 'не указан файл или папка' };

  let real;
  try { real = fs.realpathSync(src.startsWith('~') ? path.join(os.homedir(), src.slice(1)) : src); }
  catch (e) { return { ok: false, error: 'файл не найден: ' + src }; }
  const home = fs.realpathSync(os.homedir());
  if (!real.startsWith(home + path.sep)) return { ok: false, error: 'путь вне домашней папки — отклонено' };

  let dstReal;
  try { dstReal = fs.realpathSync(dstDir); } catch (e) { return { ok: false, error: 'папка не найдена: ' + dstDir }; }
  const known = (await cmdSmbMounted()).mounted.map((m) => m.path);
  const inside = known.some((k) => dstReal === k || dstReal.startsWith(k.replace(/\/$/, '') + path.sep));
  if (!inside) return { ok: false, error: 'папка не является смонтированной SMB-шарой: ' + dstReal };
  try { fs.accessSync(dstReal, fs.constants.W_OK); }
  catch (e) { return { ok: false, error: 'нет прав на запись: ' + dstReal }; }

  let target = path.join(dstReal, path.basename(real));
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  let n = 1;
  while (fs.existsSync(target)) { target = base + ' (' + n + ')' + ext; n++; } // never overwrite
  try { fs.copyFileSync(real, target); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  return { ok: true, saved: target };
}

// FTP upload via curl; credentials go through a 0600 temp config file, never
// through argv (argv is visible in `ps`).
async function cmdFtpPut(msg) {
  const src = msg.path || '';
  const host = String(msg.host || '').trim();
  if (!src || !host) return { ok: false, error: 'не указан файл или сервер' };
  if (!/^[A-Za-z0-9.\-_]+$/.test(host)) return { ok: false, error: 'недопустимое имя сервера' };

  let real;
  try { real = fs.realpathSync(src.startsWith('~') ? path.join(os.homedir(), src.slice(1)) : src); }
  catch (e) { return { ok: false, error: 'файл не найден: ' + src }; }
  const home = fs.realpathSync(os.homedir());
  if (!real.startsWith(home + path.sep)) return { ok: false, error: 'путь вне домашней папки — отклонено' };

  const port = Number(msg.port) || 21;
  const dir = String(msg.dir || '').split('/').filter((p) => p && p !== '..').join('/');
  const url = 'ftp://' + host + ':' + port + '/' + (dir ? dir + '/' : '') + path.basename(real);

  const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cfgFile = path.join(os.tmpdir(), 'ytdl-ftp-' + process.pid + '-' + Date.now());
  fs.writeFileSync(cfgFile, 'user = "' + q(msg.user || 'anonymous') + ':' + q(msg.pass || '') + '"\n', { mode: 0o600 });
  let r;
  try {
    r = await run('curl', ['-sS', '--connect-timeout', '15', '--ftp-create-dirs',
      '--config', cfgFile, '-T', real, url], 3600 * 1000);
  } finally {
    try { fs.unlinkSync(cfgFile); } catch (e) {}
  }
  if (r.code !== 0) return { ok: false, error: String(r.stderr || '').trim() || ('curl код ' + r.code) };
  return { ok: true, sent: path.basename(real), target: host };
}

async function handle(ts, msg) {
  // SMB and FTP commands do not need Tailscale at all
  switch (msg.cmd) {
    case 'smb-mounted': return cmdSmbMounted();
    case 'smb-discover': return cmdSmbDiscover(Number(msg.seconds) || 4);
    case 'smb-shares': return cmdSmbShares(msg);
    case 'smb-save': return cmdSmbSave(msg);
    case 'ftp-put': return cmdFtpPut(msg);
  }
  if (!ts) {
    return { ok: false, error: 'не найден CLI tailscale — установите Tailscale с tailscale.com ' +
                              '(версия из App Store не умеет file cp)' };
  }
  switch (msg.cmd) {
    case 'ping': return cmdPing(ts);
    case 'devices': return cmdDevices(ts);
    case 'send': return cmdSend(ts, msg);
    default: return { ok: false, error: 'неизвестная команда: ' + msg.cmd };
  }
}

// ---- stdin framing ---------------------------------------------------------
const ts = findTailscale();
let buf = Buffer.alloc(0);
let busy = Promise.resolve();

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const body = buf.slice(4, 4 + len);
    buf = buf.slice(4 + len);
    let msg;
    try { msg = JSON.parse(body.toString('utf8')); }
    catch (e) { writeMessage({ ok: false, error: 'плохое сообщение' }); continue; }
    // keep replies in request order even though handlers are async
    busy = busy.then(() => handle(ts, msg))
      .then(writeMessage)
      .catch((e) => writeMessage({ ok: false, error: String((e && e.message) || e) }));
  }
});

process.stdin.on('end', () => { busy.then(() => process.exit(0)); });
