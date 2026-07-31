// background.js — service worker. Owns the offscreen document lifecycle, performs
// the final chrome.downloads save, queries SponsorBlock, and orchestrates parallel
// multi-tab downloads of long videos: it splits the requested range into fragments,
// runs a pool of muted background tabs that each capture their own fragment, and
// tells the offscreen ffmpeg to merge the pieces into one file.

let creating = null;      // de-dupe concurrent createDocument calls
let progressTab = null;   // tab that started the current single-mode job

// ---- offscreen lifecycle --------------------------------------------------
function pingOffscreen() {
  return Promise.race([
    chrome.runtime.sendMessage({ t: 'ytdl-ping' })
      .then((r) => !!(r && r.pong)).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 2000)),
  ]);
}

async function waitForOffscreen(attempts) {
  for (let i = 0; i < attempts; i++) {
    if (await pingOffscreen()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function ensureOffscreen() {
  if (creating) { await creating; }

  if (await chrome.offscreen.hasDocument()) {
    if (await waitForOffscreen(10)) return;
    try { await chrome.offscreen.closeDocument(); } catch (e) {}
  }

  creating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'Run ffmpeg.wasm to mux captured video and audio tracks into an MP4.',
  });
  try { await creating; } catch (e) { /* may already exist — the ping below decides */ }
  finally { creating = null; }

  if (!(await waitForOffscreen(40))) {
    const missing = await missingFiles();
    throw new Error(missing.length
      ? 'в папке расширения нет файлов: ' + missing.join(', ') +
        ' — скопируйте их из репозитория и перезагрузите расширение'
      : 'offscreen-документ не отвечает');
  }
}

async function missingFiles() {
  const need = ['offscreen.html', 'offscreen.js',
    'vendor/ffmpeg/ffmpeg.js', 'vendor/ffmpeg/ffmpeg-core.js', 'vendor/ffmpeg/ffmpeg-core.wasm'];
  const missing = [];
  for (const f of need) {
    try {
      const r = await fetch(chrome.runtime.getURL(f), { method: 'GET' });
      if (!r.ok) missing.push(f);
    } catch (e) { missing.push(f); }
  }
  return missing;
}

// ---- SponsorBlock ---------------------------------------------------------
const SB_API = 'https://sponsor.ajay.app';
const SB_CATEGORIES = ['sponsor', 'selfpromo', 'interaction'];

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sbFetchSegments(videoId) {
  if (!videoId) return [];
  const prefix = (await sha256Hex(videoId)).slice(0, 4);
  const url = SB_API + '/api/skipSegments/' + prefix +
    '?categories=' + encodeURIComponent(JSON.stringify(SB_CATEGORIES));
  const resp = await fetch(url);
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error('SponsorBlock HTTP ' + resp.status);
  const list = await resp.json();
  const entry = Array.isArray(list) ? list.find((v) => v.videoID === videoId) : null;
  if (!entry || !Array.isArray(entry.segments)) return [];
  return entry.segments
    .filter((s) => (s.actionType ? s.actionType === 'skip' : true))
    .filter((s) => Array.isArray(s.segment) && s.segment[1] > s.segment[0])
    .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category }));
}

// ---- parallel download orchestrator ---------------------------------------
const jobs = Object.create(null); // taskId -> job
let taskSeq = 1;

const MAX_TABS = 4;
const FRAG_STALL_MS = 3 * 60 * 1000;  // no progress for 3 min → restart fragment
const FRAG_TRIES = 3;

function autoWorkers(rangeSec) {
  let n = rangeSec <= 1800 ? 1 : rangeSec <= 5400 ? 2 : rangeSec <= 10800 ? 3 : 4;
  const cores = navigator.hardwareConcurrency || 4;
  n = Math.min(n, Math.max(1, Math.floor(cores / 2)));
  const mem = navigator.deviceMemory || 4; // GB (capped at 8 by the API)
  if (mem < 4) n = 1; else if (mem < 8) n = Math.min(n, 2);
  const active = Object.values(jobs).filter((j) => j.state === 'run' || j.state === 'merge').length;
  if (active > 0) n = 1;
  return Math.max(1, Math.min(MAX_TABS, n));
}

