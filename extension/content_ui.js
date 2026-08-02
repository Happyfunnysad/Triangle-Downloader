// content_ui.js — isolated world. Draws the Triangle Downloader button + menu in
// the YouTube player, drives the MAIN-world capture hook over window.postMessage,
// then streams the captured tracks to the offscreen ffmpeg worker for muxing.
//
// UI v2: the menu is a range strip + a segmented format row + one primary action;
// SponsorBlock / tabs / chunk / codec live in a second pane behind the gear.
(function () {
  const BTN_ID = 'ytdl-btn';
  let reqSeq = 1;
  const pending = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__ytdl_from_hook !== true) return;
    const p = pending.get(ev.data.reqId);
    if (p) p(ev.data);
  });
  function callHook(cmd, extra) {
    return new Promise((resolve) => {
      const reqId = reqSeq++;
      pending.set(reqId, resolve);
      window.postMessage(Object.assign({ __ytdl_to_hook: true, cmd, reqId }, extra || {}), '*');
    });
  }
  // download drives streaming progress + a final result
  function download(params, onProgress) {
    return new Promise((resolve, reject) => {
      const reqId = reqSeq++;
      const handler = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.__ytdl_from_hook !== true || ev.data.reqId !== reqId) return;
        const d = ev.data;
        if (d.progress != null && !d.done) { onProgress(d); return; }
        window.removeEventListener('message', handler);
        if (d.ok && d.done) resolve(d); else reject(new Error(d.error || 'capture failed'));
      };
      window.addEventListener('message', handler);
      window.postMessage(Object.assign({ __ytdl_to_hook: true, cmd: 'download', reqId }, params), '*');
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- time helpers --------------------------------------------------------
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h + ':' + pad(m) + ':' + pad(s);
  }
  function fmtShort(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  function parseTime(str) {
    const parts = String(str).trim().split(':').map((p) => Number(p));
    if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
    let s = 0; for (const p of parts) s = s * 60 + p;
    return s;
  }
  // rough size estimate for the primary action's label — MB per second of media
  function rateFor(kind, height) {
    if (kind === 'txt') return 0;
    if (kind === 'mp3') return 0.024;
    if (height >= 1080) return 0.262;
    if (height >= 720) return 0.128;
    return 0.07;
  }
  function fmtSize(mb) {
    if (!mb) return '~12 КБ';
    return mb >= 1024 ? '~' + (mb / 1024).toFixed(1) + ' ГБ' : '~' + Math.round(mb) + ' МБ';
  }

  // ---- dom helpers (no innerHTML — the page enforces Trusted Types) ---------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function triangleSvg(fill) {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', width: '100%', height: '100%' });
    svg.appendChild(svgEl('path', { fill: fill || '#fff', d: 'M5 8 H19 L12 17 Z' }));
    return svg;
  }
  function gearSvg() {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none' });
    svg.appendChild(svgEl('path', {
      d: 'M3 7h11M18 7h3M3 17h5M12 17h9',
      stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round',
    }));
    svg.appendChild(svgEl('circle', { cx: '16', cy: '7', r: '2.4', stroke: 'currentColor', 'stroke-width': '1.7' }));
    svg.appendChild(svgEl('circle', { cx: '10', cy: '17', r: '2.4', stroke: 'currentColor', 'stroke-width': '1.7' }));
    return svg;
  }
  function listSvg() {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none' });
    svg.appendChild(svgEl('path', {
      d: 'M4 6h16M4 12h16M4 18h10',
      stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round',
    }));
    return svg;
  }
  function folderSvg() {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none' });
    svg.appendChild(svgEl('path', {
      d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7v7.8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5Z',
      stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linejoin': 'round',
    }));
    return svg;
  }

  // ---- button --------------------------------------------------------------
  function makeButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'ytp-button ytdl-btn';
    btn.title = 'Triangle Downloader';
    btn.appendChild(triangleSvg());
    btn.addEventListener('click', onClick);
    return btn;
  }
  function ensureButton() {
    if (!/\/watch/.test(location.pathname)) return;
    if (document.getElementById(BTN_ID)) return;
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return;
    controls.insertBefore(makeButton(), controls.firstChild);
  }

  let menuEl = null;
  let menuQueueTimer = null; // счётчик очереди в шапке, пока меню открыто
  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove(); menuEl = null;
    clearInterval(menuQueueTimer); menuQueueTimer = null;
    queueCount.onChange = null; // счётчик в шапке ушёл вместе с меню
    document.removeEventListener('click', onDocClick, true);
  }
  function onDocClick(e) {
    if (!menuEl || menuEl.contains(e.target) || e.target.id === BTN_ID) return;
    if (queueBox && queueBox.box.contains(e.target)) return; // панель очереди — не «мимо меню»
    closeMenu();
  }

  // Меню пересоздаётся при каждом открытии, поэтому слушатель хранилища живёт
  // здесь и лишь вызывает актуальный обработчик открытого меню.
  let onAuthChange = null;
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.votAuth && onAuthChange) onAuthChange(ch.votAuth.newValue || {});
  });

  // small segmented control: [{key,label}] → {node, set(key)}
  function optionRow(options, current, onPick) {
    const wrap = el('span', 'ytdl-opts');
    const btns = options.map((o) => {
      const b = el('button', o.key === current ? 'sel' : null, o.label);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        current = o.key;
        btns.forEach((x, i) => x.classList.toggle('sel', options[i].key === current));
        onPick(o.key);
      });
      wrap.appendChild(b);
      return b;
    });
    return wrap;
  }
  function settingRow(label, hint, options, current, onPick) {
    const row = el('div', 'ytdl-row');
    const top = el('div', 'ytdl-row-top');
    top.appendChild(el('span', null, label));
    top.appendChild(optionRow(options, current, onPick));
    row.appendChild(top);
    row.appendChild(el('div', 'ytdl-hint', hint));
    return row;
  }
  // То же самое, но с несколькими одновременно выбранными вариантами. Восемь
  // категорий SponsorBlock в строку с подписью не помещались никогда — поэтому
  // здесь набор живёт своей строкой и переносится.
  function multiRow(label, hint, options, current, onPick) {
    const row = el('div', 'ytdl-row');
    const top = el('div', 'ytdl-row-top');
    top.appendChild(el('span', null, label));
    const count = el('span', 'ytdl-note');
    count.style.marginLeft = 'auto';
    top.appendChild(count);
    row.appendChild(top);
    row.appendChild(el('div', 'ytdl-hint', hint));
    const wrap = el('span', 'ytdl-opts ytdl-opts-wrap');
    const set = new Set(current);
    const say = () => { count.textContent = set.size ? 'выбрано: ' + set.size : 'ничего не выбрано'; };
    for (const o of options) {
      const b = el('button', set.has(o.key) ? 'sel' : null, o.label);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (set.has(o.key)) set.delete(o.key); else set.add(o.key);
        b.classList.toggle('sel', set.has(o.key));
        say();
        onPick([...set]);
      });
      wrap.appendChild(b);
    }
    say();
    row.appendChild(wrap);
    return row;
  }

  // After the extension is reloaded, content scripts already running in open tabs
  // are orphaned: every chrome.* call throws "Extension context invalidated".
  // Without this check onClick would reject before the menu is ever inserted and
  // the button would look dead.
  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  let opening = false; // openMenu awaits the player: ignore re-clicks meanwhile,
                       // otherwise each click builds another orphaned menu
  async function onClick(e) {
    e.stopPropagation();
    if (opening) return;
    if (menuEl) { closeMenu(); return; }
    const btn = document.getElementById(BTN_ID);
    opening = true;
    if (btn) btn.style.opacity = '.4'; // instant feedback while the player answers
    try {
      await openMenu();
    } catch (err) {
      console.error('[Triangle] не удалось открыть меню:', err);
      closeMenu(); // снимает и счётчик очереди, и его таймер
      const t = toast();
      t.set(contextAlive() ? 'Ошибка меню: ' + ((err && err.message) || err)
                           : 'Расширение обновилось — обновите страницу (F5)', 1);
      t.hide(6000);
    } finally {
      opening = false;
      if (btn) btn.style.opacity = '';
    }
  }

  async function openMenu() {
    if (!contextAlive()) throw new Error('расширение перезагружено');

    // The player reports duration 0 until it is ready; without it the fragment
    // rail and the size estimate are meaningless, so give it a few tries.
    let info = null;
    for (let i = 0; i < 12; i++) {
      info = await Promise.race([
        callHook('info'),
        new Promise((r) => setTimeout(() => r(null), 2500)), // hook missing → don't hang
      ]);
      if (info && info.duration > 0) break;
      await sleep(400);
    }
    if (!info) throw new Error('плеер не отвечает, обновите страницу');

    const duration = Math.floor(info.duration || 0);
    const heights = (info.heights || []).filter((h) => h === 1080 || h === 720);
    if (!heights.includes(1080)) heights.unshift(1080);
    if (!heights.includes(720)) heights.push(720);
    const uniq = [...new Set(heights)].sort((a, b) => b - a);

    let store = {};
    try {
      store = await chrome.storage.local.get(['transcode', 'sbCut', 'sbCats', 'parTabs', 'parChunk',
        'audioRaw', 'capMin', 'subsIn', 'chapsIn', 'votVol', 'uiHints', 'uiTab',
        'votOn', 'votMode', 'votLang', 'votSrcLang', 'votLively', 'votAuth',
        'votProxy', 'votProxyCfg']);
    } catch (e) { /* fall back to defaults rather than losing the menu */ }
    const cfg = {
      transcode: !!store.transcode,
      sbCut: store.sbCut !== false,
      sbCats: Array.isArray(store.sbCats) && store.sbCats.length
        ? store.sbCats : ['sponsor', 'selfpromo', 'interaction'],
      parTabs: String(store.parTabs == null ? 'auto' : store.parTabs),
      parChunk: String(Number(store.parChunk) || 12),
      audioRaw: !!store.audioRaw,
      capMin: String(Number(store.capMin) || 20),
      subsIn: store.subsIn || 'off',
      chapsIn: store.chapsIn !== false,
      votVol: String(store.votVol == null ? 30 : store.votVol),
      votOn: !!store.votOn,
      votMode: store.votMode || 'mix',
      votLang: store.votLang || 'ru',
      votSrcLang: store.votSrcLang || 'auto',
      votLively: !!store.votLively,
      votProxy: !!store.votProxy,
      // пояснения к настройкам показываются только по просьбе, см. кнопку «?»
      uiHints: !!store.uiHints,
    };
    let votAuth = store.votAuth || {};
    const votProxyCfg = store.votProxyCfg || {};

    const formats = uniq.map((h) => ({ key: 'v' + h, label: h + 'p', kind: 'video', height: h }))
      .concat([
        { key: 'mp3', label: 'MP3', kind: 'mp3', height: null },
        { key: 'txt', label: '.srt', kind: 'txt', height: null },
      ]);
    let fmt = formats[0];
    let start = 0, end = duration;

    menuEl = document.createElement('div');
    menuEl.className = 'ytdl-menu';
    menuEl.addEventListener('click', (ev) => ev.stopPropagation());

    // — header —
    const head = el('div', 'ytdl-head');
    const mark = el('span'); mark.style.width = '14px'; mark.style.height = '14px';
    mark.appendChild(triangleSvg('#ff4e45'));
    head.appendChild(mark);
    head.appendChild(el('b', null, 'Triangle'));
    // очередь: кнопка со счётчиком идущих заданий (в том числе из других вкладок)
    const qBtn = el('button', 'ytdl-gear ytdl-qbtn');
    qBtn.title = 'Очередь загрузок';
    qBtn.appendChild(listSvg());
    const qBadge = el('i', 'ytdl-qbadge');
    qBtn.appendChild(qBadge);
    qBtn.addEventListener('click', (ev) => { ev.stopPropagation(); queueToggle(); });
    head.appendChild(qBtn);
    queueCount.onChange = (n) => {
      qBadge.textContent = n ? String(n) : '';
      qBadge.style.display = n ? '' : 'none';
    };
    queueCount.onChange(queueCount.active);
    queueRefresh();
    clearInterval(menuQueueTimer);
    menuQueueTimer = setInterval(queueRefresh, 2000);
    const gear = el('button', 'ytdl-gear');
    gear.title = 'Настройки';
    gear.appendChild(gearSvg());
    head.appendChild(gear);
    menuEl.appendChild(head);

    // — main pane —
    const main = el('div', 'ytdl-pane');

    const stripWrap = el('div', 'ytdl-row');
    const strip = el('div', 'ytdl-strip');
    for (let i = 0; i <= 10; i++) {
      const tick = el('span', 'ytdl-tick');
      tick.style.left = (i * 10) + '%';
      strip.appendChild(tick);
    }
    const sbLayer = el('span');
    strip.appendChild(sbLayer);
    const dimL = el('span', 'ytdl-dim'); dimL.style.left = '0';
    const dimR = el('span', 'ytdl-dim'); dimR.style.right = '0';
    const sel = el('span', 'ytdl-sel');
    const hL = el('span', 'ytdl-handle');
    const hR = el('span', 'ytdl-handle');
    strip.appendChild(dimL); strip.appendChild(dimR);
    strip.appendChild(sel); strip.appendChild(hL); strip.appendChild(hR);
    stripWrap.appendChild(strip);

    const times = el('div', 'ytdl-times');
    const tStart = document.createElement('input');
    const tEnd = document.createElement('input');
    [tStart, tEnd].forEach((i) => {
      i.className = 'ytdl-t';
      i.spellcheck = false;
      i.addEventListener('click', (ev) => ev.stopPropagation());
      i.addEventListener('change', () => {
        let a = parseTime(tStart.value), b = parseTime(tEnd.value);
        if (a == null) a = start;
        if (b == null) b = end;
        start = Math.max(0, Math.min(a, duration - 1));
        end = Math.max(start + 1, Math.min(b, duration));
        render();
      });
    });
    times.appendChild(tStart);
    times.appendChild(el('span', 'dash', '—'));
    times.appendChild(tEnd);
    const lenTxt = el('span', 'len');
    times.appendChild(lenTxt);
    const reset = el('button', 'ytdl-reset', 'весь ролик');
    reset.addEventListener('click', (ev) => { ev.stopPropagation(); start = 0; end = duration; render(); });
    times.appendChild(reset);
    stripWrap.appendChild(times);
    main.appendChild(stripWrap);

    // format row
    const seg = el('div', 'ytdl-seg');
    const segBtns = formats.map((f) => {
      const b = el('button', f.key === fmt.key ? 'sel' : null, f.label);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fmt = f;
        segBtns.forEach((x, i) => x.classList.toggle('sel', formats[i].key === fmt.key));
        render();
      });
      seg.appendChild(b);
      return b;
    });
    main.appendChild(seg);

    // destination — first-class, right above the action, not buried in settings.
    // Pills are built from CONFIGURED targets: S3/WebDAV work with no helper at
    // all (uploaded straight from the extension), Taildrop/SMB/FTP appear once
    // set up in settings. With nothing configured there is just «Локально» —
    // exactly the behaviour the extension had before any of this existed.
    let dest = 'local';           // 'local' | 's3' | 'webdav' | 'ftp' | 'smb' | 'taildrop'
    let targets = {};             // filled from storage
    // Карточки получателей на вкладке «Куда» — заполняются при сборке настроек.
    // Объявлены здесь, потому что renderDest() обновляет и пилюли, и карточки,
    // а он может сработать раньше, чем настройки собраны (reloadDest асинхронен).
    const destCards = {};
    let haveHelper = null; // null = ещё проверяем, true/false = ответ помощника
    const destWrap = el('div', 'ytdl-dest');
    destWrap.appendChild(el('div', 'ytdl-dest-cap', 'Куда'));
    const destRow = el('div', 'ytdl-pills');
    destWrap.appendChild(destRow);
    const destPath = el('div', 'ytdl-dest-path');
    destWrap.appendChild(destPath);
    main.appendChild(destWrap);

    function pill(kind, badge, label) {
      const b = el('button', 'ytdl-pill' + (dest === kind ? ' sel' : ''));
      b.appendChild(el('i', 'ytdl-pill-b', badge));
      b.appendChild(el('span', null, label));
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dest = kind;
        chrome.storage.local.set({ dest: { type: kind } }).catch(() => {});
        renderDest();
        render();
      });
      return b;
    }

    const nativeDest = (kind) => kind === 'ftp' || kind === 'smb' || kind === 'taildrop';
    function destConfigured(kind) {
      const t = targets || {};
      if (kind === 'local') return true;
      if (kind === 's3') return !!(t.s3cfg && t.s3cfg.bucket && destOk('s3cfg', t.s3cfg));
      if (kind === 'webdav') return !!(t.wdcfg && t.wdcfg.url && destOk('wdcfg', t.wdcfg));
      if (kind === 'ftp') return !!(t.ftpcfg && t.ftpcfg.host && destOk('ftpcfg', t.ftpcfg));
      if (kind === 'smb') return !!t.smbDir;
      if (kind === 'taildrop') return !!t.tdTarget;
      return false;
    }
    function destReady(kind) {
      return destConfigured(kind) && (!nativeDest(kind) || haveHelper === true);
    }
    function normalizeDest(savedKind) {
      const kind = savedKind || dest;
      const ok = haveHelper === null && nativeDest(kind) ? destConfigured(kind) : destReady(kind);
      dest = ok ? kind : 'local';
      if (kind !== dest) chrome.storage.local.set({ dest: { type: dest } }).catch(() => {});
    }

    function renderDest() {
      while (destRow.firstChild) destRow.removeChild(destRow.firstChild);
      normalizeDest(dest);
      destRow.appendChild(pill('local', '↓', 'Локально'));
      const t = targets;
      // получатель показывается, только если его настройки прошли проверку
      if (destReady('s3')) destRow.appendChild(pill('s3', 'S3', t.s3cfg.bucket));
      if (destReady('webdav')) destRow.appendChild(pill('webdav', 'DAV', (() => { try { return new URL(t.wdcfg.url).host; } catch (e) { return 'WebDAV'; } })()));
      if (destReady('ftp')) destRow.appendChild(pill('ftp', 'FTP', t.ftpcfg.host));
      if (destReady('smb')) destRow.appendChild(pill('smb', 'NAS', t.smbDir.split(/[\\/]/).filter(Boolean).pop() || 'шара'));
      if (destReady('taildrop')) destRow.appendChild(pill('taildrop', 'TS', t.tdLabel || t.tdTarget));
      const add = el('button', 'ytdl-pill ytdl-pill-add', '+');
      add.title = 'настроить получателей';
      add.addEventListener('click', (ev) => { ev.stopPropagation(); showPane('settings', 'dest'); });
      destRow.appendChild(add);
      renderDestCards();
      const shownDest = destReady(dest) || (haveHelper === null && nativeDest(dest) && destConfigured(dest)) ? dest : 'local';
      destPath.textContent =
        shownDest === 's3' ? 's3://' + t.s3cfg.bucket + '/' + ((t.s3cfg.prefix || '').replace(/^\/+|\/+$/g, '')) + '/'
        : shownDest === 'webdav' ? t.wdcfg.url
        : shownDest === 'ftp' ? 'ftp://' + t.ftpcfg.host + '/' + (t.ftpcfg.dir || '')
        : shownDest === 'smb' ? String(t.smbDir).replace(/^\/Volumes\//, 'smb://')
        : shownDest === 'taildrop' ? 'taildrop → ' + (t.tdLabel || t.tdTarget)
        : 'папка загрузок браузера';
    }

    async function reloadDest() {
      let s = {};
      try { s = await chrome.storage.local.get(['dest', 's3cfg', 'wdcfg', 'ftpcfg', 'smbDir', 'tdTarget', 'tdLabel']); } catch (e) {}
      targets = s;
      normalizeDest(s.dest && s.dest.type);
      renderDest();
      render();
    }
    reloadDest();

    // primary action
    const cta = el('button', 'ytdl-cta');
    const ctaMark = el('span'); ctaMark.style.width = '15px'; ctaMark.style.height = '15px';
    ctaMark.appendChild(triangleSvg('#fff'));
    const ctaTxt = el('span');
    cta.appendChild(ctaMark); cta.appendChild(ctaTxt);
    cta.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const s = start, e2 = end, f = fmt;
      closeMenu();
      if (f.kind === 'txt') { downloadSubtitles(info); return; }
      startDownload({
        format: f.kind === 'mp3' ? 'mp3' : 'mp4',
        height: f.kind === 'mp3' ? null : f.height,
        start: s, end: e2,
      }, info);
    });
    main.appendChild(cta);

    // settings summary chips
    const chips = el('div', 'ytdl-chips');
    const chipSb = el('button');
    const chipTabs = el('button');
    const chipCodec = el('button');
    const chipVot = el('button');
    // каждая плашка ведёт на свою вкладку настроек, а не просто «в настройки»
    [[chipSb, 'video'], [chipTabs, 'dl'], [chipCodec, 'video'], [chipVot, 'vot']].forEach(([c, tab]) => {
      c.addEventListener('click', (ev) => { ev.stopPropagation(); showPane('settings', tab); });
      chips.appendChild(c);
    });
    main.appendChild(chips);
    menuEl.appendChild(main);

    // — settings pane —
    // Раньше это была одна колонка: пятнадцать строк подряд, под каждой —
    // пояснение, а следом развёрнутые формы всех получателей. Теперь настройки
    // разложены по четырём вкладкам, пояснения включаются кнопкой «?», а
    // получатели свёрнуты в карточки — открыт только тот, которым занимаются.
    const settings = el('div', 'ytdl-pane ytdl-settings');

    const TABS = [
      { k: 'video', label: 'Видео' },
      { k: 'dl', label: 'Загрузка' },
      { k: 'vot', label: 'Перевод' },
      { k: 'dest', label: 'Куда' },
    ];
    const pane = {}, tabBtn = {}, tabMark = {};
    const sbar = el('div', 'ytdl-sbar');
    const tabsRow = el('div', 'ytdl-tabs');
    for (const t of TABS) {
      const b = el('button', 'ytdl-tab', t.label);
      // точка у вкладки: на ней есть что-то включённое сверх умолчаний
      const mark = el('span', 'n', '');
      b.appendChild(mark);
      b.addEventListener('click', (ev) => { ev.stopPropagation(); showTab(t.k); });
      tabsRow.appendChild(b);
      tabBtn[t.k] = b; tabMark[t.k] = mark;
      pane[t.k] = el('div', 'ytdl-tabpane');
    }
    sbar.appendChild(tabsRow);
    const hintBtn = el('button', 'ytdl-info', '?');
    hintBtn.title = 'Пояснения к настройкам';
    sbar.appendChild(hintBtn);
    settings.appendChild(sbar);
    for (const t of TABS) settings.appendChild(pane[t.k]);

    let curTab = TABS.some((t) => t.k === store.uiTab) ? store.uiTab : 'video';
    function showTab(k) {
      curTab = k;
      for (const t of TABS) {
        pane[t.k].style.display = t.k === k ? '' : 'none';
        tabBtn[t.k].classList.toggle('sel', t.k === k);
      }
      chrome.storage.local.set({ uiTab: k }).catch(() => {});
      place();
    }
    let hintsOn = cfg.uiHints;
    function applyHints() {
      menuEl.classList.toggle('hints', hintsOn);
      hintBtn.classList.toggle('on', hintsOn);
      place();
    }
    hintBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hintsOn = !hintsOn;
      chrome.storage.local.set({ uiHints: hintsOn }).catch(() => {});
      applyHints();
    });

    // Строки, которые имеют смысл только при включённом родителе, показываются
    // вместе с ним: раньше «Что вырезать» и шесть строк перевода занимали место
    // даже когда и SponsorBlock, и перевод были выключены.
    const votRows = [];
    // объявлена заранее: renderDestCards() дёргает syncDeps() и может успеть
    // раньше, чем строка собрана
    let sbCatsRow = null;
    function syncDeps() {
      if (sbCatsRow) sbCatsRow.style.display = cfg.sbCut ? '' : 'none';
      for (const r of votRows) r.style.display = cfg.votOn ? '' : 'none';
      tabMark.video.textContent = cfg.transcode ? '•' : '';
      tabMark.dl.textContent = cfg.parTabs === 'auto' ? '' : '•';
      tabMark.vot.textContent = cfg.votOn ? cfg.votLang.toUpperCase() : '';
      tabMark.dest.textContent = dest === 'local' ? '' : '•';
    }

    // ---- вкладка «Видео» ----
    pane.video.appendChild(settingRow('Кодек',
      'H.264 совместим со всем, но перекодирование идёт медленно',
      [{ key: 'fast', label: 'Быстро' }, { key: 'h264', label: 'H.264' }],
      cfg.transcode ? 'h264' : 'fast',
      (k) => { cfg.transcode = k === 'h264'; chrome.storage.local.set({ transcode: cfg.transcode }); renderChips(); syncDeps(); }));
    pane.video.appendChild(settingRow('Звук в MP3',
      'оригинал копирует дорожку YouTube как есть — быстрее и без потери качества (файл .opus или .m4a); с вырезками SponsorBlock всё равно нужен MP3',
      [{ key: 'mp3', label: 'MP3' }, { key: 'raw', label: 'Оригинал' }],
      cfg.audioRaw ? 'raw' : 'mp3',
      (k) => { cfg.audioRaw = k === 'raw'; chrome.storage.local.set({ audioRaw: cfg.audioRaw }); }));
    pane.video.appendChild(settingRow('Субтитры к видео',
      'расшифровка YouTube с таймингами: рядом — файлом .srt, внутрь — отдельной дорожкой в mp4 (сначала открывается панель расшифровки, это пара секунд)',
      [{ key: 'off', label: 'Нет' }, { key: 'file', label: 'Файлом' }, { key: 'mux', label: 'Внутрь' }],
      cfg.subsIn,
      (k) => { cfg.subsIn = k; chrome.storage.local.set({ subsIn: k }); }));
    pane.video.appendChild(settingRow('Главы',
      'разметка автора из описания — в mp4 как настоящие главы, по ним можно прыгать',
      [{ key: 'on', label: 'Вкл' }, { key: 'off', label: 'Выкл' }],
      cfg.chapsIn ? 'on' : 'off',
      (k) => { cfg.chapsIn = k === 'on'; chrome.storage.local.set({ chapsIn: cfg.chapsIn }); }));
    pane.video.appendChild(settingRow('SponsorBlock',
      'спонсорские вставки и «подпишись» — по данным sponsor.ajay.app',
      [{ key: 'cut', label: 'Вырезать' }, { key: 'keep', label: 'Оставить' }],
      cfg.sbCut ? 'cut' : 'keep',
      (k) => {
        cfg.sbCut = k === 'cut';
        chrome.storage.local.set({ sbCut: cfg.sbCut });
        renderChips(); drawSponsors(); syncDeps();
      }));
    sbCatsRow = multiRow('Что вырезать',
      'категории SponsorBlock; работает, когда вырезание включено',
      [{ key: 'sponsor', label: 'Реклама' }, { key: 'selfpromo', label: 'Самореклама' },
       { key: 'interaction', label: 'Подписка' }, { key: 'intro', label: 'Заставка' },
       { key: 'outro', label: 'Финал' }, { key: 'preview', label: 'Анонс' },
       { key: 'music_offtopic', label: 'Не музыка' }, { key: 'filler', label: 'Отступления' }],
      cfg.sbCats,
      (v) => { cfg.sbCats = v; chrome.storage.local.set({ sbCats: v }).then(drawSponsors); });
    pane.video.appendChild(sbCatsRow);

    // ---- вкладка «Загрузка» ----
    pane.dl.appendChild(settingRow('Вкладки',
      'параллельная загрузка длинных видео фоновыми вкладками',
      [{ key: 'auto', label: 'Авто' }, { key: '1', label: '1' }, { key: '2', label: '2' }, { key: '3', label: '3' }, { key: '4', label: '4' }],
      cfg.parTabs,
      (k) => { cfg.parTabs = k; chrome.storage.local.set({ parTabs: k }); renderChips(); syncDeps(); }));
    pane.dl.appendChild(settingRow('Размер куска',
      'меньше — экономнее по памяти, больше — меньше стыков',
      [{ key: '10', label: '10' }, { key: '12', label: '12' }, { key: '15', label: '15' }],
      cfg.parChunk,
      (k) => { cfg.parChunk = k; chrome.storage.local.set({ parChunk: Number(k) }); }));
    pane.dl.appendChild(settingRow('Потолок захвата',
      'сколько минут ждать подкачку, прежде чем сдаться; на медленном канале длинному диапазону нужно больше',
      [{ key: '20', label: '20' }, { key: '40', label: '40' }, { key: '60', label: '60' }, { key: '120', label: '120' }],
      cfg.capMin,
      (k) => { cfg.capMin = k; chrome.storage.local.set({ capMin: Number(k) }); }));

    // ---- вкладка «Перевод»: закадровый перевод Яндекса ----
    pane.vot.appendChild(settingRow('Перевод (VOT)',
      'закадровый перевод Яндекса; дорожка готовится на сервере — обычно пара минут; отключает параллельные вкладки',
      [{ key: 'off', label: 'Выкл' }, { key: 'on', label: 'Вкл' }],
      cfg.votOn ? 'on' : 'off',
      (k) => { cfg.votOn = k === 'on'; chrome.storage.local.set({ votOn: cfg.votOn }); renderChips(); syncDeps(); }));
    const votAdd = (row) => { votRows.push(row); pane.vot.appendChild(row); };
    votAdd(settingRow('Режим',
      'поверх — оригинал тише + перевод; вместо — только перевод; дорожка — 2 дорожки (mp4)',
      [{ key: 'mix', label: 'Поверх' }, { key: 'replace', label: 'Вместо' }, { key: 'track', label: 'Дорожка' }],
      cfg.votMode,
      (k) => { cfg.votMode = k; chrome.storage.local.set({ votMode: k }); }));
    votAdd(settingRow('Громкость оригинала',
      'насколько тише родная дорожка под переводом; работает в режиме «поверх»',
      [{ key: '0', label: '0%' }, { key: '15', label: '15%' }, { key: '30', label: '30%' },
       { key: '50', label: '50%' }, { key: '80', label: '80%' }],
      cfg.votVol,
      (k) => { cfg.votVol = k; chrome.storage.local.set({ votVol: Number(k) }); }));
    votAdd(settingRow('Язык перевода',
      'русский, английский или казахский',
      [{ key: 'ru', label: 'RU' }, { key: 'en', label: 'EN' }, { key: 'kk', label: 'KK' }],
      cfg.votLang,
      (k) => { cfg.votLang = k; chrome.storage.local.set({ votLang: k }); renderChips(); syncDeps(); }));
    votAdd(settingRow('Язык оригинала',
      '«авто» — Яндекс определит сам',
      [{ key: 'auto', label: 'Авто' }, { key: 'en', label: 'EN' }, { key: 'ru', label: 'RU' }],
      cfg.votSrcLang,
      (k) => { cfg.votSrcLang = k; chrome.storage.local.set({ votSrcLang: k }); }));
    votAdd(settingRow('Живой голос',
      'нейросетевые голоса Яндекса — нужен вход в аккаунт, только для перевода на русский',
      [{ key: 'off', label: 'Выкл' }, { key: 'on', label: 'Вкл' }],
      cfg.votLively ? 'on' : 'off',
      (k) => { cfg.votLively = k === 'on'; chrome.storage.local.set({ votLively: cfg.votLively }); }));

    // вход в Яндекс — отдельным окном, пароль вводится на стороне Яндекса
    const authRow = el('div', 'ytdl-row');
    const authTop = el('div', 'ytdl-row-top');
    const authState = el('span');
    const authBtn = el('button', 'ytdl-mini');
    authBtn.style.marginLeft = 'auto';
    authTop.appendChild(authState);
    authTop.appendChild(authBtn);
    authRow.appendChild(authTop);
    authRow.appendChild(el('div', 'ytdl-hint',
      'вход открывается в окне Яндекса через сервис автора VOT'));
    function renderAuth() {
      const ok = votAuth.token && (!votAuth.expires || votAuth.expires > Date.now());
      authState.textContent = ok ? 'Аккаунт Яндекса: вход выполнен' : 'Аккаунт Яндекса: входа нет';
      authBtn.textContent = ok ? 'Выйти' : 'Войти';
    }
    authBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = votAuth.token && (!votAuth.expires || votAuth.expires > Date.now());
      if (ok) {
        votAuth = {};
        await chrome.storage.local.remove('votAuth');
        renderAuth();
        return;
      }
      authBtn.textContent = 'Открываю…';
      try { await chrome.runtime.sendMessage({ t: 'ytdl-vot-login' }); } catch (e) {}
      renderAuth();
    });
    // вход происходит в отдельном окне — слушаем хранилище, чтобы строка ожила
    // сразу после него (слушатель один на страницу, см. onAuthChange)
    onAuthChange = (v) => { votAuth = v; renderAuth(); };
    renderAuth();
    votAdd(authRow);

    votAdd(settingRow('Ретранслятор',
      'Яндекс отвечает 402 на запросы из-за пределов СНГ; обход шлёт ссылку на видео через сторонний сервер',
      [{ key: 'off', label: 'Выкл' }, { key: 'on', label: 'Вкл' }],
      cfg.votProxy ? 'on' : 'off',
      (k) => { cfg.votProxy = k === 'on'; chrome.storage.local.set({ votProxy: cfg.votProxy }); }));
    votAdd(fieldGrid([
      { k: 'host', ph: 'адрес ретранслятора (vot-worker.eu.cc)', val: votProxyCfg.host, wide: true },
    ], 'votProxyCfg'));

    // ---- вкладка «Куда»: получатели ----------------------------------------
    // Two classes, deliberately separated:
    //   * S3 / WebDAV — uploaded straight from the extension, no helper, always on;
    //   * Taildrop / SMB / FTP — need the native helper; without it these rows show
    //     a quiet "нужен помощник" hint and NOTHING else changes. No banners, no
    //     errors on open: the base extension must behave exactly as before.
    // Каждый получатель — свёрнутая карточка: в заголовке имя и состояние
    // («отправляем сюда» / «настроен» / «проверьте поля» / «нужен помощник»),
    // поля открываются по клику. Развёрнуты все формы сразу были главным
    // источником ощущения перегруженности.
    function destCard(kind, badge, title, hint) {
      const c = el('div', 'ytdl-card');
      const top = el('button', 'ytdl-card-top');
      top.appendChild(el('i', 'ytdl-pill-b', badge));
      top.appendChild(el('span', 'ytdl-card-name', title));
      const st = el('span', 'ytdl-card-st', '');
      top.appendChild(st);
      top.appendChild(el('span', 'ytdl-chev', '›'));
      const body = el('div', 'ytdl-card-body');
      if (hint) body.appendChild(el('div', 'ytdl-hint', hint));
      top.addEventListener('click', (ev) => {
        ev.stopPropagation();
        c.classList.toggle('open');
        place();
      });
      c.appendChild(top);
      c.appendChild(body);
      pane.dest.appendChild(c);
      const rec = { node: c, body, st, use: null };
      destCards[kind] = rec;
      return rec;
    }
    // «Отправлять сюда» делает ровно то же, что пилюля на главной панели —
    // из настроек получателя не нужно возвращаться, чтобы его выбрать
    function useBtn(kind) {
      const b = el('button', 'ytdl-mini ytdl-use', 'Отправлять сюда');
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dest = kind;
        chrome.storage.local.set({ dest: { type: kind } }).catch(() => {});
        renderDest();
        render();
      });
      return b;
    }
    // Состояние карточек считается по тем же правилам, по каким получатель
    // попадает в «Куда»: настроен и проверен — можно отправлять.
    function renderDestCards() {
      const t = targets;
      const set = (kind, ready, txt) => {
        const c = destCards[kind];
        if (!c) return;
        const on = dest === kind;
        c.node.classList.toggle('active', on);
        c.st.textContent = on ? 'отправляем сюда' : txt;
        c.st.className = 'ytdl-card-st' + (on ? ' on' : (ready ? '' : ' bad'));
        if (c.use) c.use.style.display = (ready && !on) ? '' : 'none';
      };
      const state = (key, cfgObj, has) => !has ? 'не настроен'
        : (destOk(key, cfgObj) ? 'настроен' : 'проверьте поля');
      set('local', true, 'папка загрузок браузера');
      set('s3', destReady('s3'),
        state('s3cfg', t.s3cfg || {}, !!(t.s3cfg && t.s3cfg.bucket)));
      set('webdav', destReady('webdav'),
        state('wdcfg', t.wdcfg || {}, !!(t.wdcfg && t.wdcfg.url)));
      set('ftp', destReady('ftp'),
        haveHelper === null ? 'проверяю помощник'
        : !haveHelper ? 'нужен помощник' : state('ftpcfg', t.ftpcfg || {}, !!(t.ftpcfg && t.ftpcfg.host)));
      set('taildrop', destReady('taildrop'),
        haveHelper === null ? 'проверяю помощник'
        : !haveHelper ? 'нужен помощник' : (t.tdTarget ? (t.tdLabel || t.tdTarget) : 'устройство не выбрано'));
      set('smb', destReady('smb'),
        haveHelper === null ? 'проверяю помощник'
        : !haveHelper ? 'нужен помощник' : (t.smbDir || 'папка не задана'));
      syncDeps();
    }

    // Поля сохраняются всегда — иначе наполовину заполненная форма пропадала бы
    // при закрытии меню. Но получатель с ошибками не попадает в «Куда»:
    // непроверенные данные всплыли бы уже во время выгрузки готового файла.
    function fieldGrid(fields, saveKey) {
      const wrap = el('div');
      const grid = el('div', 'ytdl-fgrid');
      const errBox = el('div', 'ytdl-err');
      const inputs = {};

      const recheck = () => {
        const out = {};
        for (const k of Object.keys(inputs)) out[k] = inputs[k].value.trim();
        const errs = destErrors(saveKey, out);
        for (const k of Object.keys(inputs)) inputs[k].classList.toggle('bad', !!errs[k]);
        const msgs = Object.keys(errs).map((k) => errs[k]);
        errBox.textContent = msgs.length ? msgs.join(' · ') : '';
        return out;
      };

      for (const f of fields) {
        const i = document.createElement('input');
        i.className = 'ytdl-f';
        i.placeholder = f.ph;
        i.value = f.val || '';
        i.spellcheck = false;
        if (f.secret) i.type = 'password';
        if (f.wide) i.classList.add('wide');
        i.addEventListener('click', (ev) => ev.stopPropagation());
        i.addEventListener('input', () => { if (errBox.textContent) recheck(); });
        i.addEventListener('change', async () => {
          const out = recheck();
          if (saveKey === 'votProxyCfg' && out.host) {
            // vot.js подставляет https:// сам — вставленные схема и путь сломали бы URL
            out.host = out.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            inputs.host.value = out.host;
          }
          try { await chrome.storage.local.set({ [saveKey]: out }); } catch (e) {}
          reloadDest();
        });
        inputs[f.k] = i;
        grid.appendChild(i);
      }

      wrap.appendChild(grid);
      wrap.appendChild(errBox);
      // уже сохранённые данные тоже могут быть с изъяном — показываем сразу
      if (fields.some((f) => f.val)) recheck();
      return wrap;
    }

    const HELP_HINT = /Windows/i.test(navigator.userAgent)
      ? 'нужен помощник: native\\install.ps1 <id расширения>'
      : 'нужен помощник: native/install.sh <id расширения>';

    // «Локально» карточкой тоже: иначе вернуться к обычному скачиванию можно
    // было только со главной панели
    const cLocal = destCard('local', '↓', 'Локально',
      'файл кладётся в папку загрузок браузера — как без всяких настроек');
    cLocal.use = useBtn('local');
    cLocal.body.appendChild(cLocal.use);

    const s3 = targets.s3cfg || {};
    const cS3 = destCard('s3', 'S3', 'S3',
      'выгрузка напрямую из расширения, помощник не нужен');
    cS3.body.appendChild(fieldGrid([
      { k: 'endpoint', ph: 'endpoint (https://s3.amazonaws.com)', val: s3.endpoint, wide: true },
      { k: 'bucket', ph: 'bucket', val: s3.bucket },
      { k: 'region', ph: 'region (us-east-1)', val: s3.region },
      { k: 'prefix', ph: 'папка (youtube/2026)', val: s3.prefix, wide: true },
      { k: 'key', ph: 'access key', val: s3.key },
      { k: 'secret', ph: 'secret key', val: s3.secret, secret: true },
    ], 's3cfg'));
    cS3.use = useBtn('s3');
    cS3.body.appendChild(cS3.use);

    const wd = targets.wdcfg || {};
    const cWd = destCard('webdav', 'DAV', 'WebDAV',
      'тоже напрямую из расширения (Synology / Nextcloud / QNAP)');
    cWd.body.appendChild(fieldGrid([
      { k: 'url', ph: 'https://nas.local:5006/video', val: wd.url, wide: true },
      { k: 'user', ph: 'логин', val: wd.user },
      { k: 'pass', ph: 'пароль', val: wd.pass, secret: true },
    ], 'wdcfg'));
    cWd.use = useBtn('webdav');
    cWd.body.appendChild(cWd.use);

    const ftp = targets.ftpcfg || {};
    const cFtp = destCard('ftp', 'FTP', 'FTP', 'выгрузка через нативного помощника');
    const ftpHint = el('div', 'ytdl-note', '');
    cFtp.body.appendChild(ftpHint);
    cFtp.body.appendChild(fieldGrid([
      { k: 'host', ph: 'ftp.server.local', val: ftp.host, wide: true },
      { k: 'port', ph: '21', val: ftp.port },
      { k: 'dir', ph: 'папка', val: ftp.dir },
      { k: 'user', ph: 'логин', val: ftp.user },
      { k: 'pass', ph: 'пароль', val: ftp.pass, secret: true },
    ], 'ftpcfg'));
    cFtp.use = useBtn('ftp');
    cFtp.body.appendChild(cFtp.use);

    const cTd = destCard('taildrop', 'TS', 'Taildrop',
      'отправка файла на другое устройство Tailscale, через помощника');
    const tdTop = el('div', 'ytdl-row-top');
    tdTop.appendChild(el('span', null, 'Устройство'));
    const tdPick = el('select', 'ytdl-select');
    tdTop.appendChild(tdPick);
    cTd.body.appendChild(tdTop);
    const tdHint = el('div', 'ytdl-note', 'устройство Tailscale');
    cTd.body.appendChild(tdHint);
    cTd.use = useBtn('taildrop');
    cTd.body.appendChild(cTd.use);

    // Сетевая папка задаётся путём — так работает всегда. Список подключённых
    // и поиск по сети — вспомогательные: список бывает пуст (в Windows папку
    // можно открыть по \\сервер\шара, не подключая диск), а поиск зависит от
    // службы обзора сети и часто молчит, поэтому он под кнопкой, а не сам собой.
    const IS_WIN_UI = /Windows/i.test(navigator.userAgent);
    const SMB_HINT = IS_WIN_UI
      ? 'путь вида \\\\сервер\\шара — подключать сетевой диск необязательно'
      : 'путь смонтированной шары, например /Volumes/video';
    const cSmb = destCard('smb', 'NAS', 'Сетевая папка',
      'копирование в подключённую или сетевую папку, через помощника');
    const smbTop = el('div', 'ytdl-row-top');
    smbTop.appendChild(el('span', null, 'Подключённые'));
    const smbPick = el('select', 'ytdl-select');
    smbTop.appendChild(smbPick);
    const smbScan = el('button', 'ytdl-mini', 'искать');
    smbTop.appendChild(smbScan);
    cSmb.body.appendChild(smbTop);
    const smbPath = document.createElement('input');
    smbPath.className = 'ytdl-f wide';
    smbPath.placeholder = IS_WIN_UI ? '\\\\nas\\video' : '/Volumes/video';
    smbPath.spellcheck = false;
    smbPath.addEventListener('click', (ev) => ev.stopPropagation());
    cSmb.body.appendChild(smbPath);
    const smbHint = el('div', 'ytdl-note', SMB_HINT);
    cSmb.body.appendChild(smbHint);
    cSmb.use = useBtn('smb');
    cSmb.body.appendChild(cSmb.use);

    function emptyPick(pick, label) {
      while (pick.firstChild) pick.removeChild(pick.firstChild);
      const o = el('option', null, label);
      o.value = '';
      pick.appendChild(o);
    }

    async function loadHelperRows() {
      emptyPick(tdPick, 'не отправлять');
      emptyPick(smbPick, 'не копировать');
      // one quiet probe decides everything — absence is a state, not an error
      let ping = null;
      try { ping = await chrome.runtime.sendMessage({ t: 'ytdl-td-ping' }); } catch (e) {}
      haveHelper = !!(ping && (ping.ok || ping.pong || ping.tailscale !== undefined));
      for (const n of [tdHint, smbHint, ftpHint]) n.classList.toggle('warn', !haveHelper);
      if (!haveHelper) {
        tdPick.disabled = smbPick.disabled = smbScan.disabled = smbPath.disabled = true;
        tdHint.textContent = smbHint.textContent = ftpHint.textContent = HELP_HINT;
        renderDest();
        return;
      }
      tdPick.disabled = smbPick.disabled = smbScan.disabled = smbPath.disabled = false;
      ftpHint.textContent = 'помощник на связи';

      const [devs, mounted, st] = await Promise.all([
        chrome.runtime.sendMessage({ t: 'ytdl-td-devices' }).catch(() => null),
        chrome.runtime.sendMessage({ t: 'ytdl-smb', cmd: 'smb-mounted' }).catch(() => null),
        chrome.storage.local.get(['tdTarget', 'smbDir']).catch(() => ({})),
      ]);
      if (devs && devs.ok && devs.devices.length) {
        for (const d of devs.devices) {
          const o = el('option', null, d.name + (d.online ? '' : ' (офлайн)'));
          // адресом, а не именем: имена бывают с апострофами и кириллицей,
          // 100.x.y.z доезжает до помощника без потерь
          o.value = d.ip || d.host;
          tdPick.appendChild(o);
        }
        if (st.tdTarget) {
          tdPick.value = st.tdTarget;
          // сохранённое имя из прошлых версий — переводим на адрес
          if (!tdPick.value) {
            const same = devs.devices.find((d) => d.host === st.tdTarget || d.name === st.tdTarget);
            if (same) {
              tdPick.value = same.ip || same.host;
              chrome.storage.local.set({ tdTarget: tdPick.value }).catch(() => {});
            }
          }
        }
        tdHint.textContent = 'устройство Tailscale';
      } else {
        tdHint.textContent = (devs && devs.error) || 'в вашей сети нет других устройств';
      }
      if (mounted && mounted.ok) {
        for (const m of mounted.mounted) {
          const o = el('option', null, m.name + (m.writable ? '' : ' (только чтение)'));
          o.value = m.path;
          smbPick.appendChild(o);
        }
        if (st.smbDir) {
          smbPick.value = st.smbDir;
          if (!smbPick.value) smbPath.value = st.smbDir; // задано вручную
        }
        smbHint.textContent = SMB_HINT;
      }
      renderDest();
    }
    loadHelperRows();

    [tdPick, smbPick].forEach((p) => p.addEventListener('click', (ev) => ev.stopPropagation()));
    tdPick.addEventListener('change', async () => {
      // отправляем на адрес, а показываем имя — пользователю адрес ни о чём не говорит
      const label = tdPick.selectedOptions[0] ? tdPick.selectedOptions[0].textContent : '';
      await chrome.storage.local.set({
        tdTarget: tdPick.value || null,
        tdLabel: tdPick.value ? label.replace(' (офлайн)', '') : null,
      }).catch(() => {});
      // Устройство выбирают ради отправки: если в «Куда» стоит «Локально»,
      // сразу переключаем на Taildrop. Иначе пилюля лишь появляется, доставка
      // молча не происходит, и это выглядит как «ничего не отправилось».
      if (tdPick.value) {
        try {
          const { dest: d } = await chrome.storage.local.get('dest');
          if (!d || d.type === 'local') await chrome.storage.local.set({ dest: { type: 'taildrop' } });
        } catch (e) {}
      }
      reloadDest();
    });
    smbPick.addEventListener('change', async () => {
      smbPath.value = smbPick.value || '';
      await chrome.storage.local.set({ smbDir: smbPick.value || null }).catch(() => {});
      reloadDest();
    });
    const saveSmbPath = async () => {
      const v = smbPath.value.trim();
      const bad = v && !(IS_WIN_UI ? /^\\\\[^\\]+\\[^\\]/.test(v) || /^[a-zA-Z]:\\/.test(v) : v.startsWith('/'));
      smbPath.classList.toggle('bad', !!bad);
      smbHint.textContent = bad
        ? (IS_WIN_UI ? 'путь должен начинаться с \\\\сервер\\шара или с буквы диска' : 'путь должен начинаться с /')
        : SMB_HINT;
      if (bad) return;
      if (v) smbPick.value = ''; // ручной путь важнее выбранного из списка
      await chrome.storage.local.set({ smbDir: v || null }).catch(() => {});
      reloadDest();
    };
    smbPath.addEventListener('change', saveSmbPath);
    smbPath.addEventListener('input', () => { if (smbPath.classList.contains('bad')) saveSmbPath(); });
    smbScan.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      smbScan.disabled = true;
      smbHint.textContent = 'ищу серверы в сети…';
      let r = null;
      try { r = await chrome.runtime.sendMessage({ t: 'ytdl-smb', cmd: 'smb-discover' }); } catch (e) {}
      smbScan.disabled = false;
      if (!r || !r.ok) { smbHint.textContent = (r && r.error) || 'поиск не удался'; return; }
      smbHint.textContent = r.servers.length
        ? 'найдено: ' + r.servers.map((s) => s.name).join(', ') + ' — впишите путь до нужной папки'
        : (r.hint || 'серверы не найдены — впишите путь вручную');
      loadHelperRows();
    });

    // ---- журнал запусков ----------------------------------------------------
    // Живёт в подвале настроек, а не отдельной строкой среди них: его открывают
    // раз в сто загрузок, когда что-то пошло не так.
    const logBtn = el('button', 'ytdl-mini', 'Журнал JSON');
    logBtn.title = 'последние ' + RUNLOG_MAX + ' запусков: настройки, получатели и шаги; ' +
      'пароли и токены — маской';
    logBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      let list = [];
      try { list = (await chrome.storage.local.get(RUNLOG_KEY))[RUNLOG_KEY] || []; } catch (e) {}
      if (!list.length) { logBtn.textContent = 'журнал пуст'; setTimeout(() => { logBtn.textContent = 'Журнал JSON'; }, 2500); return; }
      const url = 'data:application/json;charset=utf-8,' +
        encodeURIComponent(JSON.stringify(list, null, 2));
      try {
        const r = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename: 'triangle-runlog.json', noDeliver: true });
        logBtn.textContent = r && r.ok ? 'сохранён' : 'не удалось';
      } catch (e) { logBtn.textContent = 'не удалось'; }
      setTimeout(() => { logBtn.textContent = 'Журнал JSON'; }, 2500);
    });

    const foot = el('div', 'ytdl-foot');
    const back = el('button', 'ytdl-back', '‹ к загрузке');
    back.addEventListener('click', (ev) => { ev.stopPropagation(); showPane('main'); });
    foot.appendChild(back);
    foot.appendChild(logBtn);
    settings.appendChild(foot);
    menuEl.appendChild(settings);

    function showPane(which, tab) {
      main.style.display = which === 'main' ? '' : 'none';
      settings.style.display = which === 'settings' ? '' : 'none';
      gear.classList.toggle('on', which === 'settings');
      if (which === 'settings') showTab(tab || curTab); else place();
    }
    gear.addEventListener('click', (ev) => {
      ev.stopPropagation();
      showPane(settings.style.display === 'none' ? 'settings' : 'main');
    });

    // Плашки под кнопкой скачивания — не только сводка, но и вход в нужную
    // вкладку настроек: щёлкнув по «VOT: RU», попадаешь прямо на перевод.
    function renderChips() {
      chipSb.textContent = cfg.sbCut ? 'SponsorBlock: вырезать' : 'SponsorBlock: выкл';
      chipSb.classList.toggle('on', cfg.sbCut);
      chipTabs.textContent = cfg.parTabs === 'auto' ? 'вкладок: авто' : 'вкладок: ' + cfg.parTabs;
      chipCodec.textContent = cfg.transcode ? 'H.264' : 'VP9';
      chipVot.textContent = cfg.votOn ? 'VOT: ' + cfg.votLang.toUpperCase() : 'VOT: выкл';
      chipVot.classList.toggle('on', cfg.votOn);
    }

    function render() {
      const pct = (t) => (duration ? (t / duration) * 100 : 0);
      dimL.style.width = pct(start) + '%';
      dimR.style.width = (100 - pct(end)) + '%';
      sel.style.left = pct(start) + '%';
      sel.style.width = (pct(end) - pct(start)) + '%';
      hL.style.left = pct(start) + '%';
      hR.style.left = pct(end) + '%';
      if (document.activeElement !== tStart) tStart.value = fmtShort(start);
      if (document.activeElement !== tEnd) tEnd.value = fmtShort(end);
      lenTxt.textContent = '· ' + fmtShort(end - start);
      const whole = fmt.kind === 'txt';
      strip.style.opacity = whole ? '.45' : '';
      const size = fmtSize(rateFor(fmt.kind, fmt.height) * (end - start));
      // the button states the whole action: local save, or save + upload
      ctaTxt.textContent = whole
        ? (dest === 'local' ? 'Скачать субтитры' : 'Скачать и выгрузить субтитры')
        : (dest === 'local' ? 'Скачать ' + fmt.label + ' · ' + size
                            : 'Скачать и выгрузить · ' + size);
      renderChips();
    }

    // dragging the range handles
    strip.addEventListener('pointerdown', (ev) => {
      if (fmt.kind === 'txt') return;
      ev.stopPropagation();
      const at = (e2) => {
        const r = strip.getBoundingClientRect();
        return Math.min(1, Math.max(0, (e2.clientX - r.left) / r.width)) * duration;
      };
      const which = Math.abs(at(ev) - start) <= Math.abs(at(ev) - end) ? 'start' : 'end';
      const move = (e2) => {
        const t = at(e2);
        if (which === 'start') start = Math.min(t, end - 5);
        else end = Math.max(t, start + 5);
        render();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      move(ev);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // SponsorBlock marks on the strip (never blocks the menu)
    async function drawSponsors() {
      while (sbLayer.firstChild) sbLayer.removeChild(sbLayer.firstChild);
      if (!cfg.sbCut || !duration) return;
      const segs = await fetchSponsorSegments(info.videoId, 0, duration);
      for (const s of segs) {
        const m = el('span', 'ytdl-sb-mark');
        m.style.left = (s.start / duration) * 100 + '%';
        m.style.width = Math.max(0.6, ((s.end - s.start) / duration) * 100) + '%';
        m.title = 'Спонсорская вставка';
        sbLayer.appendChild(m);
      }
    }

    showTab(curTab);   // вкладки прячутся друг за друга только после первого показа
    applyHints();
    syncDeps();
    showPane('main');
    render();
    document.body.appendChild(menuEl);
    drawSponsors();

    function place() {
      const b = document.getElementById(BTN_ID).getBoundingClientRect();
      menuEl.style.right = Math.max(8, window.innerWidth - b.right) + 'px';
      // The menu opens upwards from the button; cap its height to the viewport and
      // clamp the offset so the whole menu stays on screen (it scrolls internally).
      menuEl.style.maxHeight = Math.max(160, window.innerHeight - 16) + 'px';
      const r = menuEl.getBoundingClientRect();
      if (r.left < 8) {
        menuEl.style.right = Math.max(8, window.innerWidth - r.width - 8) + 'px';
      }
      const h = menuEl.getBoundingClientRect().height;
      const wanted = window.innerHeight - b.top + 8;      // sit just above the button
      const highest = window.innerHeight - h - 8;         // keeps top edge at >= 8px
      menuEl.style.bottom = Math.max(8, Math.min(wanted, highest)) + 'px';
    }
    place();
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  }

  // ---- progress toast ------------------------------------------------------
  function toast() {
    let box = document.getElementById('ytdl-toast');
    if (!box) {
      box = el('div'); box.id = 'ytdl-toast';
      const head = el('div', 'ytdl-toast-head');
      const mark = el('span'); mark.style.width = '13px'; mark.style.height = '13px';
      mark.appendChild(triangleSvg('#ff4e45'));
      head.appendChild(mark);
      head.appendChild(el('span', 'ytdl-toast-name', 'Triangle'));
      head.appendChild(el('span', 'ytdl-toast-pct', ''));
      box.appendChild(head);
      const bar = el('div', 'ytdl-toast-bar'); bar.appendChild(el('i'));
      box.appendChild(bar);
      box.appendChild(el('span', 'ytdl-toast-txt'));
      const copy = el('button', 'ytdl-toast-copy', 'Скопировать отчёт');
      copy.style.display = 'none';
      box.appendChild(copy);
      document.body.appendChild(box);
    }
    const copyBtn = box.querySelector('.ytdl-toast-copy');
    const hideTimer = { id: null };
    const arm = (delay) => {
      clearTimeout(hideTimer.id);
      hideTimer.id = setTimeout(() => box.classList.remove('show'), delay || 0);
    };
    return {
      set(txt, pct) {
        copyBtn.style.display = 'none';
        box.querySelector('.ytdl-toast-txt').textContent = txt;
        box.querySelector('.ytdl-toast-pct').textContent = Math.round((pct || 0) * 100) + '%';
        box.querySelector('.ytdl-toast-bar i').style.width = Math.round((pct || 0) * 100) + '%';
        clearTimeout(hideTimer.id);
        box.classList.add('show');
      },
      hide(delay) { arm(delay); },
      // Ошибку почти всегда надо кому-то переслать, а выделить текст в тосте
      // нельзя — он исчезает. Поэтому рядом с сообщением живёт кнопка, кладущая
      // в буфер обмена и саму ошибку, и обстановку, в которой она случилась.
      fail(err, ctx) {
        this.set('Ошибка: ' + ((err && err.message) || err), 1);
        const report = buildReport(err, ctx);
        console.error('[Triangle]', err, report);
        copyBtn.textContent = 'Скопировать отчёт';
        copyBtn.style.display = '';
        copyBtn.onclick = async (ev) => {
          ev.stopPropagation();
          clearTimeout(hideTimer.id); // читают отчёт — тост не должен убегать
          try {
            await navigator.clipboard.writeText(report);
            copyBtn.textContent = 'Скопировано';
          } catch (e) {
            copyBtn.textContent = 'Не вышло — отчёт в консоли (F12)';
          }
          arm(20000);
        };
        arm(30000); // ошибку читают дольше, чем «Готово»
      },
    };
  }

  // ---- очередь загрузок ----------------------------------------------------
  // Сам список заданий держит service worker (см. background.js): качать можно
  // из нескольких вкладок сразу, и панель должна показывать всё, а не только
  // «своё». Здесь только клиент — вкладка досылает свои шаги и рисует панель.
  const Q_STATE = {
    run: 'идёт', pause: 'пауза', merge: 'склейка', stall: 'нужен повтор',
    done: 'готово', error: 'ошибка', cancel: 'отменено',
  };
  const qActive = (it) => !it.finishedAt;

  function qSend(m) {
    try { return chrome.runtime.sendMessage(m).catch(() => null); }
    catch (e) { return Promise.resolve(null); }
  }

  // Возвращает «ручку» задания: .upd(текст, доля) и .end(состояние, детали).
  // Если воркер не ответил, ручка молча ничего не делает — очередь не тот повод,
  // из-за которого стоит валить саму загрузку.
  async function queueAdd(fields) {
    const r = await qSend(Object.assign({ t: 'ytdl-q-add' }, fields));
    const id = r && r.ok ? r.id : null;
    let lastNote = null, lastPct = -1;
    return {
      id,
      upd(note, progress) {
        if (!id) return;
        // шаг в 1% — иначе прогресс захвата шлёт по сообщению каждые 350 мс
        const pct = progress == null ? lastPct : Math.round(progress * 100) / 100;
        if (note === lastNote && pct === lastPct) return;
        lastNote = note; lastPct = pct;
        qSend({ t: 'ytdl-q-upd', id, note, progress: pct });
        queueRefresh();
      },
      end(state, extra) {
        if (!id) return;
        qSend(Object.assign({ t: 'ytdl-q-end', id, state }, extra || {}));
        queueRefresh();
      },
    };
  }

  let queueBox = null;    // панель, пока открыта
  let queueTimer = null;  // опрос списка раз в секунду
  const queueCount = { active: 0, onChange: null }; // для счётчика в шапке меню

  function queueToggle() { if (queueBox) queueClose(); else queueOpen(); }

  function queueClose() {
    clearInterval(queueTimer); queueTimer = null;
    if (queueBox) { queueBox.box.remove(); queueBox = null; }
  }

  function queueOpen() {
    if (queueBox) { queueRefresh(); return; }
    const box = el('div'); box.id = 'ytdl-queue';
    box.addEventListener('click', (ev) => ev.stopPropagation());

    const head = el('div', 'ytdl-q-head');
    const mark = el('span'); mark.style.width = '13px'; mark.style.height = '13px';
    mark.appendChild(triangleSvg('#ff4e45'));
    head.appendChild(mark);
    const title = el('span', 'ytdl-q-title', 'Очередь загрузок');
    head.appendChild(title);
    const clear = el('button', 'ytdl-q-clear', 'очистить');
    clear.title = 'убрать завершённые';
    clear.addEventListener('click', async () => {
      const r = await qSend({ t: 'ytdl-q-ctl', cmd: 'clear' });
      if (r && r.ok) renderQueue(r.items);
    });
    head.appendChild(clear);
    const close = el('button', 'ytdl-q-close', '✕');
    close.title = 'Скрыть';
    close.addEventListener('click', queueClose);
    head.appendChild(close);
    box.appendChild(head);

    const list = el('div', 'ytdl-q-list');
    box.appendChild(list);
    document.body.appendChild(box);

    queueBox = { box, list, title, clear };
    queueRefresh();
    queueTimer = setInterval(queueRefresh, 1000);
  }

  // Один запрос обслуживает и панель, и счётчик в шапке меню — поэтому он
  // выполняется даже с закрытой панелью, когда меню открыто.
  async function queueRefresh() {
    if (!queueBox && !queueCount.onChange) return;
    const r = await qSend({ t: 'ytdl-q-list' });
    if (!r || !r.ok) return;
    queueCount.active = r.items.filter(qActive).length;
    if (queueCount.onChange) queueCount.onChange(queueCount.active);
    if (queueBox) renderQueue(r.items);
  }

  // Панель открывается сама только когда очередь действительно очередь —
  // то есть рядом с новым заданием уже идёт другое. Одиночная загрузка и без
  // того видна в тосте, и лишнее окно поверх плеера ей ни к чему.
  async function queueAutoOpen() {
    if (queueBox) return;
    const r = await qSend({ t: 'ytdl-q-list' });
    if (r && r.ok && r.items.filter(qActive).length > 1) queueOpen();
  }

  function queueRow(it) {
    const row = el('div', 'ytdl-q-row' + (qActive(it) ? '' : ' fin'));

    const top = el('div', 'ytdl-q-top');
    if (it.label) top.appendChild(el('i', 'ytdl-q-tag', it.label));
    const name = el('span', 'ytdl-q-name', it.name || 'видео');
    name.title = it.filename || it.name || '';
    top.appendChild(name);
    const st = el('span', 'ytdl-q-st ytdl-q-st-' + it.state, Q_STATE[it.state] || it.state);
    top.appendChild(st);

    // Повтор поднимает загрузку целиком в воркере: вкладку с видео задание
    // откроет себе само, поэтому кнопка работает и для давно закрытого ролика.
    if (it.retryable) {
      const re = el('button', 'ytdl-q-re', '↻');
      re.title = 'Повторить загрузку';
      re.addEventListener('click', async () => {
        re.disabled = true;
        const r = await qSend({ t: 'ytdl-q-ctl', cmd: 'retry', id: it.id });
        if (r && r.items) renderQueue(r.items);
      });
      top.appendChild(re);
    }

    if (it.state === 'done' && it.filename) {
      const fold = el('button', 'ytdl-q-re');
      fold.appendChild(folderSvg());
      fold.title = 'Показать в папке';
      fold.addEventListener('click', () => qSend({ t: 'ytdl-q-show', filename: it.filename }));
      top.appendChild(fold);
    }

    // отменить можно только параллельное задание — однотабный захват идёт внутри
    // страницы, прервать его на полпути нечем; у завершённых крестик убирает строку
    const act = el('button', 'ytdl-q-x', '✕');
    if (it.cancelable) {
      act.title = 'Отменить';
      act.addEventListener('click', async () => {
        const r = await qSend({ t: 'ytdl-q-ctl', cmd: 'cancel', id: it.id });
        if (r && r.ok) renderQueue(r.items);
      });
    } else if (!qActive(it)) {
      act.title = 'Убрать из списка';
      act.addEventListener('click', async () => {
        const r = await qSend({ t: 'ytdl-q-ctl', cmd: 'remove', id: it.id });
        if (r && r.ok) renderQueue(r.items);
      });
    } else {
      act.style.visibility = 'hidden';
    }
    top.appendChild(act);
    row.appendChild(top);

    const bar = el('div', 'ytdl-q-bar');
    const fill = el('i');
    fill.style.width = Math.round(it.progress * 100) + '%';
    if (it.state === 'done') fill.style.background = '#3dba54';
    else if (it.state === 'error') fill.style.background = '#ff4e45';
    else if (it.state === 'cancel' || it.state === 'pause') fill.style.background = '#6f7378';
    bar.appendChild(fill);
    row.appendChild(bar);

    const note = it.state === 'error' ? (it.error || 'ошибка')
      : it.state === 'done' ? (it.filename || 'файл сохранён')
      : it.note || '';
    const foot = el('div', 'ytdl-q-note',
      (note ? note + ' · ' : '') + Math.round(it.progress * 100) + '%' +
      (it.dest && it.dest !== 'local' ? ' · → ' + it.dest : ''));
    row.appendChild(foot);
    if (it.warn) row.appendChild(el('div', 'ytdl-q-warn', it.warn));
    return row;
  }

  function renderQueue(items) {
    if (!queueBox) return;
    const { list, title, clear } = queueBox;
    while (list.firstChild) list.removeChild(list.firstChild);
    // свежие сверху: пока что-то идёт, смотрят именно на них
    const sorted = items.slice().sort((a, b) => (qActive(b) - qActive(a)) || (b.startedAt - a.startedAt));
    for (const it of sorted) list.appendChild(queueRow(it));
    if (!sorted.length) list.appendChild(el('div', 'ytdl-q-empty', 'Пока пусто'));
    const active = items.filter(qActive).length;
    title.textContent = active ? 'Очередь · ' + active + ' в работе' : 'Очередь загрузок';
    clear.style.display = items.some((it) => !qActive(it)) ? '' : 'none';
  }

  // Всё, что нужно для разбора, кроме секретов: токен Яндекса и пароли получателей
  // сюда не попадают.
  function buildReport(err, ctx) {
    const c = ctx || {};
    const v = (x, dash) => (x == null || x === '' ? (dash || '—') : String(x));
    const lines = [
      'Triangle Downloader ' + (chrome.runtime.getManifest().version || '?') + ' — отчёт об ошибке',
      'Когда: ' + new Date().toISOString(),
      'Ошибка: ' + ((err && err.message) || err),
    ];
    if (err && err.stack) lines.push('Стек: ' + String(err.stack).split('\n').slice(0, 4).join(' | '));
    lines.push(
      'Шаг: ' + v(c.stage),
      'Задача: ' + v(c.format) + (c.height ? ' ' + c.height + 'p' : '') +
        ', фрагмент ' + v(c.start, '0') + '–' + v(c.end, '?') + ' из ' + v(c.duration, '?') + ' с' +
        ', перекодирование: ' + (c.transcode ? 'да' : 'нет'),
      'SponsorBlock: ' + (c.sbCut === false ? 'выкл' : 'вкл') +
        (c.sbCount != null ? ', вставок ' + c.sbCount : ''),
      'Вкладки: ' + v(c.parTabs) + (c.parallel ? ' (параллельный режим)' : ''),
      'Получатель: ' + v(c.dest, 'локально'),
    );
    if (c.vot) {
      lines.push('VOT: вкл, режим ' + v(c.vot.mode) + ', ' + v(c.vot.srcLang) + ' → ' + v(c.vot.lang) +
        ', живой голос: ' + (c.vot.lively ? 'да' : 'нет') +
        ', вход: ' + (c.authOk ? 'есть' : 'нет') +
        ', ретранслятор: ' + (c.votProxy ? 'вкл' : 'выкл'));
    } else {
      lines.push('VOT: выкл');
    }
    lines.push(
      'Видео: ' + v(c.videoId),
      'Браузер: ' + navigator.userAgent,
    );
    return lines.join('\n');
  }

  // Проверка настроек получателя: {поле: причина}. Пустой объект — можно
  // отправлять. Правила совпадают с тем, что примет принимающая сторона (имя
  // сервера — теми же символами, что проверяет помощник), чтобы отказ случался
  // здесь, а не через полчаса после скачивания.
  function destErrors(kind, c) {
    const e = {};
    const httpUrl = (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch (err) { return false; }
    };
    const hostOk = (v) => /^[a-zA-Z0-9.\-_]+$/.test(v);
    const filled = (o) => Object.keys(o).some((k) => o[k]);

    if (kind === 's3cfg') {
      if (!filled(c)) return e; // пустая форма — не ошибка, просто не настроено
      if (!c.endpoint) e.endpoint = 'нужен адрес S3';
      else if (!httpUrl(c.endpoint)) e.endpoint = 'адрес должен начинаться с https://';
      if (!c.bucket) e.bucket = 'нужен bucket';
      else if (!/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/.test(c.bucket)) e.bucket = 'bucket: строчные буквы, цифры, точка, дефис';
      if (!c.region) e.region = 'нужен регион (например us-east-1)';
      else if (!/^[a-z0-9\-]+$/.test(c.region)) e.region = 'регион: строчные буквы, цифры, дефис';
      if (!c.key) e.key = 'нужен access key';
      if (!c.secret) e.secret = 'нужен secret key';
    }

    if (kind === 'wdcfg') {
      if (!filled(c)) return e;
      if (!c.url) e.url = 'нужен адрес WebDAV';
      else if (!httpUrl(c.url)) e.url = 'адрес должен начинаться с http:// или https://';
      if (c.pass && !c.user) e.user = 'пароль без логина';
    }

    if (kind === 'votProxyCfg') {
      if (c.host && !hostOk(c.host.replace(/^https?:\/\//, '').split('/')[0])) {
        e.host = 'адрес: буквы, цифры, точка, дефис';
      }
      return e;
    }

    if (kind === 'ftpcfg') {
      if (!filled(c)) return e;
      if (!c.host) e.host = 'нужен адрес сервера';
      else if (!hostOk(c.host)) e.host = 'адрес: буквы, цифры, точка, дефис — без ftp:// и слэшей';
      if (c.port && !(Number(c.port) >= 1 && Number(c.port) <= 65535)) e.port = 'порт: число от 1 до 65535';
      if (c.dir && /(^|\/)\.\.(\/|$)/.test(c.dir)) e.dir = 'в пути нельзя «..»';
      if (c.pass && !c.user) e.user = 'пароль без логина';
    }

    return e;
  }
  const destOk = (kind, cfg) => Object.keys(destErrors(kind, cfg || {})).length === 0;

  // ---- журнал запусков ------------------------------------------------------
  // Каждый запуск пишется в chrome.storage.local как JSON: настройки на момент
  // старта, получатели и шаги с временными метками. Хранится 15 последних.
  // Пароли, ключи и токены в журнал попадают только маской (журнал существует,
  // чтобы им делиться, — целые секреты в нём были бы утечкой).
  const RUNLOG_KEY = 'runLogs';
  const RUNLOG_MAX = 15;
  let curRun = null;
  let runSaving = Promise.resolve(); // записи строго по очереди

  function maskSecret(v) {
    const s = String(v || '');
    return s ? s.slice(0, 3) + '…(' + s.length + ' зн.)' : '';
  }
  function maskCreds(obj) {
    const out = {};
    for (const k of Object.keys(obj || {})) {
      out[k] = /pass|secret|token|key/i.test(k) ? maskSecret(obj[k]) : obj[k];
    }
    return out;
  }

  function runPersist() {
    const snap = curRun;
    runSaving = runSaving.then(async () => {
      if (!snap) return;
      let list = [];
      try { list = (await chrome.storage.local.get(RUNLOG_KEY))[RUNLOG_KEY] || []; } catch (e) {}
      const i = list.findIndex((r) => r.id === snap.id);
      if (i >= 0) list[i] = snap; else list.push(snap);
      while (list.length > RUNLOG_MAX) list.shift();
      try { await chrome.storage.local.set({ [RUNLOG_KEY]: list }); } catch (e) {}
    }).catch(() => {});
    return runSaving;
  }

  async function runStart(task) {
    let all = {};
    try { all = await chrome.storage.local.get(null); } catch (e) {}
    delete all[RUNLOG_KEY];
    const credentials = {};
    for (const k of ['s3cfg', 'wdcfg', 'ftpcfg', 'votAuth']) {
      if (all[k]) { credentials[k] = maskCreds(all[k]); delete all[k]; }
    }
    curRun = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      startedAt: new Date().toISOString(),
      version: chrome.runtime.getManifest().version,
      browser: navigator.userAgent,
      task,                 // что качаем: формат, диапазон, videoId
      settings: all,        // все настройки плагина на момент старта
      credentials,          // получатели, секреты маскированы
      steps: [],
      result: 'выполняется',
    };
    runStep('запуск');
  }

  function runStep(msg, data) {
    if (!curRun) return;
    curRun.steps.push(Object.assign({ t: new Date().toISOString(), msg }, data ? { data } : {}));
    runPersist();
  }

  function runEnd(result, err) {
    if (!curRun) return;
    curRun.result = result;
    if (err) curRun.error = String((err && err.message) || err);
    curRun.finishedAt = new Date().toISOString();
    runPersist();
    curRun = null;
  }

  function safeName(s) {
    return (s || 'video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  function fragSuffix(start, end, duration) {
    if (start <= 0 && end >= duration - 0.5) return '';
    return ' (' + fmtTime(start).replace(/:/g, '.') + '-' + fmtTime(end).replace(/:/g, '.') + ')';
  }

  // ---- субтитры и главы ------------------------------------------------------
  // Оба сдвигаются под выбранный диапазон: файл начинается со start, поэтому
  // время внутри должно отсчитываться оттуда же, иначе подписи и главы разъедутся.
  function srtStamp(sec) {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60;
    const s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return p(h) + ':' + p(m) + ':' + p(s) + ',' + p(r, 3);
  }
  function srtFrom(cues, start, end) {
    const list = (cues || []).filter((c) => c && c.t != null && c.text);
    if (!list.length) return '';
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i].t;
      // конец реплики панель не отдаёт — берём начало следующей, последней даём 5 с
      const b = i + 1 < list.length ? list[i + 1].t : a + 5;
      if (b <= start || a >= end) continue;
      out.push(String(out.length + 1) + '\n' +
        srtStamp(Math.max(a, start) - start) + ' --> ' + srtStamp(Math.min(b, end) - start) +
        '\n' + list[i].text + '\n');
    }
    return out.join('\n');
  }
  // формат ffmetadata: его ffmpeg кладёт в mp4 как настоящие главы
  function chaptersMeta(chaps, start, end) {
    const list = (chaps || []).filter((c) => c && c.t != null && c.title);
    if (list.length < 2) return '';
    const out = [';FFMETADATA1'];
    for (let i = 0; i < list.length; i++) {
      const a = list[i].t;
      const b = i + 1 < list.length ? list[i + 1].t : end;
      if (b <= start || a >= end) continue;
      out.push('[CHAPTER]', 'TIMEBASE=1/1000',
        'START=' + Math.round((Math.max(a, start) - start) * 1000),
        'END=' + Math.round((Math.min(b, end) - start) * 1000),
        'title=' + String(list[i].title).replace(/[=;#\\\n]/g, ' '));
    }
    return out.length > 1 ? out.join('\n') + '\n' : '';
  }

  async function downloadSubtitles(info) {
    const t = toast();
    t.set('Открываю расшифровку…', 0.3);
    const q = await queueAdd({ name: info.title || 'видео', label: '.srt',
      videoId: info.videoId, note: 'расшифровка' });
    queueAutoOpen();
    try {
      q.upd('открываю расшифровку', 0.3);
      const res = await callHook('subtitles');
      if (!res || !res.ok) throw new Error((res && res.error) || 'нет субтитров');
      // время у реплик теперь есть — значит файл имеет смысл делать субтитрами, а
      // не простынёй текста: .srt плеер покажет поверх видео. Времени нет (сменилась
      // вёрстка панели) — молча откатываемся к прежнему .txt
      const srt = srtFrom(res.cues, 0, info.duration || 1e9);
      const body = srt || (res.cues || []).map((c) => c.text).join('\n');
      const filename = safeName(info.title) + ' [' + (res.lang || 'txt') + ']' + (srt ? '.srt' : '.txt');
      // small text → a data URL is enough; BOM keeps Cyrillic correct on Windows
      const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent('\ufeff' + body);
      const save = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename });
      if (!save || !save.ok) throw new Error((save && save.error) || 'не удалось сохранить');
      t.set('Готово: ' + filename, 1);
      t.hide(4000);
      q.end('done', { filename });
    } catch (err) {
      t.fail(err, { stage: 'субтитры', format: 'txt', videoId: info.videoId, duration: info.duration });
      q.end('error', { error: String((err && err.message) || err) });
    }
  }

  // Ask the background for SponsorBlock segments; returns only segments that
  // overlap the selected fragment. Never throws — an unreachable API must not
  // block the download itself.
  async function fetchSponsorSegments(videoId, start, end) {
    try {
      const r = await chrome.runtime.sendMessage({ t: 'ytdl-sb-get', videoId });
      if (!r || !r.ok || !Array.isArray(r.segments)) return [];
      return r.segments.filter((s) => s.end > start + 0.2 && s.start < end - 0.2);
    } catch (e) {
      console.warn('[Triangle] SponsorBlock недоступен:', e);
      return [];
    }
  }

  async function startDownload(opts, info) {
    const { format, height, start, end } = opts;
    const duration = Math.floor(info.duration || 0);
    const isMp3 = format === 'mp3';
    const label = isMp3 ? 'MP3' : height + 'p';
    // Ключ этой загрузки. Качать можно из нескольких вкладок сразу, а offscreen и
    // воркер — общие: без ключа их чанки складывались в один буфер, а прогресс,
    // журнал и статус перевода уходили в ту вкладку, что начала последней.
    const jobId = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const t = toast();
    t.set('Готовлю ' + label + ' — загрузка сегментов…', 0.02);

    const { transcode = false, sbCut = true, audioRaw = false, capMin = 20,
      subsIn = 'off', chapsIn = true } =
      await chrome.storage.local.get(['transcode', 'sbCut', 'audioRaw', 'capMin', 'subsIn', 'chapsIn']);
    const doTranscode = isMp3 ? true : !!transcode; // mp3 always encodes

    // ---- VOT: запустить перевод СРАЗУ — он готовится на сервере Яндекса
    // параллельно с захватом, offscreen дождётся его в finalize
    const vs = await chrome.storage.local.get(['votOn', 'votMode', 'votLang', 'votSrcLang',
      'votLively', 'votAuth', 'votProxy', 'votProxyCfg', 'votVol', 'dest']);
    const auth = vs.votAuth || {};
    const authOk = !!(auth.token && (!auth.expires || auth.expires > Date.now()));
    // обстановка для отчёта об ошибке: дополняется по ходу дела
    const ctx = {
      stage: 'подготовка', format, height, start, end, duration,
      transcode: doTranscode, sbCut, videoId: info.videoId,
      // эффективный получатель на момент старта — по нему в журнале видно,
      // должна ли была случиться доставка вообще
      dest: (vs.dest && vs.dest.type) || 'local',
    };
    await runStart({ type: 'video', format, height, start, end, duration, videoId: info.videoId,
      dest: ctx.dest });
    const votLang = vs.votLang || 'ru';
    let vot = vs.votOn ? {
      videoId: info.videoId,
      mode: vs.votMode || 'mix',
      lang: votLang,
      srcLang: vs.votSrcLang || 'auto',
      // живой голос Яндекс даёт только на русский и только со входом в аккаунт;
      // эти же поля образуют ключ задания, поэтому значение должно быть честным
      lively: !!vs.votLively && authOk && votLang === 'ru',
    } : null;
    if (vot && vot.srcLang !== 'auto') {
      // Если пользователь явно выбрал тот же исходный язык, что и целевой,
      // Яндекс обычно зависает в WAITING. Авто-язык с YouTube не используем для
      // пропуска: captionTracks иногда отражают субтитры/локализацию, а не
      // реальную озвучку, и тогда VOT вообще не стартует.
      if (vot.srcLang === vot.lang) {
        runStep('VOT: видео уже на языке "' + vot.lang + '" — перевод пропущен');
        vot = null;
      }
    }
    if (vot) {
      t.set('Перевод (VOT): отправляю запрос…', 0.02);
      // Спецификация целиком (а не только ключ задания) уходит и в vot-start, и
      // потом в ytdl-begin: если offscreen пересоздадут посреди передачи, по ней
      // перевод запустится заново, а не пропадёт молча.
      const votSpec = {
        job: jobId,
        videoId: vot.videoId,
        url: 'https://youtu.be/' + info.videoId,
        duration: info.duration || 0,
        title: info.title || '',
        mode: vot.mode,
        // громкость родной дорожки под переводом, доля от исходной
        origVol: Math.max(0, Math.min(1, (vs.votVol == null ? 30 : Number(vs.votVol)) / 100)),
        lang: vot.lang,
        srcLang: vot.srcLang,
        lively: vot.lively,
        token: authOk ? auth.token : '',
        proxy: vs.votProxy ? ((vs.votProxyCfg && vs.votProxyCfg.host) || 'vot-worker.eu.cc') : '',
      };
      try {
        const vr = await toOffscreen(Object.assign({ t: 'ytdl-vot-start' }, votSpec));
        if (!vr || !vr.ok) throw new Error((vr && vr.error) || 'offscreen не принял задачу');
        vot = votSpec;
        runStep('VOT: запрос перевода отправлен',
          { lang: vot.lang, srcLang: vot.srcLang, mode: vot.mode, lively: vot.lively, proxy: !!vs.votProxy });
      } catch (e) {
        const msg = String((e && e.message) || e);
        runStep('VOT: не удалось запустить перевод — сохраню без перевода', msg);
        vot = null;
      }
    }
    ctx.vot = vot;
    ctx.authOk = authOk;
    ctx.votProxy = !!vs.votProxy;

    let sbSegments = [];
    if (sbCut !== false) {
      t.set('SponsorBlock: проверяю сегменты…', 0.02);
      sbSegments = await fetchSponsorSegments(info.videoId, start, end);
      runStep('SponsorBlock: вставок ' + sbSegments.length);
    }
    const sbNote = sbSegments.length
      ? ' (вырезаю вставок: ' + sbSegments.length + ')' : '';
    ctx.sbCount = sbSegments.length;

    // ---- parallel path for long ranges ----
    const { parTabs = 'auto', parChunk = 12 } = await chrome.storage.local.get(['parTabs', 'parChunk']);
    ctx.parTabs = parTabs;
    const range = end - start;
    let planned = 1;
    if (String(parTabs) !== '1') {
      if (parTabs === 'auto') {
        try {
          const plan = await chrome.runtime.sendMessage({ t: 'ytdl-par-plan', rangeSec: range });
          planned = (plan && plan.workers) || 1;
        } catch (e) {}
      } else {
        planned = parseInt(parTabs, 10) || 1;
      }
    }
    const parEligible = planned > 1 && range >= (Number(parChunk) || 12) * 60 * 1.5;
    const wantsMediaExtras = !isMp3 && (subsIn !== 'off' || chapsIn);
    if (vot && parEligible) {
      // перевод собирается в finalize одной вкладки — параллельный путь его не умеет;
      // без этой записи в журнале выглядело так, будто настройка вкладок игнорируется
      runStep('VOT: параллельный режим отключён, качаю в одной вкладке' +
        ' (без перевода вкладок было бы ' + planned + ')');
    }
    if (!vot && wantsMediaExtras && parEligible) {
      // параллельный путь собирает фрагменты в worker/offscreen без доступа к
      // расшифровке страницы и главам из info. Если пользователь включил эти
      // опции, важнее отдать полный файл, чем выиграть скорость на вкладках.
      runStep('субтитры/главы: параллельный режим отключён, качаю в одной вкладке' +
        ' (без них вкладок было бы ' + planned + ')');
    }
    if (!vot && !wantsMediaExtras && parEligible) {
      t.hide(0);
      runStep('параллельный режим: вкладок ' + planned + ', кусок ' + parChunk + ' мин');
      return startParallel({
        format, height, start, end, transcode: doTranscode,
        sb: sbSegments, parTabs, parChunk, label, dest: ctx.dest,
      }, info);
    }

    const ext = isMp3 ? '.mp3' : '.mp4';
    const mkName = (e) => safeName(info.title) + (isMp3 ? '' : ' [' + height + 'p]') +
      fragSuffix(start, e, duration) + ext;
    let filename = mkName(end); // при неполном захвате пересчитаем по факту

    // Расшифровку снимаем ДО захвата: getSubtitles открывает и закрывает панель
    // на странице, а во время захвата любая возня с ней ему только мешает.
    let srt = '';
    if (!isMp3 && subsIn !== 'off') {
      t.set('Читаю расшифровку…', 0.02);
      try {
        const s = await callHook('subtitles');
        if (s && s.ok) srt = srtFrom(s.cues, start, end);
        runStep(srt ? 'субтитры: реплик ' + (s.cues || []).length
                    : 'субтитры: расшифровка без таймингов — вшивать нечего');
      } catch (e) { runStep('субтитры: не получены', String((e && e.message) || e)); }
      if (srt && subsIn === 'file') {
        const fn = filename.replace(/\.(mp4|webm|mp3)$/i, '') + '.srt';
        chrome.runtime.sendMessage({ t: 'ytdl-save', noDeliver: true, filename: fn,
          url: 'data:text/plain;charset=utf-8,' + encodeURIComponent('﻿' + srt) }).catch(() => {});
        runStep('субтитры сохранены отдельным файлом: ' + fn);
        srt = ''; // отдельным файлом — внутрь уже не вшиваем
      }
    }
    const chapMeta = (!isMp3 && chapsIn) ? chaptersMeta(info.chapters, start, end) : '';
    if (chapMeta) runStep('главы: найдены в описании');

    // Запись в очереди заводим уже после развилки: у параллельного пути она своя,
    // её создаёт service worker вместе с заданием (см. ytdl-par-start). Вместе с
    // записью уходит слепок задания — по нему воркер сможет повторить загрузку,
    // даже когда эта вкладка давно закрыта.
    const q = await queueAdd({
      name: info.title || 'видео', label, videoId: info.videoId,
      dest: ctx.dest, note: 'подготовка',
      spec: {
        url: location.origin + '/watch?v=' + encodeURIComponent(info.videoId),
        videoId: info.videoId, height, format, transcode: doTranscode,
        start, end, sb: sbSegments, filename,
        tabsMode: String(parTabs), chunkMin: Number(parChunk) || 12, vot: !!vot,
        subsIn, chapsIn,
      },
    });
    queueAutoOpen();

    let lastVot = '';
    const onProg = (msg) => {
      if (!msg || (msg.job && msg.job !== jobId)) return; // чужая загрузка
      if (msg && msg.t === 'ytdl-progress') {
        // offscreen подписывает, что именно делает ffmpeg: микс перевода и
        // простая склейка — не «перекодирование», подпись не должна врать
        const phase = msg.phase || (isMp3 ? 'Кодирование MP3' : 'Перекодирование в H.264/AAC');
        t.set(phase + '… ' + Math.round(msg.value * 100) + '%', 0.55 + msg.value * 0.45);
        q.upd(phase.toLowerCase(), 0.55 + msg.value * 0.45);
      }
      if (msg && msg.t === 'ytdl-run-log') runStep(String(msg.msg || ''));
      if (msg && msg.t === 'ytdl-vot-status') {
        t.set('Перевод (VOT): ' + msg.text, 0.55);
        q.upd('перевод: ' + msg.text, 0.55);
        if (msg.text !== lastVot) { lastVot = msg.text; runStep('VOT: ' + msg.text); }
      }
    };
    chrome.runtime.onMessage.addListener(onProg);
    try {
      ctx.stage = 'захват потока';
      runStep('захват потока начат');
      let lastQ = 0;
      const result = await download({ height, format, start, end, capMin }, (d) => {
        t.set('Загрузка сегментов ' + label + '… ' + Math.round(d.progress * 100) + '%', d.progress * 0.5);
        q.upd('загрузка сегментов', d.progress * 0.5);
        const quarter = Math.floor((d.progress || 0) * 4);
        if (quarter > lastQ && quarter < 4) { lastQ = quarter; runStep('захват ' + quarter * 25 + '%'); }
      });
      // Захват мог сдаться на плато буфера или упереться в 20-минутный потолок —
      // тогда он вернул меньше запрошенного. Считаем по фактическому краю, иначе
      // ffmpeg получит -t от запрошенного диапазона, а имя файла соврёт о длине.
      const effEnd = result.partial ? Math.floor(result.partial.to) : end;
      const partialNote = result.partial
        ? 'захвачено только до ' + fmtTime(effEnd) + ' из ' + fmtTime(end) : '';
      if (partialNote) { runStep('захват неполный: ' + partialNote); filename = mkName(effEnd); }

      ctx.stage = 'сборка файла (ffmpeg)';
      runStep('захват завершён, сборка файла (ffmpeg)');
      q.upd('сборка файла', 0.55);
      t.set((isMp3 ? 'Кодирование MP3…'
        : (transcode ? 'Готовлю перекодирование (может занять дольше ролика)…' : 'Склейка дорожек…')) + sbNote, 0.55);

      const res = await muxViaOffscreen({
        jobId, format, audioRaw, videoId: info.videoId,
        video: isMp3 ? null : result._v,
        audio: result._a,
        videoMime: result.video && result.video.mime,
        audioMime: result.audio && result.audio.mime,
        filename, transcode: doTranscode, start, end: effEnd,
        sb: sbSegments, vot, srt, chapters: chapMeta,
      });

      if (!res || !res.ok) throw new Error(res && res.error || 'mux failed');
      // Оговорки не должны теряться: перевод мог не встроиться, а захват — не
      // добрать диапазон; и то и другое раньше уходило в очередь как чистое «готово».
      const warns = [];
      if (partialNote) warns.push(partialNote);
      if (vot && !res.votApplied) warns.push('без перевода' + (res.votError ? ': ' + res.votError : ''));
      const warn = warns.join('; ');
      t.set((warn ? 'Готово (' + warn + '): ' : 'Готово: ') + (res.filename || filename) + sbNote, 1);
      t.hide(warn ? 8000 : 4000);
      runStep('файл сохранён: ' + (res.filename || filename) + (warn ? ' — ' + warn : ''));
      runEnd('успех');
      q.end('done', { filename: res.filename || filename, warn });
    } catch (err) {
      t.fail(err, ctx);
      runStep('ошибка на шаге «' + ctx.stage + '»');
      runEnd('ошибка', err);
      q.end('error', { error: String((err && err.message) || err), note: ctx.stage });
    } finally {
      chrome.runtime.onMessage.removeListener(onProg);
    }
  }

  // ---- transfer to offscreen ffmpeg ---------------------------------------
  function b64encode(u8) {
    let s = '';
    const STEP = 0x8000;
    for (let i = 0; i < u8.length; i += STEP) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + STEP, u8.length)));
    }
    return btoa(s);
  }

  // Everything bound for the offscreen ffmpeg document goes through the service
  // worker — a content script cannot reliably message an offscreen document.
  function toOffscreen(m) {
    return chrome.runtime.sendMessage({ t: 'ytdl-proxy', m });
  }

  async function muxAttempt(job) {
    const CHUNK = 4 * 1024 * 1024;
    const beg = await toOffscreen({
      t: 'ytdl-begin', job: job.jobId, filename: job.filename, format: job.format,
      audioRaw: !!job.audioRaw, videoId: job.videoId || '',
      videoMime: job.videoMime, audioMime: job.audioMime,
      transcode: !!job.transcode, start: job.start, end: job.end,
      sb: job.sb || [], vot: job.vot || null,
      srt: job.srt || '', chapters: job.chapters || '',
    });
    if (!beg || !beg.ok) throw new Error('offscreen не принял задание: ' + ((beg && beg.error) || 'нет ответа'));
    const sendTrack = async (name, buf) => {
      if (!buf) return;
      const view = new Uint8Array(buf);
      for (let off = 0; off < view.length; off += CHUNK) {
        const slice = view.subarray(off, Math.min(off + CHUNK, view.length));
        let r = null;
        try {
          r = await toOffscreen({ t: 'ytdl-chunk', job: job.jobId, track: name, b64: b64encode(slice) });
        } catch (e) { r = { ok: false, error: String(e) }; }
        if (!r || !r.ok) {
          throw new Error('передача данных прервалась (' + name + ', ' +
            Math.round(off / 1048576) + ' МБ из ' + Math.round(view.length / 1048576) +
            '): ' + ((r && r.error) || 'нет ответа'));
        }
      }
    };
    await sendTrack('video', job.video);
    await sendTrack('audio', job.audio);
    return toOffscreen({ t: 'ytdl-finalize', job: job.jobId });
  }

  // The offscreen ffmpeg document can die mid-transfer (usually OOM on long
  // videos) — ytdl-ensure now health-checks and recreates it, and the captured
  // buffers are still here in the page, so one clean retry is safe and cheap.
  async function muxViaOffscreen(job) {
    let firstErr = null; // вторая ошибка обычно каскадная — показываем причину
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await muxAttempt(job);
      } catch (e) {
        if (!firstErr) firstErr = e;
        console.warn('[Triangle] передача в ffmpeg, попытка ' + (attempt + 1) + ':', e);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error((firstErr && firstErr.message || firstErr) +
      ' — похоже, ffmpeg упал (не хватило памяти?). Попробуйте меньший фрагмент или 720p.');
  }

  // ---- parallel download: main-tab UI --------------------------------------
  async function startParallel(opts, info) {
    const duration = Math.floor(info.duration || 0);
    const isMp3 = opts.format === 'mp3';
    const ext = isMp3 ? '.mp3' : '.mp4';
    const filename = safeName(info.title) + (isMp3 ? '' : ' [' + opts.height + 'p]') +
      fragSuffix(opts.start, opts.end, duration) + ext;
    const url = location.origin + '/watch?v=' + encodeURIComponent(info.videoId);
    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({
        t: 'ytdl-par-start', url, videoId: info.videoId, filename,
        height: opts.height, format: opts.format, transcode: opts.transcode,
        start: opts.start, end: opts.end, sb: opts.sb,
        tabsMode: String(opts.parTabs), chunkMin: Number(opts.parChunk) || 12,
        // для очереди: воркер сам заводит запись, но подписать её может только вкладка
        name: info.title || 'видео', label: opts.label || '', dest: opts.dest || 'local',
      });
    } catch (e) {}
    if (!resp || !resp.ok) {
      const err = new Error('не удалось запустить параллельную загрузку: ' +
        ((resp && resp.error) || 'фоновая страница не ответила'));
      toast().fail(err, {
        stage: 'запуск параллельной загрузки', parallel: true,
        format: opts.format, height: opts.height, start: opts.start, end: opts.end,
        duration, transcode: opts.transcode, parTabs: opts.parTabs,
        sbCount: (opts.sb || []).length, videoId: info.videoId,
      });
      runEnd('ошибка', err);
      return;
    }
    queueAutoOpen();
    runParallelUI(resp.taskId, opts, filename);
  }

  // Панель параллельной загрузки. Раньше здесь был ряд одинаковых полосок по
  // 8 px и одна строка текста: сколько фрагментов готово — видно, а какая часть
  // ролика уже дома, что именно сломалось и движется ли дело вообще — нет.
  // Теперь это монитор: лента фрагментов в пропорции их длины, счётчики,
  // измеренная скорость и список фрагментов с ошибками и номерами попыток.
  const P_STATE = {
    run: 'идёт', pause: 'пауза', merge: 'склейка', stall: 'нужен повтор',
    done: 'готово', error: 'ошибка', cancel: 'отменено',
  };
  const F_STATE = { pend: 'ожидает', run: 'качается', done: 'готов', err: 'ошибка' };

  function buildPanel() {
    const old = document.getElementById('ytdl-panel');
    if (old) old.remove();
    const box = el('div'); box.id = 'ytdl-panel';
    box.addEventListener('click', (ev) => ev.stopPropagation());

    // — шапка: остаётся видимой и в свёрнутом виде —
    const head = el('div', 'ytdl-p-head');
    const mark = el('span', 'ytdl-p-mark');
    mark.appendChild(triangleSvg('#ff4e45'));
    head.appendChild(mark);
    head.appendChild(el('span', 'ytdl-p-title', 'Параллельно'));
    const badge = el('i', 'ytdl-p-badge', '');
    head.appendChild(badge);
    const pct = el('span', 'ytdl-p-pct', '0%');
    head.appendChild(pct);
    const bMin = el('button', 'ytdl-p-icon', '–');
    bMin.title = 'Свернуть';
    head.appendChild(bMin);
    const bHide = el('button', 'ytdl-p-icon', '✕');
    bHide.title = 'Скрыть панель — загрузка продолжится, следить можно в очереди';
    head.appendChild(bHide);
    box.appendChild(head);

    const name = el('div', 'ytdl-p-name ytdl-p-hide', '');
    box.appendChild(name);

    const bar = el('div', 'ytdl-p-bar'); bar.appendChild(el('i'));
    box.appendChild(bar);

    const line = el('div', 'ytdl-p-line ytdl-p-hide');
    box.appendChild(line);

    // — счётчики: четыре числа, по которым сразу видно расклад —
    const stats = el('div', 'ytdl-p-stats ytdl-p-hide');
    const cell = (cls, label) => {
      const c = el('div', 'ytdl-p-stat' + (cls ? ' ' + cls : ''));
      const b = el('b', null, '0');
      c.appendChild(b);
      c.appendChild(el('span', null, label));
      stats.appendChild(c);
      return b;
    };
    const nDone = cell('ok', 'готово');
    const nRun = cell(null, 'качается');
    const nErr = cell('err', 'ошибок');
    const nTabs = cell(null, 'вкладок');
    box.appendChild(stats);

    const stat = el('div', 'ytdl-p-stat-line ytdl-p-hide', 'Запуск…');
    box.appendChild(stat);

    const more = el('button', 'ytdl-p-more ytdl-p-hide', 'фрагменты');
    box.appendChild(more);
    const list = el('div', 'ytdl-p-list ytdl-p-hide');
    box.appendChild(list);

    const warn = el('div', 'ytdl-p-warn ytdl-p-hide', '');
    box.appendChild(warn);

    const btns = el('div', 'ytdl-p-btns ytdl-p-hide');
    const bRetry = el('button', 'ytdl-pbtn ytdl-pbtn-grow', 'Повторить ошибочные');
    const bPause = el('button', 'ytdl-pbtn', 'Пауза');
    const bCancel = el('button', 'ytdl-pbtn ytdl-pbtn-danger', '✕');
    bCancel.title = 'Отменить';
    btns.appendChild(bRetry); btns.appendChild(bPause); btns.appendChild(bCancel);
    box.appendChild(btns);

    const ui = { box, head, badge, pct, name, bar, line, stat, list, more, warn,
      nDone, nRun, nErr, nTabs, bPause, bRetry, bCancel, bMin, bHide, open: true };

    bMin.addEventListener('click', () => {
      const min = box.classList.toggle('min');
      bMin.textContent = min ? '+' : '–';
      bMin.title = min ? 'Развернуть' : 'Свернуть';
    });
    more.addEventListener('click', () => {
      ui.open = !ui.open;
      list.style.display = ui.open ? '' : 'none';
      renderMore(ui);
    });

    document.body.appendChild(box);
    return ui;
  }

  function renderMore(ui) {
    ui.more.textContent = (ui.open ? '▾ ' : '▸ ') + 'фрагменты' +
      (ui.fragCount != null ? ' · ' + ui.fragCount : '');
  }

  function fmtEta(s) {
    s = Math.max(0, Math.floor(s));
    if (s < 60) return 'меньше минуты';
    if (s < 5400) return Math.round(s / 60) + ' мин';
    return (Math.round(s / 360) / 10).toString().replace('.', ',') + ' ч';
  }

  // Скорость считаем сами. Воркер отдаёт своё ETA от среднего за всё время —
  // по нему не видно, едет загрузка прямо сейчас или встала полчаса назад.
  function makeRate(rangeSec) {
    const win = []; // отсчёты за последнюю минуту
    return {
      push(progress) {
        const now = Date.now();
        win.push({ t: now, p: Math.max(0, Math.min(1, progress || 0)) });
        while (win.length > 2 && now - win[0].t > 60000) win.shift();
      },
      // секунд видео за секунду реального времени: «×2,4» понятнее, чем МБ/с
      perSec() {
        if (win.length < 2 || !rangeSec) return null;
        const a = win[0], b = win[win.length - 1];
        const dt = (b.t - a.t) / 1000;
        if (dt < 8) return null;
        const v = ((b.p - a.p) * rangeSec) / dt;
        return v > 0.01 ? v : null;
      },
      eta(progress) {
        const v = this.perSec();
        if (!v) return null;
        return Math.round(((1 - Math.min(1, progress || 0)) * rangeSec) / v);
      },
    };
  }

  function renderPanel(ui, st, rate) {
    const frags = st.frags || [];
    const first = frags[0], last = frags[frags.length - 1];
    // ширина блока — по длительности куска. Если фоновая страница старая и полей
    // s/e не прислала, блоки равны между собой, как было раньше.
    const span = (first && last && last.e != null && first.s != null) ? (last.e - first.s) : 0;

    let done = 0, run = 0, err = 0;
    const keepScroll = ui.list.scrollTop;
    while (ui.line.firstChild) ui.line.removeChild(ui.line.firstChild);
    while (ui.list.firstChild) ui.list.removeChild(ui.list.firstChild);

    for (const f of frags) {
      if (f.st === 'done') done++; else if (f.st === 'run') run++; else if (f.st === 'err') err++;
      const p = f.st === 'done' ? 1 : (f.st === 'run' ? Math.max(0, Math.min(1, f.pct || 0)) : 0);
      const range = f.e != null ? fmtShort(f.s) + ' – ' + fmtShort(f.e) : '';

      const seg = el('span', 'ytdl-p-seg ytdl-p-seg-' + f.st);
      seg.style.width = (span > 0 ? ((f.e - f.s) / span) * 100 : 100 / (frags.length || 1)) + '%';
      const fill = el('i');
      fill.style.width = Math.round(p * 100) + '%';
      seg.appendChild(fill);
      seg.title = '#' + (f.idx + 1) + (range ? ' · ' + range : '') + ' · ' +
        (F_STATE[f.st] || f.st) + (f.st === 'run' ? ' ' + Math.round(p * 100) + '%' : '') +
        (f.err ? ' · ' + f.err : '');
      ui.line.appendChild(seg);

      const row = el('div', 'ytdl-p-frag' + (f.st === 'done' ? ' done' : ''));
      const top = el('div', 'ytdl-p-frag-top');
      top.appendChild(el('i', 'ytdl-p-frag-i', String(f.idx + 1)));
      if (range) top.appendChild(el('span', 'ytdl-p-frag-t', range));
      top.appendChild(el('span', 'ytdl-p-frag-st ' + f.st,
        (F_STATE[f.st] || f.st) +
        (f.st === 'run' ? ' · ' + Math.round(p * 100) + '%' : '') +
        (f.st !== 'done' && f.tries ? ' · попытка ' + (f.tries + 1) : '')));
      row.appendChild(top);
      const bar = el('div', 'ytdl-p-frag-bar' +
        (f.st === 'done' ? ' done' : f.st === 'err' ? ' err' : ''));
      const bfill = el('i');
      bfill.style.width = (f.st === 'err' ? 100 : Math.round(p * 100)) + '%';
      bar.appendChild(bfill);
      row.appendChild(bar);
      if (f.st === 'err' && f.err) row.appendChild(el('div', 'ytdl-p-frag-err', f.err));
      ui.list.appendChild(row);
    }
    ui.list.scrollTop = keepScroll;
    ui.fragCount = frags.length ? done + '/' + frags.length : null;
    renderMore(ui);

    let pct = (st.progress || 0) * 0.9;
    if (st.state === 'merge') pct = 0.9 + 0.1 * (st.mergePct || 0);
    if (st.state === 'done') pct = 1;
    pct = Math.max(0, Math.min(1, pct));

    ui.badge.textContent = P_STATE[st.state] || st.state;
    ui.badge.className = 'ytdl-p-badge ' + st.state;
    ui.pct.textContent = Math.round(pct * 100) + '%';
    ui.bar.className = 'ytdl-p-bar' +
      (st.state === 'done' ? ' done' : (st.state === 'error' || st.state === 'stall') ? ' err' : '');
    ui.bar.firstChild.style.width = Math.round(pct * 100) + '%';

    ui.nDone.textContent = done + '/' + frags.length;
    ui.nRun.textContent = String(run);
    ui.nErr.textContent = String(err);
    ui.nTabs.textContent = String(st.workers || 0);

    if (rate) rate.push(st.progress || 0);
    const speed = rate ? rate.perSec() : null;
    const eta = rate ? rate.eta(st.progress || 0) : null;
    const speedTxt = speed ? '×' + (Math.round(speed * 10) / 10).toString().replace('.', ',') : null;

    ui.stat.textContent =
      st.state === 'run' ? (
        run === 0 && done < frags.length ? 'открываю фоновые вкладки…'
        : (eta != null || st.eta != null
          ? 'осталось ~' + fmtEta(eta != null ? eta : st.eta) +
            (speedTxt ? ' · ' + speedTxt + ' от реального времени' : '')
          : 'считаю время…'))
      : st.state === 'pause' ? 'приостановлено — скачанные фрагменты сохранены'
      : st.state === 'merge' ? 'склейка фрагментов… ' + Math.round((st.mergePct || 0) * 100) + '%'
      : st.state === 'stall' ? 'фрагментов с ошибкой: ' + err + ' — нажмите «Повторить ошибочные»'
      : st.state === 'done' ? 'готово: ' + (st.filename || '')
      : st.state === 'error' ? 'ошибка: ' + (st.error || '')
      : st.state === 'cancel' ? 'отменено' : st.state;

    ui.bRetry.style.display = (st.state === 'stall' || st.state === 'error') ? '' : 'none';
    ui.bPause.style.display = (st.state === 'run' || st.state === 'pause') ? '' : 'none';
    ui.bCancel.style.display = (st.state === 'done' || st.state === 'cancel') ? 'none' : '';
  }

  async function runParallelUI(taskId, opts, filename) {
    const ui = buildPanel();
    ui.name.textContent = filename;
    ui.name.title = filename;
    if (!opts.transcode && opts.format !== 'mp3' && opts.height >= 1080 && (opts.end - opts.start) > 5400) {
      ui.warn.textContent = '1080p длиннее ~1,5 ч может не собраться: у ffmpeg.wasm лимит памяти ~2 ГБ. Надёжнее 720p или меньший фрагмент.';
    }
    const rate = makeRate(opts.end - opts.start);
    let paused = false;
    ui.bPause.addEventListener('click', () => {
      paused = !paused;
      ui.bPause.textContent = paused ? 'Продолжить' : 'Пауза';
      chrome.runtime.sendMessage({ t: 'ytdl-par-ctl', taskId, cmd: paused ? 'pause' : 'resume' }).catch(() => {});
    });
    ui.bRetry.addEventListener('click', () => {
      chrome.runtime.sendMessage({ t: 'ytdl-par-ctl', taskId, cmd: 'retry' }).catch(() => {});
    });
    ui.bCancel.addEventListener('click', () => {
      chrome.runtime.sendMessage({ t: 'ytdl-par-ctl', taskId, cmd: 'cancel' }).catch(() => {});
      setTimeout(() => { try { ui.box.remove(); } catch (e) {} }, 800);
    });
    // Панель можно убрать с глаз: задание живёт в service worker, у него свой
    // сторож на будильнике, а прогресс остаётся виден в очереди загрузок.
    let hidden = false;
    ui.bHide.addEventListener('click', () => {
      hidden = true;
      try { ui.box.remove(); } catch (e) {}
      queueOpen();
    });
    let missing = 0;
    let lastState = '';
    while (true) {
      await sleep(1000);
      let st = null;
      try { st = await chrome.runtime.sendMessage({ t: 'ytdl-par-status', taskId }); } catch (e) {}
      if (!st) {
        if (++missing > 10) {
          ui.badge.textContent = 'ошибка';
          ui.badge.className = 'ytdl-p-badge error';
          ui.stat.textContent = 'связь с расширением потеряна';
          runEnd('ошибка', 'связь с расширением потеряна');
          break;
        }
        continue;
      }
      missing = 0;
      if (!st.ok) {
        ui.badge.textContent = 'ошибка';
        ui.badge.className = 'ytdl-p-badge error';
        ui.stat.textContent = 'задача потеряна (service worker перезапустился)';
        runEnd('ошибка', 'задача потеряна (service worker перезапустился)');
        break;
      }
      if (st.state !== lastState) {
        lastState = st.state;
        runStep('параллельно: ' + st.state + (st.error ? ' — ' + st.error : ''),
          { готово: (st.frags || []).filter((f) => f.st === 'done').length, всего: (st.frags || []).length });
      }
      // опрос не прекращается и со скрытой панелью: он же ведёт журнал запуска
      // и подгоняет сторожа в service worker — не рисуем только саму панель
      if (!hidden) renderPanel(ui, st, rate);
      if (st.state === 'done') { runEnd('успех'); break; }
      if (st.state === 'cancel') { runEnd('отменено'); break; }
      if (hidden && (st.state === 'error' || st.state === 'stall')) break;
      // visible 'error' and 'stall' keep the panel alive so the user can retry
    }
    setTimeout(() => { try { ui.box.remove(); } catch (e) {} }, 20000);
  }

  // ---- parallel download: worker-tab loop ----------------------------------
  async function sendTrackPar(taskId, idx, att, name, buf) {
    if (!buf) return;
    const CHUNK = 4 * 1024 * 1024;
    const view = new Uint8Array(buf);
    for (let off = 0; off < view.length; off += CHUNK) {
      const slice = view.subarray(off, Math.min(off + CHUNK, view.length));
      let r = null;
      try { r = await toOffscreen({ t: 'ytdl-par-chunk', task: taskId, idx, att, track: name, b64: b64encode(slice) }); }
      catch (e) { r = { ok: false, error: String(e) }; }
      if (!r || !r.ok) throw new Error('передача фрагмента прервалась (' + name + '): ' + ((r && r.error) || 'нет ответа'));
    }
  }

  // Chrome applies "intensive throttling" (timers fire once per MINUTE) when a tab
  // has been hidden >5 min, silent >30 s, has a timer chain >=5 and WebRTC is NOT in
  // use. A worker tab hits the first three by design — the capture loop is a chain of
  // setTimeout(350) over a paused, muted video — so without this the capture would
  // crawl. The audio exemption is useless here (a muted tab explicitly loses it), so
  // we hold a local loopback RTCPeerConnection open for the lifetime of the tab.
  let keepAlive = null;
  async function keepTabAwake() {
    try {
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
      b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
      const dc = a.createDataChannel('ytdl-keepalive');
      const offer = await a.createOffer();
      await a.setLocalDescription(offer);
      await b.setRemoteDescription(offer);
      const answer = await b.createAnswer();
      await b.setLocalDescription(answer);
      await a.setRemoteDescription(answer);
      keepAlive = { a, b, dc }; // keep a reference so it is not garbage collected
      window.__ytdlKeepAlive = keepAlive;
    } catch (e) {
      console.warn('[Triangle] keep-alive недоступен, фоновая вкладка может тормозить:', e);
    }
  }
  function dropKeepAwake() {
    try { keepAlive && keepAlive.a.close(); keepAlive && keepAlive.b.close(); } catch (e) {}
    keepAlive = null;
  }

  async function runWorker(taskId) {
    await keepTabAwake();
    // потолок захвата бьёт прежде всего по фоновым вкладкам — они и тормозят
    let capMin = 20;
    try { capMin = Number((await chrome.storage.local.get('capMin')).capMin) || 20; } catch (e) {}
    // wait for the player to be ready; background tabs stay "cued" until playback
    // starts, so nudge the (muted) player every couple of seconds
    for (let i = 0; i < 90; i++) {
      const inf = await callHook('info');
      if (inf && inf.ok && inf.duration > 0) break;
      if (i % 2 === 0) await callHook('play');
      await sleep(1000);
    }
    let idleRetries = 0;
    while (true) {
      let a = null;
      try { a = await chrome.runtime.sendMessage({ t: 'ytdl-par-claim', taskId }); } catch (e) {}
      if (!a) { if (++idleRetries > 6) { dropKeepAwake(); return; } await sleep(2000); continue; }
      idleRetries = 0;
      if (a.stop) { dropKeepAwake(); return; } // nothing left — background closes this tab
      if (a.wait) { await sleep(4000); continue; } // paused
      try {
        // att — номер попытки этого фрагмента: воркер по нему отсекает сообщения
        // вкладки, которую сторож уже признал зависшей и переназначил фрагмент
        const result = await download({ height: a.height, format: a.format, start: a.s, end: a.e, capMin }, (d) => {
          try { chrome.runtime.sendMessage({ t: 'ytdl-par-prog', taskId, idx: a.idx, att: a.att, pct: d.progress }); } catch (e) {}
        });
        // Кусок склейки обязан быть целым: захват сдаётся на плато буфера и по
        // 20-минутному потолку, и такой недобор раньше уходил как «фрагмент готов»
        // — в итоге собранное видео молча теряло минуты в середине.
        if (result.partial) {
          throw new Error('захвачено только до ' + fmtTime(result.partial.to) +
            ' из ' + fmtTime(result.partial.wanted));
        }
        const beg = await toOffscreen({
          t: 'ytdl-par-begin', task: taskId, idx: a.idx, att: a.att,
          videoMime: result.video && result.video.mime,
          audioMime: result.audio && result.audio.mime,
        });
        if (!beg || !beg.ok) throw new Error('offscreen не принял фрагмент: ' + ((beg && beg.error) || 'нет ответа'));
        await sendTrackPar(taskId, a.idx, a.att, 'video', result._v);
        await sendTrackPar(taskId, a.idx, a.att, 'audio', result._a);
        const fin = await toOffscreen({ t: 'ytdl-par-frag', task: taskId, idx: a.idx, att: a.att });
        if (!fin || !fin.ok) throw new Error((fin && fin.error) || 'фрагмент не сохранился');
        await chrome.runtime.sendMessage({ t: 'ytdl-par-frag-done', taskId, idx: a.idx, att: a.att });
      } catch (e) {
        console.warn('[Triangle] фрагмент', a.idx, 'ошибка:', e);
        try { await chrome.runtime.sendMessage({ t: 'ytdl-par-frag-fail', taskId, idx: a.idx, att: a.att, error: String((e && e.message) || e) }); } catch (e2) {}
        await sleep(2000);
      }
    }
  }

  // ---- boot ----------------------------------------------------------------
  const PAR_TASK = new URLSearchParams(location.search).get('ytdlTask');
  if (PAR_TASK) {
    // worker tab: no button, no menus — just capture assigned fragments
    runWorker(PAR_TASK);
    return;
  }

  const mo = new MutationObserver(() => ensureButton());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', ensureButton);
  ensureButton();
})();
