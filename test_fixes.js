// Самопроверка исправлений гонок: `node test_fixes.js`.
// Грузит настоящие extension/background.js и extension/offscreen.js в песочницу
// с заглушками chrome.* — то есть проверяет именно тот код, который поедет в
// браузер, а не его пересказ. Падает, если сломать любую из четырёх правок:
// номер попытки фрагмента, повтор после сорвавшейся склейки, очередь ffmpeg,
// разделение однотабных заданий по ключу.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

function load(file, extra) {
  const msg = [];
  const sink = () => ({ addListener: () => {} });
  let tabSeq = 200; // разные id: spawnTabs крутится, пока Set вкладок не подрос
  const chrome = {
    runtime: {
      onMessage: { addListener: (f) => msg.push(f) },
      onInstalled: sink(), onStartup: sink(),
      sendMessage: async () => ({ ok: true }),
      getURL: (s) => s, lastError: null,
    },
    tabs: {
      onRemoved: sink(), sendMessage: async () => {},
      create: async () => ({ id: tabSeq++ }), update: async () => {}, remove: async () => {},
    },
    alarms: { create: () => {}, onAlarm: sink() },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    downloads: { onChanged: sink(), search: async () => [] },
    notifications: { create: () => Promise.resolve() },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
  };
  const sandbox = Object.assign({
    chrome, console, setTimeout, clearTimeout, atob, btoa, URL, Blob: class {},
    TextEncoder, TextDecoder, crypto: require('crypto').webcrypto,
    navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
    fetch: async () => ({ ok: true }),
  }, extra || {});
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'extension', file), 'utf8'), ctx, { filename: file });
  const send = (m, tabId) => new Promise((resolve) => {
    let answered = false;
    const reply = (r) => { answered = true; resolve(r); };
    const kept = msg[0](m, tabId == null ? {} : { tab: { id: tabId } }, reply);
    if (!answered && kept !== true) resolve(undefined);
  });
  return { send, get: (expr) => vm.runInContext(expr, ctx), env: sandbox };
}

