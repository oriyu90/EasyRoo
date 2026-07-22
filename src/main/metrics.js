'use strict';
/* 実測値の集計。
 *
 * 個々の実行が runs/<id>.json に残す計測値(所要時間・ツール別の呼び出し回数と
 * 所要時間・トークン使用量・拒否回数)を読み、期間やルーティーンで束ねて返す。
 *
 * 集計は保存時ではなく参照時に行う。実行の記録は追記のみで完結させ、
 * 集計データとの二重管理による不整合を作らないため。
 */

const fs = require('fs');
const path = require('path');
const { paths } = require('./paths');

/** 空の集計器 */
function emptyAggregate() {
  return {
    runs: 0,
    success: 0,
    failed: 0,
    stopped: 0,
    totalDurationMs: 0,
    totalSteps: 0,
    deniedCommands: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    tools: {}, // name -> { calls, ok, failed, totalMs }
  };
}

function addToolStat(target, name, stat) {
  const t = (target[name] = target[name] || { calls: 0, ok: 0, failed: 0, totalMs: 0 });
  t.calls += stat.calls || 0;
  t.ok += stat.ok || 0;
  t.failed += stat.failed || 0;
  t.totalMs += stat.totalMs || 0;
}

/** 1 実行分の記録を集計器へ足し込む */
function accumulate(agg, run) {
  agg.runs++;
  if (run.status === 'success') agg.success++;
  else if (run.status === 'stopped') agg.stopped++;
  else agg.failed++;

  agg.totalDurationMs += run.durationMs || 0;
  agg.totalSteps += run.steps || 0;
  agg.deniedCommands += run.deniedCommands || 0;

  if (run.usage) {
    agg.tokens.prompt += run.usage.prompt || 0;
    agg.tokens.completion += run.usage.completion || 0;
    agg.tokens.total += run.usage.total || 0;
  }
  for (const [name, stat] of Object.entries(run.toolStats || {})) {
    addToolStat(agg.tools, name, stat);
  }
  return agg;
}

/** 集計器から表示用の値を作る */
function finalize(agg) {
  const tools = Object.entries(agg.tools)
    .map(([name, t]) => ({
      name,
      calls: t.calls,
      ok: t.ok,
      failed: t.failed,
      totalMs: t.totalMs,
      avgMs: t.calls ? Math.round(t.totalMs / t.calls) : 0,
    }))
    .sort((a, b) => b.calls - a.calls);

  return {
    runs: agg.runs,
    success: agg.success,
    failed: agg.failed,
    stopped: agg.stopped,
    successRate: agg.runs ? Math.round((agg.success / agg.runs) * 1000) / 10 : null,
    totalDurationMs: agg.totalDurationMs,
    avgDurationMs: agg.runs ? Math.round(agg.totalDurationMs / agg.runs) : 0,
    totalSteps: agg.totalSteps,
    avgSteps: agg.runs ? Math.round((agg.totalSteps / agg.runs) * 10) / 10 : 0,
    deniedCommands: agg.deniedCommands,
    tokens: agg.tokens,
    tools,
  };
}

/** 実行記録を読み込む(イベント本体は重いので落とす) */
function loadRuns({ routineId = null, sinceMs = null } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(paths.runs).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(paths.runs, f), 'utf8'));
      if (routineId && j.routineId !== routineId) continue;
      if (sinceMs && Date.parse(j.startedAt) < sinceMs) continue;
      const { events, ...rest } = j;
      out.push(rest);
    } catch (_) {
      // 壊れた記録 1 件で集計全体を止めない
    }
  }
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/**
 * 統計を返す。
 * @param {object} opts { routineId, days } days を指定すると直近N日に限定
 */
function stats({ routineId = null, days = null } = {}) {
  const sinceMs = days ? Date.now() - days * 86400000 : null;
  const runs = loadRuns({ routineId, sinceMs });

  const overall = finalize(runs.reduce(accumulate, emptyAggregate()));

  // ルーティーン別の内訳
  const byRoutine = new Map();
  for (const r of runs) {
    if (!byRoutine.has(r.routineId)) {
      byRoutine.set(r.routineId, { routineId: r.routineId, routineName: r.routineName, agg: emptyAggregate() });
    }
    const e = byRoutine.get(r.routineId);
    e.routineName = r.routineName || e.routineName;
    accumulate(e.agg, r);
  }

  return {
    period: { days: days || null, since: sinceMs ? new Date(sinceMs).toISOString() : null },
    overall,
    byRoutine: [...byRoutine.values()]
      .map((e) => ({ routineId: e.routineId, routineName: e.routineName, ...finalize(e.agg) }))
      .sort((a, b) => b.runs - a.runs),
    recent: runs.slice(0, 20).map((r) => ({
      id: r.id,
      routineId: r.routineId,
      routineName: r.routineName,
      status: r.status,
      startedAt: r.startedAt,
      durationMs: r.durationMs || 0,
      steps: r.steps || 0,
    })),
  };
}

/** 所要時間を人が読める形にする */
function formatDuration(ms, lang = 'ja') {
  if (!ms || ms < 0) return lang === 'en' ? '0s' : '0秒';
  const s = Math.round(ms / 1000);
  if (s < 60) return lang === 'en' ? `${s}s` : `${s}秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return lang === 'en' ? `${m}m ${rs}s` : `${m}分${rs}秒`;
  const h = Math.floor(m / 60);
  return lang === 'en' ? `${h}h ${m % 60}m` : `${h}時間${m % 60}分`;
}

module.exports = { stats, loadRuns, formatDuration, emptyAggregate, accumulate, finalize };
