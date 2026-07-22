'use strict';
/* EasyRoo レンダラ。フレームワーク非依存の素のDOM操作で構成し、ビルド工程を不要にしている。
   状態は state に集約し、各ビューは state から毎回描画し直す(差分管理を持たない=壊れにくい)。 */

const api = window.easyroo;
const I18N = window.EasyRooI18N;
const t = (k, p) => I18N.t(k, p);

const state = {
  view: 'routines',
  routines: [],
  runs: [],
  mcp: [],
  settings: null,
  overview: null,
  stats: null,
  denyCategories: [],
  openRunId: null,
  statsDays: null,
};

/* ------------------------- ユーティリティ ------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function locale() {
  return I18N.getLanguage() === 'en' ? 'en-US' : 'ja-JP';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms) {
  const en = I18N.getLanguage() === 'en';
  if (!ms || ms < 0) return en ? '0s' : '0秒';
  const s = Math.round(ms / 1000);
  if (s < 60) return en ? `${s}s` : `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return en ? `${m}m ${s % 60}s` : `${m}分${s % 60}秒`;
  const h = Math.floor(m / 60);
  return en ? `${h}h ${m % 60}m` : `${h}時間${m % 60}分`;
}

function toast(message, level = 'info') {
  const node = el(`<div class="toast ${esc(level)}">${esc(message)}</div>`);
  $('#toasts').appendChild(node);
  setTimeout(() => node.remove(), level === 'error' ? 9000 : 5000);
}

async function guard(fn, successMsg) {
  try {
    const r = await fn();
    if (successMsg) toast(successMsg, 'success');
    return r;
  } catch (e) {
    toast(e.message, 'error');
    throw e;
  }
}

function btn(label, cls, onClick) {
  const b = el(`<button class="btn ${cls}">${esc(label)}</button>`);
  b.addEventListener('click', onClick);
  return b;
}

/* ------------------------- テーマ・言語 ------------------------- */

const THEMES = ['system', 'light', 'dark'];
const LANGS = ['system', 'ja', 'en'];

function applyTheme(theme) {
  const v = THEMES.includes(theme) ? theme : 'system';
  const root = document.documentElement;
  if (root.dataset.theme !== v) {
    // 切替の 1 フレームだけ遷移を止める(理由は app.css の .theme-switching を参照)
    root.classList.add('theme-switching');
    root.dataset.theme = v;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
    try {
      localStorage.setItem('easyroo.theme', v);
    } catch (_) {}
  }
  $$('[data-theme-choice]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.themeChoice === v))
  );
}

function currentTheme() {
  return document.documentElement.dataset.theme || 'system';
}

function applyLanguage(pref) {
  const v = LANGS.includes(pref) ? pref : 'system';
  const resolved = I18N.resolve(v, navigator.language);
  I18N.setLanguage(resolved);
  document.documentElement.lang = resolved;
  document.documentElement.dataset.language = v;
  try {
    localStorage.setItem('easyroo.language', v);
  } catch (_) {}
  $$('[data-lang-choice]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.langChoice === v))
  );
  translateStatic();
}

function currentLangPref() {
  return document.documentElement.dataset.language || 'system';
}

/** index.html 側の固定テキストを訳す */
function translateStatic() {
  $$('[data-i18n]').forEach((n) => {
    n.textContent = t(n.dataset.i18n);
  });
  $$('[data-i18n-aria]').forEach((n) => {
    n.setAttribute('aria-label', t(n.dataset.i18nAria));
  });
}

/* ------------------------- モーダル ------------------------- */

function openModal(title, bodyNode, footNodes = []) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.innerHTML = '';
  body.appendChild(bodyNode);
  const foot = $('#modal-foot');
  foot.innerHTML = '';
  footNodes.forEach((n) => foot.appendChild(n));
  $('#modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal-body').innerHTML = '';
  state.openRunId = null;
}

/* ------------------------- データ読み込み ------------------------- */

async function refreshAll() {
  const results = await Promise.allSettled([
    api.routines.list(),
    api.runs.list({ limit: 40 }),
    api.mcp.status(),
    api.settings.get(),
    api.overview(),
    api.stats({ days: state.statsDays }),
    api.deny.categories(),
  ]);
  const [routines, runs, mcp, settings, overview, stats, deny] = results.map((r) =>
    r.status === 'fulfilled' ? r.value : null
  );
  if (routines) state.routines = routines;
  if (runs) state.runs = runs;
  if (mcp) state.mcp = mcp;
  if (settings) {
    state.settings = settings;
    const savedTheme = settings.ui?.theme;
    if (savedTheme && savedTheme !== currentTheme()) applyTheme(savedTheme);
    const savedLang = settings.ui?.language;
    if (savedLang && savedLang !== currentLangPref()) applyLanguage(savedLang);
  }
  if (overview) state.overview = overview;
  if (stats) state.stats = stats;
  if (deny) state.denyCategories = deny;
  renderStatus();
  render();
}

function renderStatus() {
  const o = state.overview;
  const dot = $('#status-dot');
  const text = $('#status-text');
  if (!o) {
    dot.className = 'dot err';
    text.textContent = t('status.disconnected');
    return;
  }
  if (o.schedulerPaused) {
    dot.className = 'dot err';
    text.textContent = t('status.schedulerPaused');
  } else if (o.routines.running > 0) {
    dot.className = 'dot busy';
    text.textContent = t('status.running', { n: o.routines.running });
  } else {
    dot.className = 'dot ok';
    text.textContent = t('status.enabledOf', { enabled: o.routines.enabled, total: o.routines.total });
  }
}

/* ------------------------- ビュー: ルーティーン ------------------------- */

function viewRoutines() {
  const wrap = el('<div></div>');

  const head = el(`
    <div class="page-head">
      <div>
        <h1>${esc(t('routines.title'))}</h1>
        <p class="subtitle">${esc(t('routines.subtitle'))}</p>
      </div>
    </div>`);
  head.appendChild(btn(t('routines.new'), 'btn-primary', () => openRoutineEditor(null)));
  wrap.appendChild(head);

  if (state.overview?.schedulerPaused) {
    const bar = el(`<div class="section-note is-alert">${t('routines.schedulerPausedWarn')}</div>`);
    bar.appendChild(
      btn(t('routines.resumeScheduler'), 'btn-sm btn-success', () =>
        guard(() => api.scheduler.pause(false)).then(refreshAll)
      )
    );
    wrap.appendChild(bar);
  }

  if (!state.routines.length) {
    wrap.appendChild(
      el(`<div class="empty">
        <p class="empty-mark">${esc(t('routines.emptyMark'))}</p>
        <p>${t('routines.empty')}</p>
      </div>`)
    );
    $('.empty', wrap).appendChild(btn(t('routines.first'), 'btn-primary', () => openRoutineEditor(null)));
    return wrap;
  }

  for (const r of state.routines) wrap.appendChild(routineCard(r));
  return wrap;
}

