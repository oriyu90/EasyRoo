#!/usr/bin/env node
'use strict';
// EasyRoo CLI — AI(またはユーザー)がターミナルから全機能を操作するための入口。
// アプリが書き出す runtime.json から接続先とトークンを自動で読む。設定作業は不要。

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME =
  process.env.EASYROO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'EasyRoo');
const RUNTIME = path.join(HOME, 'runtime.json');

function runtime() {
  try {
    const rt = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
    if (!rt.port || !rt.token) throw new Error('不完全');
    return rt;
  } catch (_) {
    die(
      'EasyRoo に接続できません。アプリが起動しているか確認してください。\n' +
        `(接続情報: ${RUNTIME})`
    );
  }
}

function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

async function api(method, p, body) {
  const rt = runtime();
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${rt.port}/api${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + rt.token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    die('EasyRoo への接続に失敗しました: ' + e.message);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = text;
  }
  if (!res.ok) die(`エラー (HTTP ${res.status}): ${data?.error || text}`);
  return data;
}

function out(v) {
  if (typeof v === 'string') console.log(v);
  else console.log(JSON.stringify(v, null, 2));
}

/** --key value / --flag 形式のオプションを解析 */
function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

function numList(v) {
  if (v === undefined) return undefined;
  return String(v)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
}

/** フラグからルーティーンの更新オブジェクトを組み立てる */
function routinePatch(flags) {
  const p = {};
  if (flags.name) p.name = flags.name;
  if (flags.goal) p.goal = flags.goal;
  if (flags.procedure) p.procedure = flags.procedure;
  if (flags['procedure-file']) p.procedure = fs.readFileSync(flags['procedure-file'], 'utf8');
  if (flags.constraints) p.constraints = flags.constraints;
  if (flags['constraints-file']) p.constraints = fs.readFileSync(flags['constraints-file'], 'utf8');
  if (flags.model) p.model = flags.model;
  if (flags.provider) p.providerId = flags.provider;
  if (flags.cwd) p.cwd = path.resolve(String(flags.cwd));
  if (flags['max-steps']) p.maxSteps = Number(flags['max-steps']);
  if (flags.shell !== undefined) p.tools = { ...(p.tools || {}), shell: flags.shell !== 'false' };
  if (flags.memory !== undefined) p.memory = { enabled: String(flags.memory) !== 'false' };
  if (flags.subrun !== undefined) p.tools = { ...(p.tools || {}), subrun: String(flags.subrun) !== 'false' };
  if (flags.overlap !== undefined) p.overlapPolicy = String(flags.overlap);
  if (flags['deny-categories'] !== undefined) {
    p.deny = { ...(p.deny || {}), inherit: false, categories: String(flags['deny-categories']).split(',').map((x) => x.trim()).filter(Boolean) };
  }
  if (flags['deny-add'] !== undefined) {
    p.deny = { ...(p.deny || {}), extraPatterns: String(flags['deny-add']).split(',').map((x) => x.trim()).filter(Boolean) };
  }
  if (flags['deny-allow'] !== undefined) {
    p.deny = { ...(p.deny || {}), allowPatterns: String(flags['deny-allow']).split(',').map((x) => x.trim()).filter(Boolean) };
  }
  if (flags['trust'] !== undefined) {
    p.deny = { ...(p.deny || {}), trustedDomains: String(flags.trust).split(',').map((x) => x.trim()).filter(Boolean) };
  }
  if (flags.mcp !== undefined) {
    p.tools = { ...(p.tools || {}), mcpServerIds: String(flags.mcp).split(',').map((s) => s.trim()).filter(Boolean) };
  }

  const type = flags.schedule;
  if (type) {
    const s = { type };
    if (flags.time) s.time = flags.time;
    if (flags.weekdays) s.weekdays = numList(flags.weekdays);
    if (flags.days) s.days = numList(flags.days);
    if (flags.every) s.intervalMinutes = Number(flags.every);
    p.schedule = s;
  }
  return p;
}