async function testBackground() {
  const bg = load('background.js');
  const started = await bg.send({
    t: 'ytdl-par-start', url: 'https://www.youtube.com/watch?v=abc', videoId: 'abc',
    filename: 'v.mp4', format: 'mp4', height: 720, transcode: false,
    start: 0, end: 3600, tabsMode: '2', chunkMin: 12,
  }, 1);
  const taskId = started.taskId;
  assert.ok(taskId, 'задание не создалось');

  // первая вкладка берёт фрагмент 0
  const a1 = await bg.send({ t: 'ytdl-par-claim', taskId }, 11);
  assert.strictEqual(a1.idx, 0);
  assert.strictEqual(a1.att, 1, 'клейм должен выдавать номер попытки');

  // сторож признал вкладку зависшей и вернул фрагмент в очередь. Номер попытки
  // обязан протухнуть сразу, а не со следующего клейма
  const jobs = bg.get('jobs');
  const job = jobs[taskId];
  bg.get('requeueFrag')(job, job.frags[0], 'тест: вкладка зависла');
  assert.notStrictEqual(job.frags[0].att, a1.att, 'requeue не обновил номер попытки');
  const raced = await bg.send({ t: 'ytdl-par-frag-done', taskId, idx: 0, att: a1.att });
  assert.strictEqual(raced.stale, true, 'готово от вкладки, снятой сторожем, принято');
  assert.strictEqual(job.frags[0].st, 'pend', 'снятый фрагмент закрыт чужим сообщением');

  const a2 = await bg.send({ t: 'ytdl-par-claim', taskId }, 12);
  assert.strictEqual(a2.idx, 0);
  assert.notStrictEqual(a2.att, a1.att, 'новая попытка должна получить новый номер');

  // догоняющее «готово» от прошлой вкладки не должно закрывать фрагмент
  const stale = await bg.send({ t: 'ytdl-par-frag-done', taskId, idx: 0, att: a1.att });
  assert.strictEqual(stale.stale, true, 'сообщение прошлой попытки принято как своё');
  assert.strictEqual(job.frags[0].st, 'run', 'фрагмент закрыт чужим сообщением');

  // и её же «ошибка» не должна сбивать идущую попытку
  await bg.send({ t: 'ytdl-par-frag-fail', taskId, idx: 0, att: a1.att, error: 'тест' });
  assert.strictEqual(job.frags[0].st, 'run', 'фрагмент перевыдан по чужой ошибке');

  // сообщение своей попытки проходит
  await bg.send({ t: 'ytdl-par-frag-done', taskId, idx: 0, att: a2.att });
  assert.strictEqual(job.frags[0].st, 'done');

  // повтор: есть сломанные фрагменты — перекачиваем только их
  const retryFrags = bg.get('retryFrags');
  job.frags[1].st = 'err';
  job.frags[2].st = 'done';
  retryFrags(job);
  assert.strictEqual(job.frags[0].st, 'done');
  assert.strictEqual(job.frags[1].st, 'pend');
  assert.strictEqual(job.frags[2].st, 'done');

  // повтор после сорвавшейся склейки: сломанных нет, а данных в offscreen уже
  // нет тоже — качать надо всё заново, иначе повтор падает «нет данных задачи»
  for (const f of job.frags) f.st = 'done';
  job.state = 'error';
  retryFrags(job);
  assert.ok(job.frags.every((f) => f.st === 'pend'), 'повтор после склейки не перекачивает фрагменты');
  assert.strictEqual(job.state, 'run');

  // сохранение отменённого задания воркер не пропускает — иначе файл всё равно
  // скачался бы и уехал получателю
  job.state = 'cancel';
  const denied = await bg.send({ t: 'ytdl-save', url: 'blob:x', filename: 'v.mp4', task: taskId });
  assert.strictEqual(denied.ok, false, 'отменённое задание всё равно сохранилось');
  job.state = 'run';

  // запоздалый ответ склейки не воскрешает отменённое задание
  job.state = 'merge'; job.mergeId = 3;
  await bg.send({ t: 'ytdl-par-merged', task: taskId, mergeId: 3, ok: true, filename: 'v.mp4' });
  assert.strictEqual(job.state, 'done');
  job.state = 'cancel';
  await bg.send({ t: 'ytdl-par-merged', task: taskId, mergeId: 3, ok: true, filename: 'v.mp4' });
  assert.strictEqual(job.state, 'cancel', 'отменённое задание воскресло по старому ответу склейки');

  // категории SponsorBlock берутся из настроек, а не из зашитой тройки
  bg.env.chrome.storage.local.get = async (k) => (k === 'sbCats' ? { sbCats: ['intro', 'outro'] } : {});
  let asked = '';
  bg.env.fetch = async (u) => { asked = u; return { ok: true, status: 200, json: async () => [] }; };
  await bg.send({ t: 'ytdl-sb-get', videoId: 'abc' });
  const cats = decodeURIComponent(String(asked).split('categories=')[1] || ''); // домен тоже зовётся sponsor
  assert.deepStrictEqual(JSON.parse(cats), ['intro', 'outro'], 'категории SponsorBlock не читаются из настроек');
}

