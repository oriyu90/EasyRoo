'use strict';
// アプリのデータ配置を一元管理する。Electron の app が使えない文脈(CLI/テスト)でも動くようにする。
const os = require('os');
const path = require('path');
const fs = require('fs');

function baseDir() {
  if (process.env.EASYROO_HOME) return path.resolve(process.env.EASYROO_HOME);
  return path.join(os.homedir(), 'Library', 'Application Support', 'EasyRoo');
}

const DIR = baseDir();

const paths = {
  dir: DIR,
  settings: path.join(DIR, 'settings.json'),
  routines: path.join(DIR, 'routines.json'),
  mcp: path.join(DIR, 'mcp.json'),
  runtime: path.join(DIR, 'runtime.json'), // APIポート/トークン。CLIが読む
  runs: path.join(DIR, 'runs'),
  logs: path.join(DIR, 'logs'),
  workspace: path.join(DIR, 'workspace'), // ルーティーンの既定 cwd
  // ルーティーンごとの長期記憶(STATE/JOURNAL)。
  // paths.routines は routines.json を指すため、別名にして衝突を避ける。
  memory: path.join(DIR, 'memory'),
};

function ensureDirs() {
  for (const d of [paths.dir, paths.runs, paths.logs, paths.workspace, paths.memory]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return paths;
}

module.exports = { paths, ensureDirs };