const HELP = `EasyRoo CLI — ルーティーンAIアプリをターミナルから操作する

使い方: easyroo <コマンド> [引数] [オプション]

■ 状態
  status                      アプリ全体の状態を表示
  health                      起動確認

■ ルーティーン
  list                        ルーティーン一覧
  show <id>                   詳細を表示
  create --name <名前> [オプション]
  update <id> [オプション]
  delete <id>
  start <id>                  スケジュールを有効化(スタートボタン相当)
  stop <id>                   スケジュールを無効化し、実行中なら停止
  run <id> [--wait]           今すぐ1回実行する
  kill <id>                   実行中のものだけ即時停止

■ 実行の予約
  queued                      完了後に実行される予約の一覧
  unqueue <id>                予約を取り消す

■ 実測値
  stats [--days N] [--routine <id>]   実行回数・成功率・所要時間・ツール別の内訳

■ 記憶（State / Journal）
  memory <id>                 引き継いでいる記憶を表示
  memory-set <id> --file <path>   STATE を差し替える
  memory-note <id> --text <文>    記録に追記する
  memory-clear <id>           記憶を消去する

■ 禁止コマンド
  deny-categories             禁止カテゴリの一覧
  deny-check '<コマンド>' [--routine <id>]   そのコマンドが通るか試す

■ 実行ログ
  runs [--limit N] [--routine <id>]
  log <runId>                 実行の詳細ログ
  stop-run <runId>
  stop-all                    実行中を全て停止
  emergency-stop              全停止 + スケジューラ停止
  resume                      スケジューラ再開

■ 設定
  settings                    現在の設定を表示
  set <JSONパッチ>            設定を更新 (例: easyroo set '{"maxSteps":40}')
  models                      利用可能なモデル一覧
  test-provider [id]          LLM接続テスト

■ MCPハブ
  mcp                         サーバ一覧と接続状態
  mcp-add --name <名> --command <cmd> [--args a,b] [--url <url>]
  mcp-remove <id>
  mcp-connect <id> / mcp-disconnect <id>
  mcp-call <id> --tool <名前> [--args '<JSON>']

■ ルーティーン作成オプション
  --name <名前>               表示名
  --goal <目的>               このルーティーンの目的
  --procedure <手順書>        手順書テキスト
  --procedure-file <path>     手順書をファイルから読む
  --constraints <注意書き>    絶対に守らせるルール
  --constraints-file <path>   注意書きをファイルから読む
  --schedule <種類>           manual | interval | weekly | monthly
  --time HH:MM                実行時刻 (weekly/monthly)
  --weekdays 1,3,5            曜日 (0=日 … 6=土)
  --days 1,15                 日 (1〜31)
  --every <分>                間隔 (interval)
  --shell true|false          ターミナル操作の許可
  --mcp <id,id>               使用するMCPサーバ
  --model <モデル名>          使用モデル
  --cwd <path>                作業ディレクトリ
  --max-steps <N>             最大ステップ数
  --memory true|false         実行をまたいで記憶を引き継ぐ
  --subrun true|false         サブラン（部分作業の切り出し）を許可
  --overlap <方針>            実行が重なったとき: skip | queue | restart
  --deny-categories <a,b>     このルーティーンの禁止カテゴリ（全体設定を上書き）
  --deny-add <正規表現,…>     禁止パターンを追加
  --deny-allow <正規表現,…>   例外的に許可するパターン
  --trust <ドメイン,…>        信頼するドメインを追加

例:
  easyroo create --name "朝のニュース要約" \\
    --goal "主要ニュースを集めて要約をデスクトップに保存する" \\
    --procedure-file ./procedure.md \\
    --constraints "ファイルの削除は絶対に行わない。書き込みは ~/Desktop 配下のみ。" \\
    --schedule weekly --weekdays 1,2,3,4,5 --time 07:30
  easyroo start <id>
  easyroo run <id> --wait
`;

