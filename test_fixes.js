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

(async () => {
  await testBackground();
  await testOffscreen();
  console.log('все проверки прошли');
  process.exit(0); // код расширения оставляет свои долгие таймеры — они тут ни к чему
})().catch((e) => { console.error(e); process.exit(1); });