function routineCard(r) {
  const card = el(`
    <div class="card">
      <div class="card-head">
        <div style="min-width:0;flex:1">
          <div class="card-title">
            <span class="badge ${r.enabled ? 'on' : 'off'}">${esc(r.enabled ? t('routines.enabled') : t('routines.disabled'))}</span>
            <span>${esc(r.name)}</span>
            ${r.isRunning ? `<span class="badge run">${esc(t('routines.isRunning'))}</span>` : ''}
            ${r.memory?.enabled !== false ? '<span class="badge" title="State / Journal">M</span>' : ''}
            ${state.overview?.queued?.some((q) => q.routineId === r.id) ? `<span class="badge run">${esc(t('editor.overlap.queue'))}</span>` : ''}
          </div>
          <div class="meta">${esc(r.goal || t('common.unset'))}</div>
          <div class="meta meta-row">
            <span>${esc(r.scheduleText)}</span>
            ${r.nextRunAt && r.enabled ? `<span>· ${esc(t('routines.next', { time: fmtTime(r.nextRunAt) }))}</span>` : ''}
            ${r.lastRunAt ? `<span>· ${esc(t('routines.last', { time: fmtTime(r.lastRunAt), status: r.lastStatus || '—' }))}</span>` : ''}
          </div>
        </div>
        <div class="row actions"></div>
      </div>
    </div>`);

  const actions = $('.actions', card);

  if (r.isRunning) {
    actions.appendChild(btn(t('routines.stopNow'), 'btn-danger btn-sm', () => guard(() => api.routines.stop(r.id)).then(refreshAll)));
  } else {
    actions.appendChild(
      btn(t('routines.runNow'), 'btn-sm', async () => {
        const run = await guard(() => api.routines.run(r.id));
        await refreshAll();
        if (run) openRunDetail(run.runId);
      })
    );
  }

  actions.appendChild(
    r.enabled
      ? btn(t('routines.stopSchedule'), 'btn-sm', () => guard(() => api.routines.setEnabled(r.id, false)).then(refreshAll))
      : btn(t('routines.start'), 'btn-success btn-sm', () => guard(() => api.routines.setEnabled(r.id, true)).then(refreshAll))
  );

  actions.appendChild(btn(t('common.edit'), 'btn-sm', () => openRoutineEditor(r.id)));

  const del = el(
    `<button class="icon-btn is-danger" aria-label="${esc(t('routines.deleteAria', { name: r.name }))}" title="${esc(t('common.delete'))}">✕</button>`
  );
  del.addEventListener('click', async () => {
    if (!confirm(t('routines.deleteConfirm', { name: r.name }))) return;
    await guard(() => api.routines.remove(r.id));
    refreshAll();
  });
  actions.appendChild(del);

  return card;
}

/* ------------------------- ルーティーン編集 ------------------------- */

function weekdayLabels() {
  return I18N.getLanguage() === 'en'
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['日', '月', '火', '水', '木', '金', '土'];
}

