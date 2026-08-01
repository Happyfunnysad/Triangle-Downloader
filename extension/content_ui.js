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
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener('click', onDocClick, true); } }
  function onDocClick(e) { if (menuEl && !menuEl.contains(e.target) && e.target.id !== BTN_ID) closeMenu(); }

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
      if (menuEl) { menuEl.remove(); menuEl = null; }
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
      store = await chrome.storage.local.get(['transcode', 'sbCut', 'parTabs', 'parChunk',
        'votOn', 'votMode', 'votLang', 'votSrcLang', 'votLively', 'votAuth',
        'votProxy', 'votProxyCfg']);
    } catch (e) { /* fall back to defaults rather than losing the menu */ }
    const cfg = {
      transcode: !!store.transcode,
      sbCut: store.sbCut !== false,
      parTabs: String(store.parTabs == null ? 'auto' : store.parTabs),
      parChunk: String(Number(store.parChunk) || 12),
      votOn: !!store.votOn,
      votMode: store.votMode || 'mix',
      votLang: store.votLang || 'ru',
      votSrcLang: store.votSrcLang || 'auto',
      votLively: !!store.votLively,
      votProxy: !!store.votProxy,
    };
    let votAuth = store.votAuth || {};
    const votProxyCfg = store.votProxyCfg || {};

    const formats = uniq.map((h) => ({ key: 'v' + h, label: h + 'p', kind: 'video', height: h }))
      .concat([
        { key: 'mp3', label: 'MP3', kind: 'mp3', height: null },
        { key: 'txt', label: '.txt', kind: 'txt', height: null },
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

    function renderDest() {
      while (destRow.firstChild) destRow.removeChild(destRow.firstChild);
      destRow.appendChild(pill('local', '↓', 'Локально'));
      const t = targets;
      // получатель показывается, только если его настройки прошли проверку
      if (t.s3cfg && t.s3cfg.bucket && destOk('s3cfg', t.s3cfg)) destRow.appendChild(pill('s3', 'S3', t.s3cfg.bucket));
      if (t.wdcfg && t.wdcfg.url && destOk('wdcfg', t.wdcfg)) destRow.appendChild(pill('webdav', 'DAV', (() => { try { return new URL(t.wdcfg.url).host; } catch (e) { return 'WebDAV'; } })()));
      if (t.ftpcfg && t.ftpcfg.host && destOk('ftpcfg', t.ftpcfg)) destRow.appendChild(pill('ftp', 'FTP', t.ftpcfg.host));
      if (t.smbDir) destRow.appendChild(pill('smb', 'NAS', t.smbDir.split(/[\\/]/).filter(Boolean).pop() || 'шара'));
      if (t.tdTarget) destRow.appendChild(pill('taildrop', 'TS', t.tdLabel || t.tdTarget));
      const add = el('button', 'ytdl-pill ytdl-pill-add', '+');
      add.title = 'настроить получателей';
      add.addEventListener('click', (ev) => { ev.stopPropagation(); showPane('settings'); });
      destRow.appendChild(add);
      destPath.textContent =
        dest === 's3' ? 's3://' + t.s3cfg.bucket + '/' + ((t.s3cfg.prefix || '').replace(/^\/+|\/+$/g, '')) + '/'
        : dest === 'webdav' ? t.wdcfg.url
        : dest === 'ftp' ? 'ftp://' + t.ftpcfg.host + '/' + (t.ftpcfg.dir || '')
        : dest === 'smb' ? String(t.smbDir).replace(/^\/Volumes\//, 'smb://')
        : dest === 'taildrop' ? 'taildrop → ' + (t.tdLabel || t.tdTarget)
        : 'папка загрузок браузера';
    }

    async function reloadDest() {
      let s = {};
      try { s = await chrome.storage.local.get(['dest', 's3cfg', 'wdcfg', 'ftpcfg', 'smbDir', 'tdTarget', 'tdLabel']); } catch (e) {}
      targets = s;
      const valid = {
        local: true,
        s3: s.s3cfg && s.s3cfg.bucket, webdav: s.wdcfg && s.wdcfg.url,
        ftp: s.ftpcfg && s.ftpcfg.host, smb: s.smbDir, taildrop: s.tdTarget,
      };
      dest = (s.dest && valid[s.dest.type]) ? s.dest.type : 'local';
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
    [chipSb, chipTabs, chipCodec, chipVot].forEach((c) => {
      c.addEventListener('click', (ev) => { ev.stopPropagation(); showPane('settings'); });
      chips.appendChild(c);
    });
    main.appendChild(chips);
    menuEl.appendChild(main);

    // — settings pane —
    const settings = el('div', 'ytdl-pane');
    settings.appendChild(settingRow('SponsorBlock',
      'спонсорские вставки и «подпишись» — по данным sponsor.ajay.app',
      [{ key: 'cut', label: 'Вырезать' }, { key: 'keep', label: 'Оставить' }],
      cfg.sbCut ? 'cut' : 'keep',
      (k) => { cfg.sbCut = k === 'cut'; chrome.storage.local.set({ sbCut: cfg.sbCut }); renderChips(); drawSponsors(); }));
    settings.appendChild(settingRow('Вкладки',
      'параллельная загрузка длинных видео фоновыми вкладками',
      [{ key: 'auto', label: 'Авто' }, { key: '1', label: '1' }, { key: '2', label: '2' }, { key: '3', label: '3' }, { key: '4', label: '4' }],
      cfg.parTabs,
      (k) => { cfg.parTabs = k; chrome.storage.local.set({ parTabs: k }); renderChips(); }));
    settings.appendChild(settingRow('Размер куска',
      'меньше — экономнее по памяти, больше — меньше стыков',
      [{ key: '10', label: '10' }, { key: '12', label: '12' }, { key: '15', label: '15' }],
      cfg.parChunk,
      (k) => { cfg.parChunk = k; chrome.storage.local.set({ parChunk: Number(k) }); }));
    settings.appendChild(settingRow('Кодек',
      'H.264 совместим со всем, но перекодирование идёт медленно',
      [{ key: 'fast', label: 'Быстро' }, { key: 'h264', label: 'H.264' }],
      cfg.transcode ? 'h264' : 'fast',
      (k) => { cfg.transcode = k === 'h264'; chrome.storage.local.set({ transcode: cfg.transcode }); renderChips(); }));
    // ---- VOT: закадровый перевод Яндекса ------------------------------------
    settings.appendChild(el('div', 'ytdl-sec', 'Перевод'));
    settings.appendChild(settingRow('Перевод (VOT)',
      'закадровый перевод Яндекса; дорожка готовится на сервере — обычно пара минут; отключает параллельные вкладки',
      [{ key: 'off', label: 'Выкл' }, { key: 'on', label: 'Вкл' }],
      cfg.votOn ? 'on' : 'off',
      (k) => { cfg.votOn = k === 'on'; chrome.storage.local.set({ votOn: cfg.votOn }); renderChips(); }));
    settings.appendChild(settingRow('Режим',
      'поверх — оригинал тише + перевод; вместо — только перевод; дорожка — 2 дорожки (mp4)',
      [{ key: 'mix', label: 'Поверх' }, { key: 'replace', label: 'Вместо' }, { key: 'track', label: 'Дорожка' }],
      cfg.votMode,
      (k) => { cfg.votMode = k; chrome.storage.local.set({ votMode: k }); }));
    settings.appendChild(settingRow('Язык перевода',
      'русский, английский или казахский',
      [{ key: 'ru', label: 'RU' }, { key: 'en', label: 'EN' }, { key: 'kk', label: 'KK' }],
      cfg.votLang,
      (k) => { cfg.votLang = k; chrome.storage.local.set({ votLang: k }); renderChips(); }));
    settings.appendChild(settingRow('Язык оригинала',
      '«авто» — Яндекс определит сам',
      [{ key: 'auto', label: 'Авто' }, { key: 'en', label: 'EN' }, { key: 'ru', label: 'RU' }],
      cfg.votSrcLang,
      (k) => { cfg.votSrcLang = k; chrome.storage.local.set({ votSrcLang: k }); }));
    settings.appendChild(settingRow('Живой голос',
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
      authState.textContent = ok ? 'Аккаунт Яндекса: выполнен вход' : 'Аккаунт Яндекса: не выполнен вход';
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
    settings.appendChild(authRow);

    settings.appendChild(settingRow('Ретранслятор',
      'Яндекс отвечает 402 на запросы из-за пределов СНГ; обход шлёт ссылку на видео через сторонний сервер',
      [{ key: 'off', label: 'Выкл' }, { key: 'on', label: 'Вкл' }],
      cfg.votProxy ? 'on' : 'off',
      (k) => { cfg.votProxy = k === 'on'; chrome.storage.local.set({ votProxy: cfg.votProxy }); }));
    settings.appendChild(fieldGrid([
      { k: 'host', ph: 'адрес ретранслятора (vot-worker.eu.cc)', val: votProxyCfg.host, wide: true },
    ], 'votProxyCfg'));
    // ---- delivery targets ---------------------------------------------------
    // Two classes, deliberately separated:
    //   * S3 / WebDAV — uploaded straight from the extension, no helper, always on;
    //   * Taildrop / SMB / FTP — need the native helper; without it these rows show
    //     a quiet "нужен помощник" hint and NOTHING else changes. No banners, no
    //     errors on open: the base extension must behave exactly as before.
    settings.appendChild(el('div', 'ytdl-sec', 'Получатели'));

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

    const s3 = targets.s3cfg || {};
    settings.appendChild(el('div', 'ytdl-hint', 'S3 — выгрузка напрямую из расширения, помощник не нужен'));
    settings.appendChild(fieldGrid([
      { k: 'endpoint', ph: 'endpoint (https://s3.amazonaws.com)', val: s3.endpoint, wide: true },
      { k: 'bucket', ph: 'bucket', val: s3.bucket },
      { k: 'region', ph: 'region (us-east-1)', val: s3.region },
      { k: 'prefix', ph: 'папка (youtube/2026)', val: s3.prefix, wide: true },
      { k: 'key', ph: 'access key', val: s3.key },
      { k: 'secret', ph: 'secret key', val: s3.secret, secret: true },
    ], 's3cfg'));

    const wd = targets.wdcfg || {};
    settings.appendChild(el('div', 'ytdl-hint', 'WebDAV — тоже напрямую (Synology/Nextcloud/QNAP)'));
    settings.appendChild(fieldGrid([
      { k: 'url', ph: 'https://nas.local:5006/video', val: wd.url, wide: true },
      { k: 'user', ph: 'логин', val: wd.user },
      { k: 'pass', ph: 'пароль', val: wd.pass, secret: true },
    ], 'wdcfg'));

    // helper presence decides how the next three rows behave
    let haveHelper = false;
    const HELP_HINT = /Windows/i.test(navigator.userAgent)
      ? 'нужен помощник: native\\install.ps1 <id расширения>'
      : 'нужен помощник: native/install.sh <id расширения>';

    const ftp = targets.ftpcfg || {};
    const ftpHint = el('div', 'ytdl-hint', 'FTP — через помощника');
    settings.appendChild(ftpHint);
    settings.appendChild(fieldGrid([
      { k: 'host', ph: 'ftp.server.local', val: ftp.host, wide: true },
      { k: 'port', ph: '21', val: ftp.port },
      { k: 'dir', ph: 'папка', val: ftp.dir },
      { k: 'user', ph: 'логин', val: ftp.user },
      { k: 'pass', ph: 'пароль', val: ftp.pass, secret: true },
    ], 'ftpcfg'));

    const tdRow = el('div', 'ytdl-row');
    const tdTop = el('div', 'ytdl-row-top');
    tdTop.appendChild(el('span', null, 'Taildrop'));
    const tdPick = el('select', 'ytdl-select');
    tdTop.appendChild(tdPick);
    tdRow.appendChild(tdTop);
    const tdHint = el('div', 'ytdl-hint', 'устройство Tailscale');
    tdRow.appendChild(tdHint);
    settings.appendChild(tdRow);

    // Сетевая папка задаётся путём — так работает всегда. Список подключённых
    // и поиск по сети — вспомогательные: список бывает пуст (в Windows папку
    // можно открыть по \\сервер\шара, не подключая диск), а поиск зависит от
    // службы обзора сети и часто молчит, поэтому он под кнопкой, а не сам собой.
    const IS_WIN_UI = /Windows/i.test(navigator.userAgent);
    const SMB_HINT = IS_WIN_UI
      ? 'путь вида \\\\сервер\\шара — подключать сетевой диск необязательно'
      : 'путь смонтированной шары, например /Volumes/video';
    const smbRow = el('div', 'ytdl-row');
    const smbTop = el('div', 'ytdl-row-top');
    smbTop.appendChild(el('span', null, 'Сетевая папка'));
    const smbPick = el('select', 'ytdl-select');
    smbTop.appendChild(smbPick);
    const smbScan = el('button', 'ytdl-mini', 'искать');
    smbTop.appendChild(smbScan);
    smbRow.appendChild(smbTop);
    const smbPath = document.createElement('input');
    smbPath.className = 'ytdl-f wide';
    smbPath.placeholder = IS_WIN_UI ? '\\\\nas\\video' : '/Volumes/video';
    smbPath.spellcheck = false;
    smbPath.addEventListener('click', (ev) => ev.stopPropagation());
    smbRow.appendChild(smbPath);
    const smbHint = el('div', 'ytdl-hint', SMB_HINT);
    smbRow.appendChild(smbHint);
    settings.appendChild(smbRow);

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
      if (!haveHelper) {
        tdPick.disabled = smbPick.disabled = smbScan.disabled = smbPath.disabled = true;
        tdHint.textContent = smbHint.textContent = HELP_HINT;
        ftpHint.textContent = 'FTP — ' + HELP_HINT;
        return;
      }
      tdPick.disabled = smbPick.disabled = smbScan.disabled = smbPath.disabled = false;

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
    const logRow = el('div', 'ytdl-row');
    const logTop = el('div', 'ytdl-row-top');
    logTop.appendChild(el('span', null, 'Журнал запусков'));
    const logBtn = el('button', 'ytdl-mini', 'Скачать JSON');
    logBtn.style.marginLeft = 'auto';
    logTop.appendChild(logBtn);
    logRow.appendChild(logTop);
    logRow.appendChild(el('div', 'ytdl-hint',
      'последние ' + RUNLOG_MAX + ' запусков: настройки, получатели и шаги; пароли и токены — маской'));
    logBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      let list = [];
      try { list = (await chrome.storage.local.get(RUNLOG_KEY))[RUNLOG_KEY] || []; } catch (e) {}
      if (!list.length) { logBtn.textContent = 'журнал пуст'; setTimeout(() => { logBtn.textContent = 'Скачать JSON'; }, 2500); return; }
      const url = 'data:application/json;charset=utf-8,' +
        encodeURIComponent(JSON.stringify(list, null, 2));
      try {
        const r = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename: 'triangle-runlog.json', noDeliver: true });
        logBtn.textContent = r && r.ok ? 'сохранён' : 'не удалось';
      } catch (e) { logBtn.textContent = 'не удалось'; }
      setTimeout(() => { logBtn.textContent = 'Скачать JSON'; }, 2500);
    });
    settings.appendChild(logRow);

    const back = el('button', 'ytdl-back', '‹ назад к загрузке');
    back.addEventListener('click', (ev) => { ev.stopPropagation(); showPane('main'); });
    settings.appendChild(back);
    menuEl.appendChild(settings);

    function showPane(which) {
      main.style.display = which === 'main' ? '' : 'none';
      settings.style.display = which === 'settings' ? '' : 'none';
      place();
    }
    gear.addEventListener('click', (ev) => {
      ev.stopPropagation();
      showPane(settings.style.display === 'none' ? 'settings' : 'main');
    });

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

  async function downloadSubtitles(info) {
    const t = toast();
    t.set('Открываю расшифровку…', 0.3);
    try {
      const res = await callHook('subtitles');
      if (!res || !res.ok) throw new Error((res && res.error) || 'нет субтитров');
      const filename = safeName(info.title) + ' [' + (res.lang || 'txt') + '].txt';
      // small text → a data URL is enough; BOM keeps Cyrillic correct on Windows
      const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent('\ufeff' + res.text);
      const save = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename });
      if (!save || !save.ok) throw new Error((save && save.error) || 'не удалось сохранить');
      t.set('Готово: ' + filename, 1);
      t.hide(4000);
    } catch (err) {
      t.fail(err, { stage: 'субтитры', format: 'txt', videoId: info.videoId, duration: info.duration });
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
    const t = toast();
    t.set('Готовлю ' + label + ' — загрузка сегментов…', 0.02);

    const { transcode = false, sbCut = true } = await chrome.storage.local.get(['transcode', 'sbCut']);
    const doTranscode = isMp3 ? true : !!transcode; // mp3 always encodes

    // ---- VOT: запустить перевод СРАЗУ — он готовится на сервере Яндекса
    // параллельно с захватом, offscreen дождётся его в finalize
    const vs = await chrome.storage.local.get(['votOn', 'votMode', 'votLang', 'votSrcLang',
      'votLively', 'votAuth', 'votProxy', 'votProxyCfg', 'dest']);
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
    const vot = vs.votOn ? {
      videoId: info.videoId,
      mode: vs.votMode || 'mix',
      lang: votLang,
      srcLang: vs.votSrcLang || 'auto',
      // живой голос Яндекс даёт только на русский и только со входом в аккаунт;
      // эти же поля образуют ключ задания, поэтому значение должно быть честным
      lively: !!vs.votLively && authOk && votLang === 'ru',
    } : null;
    if (vot) {
      t.set('Перевод (VOT): отправляю запрос…', 0.02);
      toOffscreen({
        t: 'ytdl-vot-start',
        videoId: vot.videoId,
        url: 'https://youtu.be/' + info.videoId,
        duration: info.duration || 0,
        title: info.title || '',
        lang: vot.lang,
        srcLang: vot.srcLang,
        lively: vot.lively,
        token: authOk ? auth.token : '',
        proxy: vs.votProxy ? ((vs.votProxyCfg && vs.votProxyCfg.host) || 'vot-worker.eu.cc') : '',
      }).catch(() => {}); // не фатально: finalize сохранит файл без перевода
      runStep('VOT: запрос перевода отправлен',
        { lang: vot.lang, srcLang: vot.srcLang, mode: vot.mode, lively: vot.lively, proxy: !!vs.votProxy });
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
    if (vot && parEligible) {
      // перевод собирается в finalize одной вкладки — параллельный путь его не умеет;
      // без этой записи в журнале выглядело так, будто настройка вкладок игнорируется
      runStep('VOT: параллельный режим отключён, качаю в одной вкладке' +
        ' (без перевода вкладок было бы ' + planned + ')');
    }
    if (!vot && parEligible) {
      t.hide(0);
      runStep('параллельный режим: вкладок ' + planned + ', кусок ' + parChunk + ' мин');
      return startParallel({
        format, height, start, end, transcode: doTranscode,
        sb: sbSegments, parTabs, parChunk,
      }, info);
    }

    let lastVot = '';
    const onProg = (msg) => {
      if (msg && msg.t === 'ytdl-progress') {
        // offscreen подписывает, что именно делает ffmpeg: микс перевода и
        // простая склейка — не «перекодирование», подпись не должна врать
        t.set((msg.phase || (isMp3 ? 'Кодирование MP3' : 'Перекодирование в H.264/AAC')) +
          '… ' + Math.round(msg.value * 100) + '%', 0.55 + msg.value * 0.45);
      }
      if (msg && msg.t === 'ytdl-run-log') runStep(String(msg.msg || ''));
      if (msg && msg.t === 'ytdl-vot-status') {
        t.set('Перевод (VOT): ' + msg.text, 0.55);
        if (msg.text !== lastVot) { lastVot = msg.text; runStep('VOT: ' + msg.text); }
      }
    };
    chrome.runtime.onMessage.addListener(onProg);
    try {
      ctx.stage = 'захват потока';
      runStep('захват потока начат');
      let lastQ = 0;
      const result = await download({ height, format, start, end }, (d) => {
        t.set('Загрузка сегментов ' + label + '… ' + Math.round(d.progress * 100) + '%', d.progress * 0.5);
        const q = Math.floor((d.progress || 0) * 4);
        if (q > lastQ && q < 4) { lastQ = q; runStep('захват ' + q * 25 + '%'); }
      });
      ctx.stage = 'сборка файла (ffmpeg)';
      runStep('захват завершён, сборка файла (ffmpeg)');
      t.set((isMp3 ? 'Кодирование MP3…'
        : (transcode ? 'Готовлю перекодирование (может занять дольше ролика)…' : 'Склейка дорожек…')) + sbNote, 0.55);

      const ext = isMp3 ? '.mp3' : '.mp4';
      const filename = safeName(info.title) + (isMp3 ? '' : ' [' + height + 'p]') +
        fragSuffix(start, end, duration) + ext;

      const res = await muxViaOffscreen({
        format,
        video: isMp3 ? null : result._v,
        audio: result._a,
        videoMime: result.video && result.video.mime,
        audioMime: result.audio && result.audio.mime,
        filename, transcode: doTranscode, start, end,
        sb: sbSegments, vot,
      });

      if (!res || !res.ok) throw new Error(res && res.error || 'mux failed');
      t.set('Готово: ' + (res.filename || filename) + sbNote, 1);
      t.hide(4000);
      runStep('файл сохранён: ' + (res.filename || filename));
      runEnd('успех');
    } catch (err) {
      t.fail(err, ctx);
      runStep('ошибка на шаге «' + ctx.stage + '»');
      runEnd('ошибка', err);
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
      t: 'ytdl-begin', filename: job.filename, format: job.format,
      videoMime: job.videoMime, audioMime: job.audioMime,
      transcode: !!job.transcode, start: job.start, end: job.end,
      sb: job.sb || [], vot: job.vot || null,
    });
    if (!beg || !beg.ok) throw new Error('offscreen не принял задание: ' + ((beg && beg.error) || 'нет ответа'));
    const sendTrack = async (name, buf) => {
      if (!buf) return;
      const view = new Uint8Array(buf);
      for (let off = 0; off < view.length; off += CHUNK) {
        const slice = view.subarray(off, Math.min(off + CHUNK, view.length));
        let r = null;
        try {
          r = await toOffscreen({ t: 'ytdl-chunk', track: name, b64: b64encode(slice) });
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
    return toOffscreen({ t: 'ytdl-finalize' });
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
    runParallelUI(resp.taskId, opts, filename);
  }

  function buildPanel() {
    const old = document.getElementById('ytdl-panel');
    if (old) old.remove();
    const box = el('div'); box.id = 'ytdl-panel';

    const head = el('div', 'ytdl-panel-head');
    const mark = el('span'); mark.style.width = '13px'; mark.style.height = '13px';
    mark.appendChild(triangleSvg('#ff4e45'));
    head.appendChild(mark);
    head.appendChild(el('span', null, 'Параллельная загрузка'));
    const pct = el('span', 'ytdl-panel-pct', '0%');
    pct.style.marginLeft = 'auto';
    pct.style.color = '#fff';
    pct.style.fontWeight = '600';
    pct.style.fontVariantNumeric = 'tabular-nums';
    head.appendChild(pct);
    box.appendChild(head);

    const fragsRow = el('div', 'ytdl-panel-frags');
    box.appendChild(fragsRow);
    const bar = el('div', 'ytdl-toast-bar'); bar.appendChild(el('i'));
    box.appendChild(bar);
    const stat = el('div', 'ytdl-panel-stat', 'Запуск…');
    box.appendChild(stat);
    const warn = el('div', 'ytdl-panel-warn', '');
    box.appendChild(warn);

    const btns = el('div', 'ytdl-panel-btns');
    const bRetry = el('button', 'ytdl-pbtn ytdl-pbtn-grow', 'Повторить ошибочные');
    const bPause = el('button', 'ytdl-pbtn', 'Пауза');
    const bCancel = el('button', 'ytdl-pbtn ytdl-pbtn-danger', '✕');
    bCancel.title = 'Отменить';
    btns.appendChild(bRetry); btns.appendChild(bPause); btns.appendChild(bCancel);
    box.appendChild(btns);
    document.body.appendChild(box);
    return { box, stat, pct, fragsRow, bar, warn, bPause, bRetry, bCancel };
  }

  function fmtEta(s) {
    s = Math.max(0, Math.floor(s));
    if (s < 60) return 'меньше минуты';
    return Math.round(s / 60) + ' мин';
  }

  function renderPanel(ui, st) {
    const names = { pend: 'ожидает', run: 'загружается', done: 'готов', err: 'ошибка' };
    while (ui.fragsRow.firstChild) ui.fragsRow.removeChild(ui.fragsRow.firstChild);
    let done = 0, run = 0, err = 0;
    for (const f of st.frags) {
      if (f.st === 'done') done++; else if (f.st === 'run') run++; else if (f.st === 'err') err++;
      const c = el('span', 'ytdl-chip ytdl-chip-' + f.st);
      c.title = 'Фрагмент ' + (f.idx + 1) + ': ' + (names[f.st] || f.st) +
        (f.st === 'run' ? ' ' + Math.round((f.pct || 0) * 100) + '%' : '');
      ui.fragsRow.appendChild(c);
    }
    let txt, pct = (st.progress || 0) * 0.9;
    if (st.state === 'run') {
      txt = done + ' готовы · ' + run + ' идут' + (err ? ' · ' + err + ' с ошибкой' : '') +
        ' · вкладок: ' + st.workers + (st.eta != null ? ' · осталось ~' + fmtEta(st.eta) : '');
    } else if (st.state === 'pause') { txt = 'Пауза'; }
    else if (st.state === 'merge') { txt = 'Склейка фрагментов… ' + Math.round((st.mergePct || 0) * 100) + '%'; pct = 0.9 + 0.1 * (st.mergePct || 0); }
    else if (st.state === 'stall') { txt = 'Есть фрагменты с ошибкой — «Повторить ошибочные»'; }
    else if (st.state === 'done') { txt = 'Готово: ' + (st.filename || ''); pct = 1; }
    else if (st.state === 'error') { txt = 'Ошибка: ' + (st.error || ''); }
    else txt = st.state;
    ui.stat.textContent = txt;
    ui.pct.textContent = Math.round(Math.min(1, pct) * 100) + '%';
    ui.bar.querySelector('i').style.width = Math.round(Math.min(1, pct) * 100) + '%';
    ui.bRetry.style.display = (st.state === 'stall' || st.state === 'error') ? '' : 'none';
    ui.bPause.style.display = (st.state === 'run' || st.state === 'pause') ? '' : 'none';
    ui.bCancel.style.display = (st.state === 'done') ? 'none' : '';
  }

  async function runParallelUI(taskId, opts, filename) {
    const ui = buildPanel();
    if (!opts.transcode && opts.format !== 'mp3' && opts.height >= 1080 && (opts.end - opts.start) > 5400) {
      ui.warn.textContent = '1080p длиннее ~1,5 ч может не собраться: у ffmpeg.wasm лимит памяти ~2 ГБ. Надёжнее 720p или меньший фрагмент.';
    }
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
    let missing = 0;
    let lastState = '';
    while (true) {
      await sleep(1000);
      let st = null;
      try { st = await chrome.runtime.sendMessage({ t: 'ytdl-par-status', taskId }); } catch (e) {}
      if (!st) {
        if (++missing > 10) {
          ui.stat.textContent = 'Ошибка: связь с расширением потеряна';
          runEnd('ошибка', 'связь с расширением потеряна');
          break;
        }
        continue;
      }
      missing = 0;
      if (!st.ok) {
        ui.stat.textContent = 'Ошибка: задача потеряна (service worker перезапустился)';
        runEnd('ошибка', 'задача потеряна (service worker перезапустился)');
        break;
      }
      if (st.state !== lastState) {
        lastState = st.state;
        runStep('параллельно: ' + st.state + (st.error ? ' — ' + st.error : ''),
          { готово: (st.frags || []).filter((f) => f.st === 'done').length, всего: (st.frags || []).length });
      }
      renderPanel(ui, st);
      if (st.state === 'done') { runEnd('успех'); break; }
      if (st.state === 'cancel') { runEnd('отменено'); break; }
      // 'error' and 'stall' keep the panel alive so the user can retry
    }
    setTimeout(() => { try { ui.box.remove(); } catch (e) {} }, 20000);
  }

  // ---- parallel download: worker-tab loop ----------------------------------
  async function sendTrackPar(taskId, idx, name, buf) {
    if (!buf) return;
    const CHUNK = 4 * 1024 * 1024;
    const view = new Uint8Array(buf);
    for (let off = 0; off < view.length; off += CHUNK) {
      const slice = view.subarray(off, Math.min(off + CHUNK, view.length));
      let r = null;
      try { r = await toOffscreen({ t: 'ytdl-par-chunk', task: taskId, idx, track: name, b64: b64encode(slice) }); }
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
        const result = await download({ height: a.height, format: a.format, start: a.s, end: a.e }, (d) => {
          try { chrome.runtime.sendMessage({ t: 'ytdl-par-prog', taskId, idx: a.idx, pct: d.progress }); } catch (e) {}
        });
        const beg = await toOffscreen({
          t: 'ytdl-par-begin', task: taskId, idx: a.idx,
          videoMime: result.video && result.video.mime,
          audioMime: result.audio && result.audio.mime,
        });
        if (!beg || !beg.ok) throw new Error('offscreen не принял фрагмент: ' + ((beg && beg.error) || 'нет ответа'));
        await sendTrackPar(taskId, a.idx, 'video', result._v);
        await sendTrackPar(taskId, a.idx, 'audio', result._a);
        const fin = await toOffscreen({ t: 'ytdl-par-frag', task: taskId, idx: a.idx });
        if (!fin || !fin.ok) throw new Error((fin && fin.error) || 'фрагмент не сохранился');
        await chrome.runtime.sendMessage({ t: 'ytdl-par-frag-done', taskId, idx: a.idx });
      } catch (e) {
        console.warn('[Triangle] фрагмент', a.idx, 'ошибка:', e);
        try { await chrome.runtime.sendMessage({ t: 'ytdl-par-frag-fail', taskId, idx: a.idx, error: String((e && e.message) || e) }); } catch (e2) {}
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
