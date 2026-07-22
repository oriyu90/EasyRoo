'use strict';
/* ルーティーンの長期記憶。
 *
 * 課題: 実行が終わるとエージェントの文脈は完全に消える。毎回ゼロから始まるため、
 *       「前回どこまで進んだか」「この環境の癖」といった知見が蓄積されない。
 *
 * 方針: 2 つの永続ファイルを持たせ、実行開始時にプロンプトへ注入する。
 *
 *   STATE.md    … 「いま」の状態。エージェントが上書きして維持する。
 *                 追記ではなく置換にすることで、際限なく膨らむのを防ぐ。
 *   JOURNAL.md  … 実行ごとの追記ログ。直近ぶんだけを注入する。
 *                 「何をしたか」の履歴であり、STATE とは役割が異なる。
 *
 * どちらもプレーンな Markdown にしてある。利用者が Finder で開いて読める形式に
 * しておくと、AIが何を覚えているかを人が検証・修正できる。
 */

const fs = require('fs');
const path = require('path');
const { paths } = require('./paths');

// ファイルに保持する上限
const STATE_STORE_LIMIT = 32000;
const JOURNAL_KEEP_ENTRIES = 60;

// プロンプトへ注入する上限(コンテキストを圧迫しないため、保持量より小さくする)
const STATE_INJECT_LIMIT = 8000;
const JOURNAL_INJECT_ENTRIES = 5;
const JOURNAL_INJECT_LIMIT = 3000;

const ENTRY_SEP = '\n\n---\n\n';

function routineDir(routineId) {
  return path.join(paths.memory, String(routineId));
}

function statePath(routineId) {
  return path.join(routineDir(routineId), 'STATE.md');
}

function journalPath(routineId) {
  return path.join(routineDir(routineId), 'JOURNAL.md');
}

function ensure(routineId) {
  const d = routineDir(routineId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function truncate(s, limit, note) {
  const str = String(s ?? '');
  if (str.length <= limit) return str;
  return str.slice(0, limit) + `\n\n…(${note}: ${str.length - limit} 文字省略)`;
}

/* ------------------------- STATE ------------------------- */

function readState(routineId) {
  try {
    return fs.readFileSync(statePath(routineId), 'utf8');
  } catch (_) {
    return '';
  }
}

function writeState(routineId, content) {
  ensure(routineId);
  const body = truncate(content, STATE_STORE_LIMIT, 'STATEが長すぎるため');
  const tmp = statePath(routineId) + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, statePath(routineId));
  return body.length;
}

/* ------------------------- JOURNAL ------------------------- */

function readJournalEntries(routineId) {
  let raw = '';
  try {
    raw = fs.readFileSync(journalPath(routineId), 'utf8');
  } catch (_) {
    return [];
  }
  return raw.split(ENTRY_SEP).map((s) => s.trim()).filter(Boolean);
}

function appendJournal(routineId, entry, meta = {}) {
  ensure(routineId);
  const stamp = new Date().toISOString();
  const head = `## ${stamp}${meta.status ? ` — ${meta.status}` : ''}`;
  const block = `${head}\n${String(entry).trim()}`;

  const entries = readJournalEntries(routineId);
  entries.push(block);
  // 古いものから落として、ファイル自体が肥大しないようにする
  const kept = entries.slice(-JOURNAL_KEEP_ENTRIES);

  const tmp = journalPath(routineId) + '.tmp';
  fs.writeFileSync(tmp, kept.join(ENTRY_SEP) + '\n', 'utf8');
  fs.renameSync(tmp, journalPath(routineId));
  return kept.length;
}

/* ------------------------- 注入用の組み立て ------------------------- */

/**
 * システムプロンプトへ差し込む記憶ブロックを作る。
 * 記憶が空なら null を返す(空の見出しだけを送っても文脈の無駄になるため)。
 */
function buildContext(routineId, lang = 'ja') {
  const state = readState(routineId).trim();
  const entries = readJournalEntries(routineId).slice(-JOURNAL_INJECT_ENTRIES);
  if (!state && !entries.length) return null;

  const ja = lang !== 'en';
  const parts = [];

  parts.push(
    ja
      ? '## 引き継いだ記憶\n以下は前回までの実行から引き継いだ情報です。今回の作業の前提として扱ってください。'
      : '## Carried-over memory\nThe following was carried over from previous runs. Treat it as context for this run.'
  );

  if (state) {
    parts.push(
      (ja ? '### 現在の状態 (STATE)\n' : '### Current state (STATE)\n') +
        truncate(state, STATE_INJECT_LIMIT, ja ? 'STATEが長いため' : 'STATE truncated')
    );
  }

  if (entries.length) {
    const journal = truncate(
      entries.join('\n\n'),
      JOURNAL_INJECT_LIMIT,
      ja ? '記録が長いため' : 'journal truncated'
    );
    parts.push(
      (ja
        ? `### 直近の実行記録 (JOURNAL・新しい順に最大${JOURNAL_INJECT_ENTRIES}件)\n`
        : `### Recent runs (JOURNAL, up to ${JOURNAL_INJECT_ENTRIES})\n`) + journal
    );
  }

  parts.push(
    ja
      ? '状態が変わったら state_write で STATE を更新し、今回の要点は journal_append で記録してください。'
      : 'When the state changes, update STATE with state_write, and record the key points of this run with journal_append.'
  );

  return parts.join('\n\n');
}

/** 記憶の概要(GUI/CLI 表示用) */
function summary(routineId) {
  const state = readState(routineId);
  const entries = readJournalEntries(routineId);
  let updatedAt = null;
  try {
    updatedAt = fs.statSync(statePath(routineId)).mtime.toISOString();
  } catch (_) {}
  return {
    routineId,
    dir: routineDir(routineId),
    stateChars: state.length,
    stateUpdatedAt: updatedAt,
    journalEntries: entries.length,
    hasMemory: state.length > 0 || entries.length > 0,
  };
}

/** 記憶をすべて消す */
function clear(routineId) {
  try {
    fs.rmSync(routineDir(routineId), { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  routineDir,
  statePath,
  journalPath,
  readState,
  writeState,
  readJournalEntries,
  appendJournal,
  buildContext,
  summary,
  clear,
  STATE_INJECT_LIMIT,
  JOURNAL_INJECT_ENTRIES,
};
