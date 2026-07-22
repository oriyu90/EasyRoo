'use strict';
// 破損に強い JSON ストア。書き込みは一時ファイル + rename のアトミック置換。
// 読み込み失敗時は .corrupt に退避して既定値へフォールバックし、アプリを絶対に落とさない。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths, ensureDirs } = require('./paths');
const denyRules = require('./tools/denyRules');

ensureDirs();

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return structuredClone(fallback);
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return structuredClone(fallback);
    return JSON.parse(raw);
  } catch (e) {
    try {
      fs.copyFileSync(file, file + '.corrupt.' + Date.now());
    } catch (_) {}
    return structuredClone(fallback);
  }
}

function writeJSON(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const DEFAULT_SETTINGS = {
  providers: [
    {
      id: 'lmstudio',
      name: 'LM Studio (ローカル)',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: '',
    },
  ],
  activeProviderId: 'lmstudio',
  // 実行の安全弁
  maxSteps: 30,
  stepTimeoutSec: 300,
  runTimeoutSec: 1800,
  requestTimeoutSec: 300,
  temperature: 0.3,
  // コンテキスト予算(モデル窓 − 出力余白 − プロンプト余白)。
  // プロバイダ側に contextTokens があればそちらが優先される。
  contextTokens: 32768,
  reserveOutputTokens: 4096,
  reservePromptTokens: 2048,
  // MCP サーバの接続完了を実行開始前に待つ上限(秒)
  mcpReadyTimeoutSec: 30,
  // ターミナルツールの既定ポリシー
  shell: {
    enabled: true,
    cwd: paths.workspace,
    // 有効にする禁止カテゴリ(規則の実体は tools/denyRules.js)
    denyCategories: denyRules.DEFAULT_CATEGORIES,
    // ネットワーク系コマンドを許可する宛先
    trustedDomains: denyRules.DEFAULT_TRUSTED_DOMAINS,
    // 利用者が足す禁止パターン(正規表現可)
    denyPatterns: [],
    // 例外的に通したいパターン(禁止規則より優先)
    allowPatterns: [],
    timeoutSec: 120,
    maxOutputChars: 20000,
  },
  api: { enabled: true, port: 8787 },
  // theme: 'system' = OSの外観設定に追随 / 'light' / 'dark'
  // language: 'system' = OSのロケールに追随 / 'ja' / 'en'
  ui: { theme: 'system', language: 'system' },
};

const DEFAULT_MCP = { servers: [] };

class Store {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...readJSON(paths.settings, DEFAULT_SETTINGS) };
    // ネストしたオブジェクトの欠損キーを補完(バージョン間の前方互換)
    this.settings.shell = { ...DEFAULT_SETTINGS.shell, ...(this.settings.shell || {}) };
    this.settings.api = { ...DEFAULT_SETTINGS.api, ...(this.settings.api || {}) };
    this.settings.ui = { ...DEFAULT_SETTINGS.ui, ...(this.settings.ui || {}) };
    this.routines = readJSON(paths.routines, []);
    if (!Array.isArray(this.routines)) this.routines = [];
    // 旧バージョンで作られたルーティーンに、新しい項目を補う
    for (const r of this.routines) {
      if (!r.memory) r.memory = { enabled: true };
      if (!r.tools) r.tools = { shell: true, mcpServerIds: [] };
      if (r.tools.subrun === undefined) r.tools.subrun = true;
      r.overlapPolicy = normalizeOverlap(r.overlapPolicy);
      r.deny = normalizeDeny(r.deny);
    }
    this.mcp = { ...DEFAULT_MCP, ...readJSON(paths.mcp, DEFAULT_MCP) };
    if (!Array.isArray(this.mcp.servers)) this.mcp.servers = [];
  }

  // ---- settings ----
  getSettings() {
    return structuredClone(this.settings);
  }
  /**
   * 設定を更新する。
   * shell / api / ui は「現在値 → パッチ」の順に浅くマージする。
   * 既定値へのフォールバックを挟むと、部分パッチ(例: {shell:{enabled:false}})のときに
   * ユーザーが設定した禁止コマンドや作業ディレクトリが既定値へ巻き戻ってしまうため。
   */
  saveSettings(patch = {}) {
    const cur = this.settings;
    const next = { ...cur, ...patch };
    for (const key of ['shell', 'api', 'ui']) {
      next[key] = { ...DEFAULT_SETTINGS[key], ...(cur[key] || {}), ...(patch[key] || {}) };
    }
    this.settings = next;
    writeJSON(paths.settings, this.settings);
    return this.getSettings();
  }
  activeProvider() {
    const s = this.settings;
    return s.providers.find((p) => p.id === s.activeProviderId) || s.providers[0] || null;
  }

  // ---- routines ----
  listRoutines() {
    return structuredClone(this.routines);
  }
  getRoutine(id) {
    const r = this.routines.find((x) => x.id === id);
    return r ? structuredClone(r) : null;
  }
  createRoutine(data = {}) {
    const now = new Date().toISOString();
    const r = {
      id: crypto.randomUUID(),
      name: data.name || '新しいルーティーン',
      goal: data.goal || '',
      procedure: data.procedure || '', // 手順書
      constraints: data.constraints || '', // 注意書き(必ず守らせる)
      enabled: data.enabled === true, // スタートボタンで有効化
      schedule: normalizeSchedule(data.schedule),
      tools: {
        shell: data.tools?.shell !== false,
        // 独立した部分作業を、隔離文脈のサブエージェントへ委任できるようにするか
        subrun: data.tools?.subrun !== false,
        mcpServerIds: Array.isArray(data.tools?.mcpServerIds) ? data.tools.mcpServerIds : [],
      },
      // 前回の実行が終わる前に次の発火が来たときの方針
      overlapPolicy: normalizeOverlap(data.overlapPolicy),
      // 実行をまたいで STATE.md / JOURNAL.md を引き継ぐか
      memory: { enabled: data.memory?.enabled !== false },
      // 禁止コマンドのルーティーン固有設定(inherit=true なら全体設定を引き継ぐ)
      deny: normalizeDeny(data.deny),
      providerId: data.providerId || null, // null = グローバル設定を使用
      model: data.model || null,
      maxSteps: data.maxSteps || null,
      cwd: data.cwd || null,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastStatus: null,
      nextRunAt: null,
    };
    this.routines.push(r);
    this._persistRoutines();
    return structuredClone(r);
  }
  updateRoutine(id, patch) {
    const i = this.routines.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const cur = this.routines[i];
    const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
    // スケジュールは現在値へ重ねてから正規化する。丸ごと置き換えると、
    // 「曜日だけ変更」のような部分更新で時刻が既定値に戻ってしまう。
    if (patch.schedule) next.schedule = normalizeSchedule({ ...cur.schedule, ...patch.schedule });
    if (patch.tools) next.tools = { ...cur.tools, ...patch.tools };
    if ('overlapPolicy' in patch) next.overlapPolicy = normalizeOverlap(patch.overlapPolicy);
    if (patch.memory) next.memory = { ...cur.memory, ...patch.memory };
    if (patch.deny) next.deny = normalizeDeny({ ...cur.deny, ...patch.deny });
    this.routines[i] = next;
    this._persistRoutines();
    return structuredClone(next);
  }
  deleteRoutine(id) {
    const before = this.routines.length;
    this.routines = this.routines.filter((x) => x.id !== id);
    this._persistRoutines();
    return this.routines.length < before;
  }
  _persistRoutines() {
    writeJSON(paths.routines, this.routines);
  }

  // ---- mcp ----
  listServers() {
    return structuredClone(this.mcp.servers);
  }
  upsertServer(data) {
    const servers = this.mcp.servers;
    const id = data.id || crypto.randomUUID();
    const base = {
      id,
      name: data.name || 'mcp-server',
      transport: data.transport === 'http' ? 'http' : 'stdio',
      command: data.command || '',
      args: Array.isArray(data.args) ? data.args : [],
      env: data.env && typeof data.env === 'object' ? data.env : {},
      url: data.url || '',
      headers: data.headers && typeof data.headers === 'object' ? data.headers : {},
      enabled: data.enabled !== false,
    };
    const i = servers.findIndex((s) => s.id === id);
    if (i >= 0) servers[i] = { ...servers[i], ...base };
    else servers.push(base);
    writeJSON(paths.mcp, this.mcp);
    return structuredClone(base);
  }
  deleteServer(id) {
    const before = this.mcp.servers.length;
    this.mcp.servers = this.mcp.servers.filter((s) => s.id !== id);
    writeJSON(paths.mcp, this.mcp);
    return this.mcp.servers.length < before;
  }
}