function makeFrags(start, end, chunkSec) {
  const frags = [];
  let s = start, i = 0;
  while (s < end - 1) {
    let e = Math.min(end, s + chunkSec);
    if (end - e < 60) e = end; // merge a short tail into the last fragment
    frags.push({ idx: i++, s, e, st: 'pend', pct: 0, tries: 0, tabId: null, ts: Date.now() });
    s = e;
  }
  return frags;
}

function jobFor(taskId) { return jobs[taskId] || null; }

function closeTab(tabId) {
  if (tabId != null) setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 200);
}

function closeAllTabs(job) {
  for (const id of job.tabs) closeTab(id);
  job.tabs.clear();
}

async function spawnTabs(job) {
  if (job.state !== 'run') return;
  while (job.tabs.size < job.workers && job.frags.some((f) => f.st === 'pend')) {
    const url = job.url + (job.url.includes('?') ? '&' : '?') + 'ytdlTask=' + job.id;
    let tab = null;
    try { tab = await chrome.tabs.create({ url, active: false }); } catch (e) { break; }
    job.tabs.add(tab.id);
    try { await chrome.tabs.update(tab.id, { muted: true }); } catch (e) {}
  }
}

function requeueFrag(job, f, reason) {
  if (f.st === 'done') return;
  f.tries++;
  f.tabId = null;
  f.pct = 0;
  f.st = f.tries >= FRAG_TRIES ? 'err' : 'pend';
  if (f.st === 'err') f.err = reason || 'превышено число попыток';
  console.warn('[Triangle] фрагмент', f.idx, '→', f.st, '(' + (reason || '') + ')');
}

// called from the status poll (every second while the main tab is open) — this
// doubles as the watchdog AND keeps the service worker alive during long jobs
function watchdog(job) {
  if (job.state !== 'run') return;
  const t = Date.now();
  for (const f of job.frags) {
    if (f.st === 'run' && t - f.ts > FRAG_STALL_MS) {
      const tabId = f.tabId;
      requeueFrag(job, f, 'вкладка зависла');
      if (tabId != null) { job.tabs.delete(tabId); closeTab(tabId); }
    }
  }
  spawnTabs(job);
  maybeMerge(job);
}

function jobProgress(job) {
  const total = job.end - job.start;
  let done = 0;
  for (const f of job.frags) {
    const len = f.e - f.s;
    if (f.st === 'done') done += len;
    else if (f.st === 'run') done += len * Math.min(1, f.pct || 0);
  }
  return total > 0 ? done / total : 0;
}

async function maybeMerge(job) {
  if (job.state !== 'run') return;
  if (job.frags.some((f) => f.st === 'pend' || f.st === 'run')) return;
  if (job.frags.some((f) => f.st === 'err')) { job.state = 'stall'; return; } // wait for user retry
  job.state = 'merge';
  job.mergePct = 0;
  closeAllTabs(job);
  try {
    await ensureOffscreen();
    const ack = await chrome.runtime.sendMessage({
      t: 'ytdl-par-merge', task: job.id, filename: job.filename,
      format: job.format, transcode: job.transcode,
      start: job.start, end: job.end, sb: job.sb,
      frags: job.frags.map((f) => ({ idx: f.idx, s: f.s, e: f.e })),
    });
    if (!ack || !ack.ok) throw new Error((ack && ack.error) || 'offscreen не принял склейку');
    // completion arrives later as 'ytdl-par-merged'
  } catch (e) {
    job.state = 'error';
    job.error = String((e && e.message) || e);
    notify('Ошибка: ' + job.error);
  }
}