async function openRoutineEditor(id) {
  const r = id
    ? await api.routines.get(id)
    : {
        name: '',
        goal: '',
        procedure: '',
        constraints: '',
        schedule: { type: 'manual', time: '09:00', weekdays: [1, 2, 3, 4, 5], days: [1], intervalMinutes: 60 },
        tools: { shell: true, mcpServerIds: [] },
        memory: { enabled: true },
        deny: { inherit: true, categories: null, extraPatterns: [], allowPatterns: [], trustedDomains: [] },
        model: null,
        cwd: null,
        maxSteps: null,
      };

  const settings = state.settings || (await api.settings.get());
  const servers = state.mcp.filter((s) => s.enabled);
  const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId);

  const form = el(`
    <div>
      <div class="field">
        <label>${esc(t('editor.name'))}</label>
        <input type="text" id="f-name" placeholder="${esc(t('editor.namePlaceholder'))}" value="${esc(r.name)}" />
      </div>

      <div class="field">
        <label>${esc(t('editor.goal'))} <span class="label-hint">${esc(t('editor.goalHint'))}</span></label>
        <input type="text" id="f-goal" placeholder="${esc(t('editor.goalPlaceholder'))}" value="${esc(r.goal)}" />
      </div>

      <div class="field">
        <label>${esc(t('editor.procedure'))} <span class="label-hint">${esc(t('editor.procedureHint'))}</span></label>
        <textarea id="f-procedure" rows="9">${esc(r.procedure)}</textarea>
      </div>

      <div class="field">
        <label>${esc(t('editor.constraints'))} <span class="label-hint">${esc(t('editor.constraintsHint'))}</span></label>
        <textarea id="f-constraints" rows="5">${esc(r.constraints)}</textarea>
      </div>

      <hr class="divider" />
      <h3 style="margin-bottom:var(--space-sm)">${esc(t('editor.scheduleSection'))}</h3>

      <div class="field">
        <label>${esc(t('editor.scheduleType'))}</label>
        <select id="f-sched-type">
          <option value="manual">${esc(t('editor.schedule.manual'))}</option>
          <option value="weekly">${esc(t('editor.schedule.weekly'))}</option>
          <option value="monthly">${esc(t('editor.schedule.monthly'))}</option>
          <option value="interval">${esc(t('editor.schedule.interval'))}</option>
        </select>
      </div>

      <div class="field" id="box-weekly">
        <label>${esc(t('editor.weekdays'))}</label>
        <div class="chips" id="f-weekdays"></div>
      </div>

      <div class="field" id="box-monthly">
        <label>${esc(t('editor.days'))}</label>
        <input type="text" id="f-days" placeholder="1,15" value="${esc((r.schedule.days || []).join(','))}" />
      </div>

      <div class="field" id="box-time">
        <label>${esc(t('editor.time'))}</label>
        <input type="text" id="f-time" placeholder="09:00" value="${esc(r.schedule.time || '09:00')}" style="max-width:10rem" />
      </div>

      <div class="field" id="box-interval">
        <label>${esc(t('editor.interval'))}</label>
        <input type="number" id="f-interval" min="1" value="${Number(r.schedule.intervalMinutes) || 60}" style="max-width:10rem" />
      </div>

      <hr class="divider" />
      <h3 style="margin-bottom:var(--space-sm)">${esc(t('editor.toolsSection'))}</h3>

      <div class="field">
        <label class="checkbox">
          <input type="checkbox" id="f-shell" ${r.tools.shell !== false ? 'checked' : ''} />
          <span>${esc(t('editor.shellAllow'))}</span>
        </label>
      </div>

      <div class="field">
        <label class="checkbox">
          <input type="checkbox" id="f-subrun" ${r.tools?.subrun !== false ? 'checked' : ''} />
          <span>${esc(t('editor.subrunEnable'))}</span>
        </label>
        <p class="hint" style="margin-top:var(--space-2xs)">${esc(t('editor.subrunHint'))}</p>
      </div>

      <div class="field">
        <label>${esc(t('editor.mcpServers'))}</label>
        <div id="f-mcp"></div>
      </div>

      <hr class="divider" />
      <h3 style="margin-bottom:var(--space-2xs)">${esc(t('editor.overlapSection'))}</h3>
      <p class="hint" style="margin-bottom:var(--space-sm)">${esc(t('editor.overlapHint'))}</p>
      <div class="field" id="f-overlap"></div>

      <hr class="divider" />
      <h3 style="margin-bottom:var(--space-sm)">${esc(t('editor.memorySection'))}</h3>
      <div class="field">
        <label class="checkbox">
          <input type="checkbox" id="f-memory" ${r.memory?.enabled !== false ? 'checked' : ''} />
          <span>${esc(t('editor.memoryEnable'))}</span>
        </label>
        <p class="hint" style="margin-top:var(--space-2xs)">${esc(t('editor.memoryHint'))}</p>
      </div>
      <div class="row" id="memory-actions"></div>

      <hr class="divider" />
      <h3 style="margin-bottom:var(--space-sm)">${esc(t('editor.denySection'))}</h3>
      <div class="field">
        <label class="checkbox">
          <input type="checkbox" id="f-deny-inherit" ${r.deny?.inherit !== false ? 'checked' : ''} />
          <span>${esc(t('editor.denyInherit'))}</span>
        </label>
      </div>
      <div class="field" id="box-deny-cats">
        <label>${esc(t('settings.denyCategories'))}</label>
        <div id="f-deny-cats"></div>
      </div>
      <div class="field">
        <label>${esc(t('editor.denyExtra'))} <span class="label-hint">${esc(t('editor.denyExtraHint'))}</span></label>
        <textarea id="f-deny-extra" rows="3">${esc((r.deny?.extraPatterns || []).join('\n'))}</textarea>
      </div>
      <div class="field">
        <label>${esc(t('settings.trustedDomains'))}</label>
        <textarea id="f-trust" rows="2">${esc((r.deny?.trustedDomains || []).join('\n'))}</textarea>
      </div>

      <hr class="divider" />
      <h3 style="margin-bottom:var(--space-sm)">${esc(t('editor.advanced'))} <span class="label-hint">${esc(t('editor.advancedHint'))}</span></h3>
      <div class="grid-2">
        <div class="field">
          <label>${esc(t('editor.model'))}</label>
          <input type="text" id="f-model" placeholder="${esc(activeProvider?.model || t('editor.useGlobal'))}" value="${esc(r.model || '')}" />
        </div>
        <div class="field">
          <label>${esc(t('editor.maxSteps'))}</label>
          <input type="number" id="f-maxsteps" min="1" max="200" placeholder="${esc(settings.maxSteps)}" value="${esc(r.maxSteps || '')}" />
        </div>
      </div>
      <div class="field">
        <label>${esc(t('editor.cwd'))}</label>
        <div class="row">
          <input type="text" id="f-cwd" placeholder="${esc(settings.shell.cwd)}" value="${esc(r.cwd || '')}" style="flex:1" />
          <button class="btn btn-sm" id="f-pick">${esc(t('common.select'))}</button>
        </div>
      </div>
    </div>`);

  // 曜日チップ
  const wdBox = $('#f-weekdays', form);
  const selectedWd = new Set(r.schedule.weekdays || []);
  weekdayLabels().forEach((label, i) => {
    const c = el(`<button class="chip" aria-pressed="${selectedWd.has(i)}">${esc(label)}</button>`);
    c.addEventListener('click', (e) => {
      e.preventDefault();
      if (selectedWd.has(i)) selectedWd.delete(i);
      else selectedWd.add(i);
      c.setAttribute('aria-pressed', String(selectedWd.has(i)));
    });
    wdBox.appendChild(c);
  });

  // 実行が重なったときの方針
  const overlapBox = $('#f-overlap', form);
  let overlapValue = r.overlapPolicy || 'skip';
  for (const v of ['skip', 'queue', 'restart']) {
    const row = el(`<label class="checkbox" style="align-items:flex-start">
      <input type="radio" name="overlap" value="${v}" ${overlapValue === v ? 'checked' : ''} />
      <span>${esc(t('editor.overlap.' + v))}<br /><span class="label-hint" style="margin-left:0">${esc(t('editor.overlap.' + v + 'Hint'))}</span></span>
    </label>`);
    $('input', row).addEventListener('change', (e) => {
      if (e.target.checked) overlapValue = v;
    });
    overlapBox.appendChild(row);
  }

  // MCPサーバ選択
  const mcpBox = $('#f-mcp', form);
  const selectedMcp = new Set(r.tools.mcpServerIds || []);
  if (!servers.length) {
    mcpBox.appendChild(el(`<p class="hint">${esc(t('editor.mcpEmpty'))}</p>`));
  } else {
    for (const s of servers) {
      const row = el(`<label class="checkbox">
        <input type="checkbox" ${selectedMcp.has(s.id) ? 'checked' : ''} />
        <span>${esc(s.name)} <span class="label-hint">${esc(s.status)} / ${esc(t('mcp.toolCount', { n: s.toolCount }))}</span></span>
      </label>`);
      $('input', row).addEventListener('change', (e) => {
        if (e.target.checked) selectedMcp.add(s.id);
        else selectedMcp.delete(s.id);
      });
      mcpBox.appendChild(row);
    }
  }

  // 禁止カテゴリ
  const catBox = $('#f-deny-cats', form);
  const selectedCats = new Set(r.deny?.categories || state.denyCategories.map((c) => c.id));
  for (const c of state.denyCategories) {
    const row = el(`<label class="checkbox">
      <input type="checkbox" ${selectedCats.has(c.id) ? 'checked' : ''} />
      <span>${esc(c.label)} <span class="label-hint">${esc(c.description)}</span></span>
    </label>`);
    $('input', row).addEventListener('change', (e) => {
      if (e.target.checked) selectedCats.add(c.id);
      else selectedCats.delete(c.id);
    });
    catBox.appendChild(row);
  }

  const inheritBox = $('#f-deny-inherit', form);
  const syncInherit = () => {
    $('#box-deny-cats', form).style.display = inheritBox.checked ? 'none' : '';
  };
  inheritBox.addEventListener('change', syncInherit);
  syncInherit();

  // 記憶の操作
  if (id) {
    $('#memory-actions', form).appendChild(
      btn(t('editor.memorySection'), 'btn-sm', () => openMemoryViewer(id))
    );
  }

  // スケジュール種別に応じた表示切替
  const typeSel = $('#f-sched-type', form);
  typeSel.value = r.schedule.type || 'manual';
  const syncBoxes = () => {
    const v = typeSel.value;
    $('#box-weekly', form).style.display = v === 'weekly' ? '' : 'none';
    $('#box-monthly', form).style.display = v === 'monthly' ? '' : 'none';
    $('#box-time', form).style.display = v === 'weekly' || v === 'monthly' ? '' : 'none';
    $('#box-interval', form).style.display = v === 'interval' ? '' : 'none';
  };
  typeSel.addEventListener('change', syncBoxes);
  syncBoxes();

  $('#f-pick', form).addEventListener('click', async (e) => {
    e.preventDefault();
    const p = await api.sys.pickFolder();
    if (p) $('#f-cwd', form).value = p;
  });

  const lines = (sel) =>
    $(sel, form)
      .value.split('\n')
      .map((x) => x.trim())
      .filter(Boolean);

  const save = async () => {
    const name = $('#f-name', form).value.trim();
    if (!name) return toast(t('editor.nameRequired'), 'error');

    const time = $('#f-time', form).value.trim();
    if (['weekly', 'monthly'].includes(typeSel.value) && !/^\d{1,2}:\d{1,2}$/.test(time)) {
      return toast(t('editor.timeInvalid'), 'error');
    }

    const data = {
      name,
      goal: $('#f-goal', form).value.trim(),
      procedure: $('#f-procedure', form).value,
      constraints: $('#f-constraints', form).value,
      schedule: {
        type: typeSel.value,
        time,
        weekdays: [...selectedWd],
        days: $('#f-days', form)
          .value.split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => n >= 1 && n <= 31),
        intervalMinutes: Number($('#f-interval', form).value) || 60,
      },
      tools: {
        shell: $('#f-shell', form).checked,
        subrun: $('#f-subrun', form).checked,
        mcpServerIds: [...selectedMcp],
      },
      overlapPolicy: overlapValue,
      memory: { enabled: $('#f-memory', form).checked },
      deny: {
        inherit: inheritBox.checked,
        categories: inheritBox.checked ? null : [...selectedCats],
        extraPatterns: lines('#f-deny-extra'),
        trustedDomains: lines('#f-trust'),
        allowPatterns: r.deny?.allowPatterns || [],
      },
      model: $('#f-model', form).value.trim() || null,
      maxSteps: Number($('#f-maxsteps', form).value) || null,
      cwd: $('#f-cwd', form).value.trim() || null,
    };

    if (id) await guard(() => api.routines.update(id, data), t('editor.saved'));
    else await guard(() => api.routines.create(data), t('editor.created'));

    closeModal();
    refreshAll();
  };

  openModal(id ? t('editor.editTitle') : t('editor.newTitle'), form, [
    btn(t('common.cancel'), '', closeModal),
    btn(t('common.save'), 'btn-primary', save),
  ]);
}

/* ------------------------- 記憶ビューア ------------------------- */

