'use strict';
// MCPハブ: 複数のMCPサーバを一元管理し、ツールを名前空間付きで集約する。
// 1台が落ちても他に波及しないよう、接続・呼び出しは常に個別に隔離する。

const { EventEmitter } = require('events');
const { createClient, flattenToolResult } = require('./client');

// LLM に渡す関数名は [a-zA-Z0-9_-] のみが安全
function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

// 予期せず切れたときの再接続間隔(指数バックオフ)
const RECONNECT_DELAYS_MS = [1000, 3000, 10000, 30000, 60000];

class McpHub extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    /** @type {Map<string, {config, client, status, tools, error, prefix}>} */
    this.entries = new Map();
    /** @type {Map<string, {timer, attempt}>} 再接続の予約 */
    this.reconnects = new Map();
    this.stopped = false;
  }

  /**
   * 予期せぬ切断からの再接続を予約する。
   *
   * MCP サーバ(npx で起動する子プロセス等)は、メモリ不足や一時的な失敗で落ちうる。
   * 以前は落ちたら status が disconnected のまま復帰せず、以降の実行から
   * そのサーバのツールが恒久的に消えていた。無人で動き続けるアプリでは致命的なため、
   * バックオフ付きで自動復帰させる。
   */
  scheduleReconnect(id) {
    if (this.stopped) return;
    const cfg = this.store.listServers().find((x) => x.id === id);
    if (!cfg || !cfg.enabled) return; // 利用者が無効にしたものは追いかけない

    const prev = this.reconnects.get(id);
    const attempt = prev ? prev.attempt : 0;
    if (prev && prev.timer) clearTimeout(prev.timer);

    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    const timer = setTimeout(() => {
      this.reconnects.delete(id);
      const cur = this.entries.get(id);
      if (cur && cur.status === 'connected') return; // 既に戻っていれば何もしない
      this.emit('log', { serverId: id, name: cfg.name, text: `reconnecting (attempt ${attempt + 1})` });
      this.connect(id, { attempt: attempt + 1 }).catch(() => {});
    }, delay);
    if (timer.unref) timer.unref();
    this.reconnects.set(id, { timer, attempt: attempt + 1 });
  }

  cancelReconnect(id) {
    const r = this.reconnects.get(id);
    if (r && r.timer) clearTimeout(r.timer);
    this.reconnects.delete(id);
  }

  /**
   * 指定サーバ群が接続済みになるまで待つ。
   *
   * 起動直後は接続が非同期に進むため(実測で npx 経由は約6秒)、
   * その間にスケジュール実行が始まると MCP ツールが 0 個のまま走ってしまい、
   * エージェントは理由も分からず失敗する。実行開始前にここで待たせる。
   *
   * @returns {Promise<{ready:string[], notReady:string[]}>}
   */
  async waitForReady(serverIds, timeoutMs = 30000) {
    const ids = (serverIds || []).filter(Boolean);
    if (!ids.length) return { ready: [], notReady: [] };

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = ids.filter((id) => {
        const e = this.entries.get(id);
        // 未着手 or 接続中は待つ。error は待っても変わらないので待たない。
        return !e || e.status === 'connecting';
      });
      if (!pending.length) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const ready = ids.filter((id) => this.entries.get(id)?.status === 'connected');
    return { ready, notReady: ids.filter((id) => !ready.includes(id)) };
  }

  status() {
    return this.store.listServers().map((cfg) => {
      const e = this.entries.get(cfg.id);
      return {
        ...cfg,
        status: e ? e.status : 'disconnected',
        error: e ? e.error : null,
        toolCount: e && e.tools ? e.tools.length : 0,
        tools: e && e.tools ? e.tools.map((t) => ({ name: t.name, description: t.description })) : [],
        serverInfo: e?.client?.serverInfo || null,
      };
    });
  }

  _emitStatus() {
    this.emit('status', this.status());
  }

  async connect(id, opts = {}) {
    const cfg = this.store.listServers().find((s) => s.id === id);
    if (!cfg) throw new Error('MCPサーバ設定が見つかりません: ' + id);

    // 手動接続なら再接続の予約と回数を初期化する
    if (!opts.attempt) this.cancelReconnect(id);
    await this.disconnect(id, { keepReconnect: true });

    const prefix = sanitize(cfg.name) || 'mcp';
    const entry = { config: cfg, client: null, status: 'connecting', tools: [], error: null, prefix };
    this.entries.set(id, entry);
    this._emitStatus();

    try {
      const client = createClient(cfg);
      entry.client = client;
      client.on('closed', () => {
        const cur = this.entries.get(id);
        if (cur && cur.client === client) {
          cur.status = 'disconnected';
          cur.tools = [];
          this._emitStatus();
          // 予期せぬ切断。バックオフ付きで復帰を試みる。
          this.scheduleReconnect(id);
        }
      });
      client.on('stderr', (d) => this.emit('log', { serverId: id, name: cfg.name, text: String(d) }));

      await client.connect();
      entry.tools = await client.listTools();
      entry.status = 'connected';
      entry.error = null;
      this.cancelReconnect(id); // 復帰したのでバックオフを初期化
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message;
      try {
        await entry.client?.close();
      } catch (_) {}
      entry.client = null;
      // 起動に失敗した場合も、一時的な理由(ネットワーク・npx の取得待ち)がありうる
      this.scheduleReconnect(id);
    }
    this._emitStatus();
    return this.status().find((s) => s.id === id);
  }

  async disconnect(id, opts = {}) {
    if (!opts.keepReconnect) this.cancelReconnect(id);
    const e = this.entries.get(id);
    if (!e) return;
    try {
      await e.client?.close();
    } catch (_) {}
    this.entries.delete(id);
    this._emitStatus();
  }

  /** 有効な全サーバへ接続。1台の失敗が全体を止めないよう Promise.allSettled を使う。 */
  async connectAllEnabled() {
    const enabled = this.store.listServers().filter((s) => s.enabled);
    await Promise.allSettled(enabled.map((s) => this.connect(s.id)));
    return this.status();
  }

  async disconnectAll() {
    // 終了処理中に再接続が走らないようにする
    this.stopped = true;
    for (const id of [...this.reconnects.keys()]) this.cancelReconnect(id);
    await Promise.allSettled([...this.entries.keys()].map((id) => this.disconnect(id)));
  }

  /**
   * 指定サーバ群のツールを OpenAI function 形式で返す。
   * ツール名は `mcp__<サーバ名>__<ツール名>` に名前空間化して衝突を防ぐ。
   */
  getToolDefinitions(serverIds) {
    const defs = [];
    const seen = new Set();
    for (const [id, e] of this.entries) {
      if (serverIds && !serverIds.includes(id)) continue;
      if (e.status !== 'connected') continue;
      for (const t of e.tools) {
        let fname = `mcp__${e.prefix}__${sanitize(t.name)}`;
        if (seen.has(fname)) fname = `${fname}_${defs.length}`;
        seen.add(fname);
        defs.push({
          type: 'function',
          function: {
            name: fname,
            description: (t.description || t.name).slice(0, 1000),
            parameters: normalizeSchema(t.inputSchema),
          },
          _mcp: { serverId: id, toolName: t.name },
        });
      }
    }
    return defs;
  }

  async callTool(serverId, toolName, args, timeoutMs) {
    let e = this.entries.get(serverId);

    // 切れていたらその場で 1 度だけ繋ぎ直す。
    // 実行中にサーバが落ちた場合、次の予約再接続を待たずに復帰できる。
    if (!e || e.status !== 'connected' || !e.client) {
      await this.connect(serverId).catch(() => {});
      e = this.entries.get(serverId);
    }
    if (!e || e.status !== 'connected' || !e.client) {
      throw new Error(`MCPサーバ「${e?.config?.name || serverId}」に接続されていません`);
    }
    const raw = await e.client.callTool(toolName, args, timeoutMs);
    return flattenToolResult(raw);
  }
}

// 一部のMCPサーバは inputSchema を省略/簡略化する。OpenAI互換APIが受理できる形に正規化。
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const s = { ...schema };
  if (s.type !== 'object') return { type: 'object', properties: {} };
  if (!s.properties || typeof s.properties !== 'object') s.properties = {};
  if (s.required && !Array.isArray(s.required)) delete s.required;
  delete s.$schema;
  return s;
}

module.exports = { McpHub };
