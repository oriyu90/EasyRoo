'use strict';
// アプリの中核。GUI(IPC)とターミナル(HTTP API/CLI)は、どちらもこの Engine の同じメソッドを呼ぶ。
// これにより「GUI でできることは全て AI がターミナルからできる」を構造的に保証する。

const { EventEmitter } = require('events');
const { Store } = require('./store');
const { McpHub } = require('./mcp/hub');
const { Scheduler, computeNextRun, describeSchedule } = require('./scheduler');
const { Run, listRuns, getRun } = require('./runner');
const llm = require('./llm');
const memory = require('./memory');
const metrics = require('./metrics');
const denyRules = require('./tools/denyRules');
const i18n = require('../shared/i18n');

const MAX_CONCURRENT_RUNS = 3;

class Engine extends EventEmitter {
  constructor() {
    super();
    this.store = new Store();
    this.hub = new McpHub(this.store);
    /** @type {Map<string, Run>} 実行中の Run */
    this.activeRuns = new Map();
    /** @type {Map<string, {trigger:string, queuedAt:string}>} 完了後に実行する予約(ルーティーンあたり1件) */
    this.queued = new Map();
    this.schedulerPaused = false;

    this.scheduler = new Scheduler(this.store, (routine) => {
      this.startRun(routine.id, 'schedule').catch((e) =>
        this.emit('notice', { level: 'error', message: `${routine.name}: ${e.message}` })
      );
    });

    this.hub.on('status', (s) => this.emit('mcp-status', s));
    this.hub.on('log', (l) => this.emit('mcp-log', l));

    this.applyLanguage();
  }

  /** 設定とOSロケールから表示言語を決めて反映する */
  applyLanguage(systemLocale) {
    const pref = this.store.getSettings().ui?.language || 'system';
    const locale = systemLocale || this.systemLocale || process.env.LANG || 'ja';
    this.systemLocale = locale;
    return i18n.setLanguage(i18n.resolve(pref, locale));
  }

  language() {
    return i18n.getLanguage();
  }

  async init() {
    this.scheduler.start();
    // MCP 接続は非同期で進める(接続待ちで GUI をブロックしない)
    this.hub.connectAllEnabled().catch(() => {});
  }

  async shutdown() {
    this.scheduler.stop();
    for (const run of this.activeRuns.values()) run.stop('アプリ終了');
    await this.hub.disconnectAll().catch(() => {});
  }

  /* ---------------- ルーティーン ---------------- */

  listRoutines() {
    return this.store.listRoutines().map((r) => ({
      ...r,
      scheduleText: describeSchedule(r.schedule),
      isRunning: [...this.activeRuns.values()].some((run) => run.routine.id === r.id),
    }));
  }

  getRoutine(id) {
    const r = this.store.getRoutine(id);
    if (!r) return null;
    return { ...r, scheduleText: describeSchedule(r.schedule) };
  }

  createRoutine(data) {
    const r = this.store.createRoutine(data);
    this.scheduler.refreshRoutine(r.id);
    this.emit('routines-changed');
    return this.getRoutine(r.id);
  }

  updateRoutine(id, patch) {
    const r = this.store.updateRoutine(id, patch);
    if (!r) throw new Error(i18n.t('run.notFound', { id }));
    // スケジュールや有効/無効が変わったら次回実行時刻を再計算
    if ('schedule' in patch || 'enabled' in patch) this.scheduler.refreshRoutine(id);
    this.emit('routines-changed');
    return this.getRoutine(id);
  }

  deleteRoutine(id) {
    this.queued.delete(id);
    this.stopRoutine(id, i18n.t('common.delete'));
    const ok = this.store.deleteRoutine(id);
    // 記憶も一緒に片付ける(残しても参照されず、容量だけ消費するため)
    try {
      memory.clear(id);
    } catch (_) {}
    this.emit('routines-changed');
    return ok;
  }

  /** スタートボタン: 有効化してスケジュール開始 */
  setEnabled(id, enabled) {
    const r = this.updateRoutine(id, { enabled: !!enabled });
    if (!enabled) this.stopRoutine(id, 'ルーティーンを停止しました');
    return r;
  }

  /* ---------------- 実行制御 ---------------- */