async function openMemoryViewer(routineId) {
  const m = await guard(() => api.memory.get(routineId));
  if (!m) return;

  const body = el(`
    <div>
      <div class="meta" style="margin-bottom:var(--space-sm)">
        STATE: ${m.stateChars} / JOURNAL: ${m.journalEntries}<br />
        <span class="mono">${esc(m.dir)}</span>
      </div>
      <div class="field">
        <label>STATE.md</label>
        <textarea id="mem-state" rows="12">${esc(m.state || '')}</textarea>
      </div>
      <div class="field">
        <label>JOURNAL.md</label>
        <div class="log">${
          m.journal.length ? m.journal.slice(-10).map((e) => `<div class="log-line">${esc(e)}</div>`).join('') : `<div class="log-line log-res">${esc(t('runs.logEmpty'))}</div>`
        }</div>
      </div>
    </div>`);

  const clearBtn = btn(t('common.delete'), 'btn-danger btn-sm', async () => {
    if (!confirm(t('routines.deleteConfirm', { name: 'STATE / JOURNAL' }))) return;
    await guard(() => api.memory.clear(routineId));
    closeModal();
  });

  openModal(t('editor.memorySection'), body, [
    clearBtn,
    btn(t('common.close'), '', closeModal),
    btn(t('common.save'), 'btn-primary', async () => {
      await guard(() => api.memory.setState(routineId, $('#mem-state', body).value), t('editor.saved'));
      closeModal();
    }),
  ]);
}

/* ------------------------- ビュー: 実行ログ ------------------------- */

const RUN_STATUS = {
  running: ['run', 'runs.status.running'],
  success: ['ok', 'runs.status.success'],
  failed: ['fail', 'runs.status.failed'],
  stopped: ['stop', 'runs.status.stopped'],
  pending: ['run', 'runs.status.pending'],
};

function viewRuns() {
  const wrap = el('<div></div>');
  const head = el(`
    <div class="page-head">
      <div>
        <h1>${esc(t('runs.title'))}</h1>
        <p class="subtitle">${esc(t('runs.subtitle'))}</p>
      </div>
    </div>`);
  const actions = el('<div class="row"></div>');
  actions.appendChild(btn(t('runs.stopAll'), 'btn-danger btn-sm', () => guard(() => api.runs.stopAll()).then(refreshAll)));
  actions.appendChild(btn(t('common.refresh'), 'btn-sm', refreshAll));
  head.appendChild(actions);
  wrap.appendChild(head);

  if (!state.runs.length) {
    wrap.appendChild(el(`<div class="empty"><p class="empty-mark">${esc(t('runs.emptyMark'))}</p><p>${esc(t('runs.empty'))}</p></div>`));
    return wrap;
  }

  for (const run of state.runs) {
    const [cls, key] = RUN_STATUS[run.status] || ['off', 'common.unknown'];
    const tools = Object.entries(run.toolStats || {})
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 4)
      .map(([n, s]) => `${n}×${s.calls}`)
      .join(' · ');

    const card = el(`
      <div class="card" style="cursor:pointer">
        <div class="card-head">
          <div style="min-width:0;flex:1">
            <div class="card-title">
              <span class="badge ${cls}">${esc(t(key))}</span>
              <span>${esc(run.routineName)}</span>
            </div>
            <div class="meta">${esc((run.summary || t('runs.noSummary')).slice(0, 200))}</div>
            <div class="meta meta-row">
              <span>${esc(fmtTime(run.startedAt))}</span>
              <span>· ${esc(t('runs.steps', { n: run.steps || 0 }))}</span>
              <span>· ${esc(t('runs.duration', { d: fmtDuration(run.durationMs) }))}</span>
              ${tools ? `<span>· ${esc(tools)}</span>` : ''}
              ${run.deniedCommands ? `<span class="is-error">· ${esc(t('stats.denied'))} ${run.deniedCommands}</span>` : ''}
            </div>
          </div>
          <div class="row run-actions"></div>
        </div>
      </div>`);

    card.addEventListener('click', (e) => {
      if (e.target.closest('.run-actions')) return;
      openRunDetail(run.id);
    });

    if (run.status === 'running') {
      $('.run-actions', card).appendChild(
        btn(t('runs.stopThis'), 'btn-danger btn-sm', () => guard(() => api.runs.stop(run.id)).then(refreshAll))
      );
    }
    wrap.appendChild(card);
  }
  return wrap;
}

function renderLogLines(run) {
  const lines = [];
  for (const ev of run.events || []) {
    const time = `<span class="log-time">${esc(new Date(ev.t).toLocaleTimeString(locale()))}</span>`;
    const ms = ev.durationMs ? ` <span class="log-time">(${ev.durationMs}ms)</span>` : '';
    switch (ev.type) {
      case 'step':
        lines.push(`<div class="log-line log-step">${time}── ${ev.step} / ${ev.of} ──</div>`);
        break;
      case 'assistant':
        lines.push(`<div class="log-line log-ai">${time}AI  ${esc(ev.text)}</div>`);
        break;
      case 'tool_call':
        lines.push(`<div class="log-line log-call">${time}→ ${esc(ev.name)} ${esc(JSON.stringify(ev.args).slice(0, 500))}</div>`);
        break;
      case 'tool_result':
        lines.push(
          `<div class="log-line ${ev.denied ? 'log-err' : 'log-res'}">${time}← ${esc(String(ev.output).slice(0, 2000))}${ms}</div>`
        );
        break;
      case 'memory':
        lines.push(`<div class="log-line log-res">${time}◇ STATE ${ev.stateChars} / JOURNAL ${ev.journalEntries}</div>`);
        break;
      case 'memory_flush':
        lines.push(`<div class="log-line log-ok">${time}◇ ${esc(t('stats.memoryFlushes'))} → STATE ${ev.chars}</div>`);
        break;
      case 'budget':
        lines.push(`<div class="log-line log-res">${time}·  context ${ev.contextTokens} / budget ${ev.budgetTokens} tok</div>`);
        break;
      case 'subrun_start':
        lines.push(`<div class="log-line log-call">${time}⇥ ${esc(t('stats.subruns'))}: ${esc(ev.task)}</div>`);
        break;
      case 'subrun_end':
        lines.push(`<div class="log-line log-ok">${time}⇤ ${esc(ev.summary)}</div>`);
        break;
      case 'error':
        lines.push(`<div class="log-line log-err">${time}!  ${esc(ev.message)}</div>`);
        break;
      case 'info':
        lines.push(`<div class="log-line log-res">${time}·  ${esc(ev.message)}</div>`);
        break;
      case 'finish':
        lines.push(`<div class="log-line log-ok">${time}${esc(t('run.done'))}: ${esc(ev.summary)}</div>`);
        break;
      case 'stopped':
        lines.push(`<div class="log-line log-err">${time}${esc(t('run.stop'))}: ${esc(ev.reason)}</div>`);
        break;
      case 'run_end':
        lines.push(`<div class="log-line log-step">${time}── ${esc(ev.status)} · ${esc(fmtDuration(ev.durationMs))} ──</div>`);
        break;
    }
  }
  return lines.join('') || `<div class="log-line log-res">${esc(t('runs.logEmpty'))}</div>`;
}

function renderRunStats(run) {
  const tools = Object.entries(run.toolStats || {}).sort((a, b) => b[1].calls - a[1].calls);
  const rows = tools
    .map(
      ([name, s]) =>
        `<tr><td>${esc(name)}</td><td>${s.calls}</td><td>${s.failed}</td><td>${s.calls ? Math.round(s.totalMs / s.calls) : 0}ms</td></tr>`
    )
    .join('');
  return `
    <div class="stat-grid">
      <div class="stat"><span class="stat-label">${esc(t('runs.duration', { d: '' }))}</span><span class="stat-value">${esc(fmtDuration(run.durationMs))}</span></div>
      <div class="stat"><span class="stat-label">${esc(t('runs.steps', { n: '' }))}</span><span class="stat-value">${run.steps || 0}</span></div>
      <div class="stat"><span class="stat-label">${esc(t('stats.tokens'))}</span><span class="stat-value">${run.usage?.total || 0}</span></div>
      <div class="stat"><span class="stat-label">${esc(t('stats.denied'))}</span><span class="stat-value">${run.deniedCommands || 0}</span></div>
      <div class="stat"><span class="stat-label">${esc(t('stats.compactions'))}</span><span class="stat-value">${run.compactions || 0}</span></div>
      <div class="stat"><span class="stat-label">${esc(t('stats.memoryFlushes'))}</span><span class="stat-value">${run.memoryFlushes || 0}</span></div>
      <div class="stat"><span class="stat-label">${esc(t('stats.subruns'))}</span><span class="stat-value">${run.subruns || 0}</span></div>
    </div>
    ${
      rows
        ? `<table class="table"><thead><tr><th>${esc(t('stats.toolName'))}</th><th>${esc(t('stats.calls'))}</th><th>${esc(t('stats.failed'))}</th><th>${esc(t('stats.avgMs'))}</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="hint">${esc(t('stats.noData'))}</p>`
    }`;
}

