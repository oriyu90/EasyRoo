'use strict';
/* コンテキスト予算の管理。
 *
 * 課題: v1.0 初期は履歴の上限を「固定 60,000 文字」で持っていた。これは
 *   - 128k 窓のモデルでは過剰に切り詰めてしまい、
 *   - 8k 窓のモデルでは足りずに溢れる
 * という両方の失敗を同時に起こす。さらに日本語と英語では 1 文字あたりの
 * トークン数が数倍違うため、文字数基準そのものが当てにならない。
 *
 * 方針(OpenClaw の "model window minus built-in headroom" に倣う):
 *   予算 = モデルの窓 − 出力用の余白 − プロンプト用の余白
 *
 * トークン数の推定は、正確なトークナイザを内蔵せずに行う必要がある。
 * EasyRoo は任意の OpenAI 互換エンドポイントを相手にするため、
 * モデルごとのトークナイザを持てないからである。
 * 代わりに「実際に送った文字数」と「API が返した prompt_tokens」から
 * 1 トークンあたりの文字数を逆算し、実行しながら較正する。
 */

// 較正前の既定値。日本語混在を考慮した保守側(小さいほど多めにトークンを見積もる)。
const DEFAULT_CHARS_PER_TOKEN = 2.0;

// 較正値として受け入れる範囲。外れ値で予算が壊れないように挟む。
const MIN_CHARS_PER_TOKEN = 0.5; // ほぼ全て CJK の場合
const MAX_CHARS_PER_TOKEN = 6.0; // ほぼ全て英数字の場合

// 較正の平滑化係数(指数移動平均)。1回の外れ値で大きく振れないようにする。
const CALIBRATION_ALPHA = 0.3;

class ContextBudget {
  /**
   * @param {object} opts
   *   contextTokens  モデルの窓(トークン)
   *   reserveOutput  モデルの応答に確保するトークン
   *   reservePrompt  システムプロンプト・ツール定義の分として確保するトークン
   */
  constructor({ contextTokens = 32768, reserveOutput = 4096, reservePrompt = 2048 } = {}) {
    this.contextTokens = Math.max(2048, Number(contextTokens) || 32768);
    this.reserveOutput = Math.max(256, Number(reserveOutput) || 4096);
    this.reservePrompt = Math.max(256, Number(reservePrompt) || 2048);
    this.charsPerToken = DEFAULT_CHARS_PER_TOKEN;
    this.calibrations = 0;
    // 実際に超過を食らったときに縮める係数。
    // charsPerToken(=実測にもとづく推定値)とは役割を分けている。
    // 同じ変数で兼ねると、次の較正で安全余裕が消えてしまうため。
    this.safetyFactor = 1;
  }

  /** 超過を観測したときに予算を恒久的に絞る */
  tighten(factor = 0.8) {
    this.safetyFactor = Math.max(0.4, this.safetyFactor * factor);
    return this.safetyFactor;
  }

  /** 履歴に使ってよいトークン数 */
  budgetTokens() {
    // 余白が窓を食い潰さないよう、最低でも窓の 25% は履歴に残す
    const floor = Math.floor(this.contextTokens * 0.25);
    const raw = Math.max(floor, this.contextTokens - this.reserveOutput - this.reservePrompt);
    return Math.floor(raw * this.safetyFactor);
  }

  /** 履歴に使ってよい文字数(現在の較正値による換算) */
  budgetChars() {
    return Math.floor(this.budgetTokens() * this.charsPerToken);
  }

  /** 文字数からトークン数を推定する */
  estimateTokens(chars) {
    return Math.ceil(Number(chars || 0) / this.charsPerToken);
  }

  /**
   * 実測から 1 トークンあたりの文字数を較正する。
   * @param {number} chars       実際に送ったプロンプトの文字数
   * @param {number} promptTokens API が報告した prompt_tokens
   */
  calibrate(chars, promptTokens) {
    if (!chars || !promptTokens || promptTokens <= 0) return this.charsPerToken;
    const observed = chars / promptTokens;
    if (!Number.isFinite(observed)) return this.charsPerToken;

    const clamped = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, observed));
    // 初回は実測をそのまま採用し、以降は平滑化する
    this.charsPerToken =
      this.calibrations === 0
        ? clamped
        : this.charsPerToken * (1 - CALIBRATION_ALPHA) + clamped * CALIBRATION_ALPHA;
    this.calibrations++;
    return this.charsPerToken;
  }

  /** 現在の状態(ログ・実測値の表示用) */
  snapshot() {
    return {
      contextTokens: this.contextTokens,
      budgetTokens: this.budgetTokens(),
      budgetChars: this.budgetChars(),
      charsPerToken: Math.round(this.charsPerToken * 100) / 100,
      calibrations: this.calibrations,
      safetyFactor: Math.round(this.safetyFactor * 100) / 100,
    };
  }
}

/**
 * LLM のエラーがコンテキスト超過を示しているか。
 * プロバイダごとに文言が違うため、代表的な言い回しを広めに拾う。
 * 誤検出しても「圧縮して 1 回再試行する」だけなので、取りこぼすより広く取る。
 */
function isContextOverflowError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('context length') ||
    msg.includes('context_length') ||
    msg.includes('maximum context') ||
    msg.includes('context window') ||
    msg.includes('too many tokens') ||
    msg.includes('prompt is too long') ||
    msg.includes('reduce the length') ||
    msg.includes('exceeds the model') ||
    msg.includes('context overflow')
  );
}

module.exports = {
  ContextBudget,
  isContextOverflowError,
  DEFAULT_CHARS_PER_TOKEN,
};
