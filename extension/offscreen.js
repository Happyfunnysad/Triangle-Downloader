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
// Однотабные задания — по ключу задания: качать можно из двух вкладок сразу, а
// один общий acc сваливал их чанки в один массив, и склейка выдавала мешанину
// под именем того, кто последним прислал begin.
const singles = new Map(); // job -> acc
const par = Object.create(null); // task -> { frags: idx -> {video,audio,mimes,vBytes,aBytes} }
const ffLog = []; // ring buffer of recent ffmpeg log lines
// Подпись текущей операции для тоста прогресса: без неё вкладка подписывала
// любой прогресс «Перекодирование в H.264/AAC», даже когда шли микс перевода
// или простая склейка без перекодирования.
let ffPhase = '';
let curJob = ''; // задание, которое сейчас держит ffmpeg — им подписан прогресс

// У ffmpeg одна виртуальная файловая система и один буфер лога на всех: имена
// (a.webm, list.txt, out.mp4…) не уникальны, а probeStart читает start_time из
// общего ffLog. Поэтому сборки идут строго по одной — иначе соседняя операция
// затирает вход, удаляет ещё нужный файл или обнуляет лог под чужим разбором.
let ffQueue = Promise.resolve();
function ffLock(job, fn) {
  const p = ffQueue.then(() => { curJob = job; return fn(); });
  ffQueue = p.catch(() => {});
  return p;
}