async function openRunDetail(runId) {
  const run = await guard(() => api.runs.get(runId));
  if (!run) return;
  state.openRunId = runId;

  const [cls, key] = RUN_STATUS[run.status] || ['off', 'common.unknown'];
  const body = el(`
    <div>
      <div class="meta" style="margin-bottom:var(--space-sm)">
        <strong>${esc(run.routineName)}</strong>
        <span class="badge ${cls}">${esc(t(key))}</span><br />
        ${esc(fmtTime(run.startedAt))} · ${esc(t('runs.steps', { n: run.steps || 0 }))} · ${esc(t('runs.duration', { d: fmtDuration(run.durationMs) }))}<br />
        ${esc(run.summary || t('runs.inProgress'))}
      </div>
      <div class="seg" role="group" style="margin-bottom:var(--space-sm)">
        <button class="seg-btn" data-tab="log" aria-pressed="true">${esc(t('runs.tabLog'))}</button>
        <button class="seg-btn" data-tab="stats" aria-pressed="false">${esc(t('runs.tabStats'))}</button>
      </div>
      <div class="log" id="run-log">${renderLogLines(run)}</div>
      <div id="run-stats" style="display:none">${renderRunStats(run)}</div>
    </div>`);

  $$('[data-tab]', body).forEach((b) =>
    b.addEventListener('click', () => {
      const tab = b.dataset.tab;
      $$('[data-tab]', body).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $('#run-log', body).style.display = tab === 'log' ? '' : 'none';
      $('#run-stats', body).style.display = tab === 'stats' ? '' : 'none';
    })
  );

  const foot = [];
  if (run.status === 'running') {
    foot.push(
      btn(t('runs.stopThis'), 'btn-danger', async () => {
        await guard(() => api.runs.stop(runId));
        refreshAll();
      })
    );
  }
  foot.push(btn(t('common.close'), '', closeModal));

  openModal(t('runs.detail'), body, foot);
  const log = $('#run-log');
  log.scrollTop = log.scrollHeight;
}

async function refreshOpenRun() {
  if (!state.openRunId) return;
  const log = $('#run-log');
  if (!log) return;
  try {
    const run = await api.runs.get(state.openRunId);
    if (!run) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.innerHTML = renderLogLines(run);
    const st = $('#run-stats');
    if (st) st.innerHTML = renderRunStats(run);
    if (atBottom) log.scrollTop = log.scrollHeight;
  } catch (_) {}
}

/* ------------------------- ビュー: 実測値 ------------------------- */

function viewStats() {
  const wrap = el('<div></div>');
  const head = el(`
    <div class="page-head">
      <div>
        <h1>${esc(t('stats.title'))}</h1>
        <p class="subtitle">${esc(t('stats.subtitle'))}</p>
      </div>
    </div>`);

  const periods = [
    [null, I18N.getLanguage() === 'en' ? 'All' : '全期間'],
    [7, I18N.getLanguage() === 'en' ? '7 days' : '7日'],
    [30, I18N.getLanguage() === 'en' ? '30 days' : '30日'],
  ];
  const seg = el('<div class="seg" role="group"></div>');
  for (const [days, label] of periods) {
    const b = el(`<button class="seg-btn" aria-pressed="${state.statsDays === days}">${esc(label)}</button>`);
    b.addEventListener('click', async () => {
      state.statsDays = days;
      state.stats = await api.stats({ days });
      render();
    });
    seg.appendChild(b);
  }
  head.appendChild(seg);
  wrap.appendChild(head);

  const s = state.stats;
  if (!s || !s.overall.runs) {
    wrap.appendChild(el(`<div class="empty"><p class="empty-mark">${esc(t('runs.emptyMark'))}</p><p>${esc(t('stats.noData'))}</p></div>`));
    return wrap;
  }

  const o = s.overall;
  wrap.appendChild(
    el(`<div class="card">
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">${esc(t('stats.totalRuns'))}</span><span class="stat-value">${o.runs}</span></div>
        <div class="stat"><span class="stat-label">${esc(t('stats.successRate'))}</span><span class="stat-value">${o.successRate}%</span></div>
        <div class="stat"><span class="stat-label">${esc(t('stats.avgDuration'))}</span><span class="stat-value">${esc(fmtDuration(o.avgDurationMs))}</span></div>
        <div class="stat"><span class="stat-label">${esc(t('stats.totalDuration'))}</span><span class="stat-value">${esc(fmtDuration(o.totalDurationMs))}</span></div>
        <div class="stat"><span class="stat-label">${esc(t('stats.tokens'))}</span><span class="stat-value">${o.tokens.total}</span></div>
        <div class="stat"><span class="stat-label">${esc(t('stats.denied'))}</span><span class="stat-value">${o.deniedCommands}</span></div>
      </div>
    </div>`)
  );

  if (o.tools.length) {
    const rows = o.tools
      .map(
        (tl) =>
          `<tr><td>${esc(tl.name)}</td><td>${tl.calls}</td><td>${tl.failed}</td><td>${tl.avgMs}ms</td></tr>`
      )
      .join('');
    wrap.appendChild(
      el(`<div class="card">
        <h2 style="margin-bottom:var(--space-sm)">${esc(t('stats.toolUsage'))}</h2>
        <table class="table">
          <thead><tr><th>${esc(t('stats.toolName'))}</th><th>${esc(t('stats.calls'))}</th><th>${esc(t('stats.failed'))}</th><th>${esc(t('stats.avgMs'))}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`)
    );
  }

  if (s.byRoutine.length) {
    const rows = s.byRoutine
      .map(
        (r) =>
          `<tr><td>${esc(r.routineName || r.routineId)}</td><td>${r.runs}</td><td>${r.successRate}%</td><td>${esc(fmtDuration(r.avgDurationMs))}</td></tr>`
      )
      .join('');
    wrap.appendChild(
      el(`<div class="card">
        <h2 style="margin-bottom:var(--space-sm)">${esc(t('nav.routines'))}</h2>
        <table class="table">
          <thead><tr><th>${esc(t('nav.routines'))}</th><th>${esc(t('stats.totalRuns'))}</th><th>${esc(t('stats.successRate'))}</th><th>${esc(t('stats.avgDuration'))}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`)
    );
  }

  return wrap;
}

/* ------------------------- ビュー: MCPハブ ------------------------- */

const MCP_STATUS = {
  connected: ['ok', 'mcp.status.connected'],
  connecting: ['run', 'mcp.status.connecting'],
  error: ['fail', 'mcp.status.error'],
  disconnected: ['off', 'mcp.status.disconnected'],
};