function cancelJob(job, silent) {
  job.state = 'cancel';
  closeAllTabs(job);
  chrome.runtime.sendMessage({ t: 'ytdl-par-drop', task: job.id }).catch(() => {});
  if (!silent) notify('Загрузка отменена');
  setTimeout(() => { delete jobs[job.id]; }, 30000);
}

function notify(message) {
  try {
    const p = chrome.notifications.create({
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'),
      title: 'Triangle Downloader', message,
    });
    if (p && p.catch) p.catch(() => {}); // missing icon must not reject unhandled
  } catch (e) {}
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const id of Object.keys(jobs)) {
    const job = jobs[id];
    if (job.mainTab === tabId && (job.state === 'run' || job.state === 'pause' || job.state === 'stall')) {
      cancelJob(job, true); // main page closed → cancel + cleanup
      continue;
    }
    if (job.tabs.has(tabId)) {
      job.tabs.delete(tabId);
      const f = job.frags.find((x) => x.tabId === tabId && x.st === 'run');
      if (f) requeueFrag(job, f, 'вкладка закрылась');
      spawnTabs(job);
      maybeMerge(job);
    }
  }
});

// ---- message router --------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string') return;
  const senderTab = sender && sender.tab && sender.tab.id;

  if (msg.t === 'ytdl-ensure') {
    ensureOffscreen().then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  // ffmpeg progress: offscreen → worker → tab (runtime messages don't reach content scripts)
  if (msg.t === 'ytdl-progress') {
    if (progressTab != null) chrome.tabs.sendMessage(progressTab, msg).catch(() => {});
    return;
  }

  // relay for the offscreen document (single-mode AND parallel data transfer)
  if (msg.t === 'ytdl-proxy') {
    (async () => {
      const inner = msg.m || {};
      if (inner.t === 'ytdl-begin') {
        progressTab = senderTab != null ? senderTab : null;
        await ensureOffscreen();
      }
      if (inner.t === 'ytdl-par-begin') await ensureOffscreen();
      const r = await chrome.runtime.sendMessage(inner);
      if (r === undefined) return { ok: false, error: 'offscreen не ответил на ' + inner.t };
      return r;
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.t === 'ytdl-sb-get') {
    sbFetchSegments(String(msg.videoId || ''))
      .then((segments) => sendResponse({ ok: true, segments }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.t === 'ytdl-save') {
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // ---- parallel: main tab API ----
  if (msg.t === 'ytdl-par-plan') {
    // sync — how many workers WOULD auto mode use for this range
    sendResponse({ ok: true, workers: autoWorkers(Number(msg.rangeSec) || 0) });
    return;
  }

  if (msg.t === 'ytdl-par-start') {
    const range = msg.end - msg.start;
    let workers = msg.tabsMode === 'auto' ? autoWorkers(range)
      : Math.max(1, Math.min(MAX_TABS, Number(msg.tabsMode) || 1));
    const chunkSec = Math.max(300, Math.min(1800, (Number(msg.chunkMin) || 12) * 60));
    const frags = makeFrags(msg.start, msg.end, chunkSec);
    workers = Math.min(workers, frags.length);
    const id = 't' + (taskSeq++) + '_' + Date.now();
    const job = jobs[id] = {
      id, state: 'run', url: msg.url, videoId: msg.videoId,
      height: msg.height, format: msg.format, transcode: !!msg.transcode,
      start: msg.start, end: msg.end, sb: msg.sb || [],
      filename: msg.filename, frags, workers,
      tabs: new Set(), mainTab: senderTab, startedAt: Date.now(),
      mergePct: 0, error: null,
    };
    spawnTabs(job);
    sendResponse({ ok: true, taskId: id, frags: frags.length, workers });
    return;
  }

  if (msg.t === 'ytdl-par-status') {
    const job = jobFor(msg.taskId);
    if (!job) { sendResponse({ ok: false, gone: true }); return; }
    watchdog(job);
    const pct = jobProgress(job);
    const elapsed = (Date.now() - job.startedAt) / 1000;
    sendResponse({
      ok: true, state: job.state, error: job.error, filename: job.filename,
      workers: job.tabs.size, mergePct: job.mergePct || 0, progress: pct,
      eta: pct > 0.03 && job.state === 'run' ? Math.round(elapsed * (1 - pct) / pct) : null,
      frags: job.frags.map((f) => ({ idx: f.idx, st: f.st, pct: f.pct })),
    });
    return;
  }

  if (msg.t === 'ytdl-par-ctl') {
    const job = jobFor(msg.taskId);
    if (!job) { sendResponse({ ok: false }); return; }
    if (msg.cmd === 'pause' && job.state === 'run') job.state = 'pause';
    else if (msg.cmd === 'resume' && job.state === 'pause') { job.state = 'run'; spawnTabs(job); }
    else if (msg.cmd === 'cancel') cancelJob(job, true);
    else if (msg.cmd === 'retry' && (job.state === 'stall' || job.state === 'error')) {
      for (const f of job.frags) if (f.st === 'err') { f.st = 'pend'; f.tries = 0; f.err = null; }
      job.state = 'run'; job.error = null;
      spawnTabs(job);
    }
    sendResponse({ ok: true });
    return;
  }

  // ---- parallel: worker tab API ----
  if (msg.t === 'ytdl-par-claim') {
    const job = jobFor(msg.taskId);
    if (!job || job.state === 'cancel' || job.state === 'error' || job.state === 'merge' || job.state === 'done') {
      sendResponse({ stop: true });
      if (job && senderTab != null) { job.tabs.delete(senderTab); }
      closeTab(senderTab);
      return;
    }
    if (job.state === 'pause' || job.state === 'stall') { sendResponse({ wait: true }); return; }
    const f = job.frags.find((x) => x.st === 'pend');
    if (!f) {
      sendResponse({ stop: true });
      if (senderTab != null) { job.tabs.delete(senderTab); closeTab(senderTab); }
      maybeMerge(job);
      return;
    }
    f.st = 'run'; f.tabId = senderTab; f.ts = Date.now(); f.pct = 0;
    sendResponse({ ok: true, idx: f.idx, s: f.s, e: f.e, height: job.height, format: job.format, videoId: job.videoId });
    return;
  }

  if (msg.t === 'ytdl-par-prog') {
    const job = jobFor(msg.taskId);
    if (job) {
      const f = job.frags[msg.idx];
      if (f && f.st === 'run') { f.pct = msg.pct; f.ts = Date.now(); }
    }
    return; // no response needed
  }

  if (msg.t === 'ytdl-par-frag-done') {
    const job = jobFor(msg.taskId);
    if (job) {
      const f = job.frags[msg.idx];
      if (f) { f.st = 'done'; f.pct = 1; f.ts = Date.now(); }
      maybeMerge(job);
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.t === 'ytdl-par-frag-fail') {
    const job = jobFor(msg.taskId);
    if (job) {
      const f = job.frags[msg.idx];
      if (f) requeueFrag(job, f, msg.error);
      maybeMerge(job);
    }
    sendResponse({ ok: true });
    return;
  }

  // ---- parallel: offscreen callbacks ----
  if (msg.t === 'ytdl-par-merge-prog') {
    const job = jobFor(msg.task);
    if (job) job.mergePct = msg.pct;
    return;
  }

  if (msg.t === 'ytdl-par-merged') {
    const job = jobFor(msg.task);
    if (job) {
      if (msg.ok) {
        job.state = 'done';
        job.filename = msg.filename || job.filename;
        notify('Готово: ' + job.filename);
      } else {
        job.state = 'error';
        job.error = msg.error || 'сборка не удалась';
        notify('Ошибка: ' + job.error);
      }
      setTimeout(() => { if (jobs[job.id] && (jobs[job.id].state === 'done')) delete jobs[job.id]; }, 10 * 60 * 1000);
    }
    return;
  }
});