async function testOffscreen() {
  const off = load('offscreen.js', { FFmpegWASM: { FFmpeg: class { on() {} async load() {} } } });

  // ffmpeg один на всех: операции обязаны идти строго по очереди
  const ffLock = off.get('ffLock');
  const order = [];
  await Promise.all([
    ffLock('A', async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a2');
    }),
    ffLock('B', async () => { order.push('b1'); }),
  ]);
  assert.deepStrictEqual(order, ['a1', 'a2', 'b1'], 'сборки перемешались');

  // ошибка одной операции не должна вешать очередь
  await ffLock('C', async () => { throw new Error('тест'); }).catch(() => {});
  assert.strictEqual(await ffLock('D', async () => 'жив'), 'жив');

  // две однотабные загрузки не должны складывать чанки в один буфер
  const begin = (job, filename) => off.send({
    t: 'ytdl-begin', job, filename, format: 'mp4', videoMime: 'video/webm', audioMime: 'audio/webm',
  });
  await begin('j1', 'первое.mp4');
  await begin('j2', 'второе.mp4');
  await off.send({ t: 'ytdl-chunk', job: 'j1', track: 'audio', b64: btoa('aaa') });
  await off.send({ t: 'ytdl-chunk', job: 'j2', track: 'audio', b64: btoa('bb') });

  const singles = off.get('singles');
  assert.strictEqual(singles.get('j1').audio.length, 1);
  assert.strictEqual(singles.get('j1').audio[0].length, 3, 'чанки заданий перемешались');
  assert.strictEqual(singles.get('j2').audio[0].length, 2);
  assert.strictEqual(singles.get('j1').filename, 'первое.mp4', 'имя файла перебито соседним заданием');

  // байты фрагмента от вкладки, снятой сторожем, не должны попасть в буфер
  // новой попытки: у неё свой номер, и по task+idx данные больше не проходят
  await off.send({ t: 'ytdl-par-begin', task: 'T', idx: 0, att: 2, audioMime: 'audio/webm' });
  const okChunk = await off.send({ t: 'ytdl-par-chunk', task: 'T', idx: 0, att: 2, track: 'audio', b64: btoa('mine') });
  assert.strictEqual(okChunk.ok, true);
  const oldChunk = await off.send({ t: 'ytdl-par-chunk', task: 'T', idx: 0, att: 1, track: 'audio', b64: btoa('theirs') });
  assert.strictEqual(oldChunk.ok, false, 'чанк снятой попытки записан в новый фрагмент');
  assert.strictEqual(off.get('par').T.frags[0].audio.length, 1, 'буфер фрагмента загрязнён');

  // чанк без своего задания (offscreen пересоздали) — явная ошибка, а не тишина
  const orphan = await off.send({ t: 'ytdl-chunk', job: 'нет-такого', track: 'audio', b64: btoa('x') });
  assert.strictEqual(orphan.ok, false);
  const orphanFin = await off.send({ t: 'ytdl-finalize', job: 'нет-такого' });
  assert.strictEqual(orphanFin.ok, false);
}

// srtFrom/chaptersMeta живут в замыкании content_ui.js и наружу не торчат —
// вырезаем их блок из настоящего файла и выполняем, чтобы проверять именно его.
function subsHelpers() {
  const src = fs.readFileSync(path.join(__dirname, 'extension', 'content_ui.js'), 'utf8');
  const from = src.indexOf('  function srtStamp(');
  const to = src.indexOf('  async function downloadSubtitles(');
  assert.ok(from > 0 && to > from, 'блок сборки субтитров не найден в content_ui.js');
  return new Function(src.slice(from, to) + '\nreturn { srtFrom, chaptersMeta };')();
}

function testSubsAndChapters() {
  const { srtFrom, chaptersMeta } = subsHelpers();

  // диапазон 4..12: реплики сдвигаются к нулю файла и обрезаются по краям
  const srt = srtFrom([{ t: 0, text: 'a' }, { t: 5, text: 'b' }, { t: 10, text: 'c' }], 4, 12);
  assert.strictEqual(srt.split('-->').length - 1, 3, 'не столько реплик, сколько ожидалось');
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:01,000\na'), 'реплики не сдвинуты к началу файла:\n' + srt);
  assert.ok(/00:00:08,000\nc/.test(srt), 'последняя реплика не обрезана по концу диапазона:\n' + srt);

  // реплика без времени бесполезна для .srt и не должна ломать нумерацию
  assert.strictEqual(srtFrom([{ t: null, text: 'x' }], 0, 10), '');
  assert.strictEqual(srtFrom([], 0, 10), '');

  // главы: одна глава — это не разметка; конец берётся от следующей и режется по диапазону
  assert.strictEqual(chaptersMeta([{ t: 0, title: 'Одна' }], 0, 120), '');
  const meta = chaptersMeta(
    [{ t: 0, title: 'Вступ' }, { t: 60, title: 'Сут=ь;' }, { t: 600, title: 'Финал' }], 0, 120);
  assert.ok(meta.startsWith(';FFMETADATA1'), 'нет заголовка ffmetadata');
  assert.strictEqual((meta.match(/\[CHAPTER\]/g) || []).length, 2, 'глава вне диапазона не отброшена');
  assert.ok(/END=120000/.test(meta), 'конец последней главы не обрезан по диапазону:\n' + meta);
  assert.ok(!/[=;]/.test(meta.split('title=')[2]), 'в заголовке главы остались символы разметки ffmetadata');
}

