// offscreen.js — runs ffmpeg.wasm in an extension DOM context (a service worker
// can't host ffmpeg). Receives captured tracks in chunks, cuts SponsorBlock
// segments, muxes/merges, and hands the result to the background for saving.
//
// Two modes:
//   * single: one begin/chunk/finalize job (the classic flow);
//   * parallel: several tabs each deliver a fragment (par-begin/par-chunk/par-frag),
//     then the background asks for a merge (par-merge) — fragments are trimmed into
//     pieces (SponsorBlock intervals removed), concatenated in order and saved.
//
// Capture may start mid-video, so every captured file begins at an arbitrary
// timestamp. probeStart() reads the real start time from the ffmpeg log, and all
// -ss seeks are computed relative to it (ffmpeg treats input -ss as relative to
// the file's start_time).

const { FFmpeg } = FFmpegWASM;

let ff = null;
let ffLoading = null;
const acc = { video: [], audio: [], videoMime: '', audioMime: '', filename: 'video.mp4', sb: [] };
const par = Object.create(null); // task -> { frags: idx -> {video,audio,mimes,vBytes,aBytes} }
const ffLog = []; // ring buffer of recent ffmpeg log lines

async function getFF() {
  if (ff) return ff;
  if (ffLoading) return ffLoading;
  ffLoading = (async () => {
    const inst = new FFmpeg();
    inst.on('progress', ({ progress }) => {
      try { chrome.runtime.sendMessage({ t: 'ytdl-progress', value: Math.max(0, Math.min(1, progress)) }); } catch (e) {}
    });
    inst.on('log', ({ message }) => {
      ffLog.push(message);
      if (ffLog.length > 60) ffLog.shift();
    });
    const base = chrome.runtime.getURL('vendor/ffmpeg/');
    await inst.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
    ff = inst;
    return inst;
  })();
  return ffLoading;
}

function b64decode(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function extFor(mime) {
  if (/webm/i.test(mime)) return 'webm';
  if (/mp4/i.test(mime)) return 'mp4';
  return 'bin';
}
async function rm(inst, name) { try { await inst.deleteFile(name); } catch (e) {} }

// Real start timestamp of a captured file (mid-video captures start at ~capStart).
// `ffmpeg -i file` exits with an error but prints "Duration: ..., start: X" first.
async function probeStart(inst, name) {
  ffLog.length = 0;
  try { await inst.exec(['-hide_banner', '-i', name]); } catch (e) {}
  const m = ffLog.join('\n').match(/start:\s*(-?[\d.]+)/);
  return m ? Math.max(0, parseFloat(m[1])) : 0;
}

// ---- SponsorBlock interval math -------------------------------------------
function mergeCuts(segs, start, end) {
  const clipped = (segs || [])
    .map((s) => [Math.max(start, Number(s.start) || 0), Math.min(end, Number(s.end) || 0)])
    .filter(([a, b]) => b - a > 0.2)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const s of clipped) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 0.1) last[1] = Math.max(last[1], s[1]);
    else merged.push(s);
  }
  return merged;
}