/**
 * "9:30" や "7:5" のような表記も受け入れて "09:30" / "07:05" に整える。
 * 以前は 2 桁固定で照合していたため、1 桁指定が黙って既定値 09:00 に
 * すり替わり、指定と違う時刻に実行されていた。
 */
function normalizeTime(t) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(t || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 実行が重なったときの方針。skip=見送る / queue=完了後に実行 / restart=止めてやり直す */
const OVERLAP_POLICIES = ['skip', 'queue', 'restart'];
function normalizeOverlap(v) {
  return OVERLAP_POLICIES.includes(v) ? v : 'skip';
}

/** ルーティーン固有の禁止設定を正規化する */
function normalizeDeny(d) {
  d = d || {};
  return {
    inherit: d.inherit !== false, // 既定は全体設定を引き継ぐ
    categories: Array.isArray(d.categories) ? d.categories : null,
    extraPatterns: Array.isArray(d.extraPatterns) ? d.extraPatterns : [],
    allowPatterns: Array.isArray(d.allowPatterns) ? d.allowPatterns : [],
    trustedDomains: Array.isArray(d.trustedDomains) ? d.trustedDomains : [],
  };
}

// スケジュール正規化: type=manual|interval|weekly|monthly
function normalizeSchedule(s) {
  s = s || {};
  const type = ['manual', 'interval', 'weekly', 'monthly'].includes(s.type) ? s.type : 'manual';
  return {
    type,
    time: normalizeTime(s.time) || '09:00',
    // 0=日曜 ... 6=土曜
    weekdays: Array.isArray(s.weekdays) ? s.weekdays.filter((n) => n >= 0 && n <= 6) : [1, 2, 3, 4, 5],
    // 1..31
    days: Array.isArray(s.days) ? s.days.filter((n) => n >= 1 && n <= 31) : [1],
    intervalMinutes: Math.max(1, Number(s.intervalMinutes) || 60),
  };
}

module.exports = { Store, readJSON, writeJSON, normalizeSchedule, normalizeTime, normalizeDeny, normalizeOverlap, OVERLAP_POLICIES, DEFAULT_SETTINGS };
