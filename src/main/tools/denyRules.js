'use strict';
/* 禁止コマンドの規則エンジン。
 *
 * v1.0 で単純な部分一致から正規表現ベースへ刷新した。部分一致では
 *   - 「rm -fr」「rm -Rf」のような並び替えを取りこぼす
 *   - 逆に文字列がたまたま含まれる無害なコマンドまで止めてしまう
 * という取りこぼしと過検出の両方が起きるため。
 *
 * カテゴリ単位で有効・無効を切り替えられ、ルーティーンごとに上書きできる。
 * ネットワーク系だけは「信頼ドメイン宛なら通す」という条件付き許可を持つ。
 */

/** 既定で信頼するホスト。ここ宛のネットワーク操作は許可する。 */
const DEFAULT_TRUSTED_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '::1',
  'github.com',
  'raw.githubusercontent.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
];

/** ネットワークに出るコマンド名 */
const NETWORK_COMMANDS = ['ssh', 'scp', 'rsync', 'sftp', 'ftp', 'telnet', 'nc', 'netcat', 'curl', 'wget'];

const CATEGORIES = [
  {
    id: 'destructive',
    labelKey: 'deny.destructive',
    descKey: 'deny.destructive.desc',
    severity: 'critical',
    rules: [
      // 重要なパスを対象にした再帰削除。-f が無くても止める。
      {
        id: 'rm-sensitive-path',
        re: /\brm\b[^\n;|&]*?\s-{1,2}[a-zA-Z-]*\s*(?:[^\n;|&]*\s)?(\/|~\/?|\$HOME|\/System|\/Library|\/Applications|\/Users)(\s|\/|\*|$)/,
        why: 'rm on a system path',
      },
      // -r と -f の両方が立っている rm(並び順・大文字小文字を問わない)
      { id: 'rm-rf', re: /\brm\s+(?:-\S+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*[fF]|\brm\s+(?:-\S+\s+)*-[a-zA-Z]*[fF][a-zA-Z]*[rR]/, why: 'rm -rf' },
      { id: 'rm-rf-long', re: /\brm\b[^\n]*--recursive[^\n]*--force|\brm\b[^\n]*--force[^\n]*--recursive/, why: 'rm --recursive --force' },
      { id: 'find-delete', re: /\bfind\b[^\n]*\s-delete\b/, why: 'find -delete' },
      { id: 'find-exec-rm', re: /\bfind\b[^\n]*-exec\s+rm\b/, why: 'find -exec rm' },
      { id: 'diskutil-erase', re: /\bdiskutil\s+(erase\w*|partitionDisk|reformat|zeroDisk)\b/i, why: 'diskutil erase/partition' },
      { id: 'newfs', re: /\bnewfs_\w+/, why: 'newfs_*' },
      { id: 'mkfs', re: /\bmkfs(\.\w+)?\b/, why: 'mkfs*' },
      { id: 'dd-write', re: /\bdd\b[^\n]*\bof=/, why: 'dd of=' },
      { id: 'redirect-disk', re: />\s*\/dev\/r?disk\d/, why: 'write to /dev/disk' },
      { id: 'gpt-modify', re: /\bgpt\s+(destroy|create|add|remove|recover)\b/, why: 'gpt destructive subcommand' },
      { id: 'fork-bomb', re: /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/, why: 'fork bomb' },
    ],
  },
  {
    id: 'remoteExec',
    labelKey: 'deny.remoteExec',
    descKey: 'deny.remoteExec.desc',
    severity: 'critical',
    rules: [
      {
        id: 'pipe-to-shell',
        re: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|python3?|node|ruby|perl)\b/,
        why: 'curl | sh',
      },
      { id: 'process-substitution', re: /\b(sh|bash|zsh)\b[^\n]*<\(\s*(curl|wget)\b/, why: 'bash <(curl …)' },
      { id: 'eval-download', re: /\beval\b[^\n]*\b(curl|wget)\b/, why: 'eval with curl/wget' },
    ],
  },
  {
    id: 'permissions',
    labelKey: 'deny.permissions',
    descKey: 'deny.permissions.desc',
    severity: 'high',
    rules: [
      { id: 'chmod-wide', re: /\bchmod\b[^\n]*\b(777|666|000)\b/, why: 'chmod 777/666/000' },
      { id: 'chmod-recursive', re: /\bchmod\s+(?:-\S+\s+)*-[a-zA-Z]*R\b|\bchmod\b[^\n]*--recursive/, why: 'chmod -R' },
      { id: 'chown-recursive', re: /\bchown\s+(?:-\S+\s+)*-[a-zA-Z]*R\b|\bchown\b[^\n]*--recursive/, why: 'chown -R' },
    ],
  },
  {
    id: 'gitDestructive',
    labelKey: 'deny.gitDestructive',
    descKey: 'deny.gitDestructive.desc',
    severity: 'high',
    rules: [
      { id: 'git-reset-hard', re: /\bgit\b[^\n]*\breset\b[^\n]*--hard/, why: 'git reset --hard' },
      { id: 'git-clean-force', re: /\bgit\b[^\n]*\bclean\b[^\n]*-[a-zA-Z]*[fdx]/, why: 'git clean -fdx' },
      { id: 'git-push-force', re: /\bgit\b[^\n]*\bpush\b[^\n]*(--force(?!-with-lease)|\s-f\b)/, why: 'git push --force' },
      { id: 'git-rebase-onto', re: /\bgit\b[^\n]*\brebase\b[^\n]*--onto/, why: 'git rebase --onto' },
      { id: 'git-filter', re: /\bgit\b[^\n]*\b(filter-repo|filter-branch)\b/, why: 'git filter-repo' },
      { id: 'git-branch-delete-force', re: /\bgit\b[^\n]*\bbranch\b[^\n]*-D\b/, why: 'git branch -D' },
    ],
  },
  {
    id: 'systemControl',
    labelKey: 'deny.systemControl',
    descKey: 'deny.systemControl.desc',
    severity: 'critical',
    rules: [
      { id: 'shutdown', re: /\bshutdown\b/, why: 'shutdown' },
      { id: 'reboot', re: /\breboot\b/, why: 'reboot' },
      { id: 'halt', re: /\bhalt\b/, why: 'halt' },
      { id: 'launchctl-remove', re: /\blaunchctl\s+(bootout|unload|remove|disable)\b/, why: 'launchctl bootout/unload' },
      { id: 'systemsetup', re: /\bsystemsetup\s+-set/, why: 'systemsetup -set…' },
      { id: 'spctl-disable', re: /\bspctl\s+--master-disable\b/, why: 'spctl --master-disable' },
      { id: 'csrutil-disable', re: /\bcsrutil\s+disable\b/, why: 'csrutil disable' },
    ],
  },
  {
    id: 'network',
    labelKey: 'deny.network',
    descKey: 'deny.network.desc',
    severity: 'medium',
    // このカテゴリは条件付き。宛先がすべて信頼ドメインなら許可する。
    conditional: 'trustedDomains',
    rules: [
      { id: 'network-command', re: new RegExp(`\\b(${NETWORK_COMMANDS.join('|')})\\b`), why: 'network command' },
    ],
  },
  {
    id: 'packageManager',
    labelKey: 'deny.packageManager',
    descKey: 'deny.packageManager.desc',
    severity: 'medium',
    rules: [
      { id: 'brew-uninstall', re: /\bbrew\s+(uninstall|remove|rm)\b/, why: 'brew uninstall' },
      { id: 'brew-cleanup', re: /\bbrew\s+cleanup\b/, why: 'brew cleanup' },
      { id: 'brew-services-stop', re: /\bbrew\s+services\s+(stop|kill)\b/, why: 'brew services stop' },
    ],
  },
  {
    id: 'privilege',
    labelKey: 'deny.privilege',
    descKey: 'deny.privilege.desc',
    severity: 'critical',
    rules: [
      { id: 'sudo', re: /\bsudo\b/, why: 'sudo' },
      { id: 'su-root', re: /\bsu\s+(-|root|\-l)\b/, why: 'su' },
      { id: 'doas', re: /\bdoas\b/, why: 'doas' },
    ],
  },
];

/** 既定で有効にするカテゴリ。ネットワークも含む(信頼ドメインは通るため実用性は保たれる)。 */
const DEFAULT_CATEGORIES = CATEGORIES.map((c) => c.id);

/* ------------------------- ホスト抽出 ------------------------- */

/** コマンド行から接続先ホスト名を取り出す。 */
function extractHosts(command) {
  const hosts = new Set();
  const cmd = String(command);

  // http(s)://host/... 形式
  for (const m of cmd.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s'"]+)/gi)) {
    hosts.add(m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase());
  }
  // user@host:path 形式(scp / rsync / ssh)
  for (const m of cmd.matchAll(/(?:^|\s)(?:[\w.-]+@)([\w.-]+)(?::|\s|$)/g)) {
    hosts.add(m[1].toLowerCase());
  }
  // ssh host / nc host port のように、フラグでない最初の引数がホストになる形式
  const bare = /\b(ssh|sftp|telnet|nc|netcat)\s+((?:-\S+\s+)*)([\w.-]+)/.exec(cmd);
  if (bare && !bare[3].includes('/')) hosts.add(bare[3].toLowerCase());

  // scp / rsync の user 省略形 "host:path"(ドメイン形か IP のときだけ拾う)。
  // "https://…" のような URL や、Makefile のターゲット指定と取り違えないようにする。
  for (const m of cmd.matchAll(/(?:^|\s)((?:[\w-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}):(?!\/\/)\S*/gi)) {
    hosts.add(m[1].toLowerCase());
  }

  return [...hosts];
}

/** ホストが信頼ドメインに含まれるか(完全一致 または サブドメイン) */
function isTrustedHost(host, trusted) {
  const h = String(host).toLowerCase();
  return trusted.some((d) => {
    const t = String(d).toLowerCase().trim();
    if (!t) return false;
    return h === t || h.endsWith('.' + t);
  });
}

/* ------------------------- 判定 ------------------------- */

/* --- 利用者パターンの安全な取り扱い ---
 *
 * 禁止/許可パターンは利用者が自由に書けるため、そのまま new RegExp すると
 *   - (a+)+ のような入れ子量指定子で指数時間になる(ReDoS)
 *   - 判定のたびにコンパイルし直して無駄が出る
 * という問題がある。ここでコンパイル結果をキャッシュしつつ、危険な形を弾く。
 */

/** パターン文字列の上限。実用上これを超える禁止パターンは書かない。 */
const MAX_PATTERN_LENGTH = 400;

/** 破滅的バックトラックを招きやすい形。量指定子を含むグループ全体に、さらに量指定子が付くもの。 */
const NESTED_QUANTIFIER = [
  // (a+)+ / (a*)* / (\d{1,9}){2,} など
  /\([^()]*(?:[*+]|\{\d+(?:,\d*)?\})[^()]*\)\s*(?:[*+]|\{\d+(?:,\d*)?\})/,
  // [a-z]*[a-z]* のように、同じ文字クラスの量指定子が連続するもの
  /(\[[^\]]+\])\s*(?:[*+]|\{\d+(?:,\d*)?\})\s*\1\s*(?:[*+]|\{\d+(?:,\d*)?\})/,
];

/** コンパイル済み正規表現の入れ物。パターン文字列 → RegExp または null(不採用)。 */
const patternCache = new Map();
const PATTERN_CACHE_LIMIT = 500;

/**
 * 利用者パターンを検査する。
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function validatePattern(pattern) {
  const s = String(pattern ?? '');
  if (!s) return { ok: false, reason: 'empty' };
  if (s.length > MAX_PATTERN_LENGTH) return { ok: false, reason: `too long (> ${MAX_PATTERN_LENGTH})` };
  if (NESTED_QUANTIFIER.some((re) => re.test(s))) return { ok: false, reason: 'nested quantifier (ReDoS risk)' };
  return { ok: true };
}

/**
 * 文字列パターンを正規表現へ。
 * 正規表現として不正なら、そのまま部分一致(リテラル)として扱う。
 * 破滅的バックトラックを招く形や長すぎるものは採用せず null を返す。
 */
function toRegExp(pattern) {
  const key = String(pattern ?? '');
  if (patternCache.has(key)) return patternCache.get(key);

  let re = null;
  const v = validatePattern(key);
  if (v.ok) {
    try {
      re = new RegExp(key);
    } catch (_) {
      // 正規表現として不正 → リテラル一致にフォールバック。この形は安全。
      re = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }

  // 素朴な上限。設定を書き換え続けても無制限には増やさない。
  if (patternCache.size >= PATTERN_CACHE_LIMIT) patternCache.clear();
  patternCache.set(key, re);
  return re;
}

/**
 * コマンドを評価する。
 * @param {string} command
 * @param {object} policy
 *   { categories: string[], trustedDomains: string[], extraPatterns: string[], allowPatterns: string[] }
 * @returns {{denied:boolean, ruleId?:string, categoryId?:string, why?:string}}
 */
function evaluate(command, policy = {}) {
  const cmd = String(command || '');
  const categories = Array.isArray(policy.categories) ? policy.categories : DEFAULT_CATEGORIES;
  const trusted = Array.isArray(policy.trustedDomains) && policy.trustedDomains.length
    ? policy.trustedDomains
    : DEFAULT_TRUSTED_DOMAINS;

  // 明示的な許可パターンが最優先(利用者が意図的に開けた穴)。
  // 採用できないパターン(null)は「許可しない」側に倒す。
  for (const p of policy.allowPatterns || []) {
    const re = p ? toRegExp(p) : null;
    if (re && re.test(cmd)) return { denied: false };
  }

  // 利用者が追加した禁止パターン
  for (const p of policy.extraPatterns || []) {
    const re = p ? toRegExp(p) : null;
    if (re && re.test(cmd)) {
      return { denied: true, ruleId: 'custom', categoryId: 'custom', why: p };
    }
  }

  for (const cat of CATEGORIES) {
    if (!categories.includes(cat.id)) continue;
    for (const rule of cat.rules) {
      if (!rule.re.test(cmd)) continue;

      // 条件付きカテゴリ: 宛先がすべて信頼ドメインなら通す
      if (cat.conditional === 'trustedDomains') {
        const hosts = extractHosts(cmd);
        // 宛先が読み取れない場合(例: curl --version)は通信しないとみなし許可
        if (hosts.length === 0) continue;
        if (hosts.every((h) => isTrustedHost(h, trusted))) continue;
        return {
          denied: true,
          ruleId: rule.id,
          categoryId: cat.id,
          why: `${rule.why} → ${hosts.filter((h) => !isTrustedHost(h, trusted)).join(', ')}`,
        };
      }

      return { denied: true, ruleId: rule.id, categoryId: cat.id, why: rule.why };
    }
  }

  return { denied: false };
}

/** GUI/CLI 表示用のカテゴリ一覧(正規表現は含めない) */
function listCategories() {
  return CATEGORIES.map((c) => ({
    id: c.id,
    labelKey: c.labelKey,
    descKey: c.descKey,
    severity: c.severity,
    conditional: c.conditional || null,
    ruleCount: c.rules.length,
    examples: c.rules.slice(0, 4).map((r) => r.why),
  }));
}

/**
 * ルーティーンの設定と全体設定から、実際に適用するポリシーを組み立てる。
 * ルーティーン側が null/未設定なら全体設定を引き継ぐ。
 */
function resolvePolicy(globalShell = {}, routineDeny = null) {
  const base = {
    categories: Array.isArray(globalShell.denyCategories) ? globalShell.denyCategories : DEFAULT_CATEGORIES,
    trustedDomains: Array.isArray(globalShell.trustedDomains) && globalShell.trustedDomains.length
      ? globalShell.trustedDomains
      : DEFAULT_TRUSTED_DOMAINS,
    extraPatterns: Array.isArray(globalShell.denyPatterns) ? globalShell.denyPatterns : [],
    allowPatterns: Array.isArray(globalShell.allowPatterns) ? globalShell.allowPatterns : [],
  };
  if (!routineDeny || routineDeny.inherit !== false) {
    // 引き継ぎつつ、ルーティーン固有の追加分だけ足す
    return {
      categories: base.categories,
      trustedDomains: [...base.trustedDomains, ...(routineDeny?.trustedDomains || [])],
      extraPatterns: [...base.extraPatterns, ...(routineDeny?.extraPatterns || [])],
      allowPatterns: [...base.allowPatterns, ...(routineDeny?.allowPatterns || [])],
    };
  }
  // 引き継がない: ルーティーン側だけで完結させる
  return {
    categories: Array.isArray(routineDeny.categories) ? routineDeny.categories : DEFAULT_CATEGORIES,
    trustedDomains: routineDeny.trustedDomains?.length ? routineDeny.trustedDomains : DEFAULT_TRUSTED_DOMAINS,
    extraPatterns: routineDeny.extraPatterns || [],
    allowPatterns: routineDeny.allowPatterns || [],
  };
}

module.exports = {
  CATEGORIES,
  DEFAULT_CATEGORIES,
  DEFAULT_TRUSTED_DOMAINS,
  NETWORK_COMMANDS,
  MAX_PATTERN_LENGTH,
  validatePattern,
  evaluate,
  listCategories,
  resolvePolicy,
  extractHosts,
  isTrustedHost,
};
