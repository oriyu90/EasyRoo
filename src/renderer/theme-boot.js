'use strict';
// 最初の描画より前に、テーマと言語を確定させる。
// 設定は IPC 経由(非同期)で読むため、それを待つと一瞬だけ既定の見た目・言語が見えてしまう。
// 同期的に読める localStorage に控えを持たせ、ここで先に反映する。
// CSP は script-src 'self' のため、インラインではなく独立ファイルとして <head> で読み込む。
(function () {
  let theme = null;
  let lang = null;
  try {
    theme = localStorage.getItem('easyroo.theme');
    lang = localStorage.getItem('easyroo.language');
  } catch (e) {
    /* プライベートモード等で読めなくても既定にフォールバックすればよい */
  }

  const root = document.documentElement;
  root.dataset.theme = theme === 'light' || theme === 'dark' ? theme : 'system';

  // 'system' の場合はブラウザ(=OS)のロケールから決める
  let resolved = lang;
  if (resolved !== 'ja' && resolved !== 'en') {
    resolved = String(navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
  }
  root.lang = resolved;
  root.dataset.language = lang === 'ja' || lang === 'en' ? lang : 'system';
})();
