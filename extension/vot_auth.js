// vot_auth.js — подхватывает OAuth-токен Яндекса на странице auth-сервера,
// как это делает оригинальный юзерскрипт: после логина Яндекс возвращает
// #access_token=…&expires_in=… , скрипт сохраняет токен и закрывает окно.
// Пароль вводится в окне самого Яндекса — расширение его не видит.
(() => {
  const p = new URLSearchParams(location.hash.slice(1));
  const token = p.get('access_token');
  const expiresIn = parseInt(p.get('expires_in'), 10);
  if (!token || !Number.isFinite(expiresIn)) return;

  chrome.storage.local.set({
    votAuth: { token, expires: Date.now() + expiresIn * 1000 },
  }, () => {
    try { chrome.runtime.sendMessage({ t: 'ytdl-vot-auth-done' }); } catch (e) {}
    document.title = 'Готово — можно закрыть окно';
    setTimeout(() => { try { window.close(); } catch (e) {} }, 800);
  });
})();