async function getFF() {
  if (ff) return ff;
  if (ffLoading) return ffLoading;
  ffLoading = (async () => {
    const inst = new FFmpeg();
    inst.on('progress', ({ progress }) => {
      try {
        chrome.runtime.sendMessage({
          t: 'ytdl-progress', value: Math.max(0, Math.min(1, progress)), phase: ffPhase, job: curJob,
        });
      } catch (e) {}
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

// Главы и субтитры вшиваются ОТДЕЛЬНЫМ проходом с копированием потоков. Так они
// не вмешиваются в раскладку входов основной сборки (видео, аудио, дорожка
// перевода) — а это как раз то место, где легко всё сломать. Проход не удался —
// возвращаем исходный файл: главы приятны, но не ради них всё затевалось.
async function decorate(inst, name, ext, srt, chapters) {
  if (ext !== '.mp4' || (!srt && !chapters)) return name;
  const ins = ['-i', name];
  const maps = ['-map', '0'];
  const enc = new TextEncoder();
  let idx = 1, meta = [], subCodec = [];
  if (srt) {
    await inst.writeFile('subs.srt', enc.encode(srt));
    ins.push('-i', 'subs.srt');
    maps.push('-map', String(idx));
    subCodec = ['-c:s', 'mov_text'];
    idx++;
  }
  if (chapters) {
    await inst.writeFile('chaps.txt', enc.encode(chapters));
    ins.push('-i', 'chaps.txt');
    meta = ['-map_metadata', String(idx), '-map_chapters', String(idx)];
    idx++;
  }
  ffPhase = 'Главы и субтитры';
  ffLog.length = 0;
  const out = 'deco.mp4';
  const ret = await inst.exec([...ins, ...maps, ...meta, '-c', 'copy', ...subCodec,
    '-movflags', '+faststart', out]);
  await rm(inst, 'subs.srt');
  await rm(inst, 'chaps.txt');
  if (ret === 0) return out;
  await rm(inst, out);
  relayLog('главы/субтитры вшить не удалось (' + ffLog.slice(-2).join(' | ').slice(0, 120) + ') — файл без них');
  return name;
}

// Real start timestamp of a captured file (mid-video captures start at ~capStart).
// `ffmpeg -i file` exits with an error but prints "Duration: ..., start: X" first.
async function probeStart(inst, name) {
  ffLog.length = 0;
  ffPhase = 'Анализ дорожек';
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
// vot: {third, lang} — при активном VOT только mp4 (AAC-микс/вторая дорожка
// несовместимы с webm); third — файл перевода третьим входом (режим «дорожка»).
async function copyCutConcat(inst, vName, aName, keep, sV, sA, vot) {
  const variants = [
    { ext: 'mp4', type: 'video/mp4', extra: ['-strict', '-2'], concatExtra: ['-movflags', '+faststart'] },
    { ext: 'webm', type: 'video/webm', extra: [], concatExtra: [] },
  ];
  if (vot) variants.length = 1;
  const third = (vot && vot.third) || null;
  ffPhase = 'Вырезка вставок и склейка';
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
        ...(third ? ['-ss', String(Math.max(0, a)), '-i', third] : []), // перевод идёт с t=0 видео
        '-map', '0:v:0', '-map', '1:a:0', ...(third ? ['-map', '2:a:0'] : []),
        ...t, '-c', 'copy', ...(third ? ['-c:a:1', 'aac', '-b:a:1', '160k'] : []),
        ...v.extra, part,
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
      const ret = await inst.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy',
        ...(third ? ['-metadata:s:a:1', 'language=' + ((vot && vot.lang) || 'und'), '-disposition:a:0', 'default'] : []),
        ...v.concatExtra, out]);
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

async function finalize(acc) {
  const inst = await getFF();
  const isMp3 = acc.format === 'mp3';
  let aName = 'a.' + extFor(acc.audioMime);

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
  let sA = await probeStart(inst, aName);
  const sV = vName ? await probeStart(inst, vName) : 0;

  const start = Math.max(0, Number(acc.start) || 0);
  const end = Number(acc.end) || 0;
  const effEnd = end > start ? end : Infinity;
  const dur = isFinite(effEnd) ? effEnd - start : 0;
  const limit = dur > 0 ? ['-t', String(dur)] : [];

  // ---- VOT: встроить переведённую дорожку ----------------------------------
  // mix/replace заранее готовят единый аудиофайл, чей t=0 соответствует
  // абсолютному start (aName/sA подменяются) — дальше все существующие ветки
  // (вырезки, транскод, mp3) работают без правок. track добавляет третий вход.
  let votTrack = null; // 'vot.mp3', если перевод идёт отдельной дорожкой
  let votLang3 = 'und';
  let votApplied = false; // при любом режиме VOT собираем только mp4 (не webm)
  let votError = '';      // почему перевода нет — уходит наверх, а не только в тост
  let origAudio = null; // исходное аудио до микса — для сборки без перевода
  if (acc.vot) {
    let mode = acc.vot.mode || 'mix';
    if (isMp3 && mode === 'track') mode = 'mix'; // в mp3 второй дорожки не бывает
    votLang3 = { ru: 'rus', en: 'eng', kk: 'kaz' }[acc.vot.lang] || 'und';
    let votBuf = null;
    try {
      votBuf = await votAwait(acc.vot);
      relayLog('VOT: дорожка перевода получена (' + Math.round(votBuf.length / 1024) + ' КБ), режим ' + mode);
    } catch (e) {
      votError = String((e && e.message) || e);
      const m = 'Перевод (VOT): ' + votError + ' — сохраняю без перевода';
      note(m);
      relayLog(m);
    }
    if (votBuf) {
      await inst.writeFile('vot.mp3', votBuf);
      if (mode === 'track') {
        votTrack = 'vot.mp3';
        votApplied = true;
      } else {
        // дорожка перевода начинается с t=0 видео → сик абсолютным start
        const seekVot = start > 0.2 ? ['-ss', String(start)] : [];
        const seekOrig = start - sA > 0.2 ? ['-ss', String(start - sA)] : [];
        // громкость родной дорожки под переводом — из настроек, 0.3 по умолчанию
        const ov = acc.vot.origVol == null ? 0.3 : Math.max(0, Math.min(1, Number(acc.vot.origVol)));
        const mixArgs = (norm) => [
          ...seekOrig, '-i', aName, ...seekVot, '-i', 'vot.mp3',
          '-filter_complex', '[0:a]volume=' + ov.toFixed(2) + '[o];[o][1:a]amix=inputs=2:duration=first' + norm + '[a]',
          '-map', '[a]', ...limit, '-c:a', 'aac', '-b:a', '192k', 'mix.m4a',
        ];
        const repArgs = [...seekVot, '-i', 'vot.mp3', ...limit, '-c:a', 'aac', '-b:a', '192k', 'mix.m4a'];
        ffLog.length = 0;
        ffPhase = 'Подготовка дорожки перевода';
        let ret = await inst.exec(mode === 'replace' ? repArgs : mixArgs(':normalize=0'));
        if (ret !== 0 && mode === 'mix') { // старый amix не знает normalize
          await rm(inst, 'mix.m4a');
          ret = await inst.exec(mixArgs(''));
        }
        if (ret === 0) {
          await rm(inst, 'vot.mp3');
          // оригинал не удаляем: если mp4-сборка с переводом не удастся,
          // второй заход соберёт файл по исходной дорожке
          origAudio = { name: aName, sA };
          aName = 'mix.m4a';
          sA = start;
          votApplied = true;
          relayLog('VOT: дорожка перевода подготовлена (' + mode + ')');
        } else {
          votError = 'не удалось подготовить дорожку перевода';
          const m = 'Перевод (VOT): не удалось подготовить дорожку — сохраняю без перевода';
          note(m);
          relayLog(m);
          await rm(inst, 'mix.m4a');
          await rm(inst, 'vot.mp3');
        }
      }
    }
  }

  let cuts = mergeCuts(acc.sb, start, effEnd);
  let keep = keepList(cuts, start, effEnd);
  if (!keep.length) { cuts = []; keep = keepList([], start, effEnd); }
  const relCuts = cuts.map(([a, b]) => [Math.max(0, a - start), b - start]);
  const expr = relCuts.length ? dropExpr(relCuts) : '';

  let data = null, chosen = null, lastErr = '';

  if (!isMp3 && !acc.transcode && cuts.length) {
    ({ data, chosen, lastErr } = await copyCutConcat(inst, vName, aName, keep, sV, sA,
      votApplied ? { third: votTrack, lang: votLang3 } : null));
    if (!data) {
      console.warn('[Triangle] вырезание в режиме copy не удалось, скачиваю без вырезания:', lastErr);
      relayLog('вырезание вставок в режиме копирования не удалось — собираю без вырезания');
    }
  }

  // Обложка для mp3 — превью видео вторым входом. Качаем один раз (assemble при
  // активном VOT может прогоняться дважды). Не скачалось или ffmpeg её не принял —
  // следующий прогон в runs соберёт файл без обложки, ничего не теряя.
  let cover = null;
  if (isMp3 && acc.videoId) {
    try {
      const r = await fetch('https://i.ytimg.com/vi/' + acc.videoId + '/hqdefault.jpg');
      if (r.ok) {
        await inst.writeFile('cover.jpg', new Uint8Array(await r.arrayBuffer()));
        cover = 'cover.jpg';
      }
    } catch (e) { /* обложка необязательна */ }
  }

  // Сборка — функция, потому что при активном VOT она может прогоняться дважды:
  // единственный mp4-вариант не собрался → второй заход идёт уже без перевода
  // (по исходному аудио), чтобы весь захват не пропал из-за перевода.
  const assemble = async () => {
    const seekA = start - sA > 0.2 ? ['-ss', String(start - sA)] : [];
    const seekV = start - sV > 0.2 ? ['-ss', String(start - sV)] : [];
    const inV = vName ? [...seekV, '-i', vName] : [];
    const inA = [...seekA, '-i', aName];
    const runs = [];
    if (isMp3) {
      const af = expr ? ['-af', "aselect='not(" + expr + ")',asetpts=N/SR/TB"] : [];
      // «Оригинал»: дорожка YouTube копируется как есть — быстрее в разы и без
      // потери качества. Вырезки SponsorBlock так сделать нельзя (нужен фильтр),
      // поэтому с ними честно уходим в обычное кодирование.
      if (acc.audioRaw && !expr) {
        const webm = extFor(acc.audioMime) === 'webm';
        const out = webm ? 'out.opus' : 'out.m4a';
        runs.push({
          out, type: webm ? 'audio/ogg' : 'audio/mp4', ext: webm ? '.opus' : '.m4a',
          phase: 'Сохранение звука без перекодирования',
          args: [...inA, ...limit, '-vn', '-c:a', 'copy', out],
        });
      } else if (acc.audioRaw) {
        relayLog('звук: вырезки SponsorBlock требуют перекодирования — сохраняю в MP3');
      }
      if (cover) {
        runs.push({
          out: 'out.mp3', type: 'audio/mpeg', ext: '.mp3', phase: 'Кодирование MP3',
          args: [...inA, '-i', cover, ...limit, ...af, '-map', '0:a', '-map', '1:v',
            '-c:a', 'libmp3lame', '-b:a', '192k', '-c:v', 'copy',
            '-disposition:v', 'attached_pic', '-id3v2_version', '3', 'out.mp3'],
        });
      }
      runs.push({
        out: 'out.mp3', type: 'audio/mpeg', ext: '.mp3', phase: 'Кодирование MP3',
        args: [...inA, ...limit, '-vn', ...af, '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'],
      });
    } else if (acc.transcode) {
      const inT = votTrack ? [...(start > 0.2 ? ['-ss', String(start)] : []), '-i', votTrack] : [];
      const maps = expr
        ? ['-filter_complex',
           "[0:v]select='not(" + expr + ")',setpts=N/FRAME_RATE/TB[v];" +
           "[1:a]aselect='not(" + expr + ")',asetpts=N/SR/TB[a]" +
           (votTrack ? ";[2:a]aselect='not(" + expr + ")',asetpts=N/SR/TB[a1]" : ''),
           '-map', '[v]', '-map', '[a]', ...(votTrack ? ['-map', '[a1]'] : [])]
        : ['-map', '0:v:0', '-map', '1:a:0', ...(votTrack ? ['-map', '2:a:0'] : [])];
      const votMeta = votTrack
        ? ['-metadata:s:a:1', 'language=' + votLang3, '-disposition:a:0', 'default'] : [];
      runs.push({
        out: 'out.mp4', type: 'video/mp4', ext: '.mp4', phase: 'Перекодирование в H.264/AAC',
        args: [...inV, ...inA, ...inT, ...maps, ...limit,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', ...votMeta, '-movflags', '+faststart', 'out.mp4'],
      });
    } else {
      const inT = votTrack ? [...(start > 0.2 ? ['-ss', String(start)] : []), '-i', votTrack] : [];
      const votMaps = votTrack ? ['-map', '2:a:0'] : [];
      const votCodec = votTrack
        ? ['-c:a:1', 'aac', '-b:a:1', '160k',
           '-metadata:s:a:1', 'language=' + votLang3, '-disposition:a:0', 'default'] : [];
      runs.push({
        out: 'out.mp4', type: 'video/mp4', ext: '.mp4', phase: 'Склейка дорожек (без перекодирования)',
        args: [...inV, ...inA, ...inT, '-map', '0:v:0', '-map', '1:a:0', ...votMaps, ...limit,
          '-c', 'copy', ...votCodec, '-strict', '-2', '-movflags', '+faststart', 'out.mp4'],
      });
      if (!votApplied) { // AAC-микс и вторая дорожка несовместимы с webm
        runs.push({
          out: 'out.webm', type: 'video/webm', ext: '.webm', phase: 'Склейка дорожек (без перекодирования)',
          args: [...inV, ...inA, '-map', '0:v:0', '-map', '1:a:0', ...limit, '-c', 'copy', 'out.webm'],
        });
      }
    }

    for (const run of runs) {
      ffLog.length = 0;
      ffPhase = run.phase;
      const ret = await inst.exec(run.args);
      if (ret === 0) {
        // вырезки сдвигают время, а субтитры и главы приходят с исходной шкалой —
        // с ними вшивать нечего, файл собирается как раньше
        const deco = cuts.length ? run.out
          : await decorate(inst, run.out, run.ext, acc.srt, acc.chapters);
        try {
          data = await inst.readFile(deco);
          if (data && data.length) {
            chosen = run;
            if (deco !== run.out) await rm(inst, deco);
            break;
          }
        } catch (e) { /* try next */ }
        if (deco !== run.out) await rm(inst, deco);
      }
      lastErr = 'ffmpeg код ' + ret + ': ' + ffLog.slice(-6).join(' | ');
      await rm(inst, run.out);
    }
    if (chosen) await rm(inst, chosen.out);
  };

  if (!data) {
    await assemble();
    if (!chosen && (votApplied || votTrack)) {
      votError = 'сборка с переводом не удалась';
      const m = 'сборка с переводом не удалась — собираю без перевода';
      note('Перевод (VOT): ' + m);
      relayLog('VOT: ' + m + ' (' + lastErr.slice(0, 160) + ')');
      if (origAudio) { await rm(inst, aName); aName = origAudio.name; sA = origAudio.sA; }
      votTrack = null;
      votApplied = false;
      lastErr = '';
      await assemble();
    }
  }

  await rm(inst, aName);
  if (origAudio && origAudio.name !== aName) await rm(inst, origAudio.name);
  if (vName) await rm(inst, vName);
  await rm(inst, 'vot.mp3');
  if (cover) await rm(inst, cover);
  acc.video = []; acc.audio = []; acc.sb = [];

  if (!chosen) throw new Error(lastErr || 'ffmpeg не собрал файл');
  // Явный след того, что именно произошло с файлом, — по нему в журнале видно,
  // было ли перекодирование и попал ли перевод в итог.
  relayLog('файл собран: ' + chosen.ext.slice(1) +
    (isMp3 ? '' : acc.transcode ? ', видео перекодировано в H.264' : ', потоки скопированы без перекодирования') +
    (acc.vot ? (votApplied || votTrack ? ', перевод встроен' : ', без перевода') : ''));
  // Итог перевода уходит наверх, а не только в тост: раньше файл без перевода
  // приходил во вкладку как обычный {ok:true} и в очереди значился «готово».
  const filename = await saveBlob(data, acc.filename, chosen);
  return { filename, votApplied: !!(votApplied || votTrack), votError };
}

async function saveBlob(data, baseName, chosen, task) {
  const filename = (baseName || 'video').replace(/\.(mp4|webm|mp3)$/i, '') + chosen.ext;
  const blob = new Blob([data.buffer], { type: chosen.type });
  const url = URL.createObjectURL(blob);
  // fromRun: у этого сохранения есть запись в журнале запусков — background
  // допишет туда шаги доставки (субтитры и сам журнал сохраняются без него).
  // task: последнее слово об отмене за воркером — он знает состояние задания
  // синхронно, а сюда par-drop мог ещё не доехать; иначе отменённая склейка
  // всё равно скачивала файл и отправляла его получателю.
  const res = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename, fromRun: true, task });
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

// Веха для журнала запусков во время сборки: background ретранслирует её в
// открытую вкладку, где runStep дописывает шаг в активный запуск.
function relayLog(msg) {
  try { chrome.runtime.sendMessage({ t: 'ytdl-run-log', msg, job: curJob }); } catch (e) {}
}

// Веха после конца запуска (выгрузка готового файла): вкладка уже закрыла
// запись, поэтому шаг дописывает background прямо в storage.
function bgLog(msg) {
  try { chrome.runtime.sendMessage({ t: 'ytdl-runlog-append', msg }); } catch (e) {}
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
  // запуск в журнале уже закрыт — итог выгрузки дописывает background
  const log = (m) => { note(m); bgLog(m); };
  try {
    if (type === 's3' && s.s3cfg && s.s3cfg.bucket) {
      note('S3: выгружаю ' + filename + '…');
      await s3Put(blob, filename, s.s3cfg);
      log('S3: выгружено — ' + filename);
    } else if (type === 'webdav' && s.wdcfg && s.wdcfg.url) {
      note('WebDAV: выгружаю ' + filename + '…');
      await webdavPut(blob, filename, s.wdcfg);
      log('WebDAV: выгружено — ' + filename);
    }
  } catch (e) {
    log('Выгрузка: ошибка — ' + String((e && e.message) || e));
  }
}

// ---- parallel merge --------------------------------------------------------
async function parMerge(msg) {
  const inst = await getFF();
  ffPhase = 'Сборка фрагментов';
  const state = par[msg.task];
  if (!state) throw new Error('нет данных задачи');
  // Отмена во время склейки: par-drop только выкидывал задачу из par, а идущая
  // сборка держала свою ссылку и досохраняла файл — он скачивался и уезжал
  // получателю уже после того, как пользователь нажал «отменить».
  const stop = () => { if (state.aborted) throw new Error('склейка отменена'); };
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
      stop();
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
    stop();
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
  stop();
  return saveBlob(data, msg.filename, chosen, msg.task);
}

// Фрагмент отправителя — с проверкой номера попытки: данные от вкладки, которую
// сторож уже признал зависшей, не должны попасть в буфер новой попытки.
function frag(msg) {
  const f = par[msg.task] && par[msg.task].frags[msg.idx];
  if (!f) throw new Error('нет фрагмента ' + msg.idx);
  if (f.att !== (msg.att || 0)) throw new Error('фрагмент ' + msg.idx + ' перевыдан другой вкладке');
  return f;
}

// ---- message handlers ------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'ytdl-ping') {
    sendResponse({ pong: true });
    return; // sync
  }

  // ---- VOT: запустить перевод заранее, параллельно с захватом ----
  if (msg.t === 'ytdl-vot-start') {
    try {
      votStart(msg);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return; // sync
  }

  // ---- single mode ----
  if (msg.t === 'ytdl-begin') {
    // брошенные задания (вкладку закрыли посреди передачи) держали бы гигабайты
    const now = Date.now();
    for (const [k, a] of singles) if (now - a.ts > 30 * 60 * 1000) singles.delete(k);
    singles.set(msg.job || '', {
      job: msg.job || '', ts: now,
      video: [], audio: [],
      videoMime: msg.videoMime || '',
      audioMime: msg.audioMime || '',
      filename: msg.filename || 'video.mp4',
      transcode: !!msg.transcode,
      format: msg.format || 'mp4',
      audioRaw: !!msg.audioRaw, // mp3-режим: копировать дорожку вместо кодирования
      videoId: msg.videoId || '', // для обложки mp3
      start: msg.start || 0,
      end: msg.end || 0,
      sb: Array.isArray(msg.sb) ? msg.sb : [],
      srt: msg.srt || '',           // готовый .srt под выбранный диапазон
      chapters: msg.chapters || '', // готовый ffmetadata с главами
      // полная спецификация перевода, а не только ключ: offscreen могло
      // пересоздать посреди передачи (OOM), и тогда votJobs пуст — по спецификации
      // votAwait запустит перевод заново вместо «перевод не запускался»
      vot: msg.vot || null,
    });
    getFF().catch(() => {});
    sendResponse({ ok: true });
    return; // sync
  }
  if (msg.t === 'ytdl-chunk') {
    try {
      const a = singles.get(msg.job || '');
      if (!a) throw new Error('задание не найдено (offscreen перезапущен?)');
      a[msg.track].push(b64decode(msg.b64));
      a.ts = Date.now();
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return; // sync
  }
  if (msg.t === 'ytdl-finalize') {
    const a = singles.get(msg.job || '');
    if (!a) { sendResponse({ ok: false, error: 'задание не найдено (offscreen перезапущен?)' }); return; }
    ffLock(a.job, () => finalize(a))
      .then((r) => { singles.delete(a.job); sendResponse(Object.assign({ ok: true }, r)); })
      .catch((e) => { singles.delete(a.job); sendResponse({ ok: false, error: String((e && e.message) || e) }); });
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
      // номер попытки хранится и здесь: зависшая вкладка живёт ещё минуты и
      // досылает свои чанки, а по task+idx они попадали прямо в буфер новой
      // попытки — воркер отвергал её frag-done уже после порчи данных
      att: msg.att || 0,
      // имя файла в FS ffmpeg — с заданием и номером попытки: 'fa0.webm' был
      // общим на все задания, и вторая параллельная загрузка затирала первой
      // её же фрагмент (или удаляла ещё нужный вход)
      tag: msg.task + '_' + msg.idx + '_' + (msg.att || 0),
    };
    getFF().catch(() => {});
    sendResponse({ ok: true });
    return; // sync
  }
  if (msg.t === 'ytdl-par-chunk') {
    try {
      const f = frag(msg);
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
      const f = frag(msg);
      const inst = await getFF();
      const aB = concat(f.audio); f.audio = [];
      const vB = f.video.length ? concat(f.video) : null; f.video = [];
      if (!aB.length) throw new Error('пустое аудио фрагмента ' + msg.idx);
      f.aName = 'fa' + f.tag + '.' + extFor(f.audioMime);
      await inst.writeFile(f.aName, aB);
      if (vB) {
        f.vName = 'fv' + f.tag + '.' + extFor(f.videoMime);
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
    if (st) st.aborted = true; // идущая склейка держит свою ссылку и увидит флаг
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
    ffLock(msg.task, () => parMerge(msg))
      .then((filename) => chrome.runtime.sendMessage({ t: 'ytdl-par-merged', task: msg.task, mergeId: msg.mergeId, ok: true, filename }))
      .catch((e) => chrome.runtime.sendMessage({ t: 'ytdl-par-merged', task: msg.task, mergeId: msg.mergeId, ok: false, error: String((e && e.message) || e) }))
      .finally(() => { delete par[msg.task]; });
    return; // sync (ack already sent)
  }
  // other message types belong to the background; ignore.
});