  /**
   * ルーティーンを実行する。
   *
   * 前回の実行が終わる前に次の発火が来た場合の振る舞いは、ルーティーンごとの
   * overlapPolicy で決める(OpenClaw のキューモードを、外部入力の無い
   * EasyRoo 向けに 3 方針へ絞ったもの。設計レポート §4-A 参照)。
   *
   *   skip    … 今回は見送る(既定)。冪等でない処理向け
   *   queue   … 現在の実行の完了後に 1 回だけ実行する
   *   restart … 実行中のものを停止して新しく始める
   *
   * 以前は例外を投げて捨てていたため、毎時実行が 70 分かかると次回が
   * 黙って失われ、しかも利用者が気づけなかった。
   *
   * @returns {{action:'started'|'skipped'|'queued'|'restarted', ...}}
   */
  async startRun(routineId, trigger = 'manual', opts = {}) {
    const routine = this.store.getRoutine(routineId);
    if (!routine) throw new Error(i18n.t('run.notFound', { id: routineId }));

    const active = [...this.activeRuns.values()].find((r) => r.routine.id === routineId);
    if (active) {
      const policy = opts.overlapPolicy || routine.overlapPolicy || 'skip';

      if (policy === 'skip') {
        this.emit('notice', { level: 'warn', message: i18n.t('run.overlapSkipped', { name: routine.name }) });
        return { action: 'skipped', routineId, routineName: routine.name, trigger, runningRunId: active.id };
      }

      if (policy === 'queue') {
        // 積み上げない。溜めると遅延の原因が解消した後に一斉に走り出す。
        if (this.queued.has(routineId)) {
          return { action: 'already-queued', routineId, routineName: routine.name, trigger };
        }
        this.queued.set(routineId, { trigger, queuedAt: new Date().toISOString() });
        this.emit('notice', { level: 'info', message: i18n.t('run.overlapQueued', { name: routine.name }) });
        this.emit('runs-changed');
        return { action: 'queued', routineId, routineName: routine.name, trigger };
      }

      // restart: 実行中のものを止めてから始める
      active.stop(i18n.t('run.overlapRestarted', { name: routine.name }));
      await this._waitForRunToClear(active.id, 10000);
      this.emit('notice', { level: 'warn', message: i18n.t('run.overlapRestarted', { name: routine.name }) });
    }

    if (this.activeRuns.size >= MAX_CONCURRENT_RUNS) {
      throw new Error(i18n.t('run.tooMany', { n: MAX_CONCURRENT_RUNS }));
    }

    const run = new Run(routine, { store: this.store, hub: this.hub, trigger });
    this.activeRuns.set(run.id, run);

    run.on('event', (ev) => this.emit('run-event', { runId: run.id, routineId, ...ev }));
    run.on('output', (o) => this.emit('run-output', { runId: run.id, routineId, ...o }));

    this.emit('runs-changed');
    this.store.updateRoutine(routineId, { lastRunAt: new Date().toISOString(), lastStatus: 'running' });
    this.emit('routines-changed');

    // 実行は待たずに走らせ、呼び出し側には run 情報を即返す
    run
      .execute()
      .catch((e) => {
        run.status = 'failed';
        run.summary = e.message;
      })
      .finally(() => {
        this.activeRuns.delete(run.id);
        this.store.updateRoutine(routineId, { lastStatus: run.status });
        this.emit('runs-changed');
        this.emit('routines-changed');
        const statusWord =
          run.status === 'success'
            ? i18n.t('run.done')
            : run.status === 'stopped'
              ? i18n.t('run.stop')
              : i18n.t('run.fail');
        this.emit('notice', {
          level: run.status === 'success' ? 'info' : 'error',
          message: i18n.t('run.finishedNotice', {
            name: routine.name,
            status: statusWord,
            summary: run.summary,
          }),
        });
        this._drainQueued(routineId);
      });

    return {
      action: active ? 'restarted' : 'started',
      runId: run.id,
      routineId,
      routineName: routine.name,
      trigger,
      status: 'running',
    };
  }