function keepList(cuts, start, end) {
  const keep = [];
  let cur = start;
  for (const [a, b] of cuts) {
    if (a - cur > 0.5) keep.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (!isFinite(end)) keep.push([cur, null]);
  else if (end - cur > 0.5) keep.push([cur, end]);
  return keep;
}

function dropExpr(relCuts) {
  return relCuts.map(([a, b]) => 'between(t,' + a.toFixed(3) + ',' + b.toFixed(3) + ')').join('+');
}

// ---- single mode -----------------------------------------------------------
// Fast mode with SponsorBlock: stream-copy each kept span, then concat.
async function copyCutConcat(inst, vName, aName, keep, sV, sA) {
  const variants = [
    { ext: 'mp4', type: 'video/mp4', extra: ['-strict', '-2'], concatExtra: ['-movflags', '+faststart'] },
    { ext: 'webm', type: 'video/webm', extra: [], concatExtra: [] },
  ];
  let lastErr = '';
  for (const v of variants) {
    const made = [];
    const clean = async () => { for (const f of made) await rm(inst, f); await rm(inst, 'list.txt'); };
    let ok = true;
    for (let i = 0; i < keep.length; i++) {
      const [a, b] = keep[i];
      const part = 'part' + i + '.' + v.ext;
      const t = b != null ? ['-t', String(Math.max(0.1, b - a))] : [];
      ffLog.length = 0;
      const ret = await inst.exec([
        '-ss', String(Math.max(0, a - sV)), '-i', vName,
        '-ss', String(Math.max(0, a - sA)), '-i', aName,
        '-map', '0:v:0', '-map', '1:a:0', ...t, '-c', 'copy', ...v.extra, part,
      ]);
      if (ret !== 0) {
        lastErr = 'ffmpeg код ' + ret + ' (нарезка ' + v.ext + '): ' + ffLog.slice(-6).join(' | ');
        ok = false; break;
      }
      made.push(part);
    }
    if (ok) {
      await inst.writeFile('list.txt', new TextEncoder().encode(made.map((p) => "file '" + p + "'").join('\n')));
      ffLog.length = 0;
      const out = 'out.' + v.ext;
      const ret = await inst.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', ...v.concatExtra, out]);
      if (ret === 0) {
        try {
          const data = await inst.readFile(out);
          if (data && data.length) {
            await clean(); await rm(inst, out);
            return { data, chosen: { out, type: v.type, ext: '.' + v.ext }, lastErr: '' };
          }
        } catch (e) {}
      }
      lastErr = 'ffmpeg код ' + ret + ' (склейка ' + v.ext + '): ' + ffLog.slice(-6).join(' | ');
      await rm(inst, out);
    }
    await clean();
  }
  return { data: null, chosen: null, lastErr };
}

async function finalize() {
  const inst = await getFF();
  const isMp3 = acc.format === 'mp3';
  const aName = 'a.' + extFor(acc.audioMime);

  const aBytes = concat(acc.audio);
  acc.audio = [];
  if (!aBytes.length) throw new Error('пустые данные аудио');
  await inst.writeFile(aName, aBytes);

  let vName = null;
  if (!isMp3) {
    vName = 'v.' + extFor(acc.videoMime);
    const vBytes = concat(acc.video);
    acc.video = [];
    if (!vBytes.length) throw new Error('пустые данные видео');
    await inst.writeFile(vName, vBytes);
  }

  // capture may begin mid-video → learn the real file start times
  const sA = await probeStart(inst, aName);
  const sV = vName ? await probeStart(inst, vName) : 0;

  const start = Math.max(0, Number(acc.start) || 0);
  const end = Number(acc.end) || 0;
  const effEnd = end > start ? end : Infinity;
  const dur = isFinite(effEnd) ? effEnd - start : 0;
  const limit = dur > 0 ? ['-t', String(dur)] : [];
  const seekA = start - sA > 0.2 ? ['-ss', String(start - sA)] : [];
  const seekV = start - sV > 0.2 ? ['-ss', String(start - sV)] : [];
  const inV = vName ? [...seekV, '-i', vName] : [];
  const inA = [...seekA, '-i', aName];

  let cuts = mergeCuts(acc.sb, start, effEnd);
  let keep = keepList(cuts, start, effEnd);
  if (!keep.length) { cuts = []; keep = keepList([], start, effEnd); }
  const relCuts = cuts.map(([a, b]) => [Math.max(0, a - start), b - start]);
  const expr = relCuts.length ? dropExpr(relCuts) : '';

  let data = null, chosen = null, lastErr = '';

  if (!isMp3 && !acc.transcode && cuts.length) {
    ({ data, chosen, lastErr } = await copyCutConcat(inst, vName, aName, keep, sV, sA));
    if (!data) console.warn('[Triangle] вырезание в режиме copy не удалось, скачиваю без вырезания:', lastErr);
  }

  if (!data) {
    const runs = [];
    if (isMp3) {
      const af = expr ? ['-af', "aselect='not(" + expr + ")',asetpts=N/SR/TB"] : [];
      runs.push({
        out: 'out.mp3', type: 'audio/mpeg', ext: '.mp3',
        args: [...inA, ...limit, '-vn', ...af, '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'],
      });
    } else if (acc.transcode) {
      const maps = expr
        ? ['-filter_complex',
           "[0:v]select='not(" + expr + ")',setpts=N/FRAME_RATE/TB[v];" +
           "[1:a]aselect='not(" + expr + ")',asetpts=N/SR/TB[a]",
           '-map', '[v]', '-map', '[a]']
        : ['-map', '0:v:0', '-map', '1:a:0'];
      runs.push({
        out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
        args: [...inV, ...inA, ...maps, ...limit,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4'],
      });
    } else {
      runs.push({
        out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
        args: [...inV, ...inA, '-map', '0:v:0', '-map', '1:a:0', ...limit,
          '-c', 'copy', '-strict', '-2', '-movflags', '+faststart', 'out.mp4'],
      });
      runs.push({
        out: 'out.webm', type: 'video/webm', ext: '.webm',
        args: [...inV, ...inA, '-map', '0:v:0', '-map', '1:a:0', ...limit, '-c', 'copy', 'out.webm'],
      });
    }

    for (const run of runs) {
      ffLog.length = 0;
      const ret = await inst.exec(run.args);
      if (ret === 0) {
        try {
          data = await inst.readFile(run.out);
          if (data && data.length) { chosen = run; break; }
        } catch (e) { /* try next */ }
      }
      lastErr = 'ffmpeg код ' + ret + ': ' + ffLog.slice(-6).join(' | ');
      await rm(inst, run.out);
    }
    if (chosen) await rm(inst, chosen.out);
  }

  await rm(inst, aName);
  if (vName) await rm(inst, vName);
  acc.video = []; acc.audio = []; acc.sb = [];

  if (!chosen) throw new Error(lastErr || 'ffmpeg не собрал файл');
  return saveBlob(data, acc.filename, chosen);
}

async function saveBlob(data, baseName, chosen) {
  const filename = (baseName || 'video').replace(/\.(mp4|webm|mp3)$/i, '') + chosen.ext;
  const blob = new Blob([data.buffer], { type: chosen.type });
  const url = URL.createObjectURL(blob);
  const res = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename });
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
  if (!res || !res.ok) throw new Error((res && res.error) || 'save failed');
  // Network uploads happen HERE, not in the background: the finished file already
  // lives in this document as a Blob, so S3/WebDAV need no helper and no disk read.
  maybeUpload(blob, filename); // fire-and-forget; status arrives via notifications
  return filename;
}