function testParallelExtrasDoNotForceSingleTab() {
  const src = fs.readFileSync(path.join(__dirname, 'extension', 'content_ui.js'), 'utf8');
  assert.ok(src.includes("const dropsMediaExtras = !isMp3 && (subsIn !== 'off' || chapsIn);"),
    'нет флага, который предупреждает о невшитых субтитрах/главах в параллельном пути');
  assert.ok(/if \(!vot && parEligible\)/.test(src),
    'включённые субтитры или главы снова могут принудительно отправить загрузку в одну вкладку');
  assert.ok(src.includes('subsIn: opts.subsIn') && src.includes('chapsIn: !!opts.chapsIn'),
    'параллельный старт не сохраняет выбранные субтитры/главы для честного предупреждения при повторе');

  const bg = fs.readFileSync(path.join(__dirname, 'extension', 'background.js'), 'utf8');
  assert.ok(bg.includes("if (item.spec.subsIn && item.spec.subsIn !== 'off') lost.push('субтитры');"),
    'повтор из очереди не предупреждает о потере субтитров');
  assert.ok(bg.includes("if (item.spec.chapsIn) lost.push('главы');"),
    'повтор из очереди не предупреждает о потере глав');
}

function testDestReadinessIsShared() {
  const src = fs.readFileSync(path.join(__dirname, 'extension', 'content_ui.js'), 'utf8');
  assert.ok(src.includes('function destReady(kind)'), 'нет общего правила готовности получателей');
  assert.ok(src.includes("if (destReady('ftp'))"), 'FTP-пилюля может появиться без готового помощника');
  assert.ok(src.includes("set('ftp', destReady('ftp')"), 'FTP-карточка проверяется не тем же правилом, что пилюля');
}

function testWebmCopyDoesNotTryMp4First() {
  const src = fs.readFileSync(path.join(__dirname, 'extension', 'offscreen.js'), 'utf8');
  assert.ok(src.includes('mp4CopyInput(vName) && mp4CopyInput(aName)'),
    'MP4 copy не проверяет совместимость входных потоков');
  assert.ok(src.includes('webmCopyInput(vName) && webmCopyInput(aName)'),
    'WebM copy не проверяет совместимость входных потоков');
  assert.ok(src.includes(": [{ out: 'out.webm', type: 'video/webm', ext: '.webm',"),
    'параллельная склейка без перекодирования снова может попробовать MP4 перед WebM');
}

function testParallelShowsCurrentFragmentTime() {
  const src = fs.readFileSync(path.join(__dirname, 'extension', 'content_ui.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'extension', 'content_ui.css'), 'utf8');
  assert.ok(src.includes("const nowTxt = nowAt != null ? 'сейчас ' + fmtShort(nowAt) : '';"),
    'панель фрагментов не считает текущее время внутри активного отрезка');
  assert.ok(src.includes("el('span', 'ytdl-p-frag-now', nowTxt)"),
    'текущее время активного отрезка не выводится в строку фрагмента');
  assert.ok(css.includes('.ytdl-p-frag-now'),
    'для текущего времени фрагмента нет отдельного компактного стиля');
}

(async () => {
  await testBackground();
  await testOffscreen();
  testSubsAndChapters();
  testParallelExtrasDoNotForceSingleTab();
  testDestReadinessIsShared();
  testWebmCopyDoesNotTryMp4First();
  testParallelShowsCurrentFragmentTime();
  console.log('все проверки прошли');
  process.exit(0); // код расширения оставляет свои долгие таймеры — они тут ни к чему
})().catch((e) => { console.error(e); process.exit(1); });
