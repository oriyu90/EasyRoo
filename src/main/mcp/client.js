'use strict';
// 最小構成の MCP クライアント。stdio と Streamable HTTP の 2 トランスポートに対応。
// 公式SDKに依存しないことで、Electron の asar 同梱やESM相互運用の不安定要素を排除している。

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'EasyRoo', version: '1.0.0' };

class McpError extends Error {}

/** JSON-RPC の共通処理(id採番・pending管理) */
class BaseTransportClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this._id = 0;
    this._pending = new Map();
    this.connected = false;
    this.serverInfo = null;
  }

  _nextId() {
    return ++this._id;
  }

  _resolveMessage(msg) {
    if (msg.id === undefined || msg.id === null) return; // 通知は無視
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new McpError(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }

  _failAll(err) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  async request(method, params, timeoutMs = 60000) {
    const id = this._nextId();
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new McpError(`MCPリクエストがタイムアウトしました: ${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
    });
    await this._send(payload, id);
    return promise;
  }

  async initialize() {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false } },
        clientInfo: CLIENT_INFO,
      },
      30000
    );
    this.serverInfo = result?.serverInfo || null;
    await this._notify('notifications/initialized');
    this.connected = true;
    return result;
  }

  async listTools() {
    const out = [];
    let cursor;
    // ページングに対応(多くのサーバは1ページだが仕様上は続く場合がある)
    for (let i = 0; i < 20; i++) {
      const res = await this.request('tools/list', cursor ? { cursor } : {}, 30000);
      out.push(...(res?.tools || []));
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name, args, timeoutMs = 120000) {
    return this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
  }
}

/* ------------------------- stdio ------------------------- */
class StdioClient extends BaseTransportClient {
  async connect() {
    const { command, args = [], env = {} } = this.config;
    if (!command) throw new McpError('コマンドが指定されていません');

    // GUIアプリから起動されると PATH が最小限になるため、一般的なパスを補う
    const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
    const childEnv = {
      ...process.env,
      ...env,
      PATH: `${process.env.PATH || ''}:${extraPath}`,
    };

    this.proc = spawn(command, args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => this.emit('stderr', d));

    this.proc.on('error', (e) => {
      this.connected = false;
      this._failAll(new McpError(`MCPサーバの起動に失敗しました: ${e.message}`));
      this.emit('closed', e);
    });
    this.proc.on('exit', (code) => {
      this.connected = false;
      this._failAll(new McpError(`MCPサーバが終了しました (code ${code})`));
      this.emit('closed', null);
    });

    await this.initialize();
  }

  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      try {
        this._resolveMessage(JSON.parse(line));
      } catch (_) {
        // JSON でない行(サーバのログ出力など)は捨てる
      }
    }
  }

  async _send(payload) {
    if (!this.proc || this.proc.killed) throw new McpError('MCPサーバに接続されていません');
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  async _notify(method, params) {
    await this._send({ jsonrpc: '2.0', method, params: params || {} });
  }

  async close() {
    this.connected = false;
    this._failAll(new McpError('切断されました'));
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      const p = this.proc;
      setTimeout(() => {
        try {
          if (!p.killed) p.kill('SIGKILL');
        } catch (_) {}
      }, 3000).unref?.();
    }
  }
}

/* ------------------- Streamable HTTP -------------------- */
class HttpClient extends BaseTransportClient {
  async connect() {
    if (!this.config.url) throw new McpError('URL が指定されていません');
    this.sessionId = null;
    await this.initialize();
  }

  async _send(payload, id) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...(this.config.headers || {}),
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;

    const res = await fetch(this.config.url, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new McpError(`MCP HTTP エラー (${res.status}): ${t.slice(0, 300)}`);
    }

    // 通知(id なし)は 202 Accepted で本文が無い
    if (id === undefined || res.status === 202) return;

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split('\n\n')) {
        const dataLines = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;
        try {
          this._resolveMessage(JSON.parse(dataLines.join('')));
        } catch (_) {}
      }
    } else {
      const json = await res.json().catch(() => null);
      if (json) this._resolveMessage(json);
    }
  }

  async _notify(method, params) {
    try {
      await this._send({ jsonrpc: '2.0', method, params: params || {} });
    } catch (_) {
      // initialized 通知の失敗は致命的ではない
    }
  }

  async close() {
    this.connected = false;
    this._failAll(new McpError('切断されました'));
    if (this.sessionId) {
      try {
        await fetch(this.config.url, {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': this.sessionId, ...(this.config.headers || {}) },
          signal: AbortSignal.timeout(5000),
        });
      } catch (_) {}
    }
  }
}

function createClient(config) {
  return config.transport === 'http' ? new HttpClient(config) : new StdioClient(config);
}

/** tools/call の結果を LLM に返す文字列へ整形する */
function flattenToolResult(result) {
  if (result == null) return '(結果なし)';
  if (typeof result === 'string') return result;
  const parts = [];
  for (const c of result.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') parts.push(`[画像: ${c.mimeType || 'image'}]`);
    else if (c.type === 'resource') parts.push(c.resource?.text || `[リソース: ${c.resource?.uri || ''}]`);
    else parts.push(JSON.stringify(c));
  }
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n') || '(空の結果)';
  return result.isError ? `エラー: ${text}` : text;
}

module.exports = { createClient, flattenToolResult, McpError };
