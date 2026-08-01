// vot.js — клиент серверного закадрового перевода Яндекса (VOT). Живёт в
// offscreen-документе рядом с ffmpeg: поллинг занимает минуты, а service
// worker MV3 столько не живёт. Протокол снят с референсного юзерскрипта
// [VOT] 1.11.7 (бандл @vot.js 2.4.20): два protobuf-сообщения кодируются
// вручную, подпись — HMAC-SHA256, отдельного status-endpoint нет — готовность
// проверяется повторным POST того же запроса.

const VOT_HOST = 'https://api.browser.yandex.ru';
const VOT_HMAC_KEY = 'bt8xH3VOlb4mqf0nqAibnDOoiPlXsisf';
const VOT_COMPONENT = '26.6.2.938';
const VOT_AUDIO_PREFIX = 'https://vtrans.s3-private.mds.yandex.net/tts/prod/';

// Яндекс отвечает 402 на запросы с адресов вне СНГ. Обход — сторонний ретранслятор
// FOSWLY (vot-worker), тот же, что использует юзерскрипт: он принимает protobuf,
// завёрнутый в JSON, и передаёт запрос дальше. Выключен по умолчанию: включая его,
// пользователь соглашается, что ссылка на видео уходит на чужой сервер.
let votProxyHost = '';

// ---- минимальный protobuf ---------------------------------------------------
function pbVarint(n) {
  const out = [];
  n = Math.max(0, Math.floor(n));
  while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
function pbStr(field, s) {
  if (!s) return [];
  const b = new TextEncoder().encode(String(s));
  return [...pbVarint((field << 3) | 2), ...pbVarint(b.length), ...b];
}
function pbBool(field, v) { return v ? [...pbVarint((field << 3) | 0), 1] : []; }
function pbInt32(field, n) { return n ? [...pbVarint((field << 3) | 0), ...pbVarint(n)] : []; }
function pbDouble(field, x) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x, true);
  return [...pbVarint((field << 3) | 1), ...b];
}
function pbMsg(field, bytes) {
  return [...pbVarint((field << 3) | 2), ...pbVarint(bytes.length), ...bytes];
}
// плоское чтение: { номерПоля: значение }; вложенные сообщения не нужны
function pbRead(u8) {
  const out = {};
  let i = 0;
  const varint = () => {
    let v = 0, m = 1, b;
    do { b = u8[i++]; v += (b & 127) * m; m *= 128; } while (b & 128);
    return v;
  };
  while (i < u8.length) {
    const tag = varint();
    const field = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 0) out[field] = varint();
    else if (wire === 1) {
      out[field] = new DataView(u8.buffer, u8.byteOffset + i, 8).getFloat64(0, true);
      i += 8;
    } else if (wire === 2) {
      const len = varint();
      out[field] = u8.subarray(i, i + len);
      i += len;
    } else if (wire === 5) i += 4;
    else break;
  }
  return out;
}
const votUtf8 = (v) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : '');

// ---- подпись и сессия -------------------------------------------------------
async function votHmacHex(data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(VOT_HMAC_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key,
    typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function votUUID() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += '0123456789ABCDEF'[b & 15];
  return s;
}

// Заголовки, которыми представляется Яндекс-браузер. User-Agent в прямом режиме
// подставляет declarativeNetRequest (fetch в MV3 его не отдаёт), в режиме
// ретранслятора — передаётся явно, потому что запрос уходит с чужого сервера.
const VOT_BASE_HEADERS = {
  'Accept': 'application/x-protobuf',
  'Accept-Language': 'en',
  'Content-Type': 'application/x-protobuf',
  'Pragma': 'no-cache',
  'Cache-Control': 'no-cache',
};
const VOT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 YaBrowser/26.6.0.0 Safari/537.36';

async function votPost(path, body, headers, method) {
  const h = Object.assign({}, VOT_BASE_HEADERS, headers || {});
  if (votProxyHost) {
    return fetch('https://' + votProxyHost + path, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headers: Object.assign({ 'User-Agent': VOT_UA }, h), body: [...body] }),
    });
  }
  return fetch(VOT_HOST + path, { method: method || 'POST', headers: h, body });
}

