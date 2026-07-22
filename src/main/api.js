'use strict';
// ローカル制御 API。127.0.0.1 のみ待ち受け、Bearer トークン必須。
// GUI と完全に同じ Engine メソッドを公開するため、AI はターミナルから全操作を行える。

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { paths } = require('./paths');

function loadOrCreateToken() {
  try {
    const rt = JSON.parse(fs.readFileSync(paths.runtime, 'utf8'));
    if (rt.token) return rt.token;
  } catch (_) {}
  return crypto.randomBytes(24).toString('hex');
}

function writeRuntime(info) {
  fs.writeFileSync(paths.runtime, JSON.stringify(info, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(paths.runtime, 0o600); // トークンを他ユーザーから守る
  } catch (_) {}
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body ?? null, null, 2));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5_000_000) {
        reject(new Error('リクエストが大きすぎます'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('JSON の解析に失敗しました: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

class ControlApi {
  constructor(engine) {
    this.engine = engine;
    this.token = loadOrCreateToken();
    this.server = null;
    this.port = null;
  }

  async start(preferredPort = 8787) {
    const routes = this._routes();

    this.server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');

        // /api/health のみ認証不要(起動確認用)
        const isHealth = url.pathname === '/api/health';
        if (!isHealth) {
          const auth = req.headers.authorization || '';
          const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token') || '';
          // タイミング攻撃を避けるため固定時間比較
          const a = Buffer.from(given.padEnd(64).slice(0, 64));
          const b = Buffer.from(this.token.padEnd(64).slice(0, 64));
          if (!crypto.timingSafeEqual(a, b)) return json(res, 401, { error: '認証に失敗しました' });
        }

        if (parts[0] !== 'api') return json(res, 404, { error: 'not found' });

        const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        const handler = matchRoute(routes, req.method, parts.slice(1));
        if (!handler) return json(res, 404, { error: `不明なエンドポイント: ${req.method} ${url.pathname}` });

        const result = await handler.fn({ params: handler.params, body, query: url.searchParams });
        json(res, 200, result === undefined ? { ok: true } : result);
      } catch (e) {
        // 「見つからない」は 404、それ以外の要求不備は 400 として区別する
        json(res, e && e.notFound ? 404 : 400, { error: e.message });
      }
    });

    // ポート衝突時は +1 して最大 20 回試す(他アプリと共存できるように)
    for (let i = 0; i < 20; i++) {
      const port = preferredPort + i;
      try {
        await new Promise((resolve, reject) => {
          const onErr = (e) => reject(e);
          this.server.once('error', onErr);
          this.server.listen(port, '127.0.0.1', () => {
            this.server.removeListener('error', onErr);
            resolve();
          });
        });
        this.port = port;
        break;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
      }
    }
    if (!this.port) throw new Error('制御APIのポートを確保できませんでした');

    writeRuntime({
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      baseUrl: `http://127.0.0.1:${this.port}`,
    });

    return this.port;
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
    try {
      fs.unlinkSync(paths.runtime);
    } catch (_) {}
  }

  _routes() {
    const e = this.engine;
    return [
      ['GET', ['health'], () => ({ ok: true, app: 'EasyRoo', version: e.overview().version })],
      ['GET', ['overview'], () => e.overview()],

      // ルーティーン
      ['GET', ['routines'], () => e.listRoutines()],
      ['POST', ['routines'], ({ body }) => e.createRoutine(body)],
      ['GET', ['routines', ':id'], ({ params }) => must(e.getRoutine(params.id), 'ルーティーン')],
      ['PATCH', ['routines', ':id'], ({ params, body }) => e.updateRoutine(params.id, body)],
      ['DELETE', ['routines', ':id'], ({ params }) => ({ deleted: e.deleteRoutine(params.id) })],
      ['POST', ['routines', ':id', 'run'], ({ params }) => e.startRun(params.id, 'api')],
      ['POST', ['routines', ':id', 'stop'], ({ params }) => ({ stopped: e.stopRoutine(params.id, 'API経由の停止') })],
      ['POST', ['routines', ':id', 'enable'], ({ params, body }) => e.setEnabled(params.id, body.enabled !== false)],
      ['POST', ['routines', ':id', 'disable'], ({ params }) => e.setEnabled(params.id, false)],

      // 実行
      ['GET', ['runs'], ({ query }) => e.listRuns(Number(query.get('limit')) || 50, query.get('routineId'))],
      ['GET', ['runs', ':id'], ({ params }) => must(e.getRunDetail(params.id), '実行ログ')],
      ['POST', ['runs', ':id', 'stop'], ({ params }) => ({ stopped: e.stopRun(params.id, 'API経由の停止') })],
      ['POST', ['stop-all'], () => ({ stopped: e.stopAll('API経由の全停止') })],
      ['POST', ['emergency-stop'], () => e.emergencyStop()],
      ['POST', ['scheduler', 'pause'], ({ body }) => ({ paused: e.pauseScheduler(body.paused !== false) })],
      ['POST', ['scheduler', 'resume'], () => ({ paused: e.pauseScheduler(false) })],

      // 実行の予約(重複時に queue 方針を選んだ場合)
      ['GET', ['queued'], () => e.listQueued()],
      ['DELETE', ['routines', ':id', 'queued'], ({ params }) => e.cancelQueued(params.id)],

      // 実測値
      ['GET', ['stats'], ({ query }) =>
        e.stats({
          routineId: query.get('routineId') || null,
          days: query.get('days') ? Number(query.get('days')) : null,
        }),
      ],

      // 記憶(STATE / JOURNAL)
      ['GET', ['routines', ':id', 'memory'], ({ params }) => e.memoryRead(params.id)],
      ['PUT', ['routines', ':id', 'memory', 'state'], ({ params, body }) =>
        e.memoryWriteState(params.id, body.content || ''),
      ],
      ['POST', ['routines', ':id', 'memory', 'journal'], ({ params, body }) =>
        e.memoryAppendJournal(params.id, body.entry || ''),
      ],
      ['DELETE', ['routines', ':id', 'memory'], ({ params }) => e.memoryClear(params.id)],

      // 禁止コマンド
      ['GET', ['deny', 'categories'], () => e.denyCategories()],
      ['POST', ['deny', 'check'], ({ body }) => e.denyCheck(body.command || '', body.routineId || null)],

      // 設定
      ['GET', ['settings'], () => e.getSettings()],
      ['PATCH', ['settings'], ({ body }) => e.saveSettings(body)],
      ['POST', ['settings', 'test-provider'], ({ body }) => e.testProvider(body.providerId || body.provider || body)],
      ['GET', ['models'], async () => {
        const r = await e.testProvider(e.getSettings().activeProviderId);
        if (!r.ok) throw new Error(r.error);
        return r.models;
      }],

      // MCP ハブ
      ['GET', ['mcp'], () => e.mcpStatus()],
      ['POST', ['mcp'], ({ body }) => e.mcpUpsert(body)],
      ['DELETE', ['mcp', ':id'], ({ params }) => e.mcpDelete(params.id)],
      ['POST', ['mcp', ':id', 'connect'], ({ params }) => e.mcpConnect(params.id)],
      ['POST', ['mcp', ':id', 'disconnect'], ({ params }) => e.mcpDisconnect(params.id)],
      ['POST', ['mcp', ':id', 'call'], ({ params, body }) =>
        e.mcpCallTool(params.id, body.tool, body.arguments || body.args || {}).then((output) => ({ output })),
      ],
    ].map(([method, path, fn]) => ({ method, path, fn }));
  }
}

function must(v, label) {
  if (!v) {
    const e = new Error(`${label}が見つかりません`);
    e.notFound = true;
    throw e;
  }
  return v;
}

function matchRoute(routes, method, parts) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.path.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.path.length; i++) {
      const seg = r.path[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { fn: r.fn, params };
  }
  return null;
}

module.exports = { ControlApi };
