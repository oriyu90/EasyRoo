'use strict';
/* ネットワークの正規化と失敗理由の説明。
 *
 * 背景: 同一ネットワーク上(VPN含む)の別デバイスで動く LM Studio へ接続できない、
 * という不具合を調べたところ、原因は「接続できないこと」そのものより
 * 「なぜ接続できないのか分からないこと」だった。
 *
 * Node の fetch は DNS 失敗・接続拒否・到達不能・タイムアウトを
 * すべて `TypeError: fetch failed` にまとめてしまう。実際の理由は
 * `err.cause.code` にあるが、それを捨てていたため利用者には
 * 「接続に失敗しました: fetch failed」としか出ていなかった。
 *
 * ここでは cause を取り出して原因を分類し、次に何を確認すべきかを添える。
 */

/** プライベート/ローカルネットワーク宛かどうか */
function isLocalNetworkHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false; // ループバックは対象外
  if (h.endsWith('.local')) return true; // mDNS
  // IPv4 のプライベート範囲
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT(VPNでよく使われる)
    return false;
  }
  // IPv6 のユニークローカル / リンクローカル
  if (/^fd|^fc|^fe80/.test(h)) return true;
  // ドットを含まないホスト名は同一LAN上の名前とみなす
  return !h.includes('.');
}

/**
 * ベースURLを整える。
 *  - スキームが無ければ http:// を補う
 *  - 末尾のスラッシュを落とす
 *  - パスが空なら /v1 を補う(OpenAI 互換の実装はほぼ全て /v1 配下)
 * @returns {{url:string, changed:boolean, notes:string[]}}
 */
function normalizeBaseUrl(raw) {
  const notes = [];
  let s = String(raw || '').trim();
  if (!s) return { url: '', changed: false, notes };

  const original = s;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = 'http://' + s;
    notes.push('scheme-added');
  }

  let u;
  try {
    u = new URL(s);
  } catch (_) {
    // 直せない書式はそのまま返し、呼び出し側で扱わせる
    return { url: original, changed: false, notes: ['unparsable'] };
  }

  // URL.pathname に '' を代入すると仕様上 '/' へ戻されるため、
  // いったんローカル変数で整えてから一度だけ代入する。
  const cleanPath = u.pathname.replace(/\/+$/, '');
  if (cleanPath === '') {
    u.pathname = '/v1';
    notes.push('v1-added');
  } else {
    u.pathname = cleanPath;
  }
  u.search = '';
  u.hash = '';

  const url = u.toString().replace(/\/+$/, '');
  return { url, changed: url !== original, notes };
}

/** URL からホスト名を取り出す(失敗しても落ちない) */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

/**
 * fetch の失敗を、原因と対処に翻訳する。
 * @param {Error} err
 * @param {string} url 接続先
 * @param {'ja'|'en'} lang
 * @returns {{code:string, message:string, hints:string[]}}
 */
function describeNetworkError(err, url, lang = 'ja') {
  const ja = lang !== 'en';
  const host = hostOf(url);
  const local = isLocalNetworkHost(host);
  const cause = err && err.cause ? err.cause : null;
  const code = (cause && cause.code) || (err && err.name === 'TimeoutError' ? 'ETIMEDOUT' : '') || '';
  const hints = [];

  const localNetworkHint = ja
    ? 'macOS の「システム設定 → プライバシーとセキュリティ → ローカルネットワーク」で EasyRoo が許可されているか確認してください。'
    : 'Check System Settings → Privacy & Security → Local Network and make sure EasyRoo is allowed.';
  const serveHint = ja
    ? '接続先の LM Studio で「Serve on Local Network」が有効になっているか確認してください（既定では localhost のみで待ち受けます）。'
    : 'Make sure "Serve on Local Network" is enabled in the target LM Studio (by default it listens on localhost only).';
  const firewallHint = ja
    ? '接続先デバイスのファイアウォールがそのポートを通しているか確認してください。'
    : "Check that the target device's firewall allows that port.";
  const vpnHint = ja
    ? 'VPN 使用時は、そのアドレスが VPN 経由で到達可能か（スプリットトンネルの除外対象でないか）確認してください。'
    : 'On a VPN, confirm the address is reachable through it (not excluded by split tunnelling).';

  let message;
  switch (code) {
    case 'ECONNREFUSED':
      message = ja
        ? `接続を拒否されました（${host} はこのポートで待ち受けていません）`
        : `Connection refused (${host} is not listening on that port)`;
      hints.push(serveHint, firewallHint);
      break;

    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      message = ja
        ? `ホスト名「${host}」を解決できませんでした`
        : `Could not resolve the host name "${host}"`;
      hints.push(
        ja
          ? 'ホスト名の綴りを確認するか、IPアドレス（例: 192.168.1.10）で直接指定してください。'
          : 'Check the spelling, or use the IP address directly (e.g. 192.168.1.10).'
      );
      if (host.endsWith('.local')) hints.push(localNetworkHint);
      break;

    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      message = ja ? `${host} へ到達できません（経路がありません）` : `${host} is unreachable (no route)`;
      hints.push(vpnHint, firewallHint);
      break;

    case 'ETIMEDOUT':
      message = ja
        ? `${host} への接続がタイムアウトしました`
        : `Connection to ${host} timed out`;
      if (local) hints.push(localNetworkHint);
      hints.push(firewallHint, vpnHint);
      break;

    case 'ECONNRESET':
      message = ja ? '接続が切断されました' : 'The connection was reset';
      hints.push(firewallHint);
      break;

    case 'EACCES':
    case 'EPERM':
      message = ja ? '接続が拒否されました（権限）' : 'Connection denied (permission)';
      hints.push(localNetworkHint);
      break;

    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      message = ja ? 'TLS証明書を検証できませんでした' : 'Could not verify the TLS certificate';
      hints.push(
        ja
          ? '自己署名証明書の場合は http:// での接続を検討してください。'
          : 'For a self-signed certificate, consider connecting over http:// instead.'
      );
      break;

    default: {
      // 分類できない場合でも "fetch failed" をそのまま見出しにしない。
      // 利用者に何の情報も与えないため。
      const raw = (err && err.message) || '';
      const useless = /^fetch failed$/i.test(raw.trim()) || !raw.trim();
      message = useless
        ? ja
          ? `${host} へ接続できませんでした`
          : `Could not connect to ${host}`
        : raw;
      if (local) hints.push(localNetworkHint);
      hints.push(serveHint, firewallHint, vpnHint);
      break;
    }
  }

  // ローカルネットワーク宛は、macOS の権限が原因のことが多い。先頭で目立たせる。
  if (local && !hints.includes(localNetworkHint)) hints.unshift(localNetworkHint);

  return { code: code || 'UNKNOWN', message, hints, host, isLocalNetwork: local };
}

/** 原因と対処をまとめた 1 本の文字列にする */
function formatNetworkError(err, url, lang = 'ja') {
  const d = describeNetworkError(err, url, lang);
  const head = `${d.message}（${url}）`;
  if (!d.hints.length) return head;
  return head + '\n' + d.hints.map((h) => '・' + h).join('\n');
}

module.exports = {
  normalizeBaseUrl,
  describeNetworkError,
  formatNetworkError,
  isLocalNetworkHost,
  hostOf,
};