function votHttpError(what, status) {
  if (status === 402 && !votProxyHost) {
    return new Error(what + ': Яндекс отклонил запрос (402) — обычно так он отвечает ' +
      'на запросы из-за пределов СНГ; включите ретранслятор в настройках');
  }
  return new Error(what + ': HTTP ' + status);
}

let votSession = null; // { uuid, secretKey, expires, ts (сек) }

async function votGetSession() {
  const now = Date.now() / 1000;
  if (votSession && votSession.ts + votSession.expires > now + 60) return votSession;
  const uuid = votUUID();
  const body = new Uint8Array([...pbStr(1, uuid), ...pbStr(2, 'video-translation')]);
  const res = await votPost('/session/create', body, { 'Vtrans-Signature': await votHmacHex(body) });
  if (!res.ok) throw votHttpError('сессия Яндекса', res.status);
  const f = pbRead(new Uint8Array(await res.arrayBuffer()));
  votSession = { uuid, secretKey: votUtf8(f[1]), expires: Number(f[2]) || 3600, ts: now };
  return votSession;
}

async function votSecHeaders(body, path) {
  const s = await votGetSession();
  const token = s.uuid + ':' + path + ':' + VOT_COMPONENT;
  return {
    'Vtrans-Signature': await votHmacHex(body),
    'Sec-Vtrans-Sk': s.secretKey,
    'Sec-Vtrans-Token': (await votHmacHex(token)) + ':' + token,
  };
}

// ---- перевод ----------------------------------------------------------------
// статусы ответа: 0 FAILED, 1 FINISHED, 2 WAITING, 3 LONG_WAITING,
// 5 PART_CONTENT, 6 AUDIO_REQUESTED, 7 SESSION_REQUIRED
function votEncodeTranslate(o) {
  return new Uint8Array([
    ...pbStr(3, o.url),
    ...pbBool(5, o.firstRequest),
    ...pbDouble(6, o.duration > 0 ? o.duration : 310),
    ...pbInt32(7, 1),
    ...pbStr(8, o.lang),
    ...pbBool(9, o.forceSourceLang),
    ...pbStr(14, o.responseLang),
    ...pbInt32(15, 1),
    ...pbInt32(16, 2),
    ...pbBool(18, o.lively),
    ...pbStr(19, o.title),
  ]);
}

// Яндекс не смог сам забрать аудио (статус 6): имитируем «отдачу из iframe»,
// как это делает юзерскрипт, — после этого перевод обычно продолжается.
async function votFakeAudio(url, translationId) {
  try {
    const host = votProxyHost ? 'https://' + votProxyHost : VOT_HOST;
    await fetch(host + '/video-translation/fail-audio-js', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: url }),
    });
  } catch (e) { /* необязательный запрос */ }
  const body = new Uint8Array([
    ...pbStr(1, translationId),
    ...pbStr(2, url),
    ...pbMsg(6, pbStr(1, 'web_api_get_all_generating_urls_data_from_iframe')),
  ]);
  const res = await votPost('/video-translation/audio', body,
    await votSecHeaders(body, '/video-translation/audio'), 'PUT');
  if (!res.ok) throw votHttpError('audio-запрос', res.status);
}

function votNote(text) {
  try { chrome.runtime.sendMessage({ t: 'ytdl-vot-status', text }); } catch (e) {}
}

const votSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function votRun(o) {
  const srcLang = o.srcLang && o.srcLang !== 'auto' ? o.srcLang : 'auto';
  // живой голос: только на русский и только с токеном; при «авто» источнике
  // Яндекс требует конкретный язык — юзерскрипт в этом случае шлёт en
  let lively = !!o.lively && o.lang === 'ru' && !!o.token;
  let audioSent = false;
  let polls = 0;
  const deadline = Date.now() + 60 * 60 * 1000;

  while (true) {
    if (Date.now() > deadline) throw new Error('перевод не успел подготовиться за час');
    const body = votEncodeTranslate({
      url: o.url,
      duration: o.duration,
      lang: lively && srcLang === 'auto' ? 'en' : srcLang,
      forceSourceLang: srcLang !== 'auto',
      responseLang: o.lang,
      firstRequest: true, // поллинг — повтор идентичного запроса, поле не меняется
      lively,
      title: o.title,
    });
    const headers = await votSecHeaders(body, '/video-translation/translate');
    if (lively) headers['Authorization'] = 'OAuth ' + o.token;
    const res = await votPost('/video-translation/translate', body, headers);
    if (!res.ok) throw votHttpError('запрос перевода', res.status);
    const f = pbRead(new Uint8Array(await res.arrayBuffer()));
    const status = Number(f[4]) || 0;
    const message = votUtf8(f[9]);

    if (status === 1 || (status === 5 && f[1])) {
      const url = votUtf8(f[1]);
      if (!url) throw new Error('Яндекс не вернул ссылку на аудио');
      votNote('скачиваю переведённую дорожку…');
      // S3 Яндекса отдаёт файл обычным GET без подписи; через ретранслятор — по
      // его же пути audio-proxy, иначе скачивание упрётся в ту же блокировку
      const src = votProxyHost && url.startsWith(VOT_AUDIO_PREFIX)
        ? url.replace(VOT_AUDIO_PREFIX, 'https://' + votProxyHost + '/video-translation/audio-proxy/')
        : url;
      const a = await fetch(src);
      if (!a.ok) throw new Error('аудио перевода: HTTP ' + a.status);
      return new Uint8Array(await a.arrayBuffer());
    }
    if (status === 0) {
      if (lively && /обычная озвучка/i.test(message)) {
        lively = false;
        votNote('живой голос недоступен — пробую обычный');
        continue;
      }
      throw new Error('Яндекс не смог перевести видео' + (message ? ': ' + message : ''));
    }
    if (status === 6) {
      if (audioSent) throw new Error('Яндекс не получил аудио этого видео');
      audioSent = true;
      await votFakeAudio(o.url, votUtf8(f[7]));
      continue;
    }
    if (status === 7) {
      throw new Error(lively ? 'токен Яндекса недействителен или истёк'
                             : 'перевод этого видео требует авторизации Яндекса');
    }

    // 2 WAITING / 3 LONG_WAITING: ждём и повторяем тот же запрос
    const eta = Number(f[5]) || 0;
    votNote('Яндекс переводит…' + (eta > 0 ? ' осталось ~' + Math.max(1, Math.round(eta / 60)) + ' мин' : ''));
    const delayS = polls === 0 ? (eta > 0 ? Math.min(eta, 180) : 120) : 30;
    polls++;
    await votSleep(delayS * 1000);
  }
}

// ---- публичный API ----------------------------------------------------------
const votJobs = new Map(); // ключ перевода -> { p: Promise<Uint8Array>, failed }

// В ключ входят все параметры озвучки: сменив голос или язык, пользователь ждёт
// новую дорожку, а не ту, что уже лежит от прошлой загрузки этого же видео.
function votKey(o) {
  return [o.videoId, o.lang, o.srcLang || 'auto', o.lively ? 'lively' : 'plain'].join('|');
}

// идемпотентен: повторный запуск с теми же параметрами переиспользует задание.
// Упавшее задание остаётся в votJobs до следующего votStart: votAwait должен
// получить настоящую причину («Яндекс отклонил запрос (402)…»), а не
// «перевод не запускался» из-за того, что запись успели удалить.
function votStart(o) {
  // в поле адреса легко вставить https:// и путь — для URL нужен голый хост
  const proxy = (o.proxy || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (proxy !== votProxyHost) votSession = null; // сессия привязана к маршруту запроса
  votProxyHost = proxy;
  const key = votKey(o);
  let j = votJobs.get(key);
  if (!j || j.failed) {
    const job = { p: votRun(o), failed: false };
    job.p.catch((e) => {
      job.failed = true; // сорванное задание не переиспользуем при новом запуске
      votNote('ошибка: ' + String((e && e.message) || e));
    });
    votJobs.set(key, job);
    j = job;
  }
  return j.p;
}

// Каждому вызову — своя копия: ffmpeg.writeFile забирает буфер как transferable
// и обнуляет исходный, а задание переживает повторные попытки сборки файла.
function votAwait(o) {
  const j = votJobs.get(votKey(o));
  if (!j) return Promise.reject(new Error('перевод не запускался'));
  return j.p.then((bytes) => bytes.slice());
}