// ---- direct uploads (no native helper required) ----------------------------
function note(message) {
  try { chrome.runtime.sendMessage({ t: 'ytdl-note', message }); } catch (e) {}
}

async function hmac(keyBytes, str) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(str)));
}
async function sha256hexStr(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

// Minimal AWS Signature V4 for a single PUT. UNSIGNED-PAYLOAD keeps us from
// hashing a multi-GB body in JS; S3 and MinIO both accept it over HTTPS.
async function s3Put(blob, filename, cfg) {
  const endpoint = new URL(cfg.endpoint);
  const region = cfg.region || 'us-east-1';
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const keyPath = ((cfg.prefix || '').replace(/^\/+|\/+$/g, '') + '/' + filename).replace(/^\/+/, '');
  const uri = '/' + enc(cfg.bucket) + '/' + keyPath.split('/').map(enc).join('/');

  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const day = now.slice(0, 8);
  const host = endpoint.host;

  const headers = {
    host,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-amz-date': now,
  };
  const signedList = Object.keys(headers).sort();
  const canonical = ['PUT', uri, '',
    ...signedList.map((h) => h + ':' + headers[h]), '',
    signedList.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = day + '/' + region + '/s3/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', now, scope, await sha256hexStr(canonical)].join('\n');

  let k = await hmac(new TextEncoder().encode('AWS4' + cfg.secret), day);
  k = await hmac(k, region);
  k = await hmac(k, 's3');
  k = await hmac(k, 'aws4_request');
  const sig = hex(await hmac(k, toSign));

  const auth = 'AWS4-HMAC-SHA256 Credential=' + cfg.key + '/' + scope +
    ', SignedHeaders=' + signedList.join(';') + ', Signature=' + sig;

  const r = await fetch(endpoint.origin + uri, {
    method: 'PUT',
    headers: {
      Authorization: auth,
      'x-amz-date': now,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'Content-Type': blob.type || 'application/octet-stream',
    },
    body: blob,
  });
  if (!r.ok) throw new Error('S3 HTTP ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
}

async function webdavPut(blob, filename, cfg) {
  const url = String(cfg.url || '').replace(/\/+$/, '') + '/' + encodeURIComponent(filename);
  const headers = {};
  if (cfg.user) headers.Authorization = 'Basic ' + btoa(cfg.user + ':' + (cfg.pass || ''));
  const r = await fetch(url, { method: 'PUT', headers, body: blob });
  if (!r.ok && r.status !== 201 && r.status !== 204) throw new Error('WebDAV HTTP ' + r.status);
}

async function maybeUpload(blob, filename) {
  let s = {};
  try { s = await chrome.storage.local.get(['dest', 's3cfg', 'wdcfg']); } catch (e) { return; }
  const type = s.dest && s.dest.type;
  try {
    if (type === 's3' && s.s3cfg && s.s3cfg.bucket) {
      note('S3: выгружаю ' + filename + '…');
      await s3Put(blob, filename, s.s3cfg);
      note('S3: выгружено — ' + filename);
    } else if (type === 'webdav' && s.wdcfg && s.wdcfg.url) {
      note('WebDAV: выгружаю ' + filename + '…');
      await webdavPut(blob, filename, s.wdcfg);
      note('WebDAV: выгружено — ' + filename);
    }
  } catch (e) {
    note('Выгрузка: ошибка — ' + String((e && e.message) || e));
  }
}

// ---- parallel merge --------------------------------------------------------
async function parMerge(msg) {
  const inst = await getFF();
  const state = par[msg.task];
  if (!state) throw new Error('нет данных задачи');
  const isMp3 = msg.format === 'mp3';

  const cuts = mergeCuts(msg.sb, msg.start, msg.end);
  let keep = keepList(cuts, msg.start, msg.end);
  if (!keep.length) keep = [[msg.start, msg.end]];

  // output order: intersect keep spans with fragment ranges → pieces
  const pieces = [];
  for (const [a, b] of keep) {
    for (const fr of msg.frags) {
      const x = Math.max(a, fr.s), y = Math.min(b == null ? msg.end : b, fr.e);
      if (y - x > 0.3) pieces.push({ frag: fr.idx, x, y });
    }
  }
  pieces.sort((p, q) => p.x - q.x);
  if (!pieces.length) throw new Error('нечего собирать');

  const pieceNames = new Array(pieces.length);
  let doneCount = 0;
  const prog = () => {
    try { chrome.runtime.sendMessage({ t: 'ytdl-par-merge-prog', task: msg.task, pct: doneCount / (pieces.length + 1) }); } catch (e) {}
  };

  // per fragment: write raw tracks once, cut all its pieces, free the raw data
  for (const fr of msg.frags) {
    const mine = pieces.map((p, i) => ({ p, i })).filter((z) => z.p.frag === fr.idx);
    if (!mine.length) continue;
    const d = state.frags[fr.idx];
    if (!d || !d.aName || (!isMp3 && !d.vName)) throw new Error('нет данных фрагмента ' + fr.idx);

    // already written into the ffmpeg FS when the fragment arrived
    const aN = d.aName;
    const vN = isMp3 ? null : d.vName;

    const sA = await probeStart(inst, aN);
    const sV = vN ? await probeStart(inst, vN) : 0;

    for (const z of mine) {
      const { x, y } = z.p;
      const len = String(Math.max(0.1, y - x));
      let out, args;
      if (isMp3) {
        out = 'p' + z.i + '.webm';
        args = ['-ss', String(Math.max(0, x - sA)), '-i', aN, '-t', len, '-vn', '-c', 'copy', out];
      } else if (msg.transcode) {
        out = 'p' + z.i + '.mp4';
        args = ['-ss', String(Math.max(0, x - sV)), '-i', vN, '-ss', String(Math.max(0, x - sA)), '-i', aN,
          '-map', '0:v:0', '-map', '1:a:0', '-t', len,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', out];
      } else {
        out = 'p' + z.i + '.webm';
        args = ['-ss', String(Math.max(0, x - sV)), '-i', vN, '-ss', String(Math.max(0, x - sA)), '-i', aN,
          '-map', '0:v:0', '-map', '1:a:0', '-t', len, '-c', 'copy', out];
      }
      ffLog.length = 0;
      const ret = await inst.exec(args);
      if (ret !== 0) throw new Error('ffmpeg код ' + ret + ' (кусок ' + z.i + '): ' + ffLog.slice(-6).join(' | '));
      pieceNames[z.i] = out;
      doneCount++; prog();
    }
    await rm(inst, aN);
    if (d.vName) await rm(inst, d.vName);
    d.aName = null; d.vName = null;
  }

  // final concat in piece order
  await inst.writeFile('list.txt', new TextEncoder().encode(pieceNames.map((p) => "file '" + p + "'").join('\n')));
  const attempts = isMp3
    ? [{ out: 'out.mp3', type: 'audio/mpeg', ext: '.mp3',
         args: ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'] }]
    : msg.transcode
      ? [{ out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
           args: ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', 'out.mp4'] }]
      : [
          { out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
            args: ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-strict', '-2', '-movflags', '+faststart', 'out.mp4'] },
          { out: 'out.webm', type: 'video/webm', ext: '.webm',
            args: ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'out.webm'] },
        ];

  let data = null, chosen = null, lastErr = '';
  for (const run of attempts) {
    ffLog.length = 0;
    const ret = await inst.exec(run.args);
    if (ret === 0) {
      try {
        data = await inst.readFile(run.out);
        if (data && data.length) { chosen = run; break; }
      } catch (e) {}
    }
    lastErr = 'ffmpeg код ' + ret + ': ' + ffLog.slice(-6).join(' | ');
    await rm(inst, run.out);
  }

  for (const p of pieceNames) if (p) await rm(inst, p);
  await rm(inst, 'list.txt');
  if (chosen) await rm(inst, chosen.out);

  if (!chosen) throw new Error(lastErr || 'склейка фрагментов не удалась');
  return saveBlob(data, msg.filename, chosen);
}

// ---- message handlers ------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'ytdl-ping') {
    sendResponse({ pong: true });
    return; // sync
  }

  // ---- single mode ----
  if (msg.t === 'ytdl-begin') {
    acc.video = []; acc.audio = [];
    acc.videoMime = msg.videoMime || '';
    acc.audioMime = msg.audioMime || '';
    acc.filename = msg.filename || 'video.mp4';
    acc.transcode = !!msg.transcode;
    acc.format = msg.format || 'mp4';
    acc.start = msg.start || 0;
    acc.end = msg.end || 0;
    acc.sb = Array.isArray(msg.sb) ? msg.sb : [];
    getFF().catch(() => {});
    sendResponse({ ok: true });
    return; // sync
  }
  if (msg.t === 'ytdl-chunk') {
    try {
      acc[msg.track].push(b64decode(msg.b64));
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return; // sync
  }
  if (msg.t === 'ytdl-finalize') {
    finalize()
      .then((filename) => sendResponse({ ok: true, filename }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async
  }

  // ---- parallel mode ----
  if (msg.t === 'ytdl-par-begin') {
    const st = par[msg.task] || (par[msg.task] = { frags: Object.create(null) });
    const prev = st.frags[msg.idx];
    if (prev && ff) { // a retried fragment — throw away the previous attempt
      if (prev.aName) rm(ff, prev.aName);
      if (prev.vName) rm(ff, prev.vName);
    }
    st.frags[msg.idx] = {
      video: [], audio: [], aName: null, vName: null,
      videoMime: msg.videoMime || '', audioMime: msg.audioMime || '',
    };
    getFF().catch(() => {});
    sendResponse({ ok: true });
    return; // sync
  }
  if (msg.t === 'ytdl-par-chunk') {
    try {
      const f = par[msg.task] && par[msg.task].frags[msg.idx];
      if (!f) throw new Error('нет фрагмента ' + msg.idx);
      f[msg.track].push(b64decode(msg.b64));
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return; // sync
  }
  if (msg.t === 'ytdl-par-frag') {
    // Move the fragment straight into the ffmpeg filesystem and drop the JS
    // buffers: with 4 workers in flight, holding every fragment as JS arrays AND
    // as an ffmpeg copy is what pushes the wasm heap over its ~2 GB ceiling.
    (async () => {
      const f = par[msg.task] && par[msg.task].frags[msg.idx];
      if (!f) throw new Error('нет фрагмента ' + msg.idx);
      const inst = await getFF();
      const aB = concat(f.audio); f.audio = [];
      const vB = f.video.length ? concat(f.video) : null; f.video = [];
      if (!aB.length) throw new Error('пустое аудио фрагмента ' + msg.idx);
      f.aName = 'fa' + msg.idx + '.' + extFor(f.audioMime);
      await inst.writeFile(f.aName, aB);
      if (vB) {
        f.vName = 'fv' + msg.idx + '.' + extFor(f.videoMime);
        await inst.writeFile(f.vName, vB);
      }
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async
  }
  if (msg.t === 'ytdl-par-drop') {
    const st = par[msg.task];
    delete par[msg.task];
    sendResponse({ ok: true });
    if (st && ff) {
      for (const k of Object.keys(st.frags)) {
        const f = st.frags[k];
        if (f.aName) rm(ff, f.aName);
        if (f.vName) rm(ff, f.vName);
      }
    }
    return; // sync
  }
  if (msg.t === 'ytdl-par-merge') {
    sendResponse({ ok: true }); // ack now; the result arrives as 'ytdl-par-merged'
    parMerge(msg)
      .then((filename) => chrome.runtime.sendMessage({ t: 'ytdl-par-merged', task: msg.task, ok: true, filename }))
      .catch((e) => chrome.runtime.sendMessage({ t: 'ytdl-par-merged', task: msg.task, ok: false, error: String((e && e.message) || e) }))
      .finally(() => { delete par[msg.task]; });
    return; // sync (ack already sent)
  }
  // other message types belong to the background; ignore.
});
