'use strict';
// 組み込みツール群。LLM がターミナル・ファイル・記憶を操作するための入口。
// すべて「中断可能」「タイムアウトあり」「出力量に上限あり」「所要時間を計測」を満たす。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const denyRules = require('./denyRules');
const memory = require('../memory');
const { t } = require('../../shared/i18n');

/* ------------------------ shell ------------------------ */

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n' + t('error.truncated', { n: s.length - max });
}

/**
 * シェルコマンドを実行する。
 * @param {string} command
 * @param {object} opts { cwd, timeoutMs, maxOutputChars, policy, signal, onOutput }
 */
function runShell(command, opts = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = 120000,
    maxOutputChars = 20000,
    policy = {},
    signal,
    onOutput,
  } = opts;

  const verdict = denyRules.evaluate(command, policy);
  if (verdict.denied) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      denied: true,
      rule: verdict.ruleId,
      category: verdict.categoryId,
      output:
        t('error.denied', { rule: verdict.why || verdict.ruleId }) + '\n' + t('error.deniedHint'),
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    // timer / onAbort は下で代入される。finish は起動失敗パスからも呼ばれるため、
    // 一時的デッドゾーンに入らないよう let で先に宣言しておく(const だと ReferenceError になる)。
    let timer = null;
    let onAbort = null;

    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve(r);
    };

    let proc;
    try {
      fs.mkdirSync(cwd, { recursive: true });
      // detached: true でプロセスグループを作り、中断時に子孫ごと確実に停止させる
      proc = spawn('/bin/zsh', ['-l', '-c', command], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        },
      });
    } catch (e) {
      return finish({ ok: false, exitCode: null, output: `起動に失敗しました: ${e.message}` });
    }

    let out = '';
    const append = (chunk) => {
      const s = String(chunk);
      if (out.length < maxOutputChars * 2) out += s;
      if (onOutput) onOutput(s);
    };
    proc.stdout.on('data', append);
    proc.stderr.on('data', append);

    const kill = (sig) => {
      try {
        process.kill(-proc.pid, sig);
      } catch (_) {
        try {
          proc.kill(sig);
        } catch (_) {}
      }
    };

    timer = setTimeout(() => {
      kill('SIGKILL');
      finish({
        ok: false,
        exitCode: null,
        output: truncate(out, maxOutputChars) + '\n\n' + t('error.timedOut', { n: timeoutMs / 1000 }),
        timedOut: true,
      });
    }, timeoutMs);

    onAbort = () => {
      kill('SIGKILL');
      finish({
        ok: false,
        exitCode: null,
        output: truncate(out, maxOutputChars) + '\n\n' + t('error.aborted'),
        aborted: true,
      });
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.on('error', (e) => finish({ ok: false, exitCode: null, output: `実行エラー: ${e.message}` }));
    proc.on('close', (code) => {
      finish({
        ok: code === 0,
        exitCode: code,
        output: truncate(out.trim() || '(出力なし)', maxOutputChars),
      });
    });
  });
}

/* --------------------- ツール定義 --------------------- */
// 説明文は実行時の表示言語に合わせる。モデルへ渡す指示も同じ言語に揃えたほうが
// 手順書・注意書きとの一貫性が保たれ、指示の取りこぼしが減る。

function shellTool() {
  return {
    type: 'function',
    function: {
      name: 'shell',
      description: t('tool.shell.desc'),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          purpose: { type: 'string', description: 'One line: why this command is being run' },
        },
        required: ['command'],
      },
    },
  };
}

function readFileTool() {
  return {
    type: 'function',
    function: {
      name: 'read_file',
      description: t('tool.readFile.desc'),
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  };
}

function writeFileTool() {
  return {
    type: 'function',
    function: {
      name: 'write_file',
      description: t('tool.writeFile.desc'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          append: { type: 'boolean' },
        },
        required: ['path', 'content'],
      },
    },
  };
}

function httpTool() {
  return {
    type: 'function',
    function: {
      name: 'http_request',
      description: t('tool.http.desc'),
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          headers: { type: 'object' },
          body: { type: 'string' },
        },
        required: ['url'],
      },
    },
  };
}

function finishTool() {
  return {
    type: 'function',
    function: {
      name: 'finish',
      description: t('tool.finish.desc'),
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          success: { type: 'boolean' },
        },
        required: ['summary', 'success'],
      },
    },
  };
}