async function waitForRun(runId) {
  process.stderr.write('実行中');
  for (let i = 0; i < 1200; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const run = await api('GET', `/runs/${runId}`);
    if (run.status !== 'running' && run.status !== 'pending') {
      process.stderr.write('\n');
      return run;
    }
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  return api('GET', `/runs/${runId}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || ['-h', '--help', 'help'].includes(argv[0])) return out(HELP);

  const cmd = argv[0];
  const { flags, rest } = parseFlags(argv.slice(1));
  const id = rest[0];

  switch (cmd) {
    case 'health':
      return out(await api('GET', '/health'));
    case 'status':
      return out(await api('GET', '/overview'));

    case 'list': {
      const rs = await api('GET', '/routines');
      if (flags.json) return out(rs);
      if (!rs.length) return out('ルーティーンはまだありません。easyroo create で作成してください。');
      return out(
        rs
          .map(
            (r) =>
              `${r.enabled ? '●' : '○'} ${r.name}\n   id: ${r.id}\n   ${r.scheduleText}` +
              `${r.nextRunAt ? ` / 次回 ${new Date(r.nextRunAt).toLocaleString('ja-JP')}` : ''}` +
              `${r.isRunning ? ' / 実行中' : ''}${r.lastStatus ? ` / 前回: ${r.lastStatus}` : ''}`
          )
          .join('\n\n')
      );
    }
    case 'show':
      if (!id) die('id を指定してください');
      return out(await api('GET', `/routines/${id}`));

    case 'create': {
      const patch = routinePatch(flags);
      if (!patch.name) die('--name は必須です');
      return out(await api('POST', '/routines', patch));
    }
    case 'update':
      if (!id) die('id を指定してください');
      return out(await api('PATCH', `/routines/${id}`, routinePatch(flags)));
    case 'delete':
      if (!id) die('id を指定してください');
      return out(await api('DELETE', `/routines/${id}`));

    case 'start':
      if (!id) die('id を指定してください');
      return out(await api('POST', `/routines/${id}/enable`, { enabled: true }));
    case 'stop':
      if (!id) die('id を指定してください');
      return out(await api('POST', `/routines/${id}/disable`, {}));
    case 'kill':
      if (!id) die('id を指定してください');
      return out(await api('POST', `/routines/${id}/stop`, {}));

    case 'run': {
      if (!id) die('id を指定してください');
      const started = await api('POST', `/routines/${id}/run`, {});
      if (started.action && started.action !== 'started' && started.action !== 'restarted') {
        // skip / queue 方針により、今回は実行されなかった
        return out(started);
      }
      if (!flags.wait) return out(started);
      const done = await waitForRun(started.runId);
      out(done);
      if (done.status !== 'success') process.exit(2);
      return;
    }

    case 'runs': {
      const q = new URLSearchParams();
      if (flags.limit) q.set('limit', flags.limit);
      if (flags.routine) q.set('routineId', flags.routine);
      return out(await api('GET', `/runs?${q}`));
    }
    case 'log': {
      if (!id) die('runId を指定してください');
      const run = await api('GET', `/runs/${id}`);
      if (flags.json) return out(run);
      const head = `${run.routineName} — ${run.status}\n開始: ${run.startedAt}\n要約: ${run.summary || '(なし)'}\n${'─'.repeat(50)}`;
      const body = (run.events || [])
        .map((ev) => {
          const t = new Date(ev.t).toLocaleTimeString('ja-JP');
          if (ev.type === 'assistant') return `[${t}] AI: ${ev.text}`;
          if (ev.type === 'tool_call') return `[${t}] → ${ev.name}(${JSON.stringify(ev.args).slice(0, 300)})`;
          if (ev.type === 'tool_result') return `[${t}] ← ${String(ev.output).slice(0, 600)}`;
          if (ev.type === 'step') return `\n[${t}] --- ステップ ${ev.step}/${ev.of} ---`;
          if (ev.type === 'error') return `[${t}] エラー: ${ev.message}`;
          if (ev.type === 'info') return `[${t}] ${ev.message}`;
          return null;
        })
        .filter(Boolean)
        .join('\n');
      return out(head + '\n' + body);
    }
    case 'stop-run':
      if (!id) die('runId を指定してください');
      return out(await api('POST', `/runs/${id}/stop`, {}));
    case 'stop-all':
      return out(await api('POST', '/stop-all', {}));
    case 'emergency-stop':
      return out(await api('POST', '/emergency-stop', {}));
    case 'resume':
      return out(await api('POST', '/scheduler/resume', {}));

    case 'queued': {
      const q = await api('GET', '/queued');
      if (flags.json) return out(q);
      if (!q.length) return out('予約はありません。');
      return out(q.map((x) => `${x.routineName}\n   id: ${x.routineId}\n   予約 ${new Date(x.queuedAt).toLocaleString('ja-JP')} (${x.trigger})`).join('\n\n'));
    }
    case 'unqueue':
      if (!id) die('id を指定してください');
      return out(await api('DELETE', `/routines/${id}/queued`, {}));

    case 'stats': {
      const q = new URLSearchParams();
      if (flags.days) q.set('days', flags.days);
      if (flags.routine) q.set('routineId', flags.routine);
      const st = await api('GET', `/stats?${q}`);
      if (flags.json) return out(st);
      const o = st.overall;
      if (!o.runs) return out('まだ実測値がありません。');
      const dur = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}秒` : `${Math.floor(ms / 60000)}分${Math.round((ms % 60000) / 1000)}秒`);
      const lines = [
        `実行回数   ${o.runs}（成功 ${o.success} / 失敗 ${o.failed} / 停止 ${o.stopped}）`,
        `成功率     ${o.successRate}%`,
        `平均所要   ${dur(o.avgDurationMs)}   合計 ${dur(o.totalDurationMs)}`,
        `平均ステップ ${o.avgSteps}`,
        `トークン   入力 ${o.tokens.prompt} / 出力 ${o.tokens.completion} / 合計 ${o.tokens.total}`,
        `拒否コマンド ${o.deniedCommands}`,
        '',
        'ツール利用:',
        ...o.tools.map((tl) => `  ${tl.name.padEnd(24)} ${String(tl.calls).padStart(4)}回  失敗 ${String(tl.failed).padStart(3)}  平均 ${tl.avgMs}ms`),
      ];
      if (st.byRoutine.length > 1) {
        lines.push('', 'ルーティーン別:');
        for (const r of st.byRoutine) {
          lines.push(`  ${(r.routineName || r.routineId).padEnd(24)} ${String(r.runs).padStart(3)}回  成功率 ${r.successRate}%  平均 ${dur(r.avgDurationMs)}`);
        }
      }
      return out(lines.join('\n'));
    }

    case 'memory': {
      if (!id) die('id を指定してください');
      const m = await api('GET', `/routines/${id}/memory`);
      if (flags.json) return out(m);
      const lines = [
        `STATE: ${m.stateChars} 文字${m.stateUpdatedAt ? ` (更新 ${new Date(m.stateUpdatedAt).toLocaleString('ja-JP')})` : ''}`,
        `JOURNAL: ${m.journalEntries} 件`,
        `保存先: ${m.dir}`,
        '─'.repeat(50),
        m.state || '(STATE は空です)',
      ];
      if (m.journal.length) {
        lines.push('─'.repeat(50), '直近の記録:', ...m.journal.slice(-5));
      }
      return out(lines.join('\n'));
    }
    case 'memory-set': {
      if (!id) die('id を指定してください');
      const content = flags.file ? fs.readFileSync(flags.file, 'utf8') : flags.text;
      if (!content) die('--file か --text を指定してください');
      return out(await api('PUT', `/routines/${id}/memory/state`, { content }));
    }
    case 'memory-note': {
      if (!id) die('id を指定してください');
      const entry = flags.file ? fs.readFileSync(flags.file, 'utf8') : flags.text;
      if (!entry) die('--text か --file を指定してください');
      return out(await api('POST', `/routines/${id}/memory/journal`, { entry }));
    }
    case 'memory-clear':
      if (!id) die('id を指定してください');
      return out(await api('DELETE', `/routines/${id}/memory`, {}));

    case 'deny-categories': {
      const cats = await api('GET', '/deny/categories');
      if (flags.json) return out(cats);
      return out(
        cats
          .map((c) => `${c.id}\n   ${c.label} [${c.severity}${c.conditional ? ' / 条件付き' : ''}]\n   ${c.description}\n   規則 ${c.ruleCount}件: ${c.examples.join(', ')}`)
          .join('\n\n')
      );
    }
    case 'deny-check': {
      if (!id) die("コマンドを指定してください 例: easyroo deny-check 'rm -rf /'");
      const r = await api('POST', '/deny/check', { command: id, routineId: flags.routine || null });
      if (flags.json) return out(r);
      return out(r.denied ? `拒否されます: ${r.categoryId}/${r.ruleId} — ${r.why}` : '許可されます');
    }

    case 'settings':
      return out(await api('GET', '/settings'));
    case 'set': {
      if (!id) die("JSONパッチを指定してください 例: easyroo set '{\"maxSteps\":40}'");
      return out(await api('PATCH', '/settings', JSON.parse(id)));
    }
    case 'models':
      return out(await api('GET', '/models'));
    case 'test-provider':
      return out(await api('POST', '/settings/test-provider', { providerId: id }));

    case 'mcp':
      return out(await api('GET', '/mcp'));
    case 'mcp-add': {
      const cfg = {
        name: flags.name,
        transport: flags.url ? 'http' : 'stdio',
        command: flags.command || '',
        args: flags.args ? String(flags.args).split(',') : [],
        url: flags.url || '',
        enabled: flags.enabled !== 'false',
      };
      if (flags.env) cfg.env = JSON.parse(flags.env);
      if (!cfg.name) die('--name は必須です');
      if (!cfg.command && !cfg.url) die('--command か --url のどちらかが必要です');
      return out(await api('POST', '/mcp', cfg));
    }
    case 'mcp-remove':
      if (!id) die('id を指定してください');
      return out(await api('DELETE', `/mcp/${id}`));
    case 'mcp-connect':
      if (!id) die('id を指定してください');
      return out(await api('POST', `/mcp/${id}/connect`, {}));
    case 'mcp-disconnect':
      if (!id) die('id を指定してください');
      return out(await api('POST', `/mcp/${id}/disconnect`, {}));
    case 'mcp-call': {
      if (!id) die('サーバ id を指定してください');
      if (!flags.tool) die('--tool を指定してください');
      const args = flags.args ? JSON.parse(flags.args) : {};
      const r = await api('POST', `/mcp/${id}/call`, { tool: flags.tool, arguments: args });
      return out(r.output);
    }

    default:
      die(`不明なコマンド: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => die('予期しないエラー: ' + e.message));
