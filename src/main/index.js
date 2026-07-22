'use strict';
// Electron メインプロセス。Engine を起動し、GUI(IPC)と制御API(HTTP)の両方に接続する。

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { Engine } = require('./engine');
const { ControlApi } = require('./api');
const { paths, ensureDirs } = require('./paths');

ensureDirs();

let engine = null;
let api = null;
let win = null;

// 未処理例外でアプリを落とさない。ログに残して動作を継続する。
function logCrash(kind, err) {
  try {
    const line = `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : err}\n`;
    fs.appendFileSync(path.join(paths.logs, 'main.log'), line);
  } catch (_) {}
  console.error(kind, err);
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

// tokens.css の --color-paper と同じ値。ウィンドウ枠の初期色を本文の紙色に合わせ、
// 起動直後に別テーマの色が一瞬見える現象を防ぐ。
const PAPER_LIGHT = '#f8f6f2';
const PAPER_DARK = '#1c1a17';

/** 保存済みのテーマ設定から、ウィンドウ背景に使う色を決める */
function paperColor() {
  const pref = engine ? engine.getSettings().ui?.theme : 'system';
  if (pref === 'light') return PAPER_LIGHT;
  if (pref === 'dark') return PAPER_DARK;
  return nativeTheme.shouldUseDarkColors ? PAPER_DARK : PAPER_LIGHT;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: 'EasyRoo',
    titleBarStyle: 'hiddenInset',
    backgroundColor: paperColor(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 外部リンクは既定ブラウザで開く(アプリ内遷移を許さない)
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

// OSの外観設定が変わったとき、'system' 追随ならウィンドウ枠の色も合わせる
nativeTheme.on('updated', () => {
  if (win && !win.isDestroyed()) {
    try {
      win.setBackgroundColor(paperColor());
    } catch (_) {}
  }
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(channel, payload);
    } catch (_) {}
  }
}

function wireEngineEvents() {
  engine.on('routines-changed', () => send('routines-changed'));
  engine.on('runs-changed', () => send('runs-changed'));
  engine.on('run-event', (e) => send('run-event', e));
  engine.on('run-output', (e) => send('run-output', e));
  engine.on('mcp-status', (s) => send('mcp-status', s));
  engine.on('mcp-log', (l) => send('mcp-log', l));
  engine.on('settings-changed', (s) => {
    send('settings-changed', s);
    if (win && !win.isDestroyed()) {
      try {
        win.setBackgroundColor(paperColor());
      } catch (_) {}
    }
  });
  engine.on('notice', (n) => {
    send('notice', n);
    // 完了/失敗は macOS 通知でも知らせる(ウィンドウを閉じていても気づける)
    try {
      if (Notification.isSupported()) {
        new Notification({ title: 'EasyRoo', body: String(n.message).slice(0, 200) }).show();
      }
    } catch (_) {}
  });
}

/** IPC ハンドラ。全て Engine のメソッドへ委譲する。 */
function registerIpc() {
  const H = {
    'app:overview': () => engine.overview(),
    'app:runtime': () => ({ port: api?.port, token: api?.token, dataDir: paths.dir }),

    'routines:list': () => engine.listRoutines(),
    'routines:get': (id) => engine.getRoutine(id),
    'routines:create': (data) => engine.createRoutine(data),
    'routines:update': ({ id, patch }) => engine.updateRoutine(id, patch),
    'routines:delete': (id) => engine.deleteRoutine(id),
    'routines:setEnabled': ({ id, enabled }) => engine.setEnabled(id, enabled),
    'routines:run': (id) => engine.startRun(id, 'gui'),
    'routines:stop': (id) => engine.stopRoutine(id, 'GUIからの停止'),

    'stats:get': (opts) => engine.stats(opts || {}),
    'runs:queued': () => engine.listQueued(),
    'runs:cancelQueued': (id) => engine.cancelQueued(id),
    'memory:get': (id) => engine.memoryRead(id),
    'memory:setState': ({ routineId, content }) => engine.memoryWriteState(routineId, content),
    'memory:appendJournal': ({ routineId, entry }) => engine.memoryAppendJournal(routineId, entry),
    'memory:clear': (id) => engine.memoryClear(id),
    'deny:categories': () => engine.denyCategories(),
    'deny:check': ({ command, routineId }) => engine.denyCheck(command, routineId),

    'runs:list': ({ limit, routineId }) => engine.listRuns(limit, routineId),
    'runs:get': (id) => engine.getRunDetail(id),
    'runs:stop': (id) => engine.stopRun(id, 'GUIからの停止'),
    'runs:stopAll': () => engine.stopAll('GUIからの全停止'),
    'runs:emergencyStop': () => engine.emergencyStop(),
    'scheduler:pause': (paused) => engine.pauseScheduler(paused),

    'settings:get': () => engine.getSettings(),
    'settings:save': (patch) => engine.saveSettings(patch),
    'settings:testProvider': (provider) => engine.testProvider(provider),

    'mcp:status': () => engine.mcpStatus(),
    'mcp:upsert': (cfg) => engine.mcpUpsert(cfg),
    'mcp:delete': (id) => engine.mcpDelete(id),
    'mcp:connect': (id) => engine.mcpConnect(id),
    'mcp:disconnect': (id) => engine.mcpDisconnect(id),
    'mcp:call': ({ serverId, tool, args }) => engine.mcpCallTool(serverId, tool, args),

    'sys:pickFolder': async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    },
    'sys:openDataDir': () => shell.openPath(paths.dir),
    'sys:installCli': () => installCli(),
  };

  for (const [channel, fn] of Object.entries(H)) {
    ipcMain.handle(channel, async (_e, payload) => {
      try {
        return { ok: true, data: await fn(payload) };
      } catch (err) {
        logCrash('ipc:' + channel, err);
        return { ok: false, error: err.message };
      }
    });
  }
}

/**
 * `easyroo` コマンドを /usr/local/bin に設置する。
 * ・パッケージ後のスクリプトは asar 内にあり直接実行できないため、asarUnpack した実体を指す。
 * ・利用者に Node が無くても動くよう、Node が見つからなければ同梱の Electron を
 *   ELECTRON_RUN_AS_NODE で Node として使うラッパーを書き出す。
 */
function cliScriptPath() {
  const p = path.join(__dirname, '..', '..', 'bin', 'easyroo.js');
  return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}

async function installCli() {
  const script = cliScriptPath();
  const electronBin = process.execPath; // パッケージ後は EasyRoo 本体の実行ファイル
  const dest = '/usr/local/bin/easyroo';

  const wrapper = `#!/bin/sh
# EasyRoo CLI ラッパー (EasyRoo.app により自動生成)
# node があればそれを使い、無ければ EasyRoo に同梱の Electron を Node として使う。
SCRIPT="${script}"
if command -v node >/dev/null 2>&1; then
  exec node "$SCRIPT" "$@"
else
  ELECTRON_RUN_AS_NODE=1 exec "${electronBin}" "$SCRIPT" "$@"
fi
`;

  try {
    fs.mkdirSync('/usr/local/bin', { recursive: true });
    fs.writeFileSync(dest, wrapper, { mode: 0o755 });
    fs.chmodSync(dest, 0o755);
    return { installed: true, path: dest };
  } catch (e) {
    // /usr/local/bin への書き込みには管理者権限が要る場合がある。手動用の手順を返す。
    const tmp = path.join(app.getPath('temp'), 'easyroo-cli-install.sh');
    try {
      fs.writeFileSync(tmp, wrapper, { mode: 0o755 });
    } catch (_) {}
    return {
      installed: false,
      error: e.message,
      manualCommand: `sudo mkdir -p /usr/local/bin && sudo cp "${tmp}" /usr/local/bin/easyroo && sudo chmod +x /usr/local/bin/easyroo`,
    };
  }
}

function buildMenu() {
  const template = [
    {
      label: 'EasyRoo',
      submenu: [
        { role: 'about', label: 'EasyRoo について' },
        { type: 'separator' },
        {
          label: '全ルーティーンを緊急停止',
          accelerator: 'CmdOrCtrl+Shift+.',
          click: () => {
            engine.emergencyStop();
            send('notice', { level: 'warn', message: '緊急停止しました。スケジューラも一時停止しています。' });
          },
        },
        { label: 'データフォルダを開く', click: () => shell.openPath(paths.dir) },
        { type: 'separator' },
        { role: 'hide', label: '隠す' },
        { role: 'quit', label: 'EasyRoo を終了' },
      ],
    },
    { label: '編集', submenu: [{ role: 'undo', label: '取り消す' }, { role: 'redo', label: 'やり直す' }, { type: 'separator' }, { role: 'cut', label: 'カット' }, { role: 'copy', label: 'コピー' }, { role: 'paste', label: 'ペースト' }, { role: 'selectAll', label: 'すべて選択' }] },
    { label: '表示', submenu: [{ role: 'reload', label: '再読み込み' }, { role: 'toggleDevTools', label: '開発者ツール' }, { type: 'separator' }, { role: 'resetZoom', label: '標準サイズ' }, { role: 'zoomIn', label: '拡大' }, { role: 'zoomOut', label: '縮小' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'フルスクリーン' }] },
    { role: 'windowMenu', label: 'ウインドウ' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 多重起動を防ぐ(スケジューラの二重発火を根本から防止)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else createWindow();
  });

  app.whenReady().then(async () => {
    engine = new Engine();
    // Electron が解決した OS ロケールを使う(CLI と違い app.getLocale() が正確)
    engine.applyLanguage(app.getLocale());
    wireEngineEvents();
    registerIpc();
    await engine.init();

    const settings = engine.getSettings();
    if (settings.api?.enabled !== false) {
      api = new ControlApi(engine);
      try {
        const port = await api.start(settings.api?.port || 8787);
        console.log(`[EasyRoo] 制御APIを起動しました: http://127.0.0.1:${port}`);
      } catch (e) {
        logCrash('api:start', e);
      }
    }

    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS の慣習に合わせ、ウィンドウを閉じてもスケジューラは動き続ける
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async () => {
    try {
      api?.stop();
      await engine?.shutdown();
    } catch (e) {
      logCrash('shutdown', e);
    }
  });
}
