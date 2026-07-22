'use strict';
// OpenAI 互換 Chat Completions クライアント。
// Node 標準の fetch のみを使用(依存ゼロ)。LM Studio / Ollama / llama.cpp / OpenAI 本家で共通に動く。

const { normalizeBaseUrl, formatNetworkError } = require('./netdiag');
const { getLanguage } = require('../shared/i18n');

function joinUrl(base, p) {
  // ベースURLを整えてから連結する。利用者が "192.168.1.10:1234" のように
  // スキームや /v1 を省略しても通るようにするため。
  const { url } = normalizeBaseUrl(base);
  return String(url).replace(/\/+$/, '') + p;
}

function headers(provider) {
  const h = { 'Content-Type': 'application/json' };
  if (provider.apiKey) h['Authorization'] = 'Bearer ' + provider.apiKey;
  return h;
}

async function listModels(provider, timeoutMs = 20000) {
  const url = joinUrl(provider.baseUrl, '/models');
  let res;
  try {
    res = await fetch(url, { headers: headers(provider), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // fetch は DNS 失敗・接続拒否・到達不能をすべて "fetch failed" にまとめる。
    // 原因と対処に翻訳してから投げ直す。
    throw new Error(formatNetworkError(e, url, getLanguage()));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const ja = getLanguage() !== 'en';
    let hint = '';
    if (res.status === 404) {
      hint = ja
        ? '\n・ベースURLが正しいか確認してください（OpenAI互換のエンドポイントは通常 /v1 で終わります）。'
        : '\n・Check the base URL (OpenAI-compatible endpoints usually end with /v1).';
    } else if (res.status === 401 || res.status === 403) {
      hint = ja ? '\n・APIキーを確認してください。' : '\n・Check the API key.';
    }
    throw new Error(
      (ja ? `モデル一覧の取得に失敗しました (HTTP ${res.status})` : `Failed to list models (HTTP ${res.status})`) +
        hint +
        (body ? `\n${body.slice(0, 200)}` : '')
    );
  }

  const json = await res.json().catch(() => null);
  const raw = json && (Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : null);
  if (!raw) {
    // 応答は返ったが OpenAI 互換の形をしていない。
    // 以前はここで空配列を返しており、「接続成功（0モデル）」と表示されて
    // 誤ったURLに繋がっていることに気づけなかった。
    const ja = getLanguage() !== 'en';
    throw new Error(
      ja
        ? `${url} は OpenAI 互換のモデル一覧を返しませんでした。ベースURLを確認してください。`
        : `${url} did not return an OpenAI-compatible model list. Check the base URL.`
    );
  }
  return raw.map((m) => m.id || m.name).filter(Boolean);
}

/**
 * 1 回の chat completion。ツール呼び出し対応。
 * @param {object} opts { provider, model, messages, tools, temperature, timeoutMs, signal }
 * @returns {Promise<{message: object, finishReason: string, usage: object}>}
 */
async function chat(opts) {
  const { provider, model, messages, tools, temperature, timeoutMs = 300000, signal } = opts;

  const body = {
    model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0.3,
    stream: false,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  // 呼び出し側の中断シグナルとタイムアウトを合成する
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let res;
  try {
    res = await fetch(joinUrl(provider.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: headers(provider),
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (e) {
    if (signal && signal.aborted) throw new Error('ABORTED');
    if (e && e.name === 'TimeoutError') {
      throw new Error(`LLM応答がタイムアウトしました (${timeoutMs / 1000}秒)`);
    }
    throw new Error(formatNetworkError(e, joinUrl(provider.baseUrl, '/chat/completions'), getLanguage()));
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLMがエラーを返しました (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  const json = await res.json();
  const choice = (json.choices && json.choices[0]) || {};
  const message = choice.message || { role: 'assistant', content: '' };

  // 一部のローカルモデルは tool_calls の id を省略する。後続の tool メッセージ紐付けのため補完する。
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((tc, i) => {
      if (!tc.id) tc.id = `call_${Date.now()}_${i}`;
      if (!tc.type) tc.type = 'function';
    });
  }

  return {
    message,
    finishReason: choice.finish_reason || 'stop',
    usage: json.usage || null,
  };
}

/**
 * 接続テスト。成功なら {ok:true, models:[...], url}
 * 正規化後のURLも返し、利用者が「何処へ繋ぎに行ったか」を確認できるようにする。
 */
async function testProvider(provider, timeoutMs = 20000) {
  const norm = normalizeBaseUrl(provider.baseUrl);
  try {
    const models = await listModels(provider, timeoutMs);
    return { ok: true, models, url: norm.url, normalized: norm.changed };
  } catch (e) {
    return { ok: false, error: e.message, url: norm.url, normalized: norm.changed };
  }
}

module.exports = { chat, listModels, testProvider, joinUrl };