function stateWriteTool() {
  return {
    type: 'function',
    function: {
      name: 'state_write',
      description: t('tool.stateWrite.desc'),
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The complete new STATE content (Markdown)' },
        },
        required: ['content'],
      },
    },
  };
}

function journalAppendTool() {
  return {
    type: 'function',
    function: {
      name: 'journal_append',
      description: t('tool.journalAppend.desc'),
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'string', description: 'What happened / what was learned in this run' },
        },
        required: ['entry'],
      },
    },
  };
}

function spawnSubrunTool() {
  return {
    type: 'function',
    function: {
      name: 'spawn_subrun',
      description: t('tool.spawnSubrun.desc'),
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'The self-contained sub-task to delegate. Include everything the child needs — it does NOT see your conversation.',
          },
        },
        required: ['task'],
      },
    },
  };
}

function resolvePath(p, cwd) {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/** 組み込みツールの実行ディスパッチ */
async function executeBuiltin(name, args, ctx) {
  const { cwd, shellCfg, policy, signal, onOutput, routineId, memoryEnabled } = ctx;
  switch (name) {
    case 'shell': {
      if (!shellCfg.enabled) return { output: t('error.shellDisabled'), ok: false };
      const r = await runShell(args.command, {
        cwd,
        timeoutMs: (shellCfg.timeoutSec || 120) * 1000,
        maxOutputChars: shellCfg.maxOutputChars || 20000,
        policy,
        signal,
        onOutput,
      });
      return {
        output: `終了コード: ${r.exitCode}\n---\n${r.output}`,
        ok: r.ok,
        denied: !!r.denied,
      };
    }
    case 'read_file': {
      const f = resolvePath(args.path, cwd);
      if (!fs.existsSync(f)) return { output: `ファイルが存在しません: ${f}`, ok: false };
      const st = fs.statSync(f);
      if (st.size > 2_000_000) {
        return { output: `ファイルが大きすぎます (${st.size} bytes)。shell の head/grep を使ってください。`, ok: false };
      }
      return { output: fs.readFileSync(f, 'utf8'), ok: true };
    }
    case 'write_file': {
      const f = resolvePath(args.path, cwd);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (args.append) fs.appendFileSync(f, args.content, 'utf8');
      else fs.writeFileSync(f, args.content, 'utf8');
      return { output: `書き込みました: ${f} (${Buffer.byteLength(args.content)} bytes)`, ok: true };
    }
    case 'http_request': {
      const res = await fetch(args.url, {
        method: args.method || 'GET',
        headers: args.headers || {},
        body: args.body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      });
      const text = await res.text();
      return { output: `HTTP ${res.status}\n---\n${truncate(text, 20000)}`, ok: res.ok };
    }
    case 'state_write': {
      if (!memoryEnabled) return { output: '記憶は無効です。', ok: false };
      const n = memory.writeState(routineId, args.content || '');
      return { output: `STATE を更新しました (${n} 文字)`, ok: true };
    }
    case 'journal_append': {
      if (!memoryEnabled) return { output: '記憶は無効です。', ok: false };
      const n = memory.appendJournal(routineId, args.entry || '');
      return { output: `記録に追記しました (計 ${n} 件)`, ok: true };
    }
    default:
      throw new Error('不明な組み込みツール: ' + name);
  }
}

/**
 * このルーティーンで使えるツール定義を返す。
 * @param {object} opts { shell: boolean, memory: boolean }
 */
function builtinToolDefs({ shell = true, memory: mem = false, subrun = false } = {}) {
  const defs = [];
  if (shell) defs.push(shellTool());
  defs.push(readFileTool(), writeFileTool(), httpTool());
  if (mem) defs.push(stateWriteTool(), journalAppendTool());
  // spawn_subrun は runner が直接処理する(executeBuiltin では扱わない)
  if (subrun) defs.push(spawnSubrunTool());
  defs.push(finishTool());
  return defs;
}

const BUILTIN_NAMES = new Set([
  'shell',
  'read_file',
  'write_file',
  'http_request',
  'state_write',
  'journal_append',
  'finish',
]);

module.exports = { runShell, executeBuiltin, builtinToolDefs, BUILTIN_NAMES };