function viewMcp() {
  const wrap = el('<div></div>');
  const head = el(`
    <div class="page-head">
      <div>
        <h1>${esc(t('mcp.title'))}</h1>
        <p class="subtitle">${esc(t('mcp.subtitle'))}</p>
      </div>
    </div>`);
  head.appendChild(btn(t('mcp.add'), 'btn-primary', () => openMcpEditor(null)));
  wrap.appendChild(head);
  wrap.appendChild(el(`<div class="section-note">${esc(t('mcp.note'))}</div>`));

  if (!state.mcp.length) {
    wrap.appendChild(el(`<div class="empty"><p class="empty-mark">${esc(t('mcp.emptyMark'))}</p><p>${esc(t('mcp.empty'))}</p></div>`));
    $('.empty', wrap).appendChild(btn(t('mcp.add'), 'btn-primary', () => openMcpEditor(null)));
    return wrap;
  }

  for (const s of state.mcp) {
    const [cls, key] = MCP_STATUS[s.status] || ['off', 'common.unknown'];
    const card = el(`
      <div class="card">
        <div class="card-head">
          <div style="min-width:0;flex:1">
            <div class="card-title">
              <span class="badge ${cls}">${esc(t(key))}</span>
              <span>${esc(s.name)}</span>
              ${s.toolCount ? `<span class="badge">${esc(t('mcp.toolCount', { n: s.toolCount }))}</span>` : ''}
            </div>
            <div class="meta mono">${esc(s.transport === 'http' ? s.url : [s.command, ...(s.args || [])].join(' '))}</div>
            ${s.error ? `<div class="meta is-error">${esc(s.error)}</div>` : ''}
            ${s.tools?.length ? `<div class="meta">${esc(t('mcp.available', { list: s.tools.map((x) => x.name).join(', ').slice(0, 300) }))}</div>` : ''}
          </div>
          <div class="row mcp-actions"></div>
        </div>
      </div>`);

    const a = $('.mcp-actions', card);
    a.appendChild(
      s.status === 'connected'
        ? btn(t('mcp.disconnect'), 'btn-sm', () => guard(() => api.mcp.disconnect(s.id)).then(refreshAll))
        : btn(t('mcp.connect'), 'btn-success btn-sm', () => guard(() => api.mcp.connect(s.id)).then(refreshAll))
    );
    a.appendChild(btn(t('common.edit'), 'btn-sm', () => openMcpEditor(s.id)));
    const del = el(`<button class="icon-btn is-danger" aria-label="${esc(t('routines.deleteAria', { name: s.name }))}">✕</button>`);
    del.addEventListener('click', async () => {
      if (!confirm(t('mcp.deleteConfirm', { name: s.name }))) return;
      await guard(() => api.mcp.remove(s.id));
      refreshAll();
    });
    a.appendChild(del);
    wrap.appendChild(card);
  }
  return wrap;
}

function openMcpEditor(id) {
  const s = state.mcp.find((x) => x.id === id) || {
    name: '', transport: 'stdio', command: '', args: [], url: '', env: {}, enabled: true,
  };

  const form = el(`
    <div>
      <div class="field">
        <label>${esc(t('mcp.name'))} <span class="label-hint">${esc(t('mcp.nameHint'))}</span></label>
        <input type="text" id="m-name" placeholder="filesystem" value="${esc(s.name)}" />
      </div>
      <div class="field">
        <label>${esc(t('mcp.transport'))}</label>
        <select id="m-transport">
          <option value="stdio">${esc(t('mcp.transport.stdio'))}</option>
          <option value="http">${esc(t('mcp.transport.http'))}</option>
        </select>
      </div>
      <div id="m-box-stdio">
        <div class="field">
          <label>${esc(t('mcp.command'))}</label>
          <input type="text" id="m-command" placeholder="npx" value="${esc(s.command)}" />
        </div>
        <div class="field">
          <label>${esc(t('mcp.args'))} <span class="label-hint">${esc(t('mcp.argsHint'))}</span></label>
          <input type="text" id="m-args" value="${esc((s.args || []).join(' '))}" />
        </div>
        <div class="field">
          <label>${esc(t('mcp.env'))} <span class="label-hint">${esc(t('mcp.envHint'))}</span></label>
          <input type="text" id="m-env" placeholder='{"API_KEY":"…"}' value="${esc(Object.keys(s.env || {}).length ? JSON.stringify(s.env) : '')}" />
        </div>
      </div>
      <div id="m-box-http">
        <div class="field">
          <label>${esc(t('mcp.url'))}</label>
          <input type="text" id="m-url" placeholder="http://localhost:3000/mcp" value="${esc(s.url)}" />
        </div>
      </div>
      <div class="field">
        <label class="checkbox">
          <input type="checkbox" id="m-enabled" ${s.enabled !== false ? 'checked' : ''} />
          <span>${esc(t('mcp.enable'))}</span>
        </label>
      </div>
    </div>`);

  const tSel = $('#m-transport', form);
  tSel.value = s.transport || 'stdio';
  const sync = () => {
    $('#m-box-stdio', form).style.display = tSel.value === 'stdio' ? '' : 'none';
    $('#m-box-http', form).style.display = tSel.value === 'http' ? '' : 'none';
  };
  tSel.addEventListener('change', sync);
  sync();

  const save = async () => {
    const name = $('#m-name', form).value.trim();
    if (!name) return toast(t('mcp.nameRequired'), 'error');
    let env = {};
    const envRaw = $('#m-env', form).value.trim();
    if (envRaw) {
      try {
        env = JSON.parse(envRaw);
      } catch (_) {
        return toast(t('mcp.envInvalid'), 'error');
      }
    }
    const cfg = {
      id: id || undefined,
      name,
      transport: tSel.value,
      command: $('#m-command', form).value.trim(),
      args: $('#m-args', form).value.trim().split(/\s+/).filter(Boolean),
      url: $('#m-url', form).value.trim(),
      env,
      enabled: $('#m-enabled', form).checked,
    };
    if (cfg.transport === 'stdio' && !cfg.command) return toast(t('mcp.commandRequired'), 'error');
    if (cfg.transport === 'http' && !cfg.url) return toast(t('mcp.urlRequired'), 'error');
    await guard(() => api.mcp.upsert(cfg), t('editor.saved'));
    closeModal();
    refreshAll();
  };

  openModal(id ? t('mcp.editTitle') : t('mcp.addTitle'), form, [
    btn(t('common.cancel'), '', closeModal),
    btn(t('mcp.saveConnect'), 'btn-primary', save),
  ]);
}

/* ------------------------- ビュー: 設定 ------------------------- */

