'use strict';
// スケジューラ。曜日 / 日 / 時刻 / 間隔 に対応。
// 実装方針: 長時間 setTimeout は macOS のスリープでずれるため使わず、
//          20秒ごとの tick で「次回実行時刻を過ぎたか」を判定する(スリープ復帰後も自己回復する)。

const { getLanguage } = require('../shared/i18n');

const TICK_MS = 20000;

/**
 * 次回実行時刻を計算する。
 * @param {object} schedule 正規化済みスケジュール
 * @param {Date} from 起点
 * @returns {number|null} epoch ms。手動実行のみなら null
 */
function computeNextRun(schedule, from = new Date()) {
  if (!schedule || schedule.type === 'manual') return null;

  if (schedule.type === 'interval') {
    return from.getTime() + schedule.intervalMinutes * 60000;
  }

  const [hh, mm] = String(schedule.time || '09:00').split(':').map(Number);

  if (schedule.type === 'weekly') {
    const days = schedule.weekdays && schedule.weekdays.length ? schedule.weekdays : [1, 2, 3, 4, 5];
    // 今日から 8 日先まで走査して最初に一致する日時を返す
    for (let i = 0; i <= 8; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      d.setHours(hh, mm, 0, 0);
      if (days.includes(d.getDay()) && d.getTime() > from.getTime()) return d.getTime();
    }
    return null;
  }

  if (schedule.type === 'monthly') {
    const days = schedule.days && schedule.days.length ? schedule.days : [1];
    // 最大 400 日先まで走査(31日指定で該当月が無いケースを吸収)
    for (let i = 0; i <= 400; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      d.setHours(hh, mm, 0, 0);
      if (days.includes(d.getDate()) && d.getTime() > from.getTime()) return d.getTime();
    }
    return null;
  }

  return null;
}

/** スケジュールを人が読める一文にする。表示言語に追従する。 */
function describeSchedule(schedule) {
  const en = getLanguage() === 'en';
  if (!schedule || schedule.type === 'manual') return en ? 'Manual only' : '手動実行のみ';

  const WD = en
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['日', '月', '火', '水', '木', '金', '土'];
  const sep = en ? ', ' : '・';

  switch (schedule.type) {
    case 'interval': {
      const m = schedule.intervalMinutes;
      if (m % 60 === 0) {
        const h = m / 60;
        return en ? `Every ${h}h` : `${h}時間ごと`;
      }
      return en ? `Every ${m}min` : `${m}分ごと`;
    }
    case 'weekly': {
      const d = (schedule.weekdays || [])
        .slice()
        .sort((a, b) => a - b)
        .map((n) => WD[n])
        .join(sep);
      return en ? `Weekly ${d || '—'} at ${schedule.time}` : `毎週 ${d || '—'} ${schedule.time}`;
    }
    case 'monthly': {
      const d = (schedule.days || []).slice().sort((a, b) => a - b).join(sep);
      return en ? `Monthly on ${d || '—'} at ${schedule.time}` : `毎月 ${d || '—'}日 ${schedule.time}`;
    }
    default:
      return en ? 'Manual only' : '手動実行のみ';
  }
}

class Scheduler {
  /**
   * @param {object} store
   * @param {(routine)=>void} onFire 実行トリガ
   */
  constructor(store, onFire) {
    this.store = store;
    this.onFire = onFire;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.running = true;
    this.reschedule();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 有効なルーティーンの nextRunAt が未設定なら埋める */
  reschedule() {
    const now = new Date();
    for (const r of this.store.listRoutines()) {
      if (!r.enabled || r.schedule.type === 'manual') {
        if (r.nextRunAt) this.store.updateRoutine(r.id, { nextRunAt: null });
        continue;
      }
      if (!r.nextRunAt) {
        const next = computeNextRun(r.schedule, now);
        this.store.updateRoutine(r.id, { nextRunAt: next ? new Date(next).toISOString() : null });
      }
    }
  }

  /** 有効化・スケジュール変更時に呼ぶ */
  refreshRoutine(id) {
    const r = this.store.getRoutine(id);
    if (!r) return;
    if (!r.enabled || r.schedule.type === 'manual') {
      this.store.updateRoutine(id, { nextRunAt: null });
      return;
    }
    const next = computeNextRun(r.schedule, new Date());
    this.store.updateRoutine(id, { nextRunAt: next ? new Date(next).toISOString() : null });
  }

  tick() {
    if (!this.running) return;
    const now = Date.now();
    for (const r of this.store.listRoutines()) {
      if (!r.enabled || !r.nextRunAt || r.schedule.type === 'manual') continue;
      const due = Date.parse(r.nextRunAt);
      if (Number.isNaN(due) || now < due) continue;

      // 先に次回時刻を更新してから発火する(実行が長引いても二重発火しない)
      const next = computeNextRun(r.schedule, new Date());
      this.store.updateRoutine(r.id, { nextRunAt: next ? new Date(next).toISOString() : null });

      try {
        this.onFire(this.store.getRoutine(r.id));
      } catch (e) {
        // 1件の失敗で tick 全体を止めない
        console.error('[scheduler] 発火に失敗:', e.message);
      }
    }
  }
}

module.exports = { Scheduler, computeNextRun, describeSchedule };
