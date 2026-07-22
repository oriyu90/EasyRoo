'use strict';
// レンダラに公開する API。contextIsolation 有効・nodeIntegration 無効のため、
// レンダラは Node に一切触れず、ここで定義したチャンネルのみ利用できる。

const { contextBridge, ipcRenderer } = require('electron');

// 呼び出しは全て {ok, data|error} に正規化されている。エラーは例外として投げ直す。
function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload).then((r) => {
    if (r && r.ok) return r.data;
    throw new Error(r?.error || '不明なエラー');
  });
}

const EVENTS = [
  'routines-changed',
  'runs-changed',
  'run-event',
  'run-output',
  'mcp-status',
  'mcp-log',
  'settings-changed',
  'notice',
];

contextBridge.exposeInMainWorld('easyroo', {
  overview: () => invoke('app:overview'),
  runtime: () => invoke('app:runtime'),

  routines: {
    list: () => invoke('routines:list'),
    get: (id) => invoke('routines:get', id),
    create: (data) => invoke('routines:create', data),
    update: (id, patch) => invoke('routines:update', { id, patch }),
    remove: (id) => invoke('routines:delete', id),
    setEnabled: (id, enabled) => invoke('routines:setEnabled', { id, enabled }),
    run: (id) => invoke('routines:run', id),
    stop: (id) => invoke('routines:stop', id),
  },

  runs: {
    list: (opts) => invoke('runs:list', opts || {}),
    get: (id) => invoke('runs:get', id),
    stop: (id) => invoke('runs:stop', id),
    stopAll: () => invoke('runs:stopAll'),
    emergencyStop: () => invoke('runs:emergencyStop'),
    queued: () => invoke('runs:queued'),
    cancelQueued: (routineId) => invoke('runs:cancelQueued', routineId),
  },

  scheduler: { pause: (paused) => invoke('scheduler:pause', paused) },

  stats: (opts) => invoke('stats:get', opts || {}),

  memory: {
    get: (routineId) => invoke('memory:get', routineId),
    setState: (routineId, content) => invoke('memory:setState', { routineId, content }),
    appendJournal: (routineId, entry) => invoke('memory:appendJournal', { routineId, entry }),
    clear: (routineId) => invoke('memory:clear', routineId),
  },

  deny: {
    categories: () => invoke('deny:categories'),
    check: (command, routineId) => invoke('deny:check', { command, routineId }),
  },

  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
    testProvider: (p) => invoke('settings:testProvider', p),
  },

  mcp: {
    status: () => invoke('mcp:status'),
    upsert: (cfg) => invoke('mcp:upsert', cfg),
    remove: (id) => invoke('mcp:delete', id),
    connect: (id) => invoke('mcp:connect', id),
    disconnect: (id) => invoke('mcp:disconnect', id),
    call: (serverId, tool, args) => invoke('mcp:call', { serverId, tool, args }),
  },

  sys: {
    pickFolder: () => invoke('sys:pickFolder'),
    openDataDir: () => invoke('sys:openDataDir'),
    installCli: () => invoke('sys:installCli'),
  },

  on: (event, cb) => {
    if (!EVENTS.includes(event)) throw new Error('不明なイベント: ' + event);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