function viewSettings() {
  const s = state.settings;
  const wrap = el('<div></div>');
  wrap.appendChild(
    el(`<div class="page-head"><div>
      <h1>${esc(t('settings.title'))}</h1>
      <p class="subtitle">${esc(t('settings.subtitle'))}</p>
    </div></div>`)
  );
  if (!s) return wrap;

  /* --- LLM --- */
  let getProviderCfg = null;
  const prov = el(`
    <div class="card">
      <h2 style="margin-bottom:var(--space-sm)">${esc(t('settings.llm'))}</h2>
      <div class="section-note">${t('settings.llmNote')}</div>
      <div class="field">
        <label>${esc(t('settings.provider'))}</label>
        <select id="s-active"></select>
      </div>
      <div id="prov-form"></div>
    </div>`);

  const activeSel = $('#s-active', prov);
  s.providers.forEach((p) => activeSel.appendChild(el(`<option value="${esc(p.id)}">${esc(p.name)}</option>`)));
  activeSel.value = s.activeProviderId;

  const renderProvForm = () => {
    const p = s.providers.find((x) => x.id === activeSel.value) || s.providers[0];
    const box = $('#prov-form', prov);
    box.innerHTML = '';
    const f = el(`
      <div>
        <div class="grid-2">
          <div class="field">
            <label>${esc(t('settings.displayName'))}</label>
            <input type="text" id="p-name" value="${esc(p.name)}" />
          </div>
          <div class="field">
            <label>${esc(t('settings.baseUrl'))}</label>
            <input type="text" id="p-url" value="${esc(p.baseUrl)}" />
          </div>
        </div>
        <div class="field">
          <label>${esc(t('settings.apiKey'))} <span class="label-hint">${esc(t('settings.apiKeyHint'))}</span></label>
          <input type="password" id="p-key" value="${esc(p.apiKey || '')}" placeholder="sk-…" />
        </div>
        <div class="field">
          <label>${esc(t('editor.model'))}</label>
          <div class="row">
            <select id="p-model" style="flex:1"><option value="${esc(p.model || '')}">${esc(p.model || t('common.unset'))}</option></select>
            <button class="btn btn-sm" id="p-fetch">${esc(t('settings.fetchModels'))}</button>
          </div>
        </div>
        <div class="row">
          <button class="btn btn-sm" id="p-test">${esc(t('settings.testConnection'))}</button>
          <button class="btn btn-sm btn-primary" id="p-save">${esc(t('settings.saveProvider'))}</button>
          <button class="btn btn-sm" id="p-add">${esc(t('settings.addProvider'))}</button>
          <span id="p-status" class="hint"></span>
        </div>
      </div>`);

    const currentCfg = () => ({
      id: p.id,
      name: $('#p-name', f).value.trim(),
      baseUrl: $('#p-url', f).value.trim(),
      apiKey: $('#p-key', f).value,
      model: $('#p-model', f).value,
    });
    getProviderCfg = currentCfg;

    $('#p-fetch', f).addEventListener('click', async () => {
      $('#p-status', f).textContent = t('settings.fetching');
      const r = await api.settings.testProvider(currentCfg());
      if (!r.ok) {
        $('#p-status', f).textContent = '';
        return toast(t('settings.testFailed', { error: r.error }), 'error');
      }
      const sel = $('#p-model', f);
      sel.innerHTML = '';
      r.models.forEach((m) => sel.appendChild(el(`<option value="${esc(m)}">${esc(m)}</option>`)));
      if (p.model && r.models.includes(p.model)) sel.value = p.model;
      $('#p-status', f).textContent = t('settings.modelsFound', { n: r.models.length });
    });

    $('#p-test', f).addEventListener('click', async () => {
      $('#p-status', f).textContent = t('settings.testing');
      const r = await api.settings.testProvider(currentCfg());
      // 正規化後のURLも見せる。「どこへ繋ぎに行ったか」が分からないと原因を追えない。
      $('#p-status', f).textContent = r.ok
        ? t('settings.testOk', { n: r.models.length }) + (r.normalized ? ` → ${r.url}` : '')
        : '';
      if (!r.ok) toast(t('settings.testFailed', { error: r.error }), 'error');
      else toast(t('settings.connected'), 'success');
    });

    $('#p-save', f).addEventListener('click', async () => {
      const cfg = currentCfg();
      const providers = s.providers.map((x) => (x.id === p.id ? { ...x, ...cfg } : x));
      await guard(() => api.settings.save({ providers, activeProviderId: activeSel.value }), t('settings.savedAll'));
      refreshAll();
    });

    $('#p-add', f).addEventListener('click', async () => {
      const name = prompt(t('settings.newProviderName'), t('settings.newProvider'));
      if (!name) return;
      const providers = [...s.providers, { id: 'p' + Date.now(), name, baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' }];
      await guard(() => api.settings.save({ providers }), t('settings.added'));
      refreshAll();
    });

    box.appendChild(f);
  };
  activeSel.addEventListener('change', renderProvForm);
  renderProvForm();
  wrap.appendChild(prov);

  /* --- 安全装置 --- */
  const safety = el(`
    <div class="card">
      <h2 style="margin-bottom:var(--space-sm)">${esc(t('settings.safety'))}</h2>
      <div class="grid-3">
        <div class="field"><label>${esc(t('settings.maxSteps'))}</label><input type="number" id="s-maxsteps" min="1" max="200" value="${esc(s.maxSteps)}" /></div>
        <div class="field"><label>${esc(t('settings.runTimeout'))}</label><input type="number" id="s-runtimeout" min="60" value="${esc(s.runTimeoutSec)}" /></div>
        <div class="field"><label>${esc(t('settings.reqTimeout'))}</label><input type="number" id="s-reqtimeout" min="10" value="${esc(s.requestTimeoutSec)}" /></div>
      </div>
      <div class="field">
        <label>${esc(t('settings.temperature'))} <span class="label-hint">${esc(t('settings.temperatureHint'))}</span></label>
        <input type="number" id="s-temp" min="0" max="2" step="0.1" value="${esc(s.temperature)}" style="max-width:10rem" />
      </div>
      <div class="grid-3">
        <div class="field">
          <label>${esc(t('settings.contextTokens'))}</label>
          <input type="number" id="s-ctx" min="2048" step="1024" value="${esc(s.contextTokens || 32768)}" />
        </div>
        <div class="field">
          <label>${esc(t('settings.reserveOutput'))}</label>
          <input type="number" id="s-reserve-out" min="256" step="256" value="${esc(s.reserveOutputTokens || 4096)}" />
        </div>
        <div class="field">
          <label>${esc(t('settings.reservePrompt'))}</label>
          <input type="number" id="s-reserve-prompt" min="256" step="256" value="${esc(s.reservePromptTokens || 2048)}" />
        </div>
      </div>
      <p class="hint">${esc(t('settings.contextTokensHint'))}</p>
    </div>`);
  wrap.appendChild(safety);

  /* --- ターミナル --- */
  const shell = el(`
    <div class="card">
      <h2 style="margin-bottom:var(--space-sm)">${esc(t('settings.shell'))}</h2>
      <div class="field">
        <label class="checkbox"><input type="checkbox" id="s-shell-enabled" ${s.shell.enabled ? 'checked' : ''} /><span>${esc(t('settings.shellEnable'))}</span></label>
      </div>
      <div class="field">
        <label>${esc(t('settings.defaultCwd'))}</label>
        <div class="row">
          <input type="text" id="s-cwd" value="${esc(s.shell.cwd)}" style="flex:1" />
          <button class="btn btn-sm" id="s-pick">${esc(t('common.select'))}</button>
        </div>
      </div>
      <div class="grid-2">
        <div class="field"><label>${esc(t('settings.cmdTimeout'))}</label><input type="number" id="s-shell-timeout" min="5" value="${esc(s.shell.timeoutSec)}" /></div>
        <div class="field"><label>${esc(t('settings.maxOutput'))}</label><input type="number" id="s-shell-max" min="1000" value="${esc(s.shell.maxOutputChars)}" /></div>
      </div>
    </div>`);
  $('#s-pick', shell).addEventListener('click', async () => {
    const p = await api.sys.pickFolder();
    if (p) $('#s-cwd', shell).value = p;
  });
  wrap.appendChild(shell);

  /* --- 禁止コマンド --- */
  const selectedCats = new Set(s.shell.denyCategories || []);
  const deny = el(`
    <div class="card">
      <h2 style="margin-bottom:var(--space-sm)">${esc(t('settings.denyTitle'))}</h2>
      <div class="section-note">${esc(t('settings.denyNote'))}</div>
      <div class="field">
        <label>${esc(t('settings.denyCategories'))}</label>
        <div id="s-deny-cats"></div>
      </div>
      <div class="field">
        <label>${esc(t('settings.trustedDomains'))} <span class="label-hint">${esc(t('settings.trustedDomainsHint'))}</span></label>
        <textarea id="s-trusted" rows="4">${esc((s.shell.trustedDomains || []).join('\n'))}</textarea>
      </div>
      <div class="field">
        <label>${esc(t('settings.customDeny'))} <span class="label-hint">${esc(t('settings.customDenyHint'))}</span></label>
        <textarea id="s-deny" rows="3">${esc((s.shell.denyPatterns || []).join('\n'))}</textarea>
      </div>
      <div class="field">
        <label>${esc(t('editor.denySection'))} — test</label>
        <div class="row">
          <input type="text" id="s-deny-test" placeholder="rm -rf /" style="flex:1" />
          <button class="btn btn-sm" id="s-deny-check">${esc(t('settings.testConnection'))}</button>
        </div>
        <p class="hint" id="s-deny-result" style="margin-top:var(--space-2xs);white-space:pre-line"></p>
      </div>
    </div>`);

  const catBox = $('#s-deny-cats', deny);
  for (const c of state.denyCategories) {
    const row = el(`<label class="checkbox">
      <input type="checkbox" ${selectedCats.has(c.id) ? 'checked' : ''} />
      <span>${esc(c.label)} <span class="label-hint">${esc(c.description)}</span></span>
    </label>`);
    $('input', row).addEventListener('change', (e) => {
      if (e.target.checked) selectedCats.add(c.id);
      else selectedCats.delete(c.id);
    });
    catBox.appendChild(row);
  }

  $('#s-deny-check', deny).addEventListener('click', async () => {
    const cmd = $('#s-deny-test', deny).value;
    if (!cmd) return;
    const r = await guard(() => api.deny.check(cmd));
    const out = $('#s-deny-result', deny);
    const lines = [r.denied ? `⛔ ${r.categoryId}/${r.ruleId} — ${r.why}` : '✔ OK'];
    for (const p of r.invalidPatterns || []) {
      lines.push(`⚠ ${p.kind}: "${p.pattern}" — ${p.reason}`);
    }
    out.textContent = lines.join('\n');
    out.className = r.denied || (r.invalidPatterns || []).length ? 'hint is-error' : 'hint';
  });
  wrap.appendChild(deny);

  /* --- CLI --- */
  const cli = el(`
    <div class="card">
      <h2 style="margin-bottom:var(--space-sm)">${esc(t('settings.cli'))}</h2>
      <div class="section-note">${t('settings.cliNote')}</div>
      <div class="field">
        <label>${esc(t('settings.connInfo'))}</label>
        <div class="log" id="cli-info" style="max-height:10rem">${esc(t('common.loading'))}</div>
      </div>
      <div class="row">
        <button class="btn btn-sm btn-primary" id="cli-install">${esc(t('settings.installCli'))}</button>
        <button class="btn btn-sm" id="open-data">${esc(t('settings.openDataDir'))}</button>
      </div>
    </div>`);

  api.runtime()
    .then((rt) => {
      $('#cli-info', cli).textContent =
        `API:   http://127.0.0.1:${rt.port}\nToken: ${rt.token}\nData:  ${rt.dataDir}\n\n` +
        `easyroo status\neasyroo stats --days 7\neasyroo memory <id>\neasyroo deny-check 'rm -rf /'`;
    })
    .catch(() => {});

  $('#cli-install', cli).addEventListener('click', async () => {
    const r = await guard(() => api.sys.installCli());
    if (r.installed) toast(t('settings.installed', { path: r.path }), 'success');
    else {
      toast(t('settings.installFailed'), 'warn');
      $('#cli-info', cli).textContent = r.manualCommand;
    }
  });
  $('#open-data', cli).addEventListener('click', () => api.sys.openDataDir());
  wrap.appendChild(cli);

  /* --- 保存 --- */
  const saveBar = el('<div class="row"></div>');
  saveBar.appendChild(
    btn(t('settings.saveAll'), 'btn-primary', async () => {
      const cfg = getProviderCfg ? getProviderCfg() : null;
      const patch = {
        activeProviderId: activeSel.value,
        providers: cfg ? s.providers.map((x) => (x.id === cfg.id ? { ...x, ...cfg } : x)) : s.providers,
        maxSteps: Number($('#s-maxsteps', safety).value) || 30,
        runTimeoutSec: Number($('#s-runtimeout', safety).value) || 1800,
        requestTimeoutSec: Number($('#s-reqtimeout', safety).value) || 300,
        temperature: Number($('#s-temp', safety).value),
        contextTokens: Number($('#s-ctx', safety).value) || 32768,
        reserveOutputTokens: Number($('#s-reserve-out', safety).value) || 4096,
        reservePromptTokens: Number($('#s-reserve-prompt', safety).value) || 2048,
        shell: {
          ...s.shell,
          enabled: $('#s-shell-enabled', shell).checked,
          cwd: $('#s-cwd', shell).value.trim(),
          timeoutSec: Number($('#s-shell-timeout', shell).value) || 120,
          maxOutputChars: Number($('#s-shell-max', shell).value) || 20000,
          denyCategories: [...selectedCats],
          trustedDomains: $('#s-trusted', deny).value.split('\n').map((x) => x.trim()).filter(Boolean),
          denyPatterns: $('#s-deny', deny).value.split('\n').map((x) => x.trim()).filter(Boolean),
        },
      };
      await guard(() => api.settings.save(patch), t('settings.savedAll'));
      refreshAll();
    })
  );
  wrap.appendChild(saveBar);

  return wrap;
}

/* ------------------------- ルーティング ------------------------- */

const VIEWS = { routines: viewRoutines, runs: viewRuns, stats: viewStats, mcp: viewMcp, settings: viewSettings };

function render() {
  const root = $('#view');
  const scroll = $('#main').scrollTop;
  root.innerHTML = '';
  try {
    root.appendChild(VIEWS[state.view]());
  } catch (e) {
    root.appendChild(el(`<div class="empty"><p>${esc(e.message)}</p></div>`));
  }
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $('#main').scrollTop = scroll;
}

function navigate(view) {
  state.view = view;
  render();
}

/* ------------------------- 起動 ------------------------- */

function boot() {
  applyLanguage(document.documentElement.dataset.language || 'system');
  applyTheme(currentTheme());

  $$('.nav-item').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.view)));

  $$('[data-theme-choice]').forEach((b) =>
    b.addEventListener('click', () => {
      applyTheme(b.dataset.themeChoice);
      api.settings.save({ ui: { ...(state.settings?.ui || {}), theme: b.dataset.themeChoice } }).catch(() => {});
    })
  );

  $$('[data-lang-choice]').forEach((b) =>
    b.addEventListener('click', () => {
      applyLanguage(b.dataset.langChoice);
      render();
      renderStatus();
      api.settings.save({ ui: { ...(state.settings?.ui || {}), language: b.dataset.langChoice } }).catch(() => {});
    })
  );

  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal-backdrop').classList.contains('hidden')) closeModal();
  });

  $('#btn-emergency').addEventListener('click', async () => {
    if (!confirm(t('nav.emergencyHint'))) return;
    const r = await guard(() => api.runs.emergencyStop());
    toast(t('status.running', { n: r.stopped }), 'warn');
    refreshAll();
  });

  api.on('routines-changed', () => refreshAll());
  api.on('runs-changed', () => refreshAll());
  // CLI や別プロセスから設定が変わった場合も画面へ反映する
  // (これが無いと、ターミナルで言語やテーマを変えても GUI が古いままになる)
  api.on('settings-changed', () => refreshAll());
  api.on('mcp-status', (s) => {
    state.mcp = s;
    if (state.view === 'mcp') render();
  });
  api.on('notice', (n) => toast(n.message, n.level === 'error' ? 'error' : 'info'));
  api.on('run-event', () => refreshOpenRun());

  refreshAll();
  startPolling();
}

/* ------------------------- 定期更新 -------------------------
   タイマーIDを保持し、ウィンドウが隠れている間は止め、閉じるときに必ず片付ける。
   前回の通信が終わる前に次を撃たないよう、実行中フラグでも守る。 */

const timers = { overview: null, openRun: null };
let overviewInFlight = false;

async function pollOverview() {
  if (overviewInFlight) return;
  overviewInFlight = true;
  try {
    state.overview = await api.overview();
    renderStatus();
  } catch (_) {
    // 一時的な失敗は無視してよい。次のティックで取り直す。
  } finally {
    overviewInFlight = false;
  }
}

function startPolling() {
  stopPolling();
  timers.overview = setInterval(pollOverview, 5000);
  timers.openRun = setInterval(refreshOpenRun, 1500);
}

function stopPolling() {
  for (const key of Object.keys(timers)) {
    if (timers[key] !== null) {
      clearInterval(timers[key]);
      timers[key] = null;
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);

// 画面が見えていない間はポーリングしない(無駄な通信と電力を使わない)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else if (timers.overview === null) {
    startPolling();
    refreshAll();
  }
});

// ウィンドウを閉じる / 再読み込みするときにタイマーを残さない
window.addEventListener('pagehide', stopPolling);