  /** run が activeRuns から外れるまで待つ(restart で使う) */
  async _waitForRunToClear(runId, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (this.activeRuns.has(runId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return !this.activeRuns.has(runId);
  }

  /** 予約済みの実行があれば開始する */
  _drainQueued(routineId) {
    const q = this.queued.get(routineId);
    if (!q) return;
    this.queued.delete(routineId);
    // 同じ finally の中から再入しないよう、次のタイミングへ逃がす
    setTimeout(() => {
      this.startRun(routineId, q.trigger).catch((e) =>
        this.emit('notice', { level: 'error', message: e.message })
      );
    }, 200);
  }

  /** 予約中の一覧 */
  listQueued() {
    return [...this.queued.entries()].map(([routineId, q]) => ({
      routineId,
      routineName: this.store.getRoutine(routineId)?.name || routineId,
      ...q,
    }));
  }

  /** 予約を取り消す */
  cancelQueued(routineId) {
    const had = this.queued.delete(routineId);
    if (had) this.emit('runs-changed');
    return { cancelled: had };
  }

  /** 実行中の run を即時停止 */
  stopRun(runId, reason = 'ユーザーによる停止') {
    const run = this.activeRuns.get(runId);
    if (!run) return false;
    return run.stop(reason);
  }

  /** 指定ルーティーンの実行中のものを全て停止 */
  stopRoutine(routineId, reason = 'ユーザーによる停止') {
    let n = 0;
    for (const run of this.activeRuns.values()) {
      if (run.routine.id === routineId && run.stop(reason)) n++;
    }
    return n;
  }

  /** 非常停止: 全実行を止め、スケジューラも一時停止する */
  stopAll(reason = '全停止') {
    let n = 0;
    for (const run of this.activeRuns.values()) if (run.stop(reason)) n++;
    return n;
  }

  emergencyStop() {
    // 予約も破棄する。止めたのに後から動き出すのは意図に反する。
    this.queued.clear();
    const n = this.stopAll('緊急停止');
    this.pauseScheduler(true);
    return { stopped: n, schedulerPaused: true };
  }

  pauseScheduler(paused) {
    this.schedulerPaused = !!paused;
    if (paused) this.scheduler.stop();
    else this.scheduler.start();
    this.emit('routines-changed');
    return this.schedulerPaused;
  }

  listActiveRuns() {
    return [...this.activeRuns.values()].map((r) => r.toJSON());
  }

  getActiveRun(runId) {
    const r = this.activeRuns.get(runId);
    return r ? r.toJSON(true) : null;
  }

  listRuns(limit, routineId) {
    // 実行中のものを先頭に、履歴を後ろに
    const active = this.listActiveRuns();
    const past = listRuns(limit || 50, routineId || null).filter(
      (p) => !active.some((a) => a.id === p.id)
    );
    return [...active, ...past].filter((r) => !routineId || r.routineId === routineId);
  }

  getRunDetail(runId) {
    return this.getActiveRun(runId) || getRun(runId);
  }

  /* ---------------- 設定 ---------------- */

  getSettings() {
    return this.store.getSettings();
  }
  saveSettings(patch) {
    const s = this.store.saveSettings(patch);
    this.applyLanguage();
    this.emit('settings-changed', s);
    return s;
  }
  async testProvider(providerOrId) {
    const p =
      typeof providerOrId === 'string'
        ? this.store.getSettings().providers.find((x) => x.id === providerOrId)
        : providerOrId;
    if (!p) return { ok: false, error: 'プロバイダが見つかりません' };
    return llm.testProvider(p);
  }

  /* ---------------- MCP ---------------- */

  mcpStatus() {
    return this.hub.status();
  }
  async mcpUpsert(cfg) {
    const s = this.store.upsertServer(cfg);
    if (s.enabled) await this.hub.connect(s.id);
    else await this.hub.disconnect(s.id);
    return this.hub.status();
  }
  async mcpDelete(id) {
    await this.hub.disconnect(id);
    this.store.deleteServer(id);
    return this.hub.status();
  }
  async mcpConnect(id) {
    return this.hub.connect(id);
  }
  async mcpDisconnect(id) {
    await this.hub.disconnect(id);
    return this.hub.status();
  }
  async mcpCallTool(serverId, toolName, args) {
    return this.hub.callTool(serverId, toolName, args, 120000);
  }

  /* ---------------- 実測値 ---------------- */

  stats(opts = {}) {
    return metrics.stats(opts);
  }

  /* ---------------- 記憶 ---------------- */

  memorySummary(routineId) {
    return memory.summary(routineId);
  }
  memoryRead(routineId) {
    return {
      ...memory.summary(routineId),
      state: memory.readState(routineId),
      journal: memory.readJournalEntries(routineId),
    };
  }
  memoryWriteState(routineId, content) {
    memory.writeState(routineId, content);
    return this.memorySummary(routineId);
  }
  memoryAppendJournal(routineId, entry) {
    memory.appendJournal(routineId, entry);
    return this.memorySummary(routineId);
  }
  memoryClear(routineId) {
    return { cleared: memory.clear(routineId) };
  }

  /* ---------------- 禁止コマンド ---------------- */

  denyCategories() {
    return denyRules.listCategories().map((c) => ({
      ...c,
      label: i18n.t(c.labelKey),
      description: i18n.t(c.descKey),
    }));
  }

  /** コマンドが現在のポリシーで通るか試す(GUI/CLI の確認用) */
  denyCheck(command, routineId = null) {
    const settings = this.store.getSettings();
    const routine = routineId ? this.store.getRoutine(routineId) : null;
    const policy = denyRules.resolvePolicy(settings.shell, routine?.deny);
    const v = denyRules.evaluate(command, policy);
    // 採用されなかったパターン(長すぎる / ReDoS を招く形)は黙って消さず、確認画面に出す
    const invalidPatterns = [];
    for (const [kind, list] of [['deny', policy.extraPatterns], ['allow', policy.allowPatterns]]) {
      for (const p of list || []) {
        const r = denyRules.validatePattern(p);
        if (!r.ok) invalidPatterns.push({ kind, pattern: p, reason: r.reason });
      }
    }
    return { command, ...v, invalidPatterns };
  }

  /* ---------------- 状態サマリ ---------------- */

  overview() {
    const routines = this.listRoutines();
    return {
      version: require('../../package.json').version,
      language: i18n.getLanguage(),
      routines: {
        total: routines.length,
        enabled: routines.filter((r) => r.enabled).length,
        running: this.activeRuns.size,
      },
      schedulerPaused: this.schedulerPaused,
      activeRuns: this.listActiveRuns(),
      queued: this.listQueued(),
      mcp: this.hub.status().map((s) => ({ id: s.id, name: s.name, status: s.status, toolCount: s.toolCount })),
      provider: this.store.activeProvider(),
      nextRun: routines
        .filter((r) => r.nextRunAt)
        .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0] || null,
    };
  }
}

module.exports = { Engine, computeNextRun, describeSchedule };
