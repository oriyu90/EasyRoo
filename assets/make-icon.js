#!/usr/bin/env node
'use strict';
// アプリアイコン生成。
// 元絵は作業フォルダの IMG_0147.ico（256px・ループ＋再生記号）。
// 256px のままでは Retina (1024px) に足りないため、採寸した形状を 1024px で描き直す。
// 外部ツール・依存パッケージなしで PNG を書き出す（zlib のみ使用）。
//
// ── 使い方 ────────────────────────────────────────────────
//   npm run icon      … icon.png と icon.icns をまとめて再生成する
//
// 図案を差し替える場合は、下の GLYPH 定数（元絵 256px 座標系での採寸値）を
// 直してから実行する。採寸には、元絵を ASCII マップに落とすのが早い:
//   sips -s format png 新しい図案.ico --out /tmp/src.png
//   （/tmp/src.png を読み、白画素の座標を拾って GLYPH を調整する）
// ─────────────────────────────────────────────────────────

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 1024; // 出力サイズ
const SS = 3; // スーパーサンプリング倍率（アンチエイリアス用）

// --- 元絵(256px座標系)から実測した形状 ---
const SRC = 256;
const GLYPH = {
  rect: { x0: 38, y0: 72, x1: 217, y1: 183, r: 27, stroke: 13 },
  gap: { x0: 106, x1: 126 }, // 下辺の切れ目（矢印が貫くところ）
  arrow: [
    [82, 154],
    [82, 202],
    [126, 178],
  ],
};

// macOS アプリアイコンの規約: 1024 のキャンバスに対し本体は約 824、角丸は約 185
const BODY = 824;
const INSET = (S - BODY) / 2;
const BODY_R = 185;
// 元絵は矢印が下に張り出して重心が下寄りなので、視覚的中心に合わせて少し持ち上げる
const SCALE = BODY / SRC;
const OFF_X = INSET;
const OFF_Y = INSET - 26 * SCALE;

const tx = (x) => OFF_X + x * SCALE;
const ty = (y) => OFF_Y + y * SCALE;

/* ---------- 図形判定（元絵の座標系で判定する） ---------- */

// 角丸長方形の内部か
function inRoundRect(x, y, r0) {
  const { x0, y0, x1, y1, r } = r0;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// 三角形の内部か
function inTriangle(x, y, t) {
  const [[ax, ay], [bx, by], [cx, cy]] = t;
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  return a >= 0 && b >= 0 && a + b <= 1;
}

/** グリフ（白い部分）に含まれるか。元絵座標で判定。 */
function inGlyph(x, y) {
  const { rect, gap, arrow } = GLYPH;
  // 矢印
  if (inTriangle(x, y, arrow)) return true;
  // 角丸長方形の輪郭（外側にあって内側にない部分）
  const inner = {
    x0: rect.x0 + rect.stroke,
    y0: rect.y0 + rect.stroke,
    x1: rect.x1 - rect.stroke,
    y1: rect.y1 - rect.stroke,
    r: Math.max(2, rect.r - rect.stroke),
  };
  if (inRoundRect(x, y, rect) && !inRoundRect(x, y, inner)) {
    // 下辺の切れ目は描かない
    if (y > rect.y1 - rect.stroke - 1 && x > gap.x0 && x < gap.x1) return false;
    return true;
  }
  return false;
}

/** 本体（角丸スクエア）に含まれるか。出力座標で判定。 */
function inBody(px, py) {
  const x0 = INSET, y0 = INSET, x1 = S - INSET, y1 = S - INSET;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + BODY_R), x1 - BODY_R);
  const cy = Math.min(Math.max(py, y0 + BODY_R), y1 - BODY_R);
  return (px - cx) ** 2 + (py - cy) ** 2 <= BODY_R * BODY_R;
}

/* ---------- 配色 ---------- */
// アプリのトークンと同じアンカー色相(60)。純黒 #000 は使わずわずかに暖色へ寄せる。
const BG = [17, 16, 14]; // oklch(≒14% 0.006 60) 相当
const FG = [247, 246, 243]; // 紙白（純白 #fff は使わない）

/* ---------- ラスタライズ ---------- */
const px = Buffer.alloc(S * S * 4);

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let bodyHits = 0;
    let glyphHits = 0;
    const n = SS * SS;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        if (!inBody(fx, fy)) continue;
        bodyHits++;
        // 出力座標 → 元絵座標へ逆変換
        const gx = (fx - OFF_X) / SCALE;
        const gy = (fy - OFF_Y) / SCALE;
        if (inGlyph(gx, gy)) glyphHits++;
      }
    }
    const i = (y * S + x) * 4;
    if (!bodyHits) {
      px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
      continue;
    }
    const alpha = Math.round((bodyHits / n) * 255);
    const g = glyphHits / bodyHits; // 本体内でのグリフ被覆率
    px[i] = Math.round(BG[0] + (FG[0] - BG[0]) * g);
    px[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * g);
    px[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * g);
    px[i + 3] = alpha;
  }
}

/* ---------- PNG 書き出し ---------- */
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('生成しました:', out, `(${png.length} bytes)`);
