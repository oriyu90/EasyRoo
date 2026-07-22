# サードパーティ ライセンス表記

EasyRoo は MIT License (Copyright © 2026 yuki_orita) で配布されます。
本ファイルは、EasyRoo が同梱・参照する第三者ソフトウェアのライセンス表記です。

配布物内の実際のライセンス全文は、アプリケーションバンドル内の
`EasyRoo.app/Contents/Resources/licenses/` に同梱されています。

---

## 1. 実行時の npm 依存パッケージ

**なし。** EasyRoo は実行時の依存パッケージを一切持ちません（`dependencies: {}`）。
アプリケーションコードは Node.js 標準モジュールと Electron API のみを使用しています。

これは意図的な設計判断です。詳細は設計書の「1.2 設計上の最優先事項」を参照してください。

---

## 2. アプリケーション実行基盤（同梱）

### Electron

- ライセンス: MIT License
- 著作権: Copyright (c) Electron contributors / Copyright (c) 2013-2020 GitHub Inc.
- 全文: `licenses/Electron-LICENSE.txt`
- 用途: アプリケーション実行基盤

### Chromium および関連コンポーネント

- ライセンス: BSD 3-Clause License ほか（各コンポーネントごとに異なる）
- 全文: `licenses/LICENSES.chromium.html`
- 用途: Electron に含まれるレンダリングエンジンおよび依存ライブラリ群

> BSD 3-Clause は「バイナリ形式での再頒布時に、著作権表示・条件・免責事項を
> 頒布物に添付する」ことを求めています。EasyRoo はこの要件を満たすため、
> `LICENSES.chromium.html` をアプリケーションバンドル内に同梱しています。

### Node.js

- ライセンス: MIT License
- 用途: Electron に組み込まれた JavaScript 実行環境
- 全文: `licenses/LICENSES.chromium.html` に含まれます

---

## 3. 書体（同梱しない — 参照のみ）

EasyRoo は書体ファイルを**一切同梱していません**。
UI は macOS に標準搭載されている書体を名前で参照するのみです。

| 用途 | 書体 | 提供元 |
| --- | --- | --- |
| 見出し・ワードマーク | Avenir Next | macOS 標準搭載 |
| 本文（日本語） | Hiragino Sans | macOS 標準搭載 |
| 等幅（ログ・コマンド） | SF Mono / Menlo | macOS 標準搭載 |

いずれも Apple が macOS のシステム書体として提供するものであり、
アプリケーションから参照して表示する用途は macOS の利用条件の範囲内です。
**再頒布は行っていない**ため、書体に起因するライセンス上の義務は発生しません。

> Web フォント（Google Fonts 等）を採用しなかったのは、
> (1) オフライン動作の保証、(2) 書体ファイル再頒布に伴うライセンス義務の回避、
> (3) 日本語 UI における表示品質、の 3 点によります。

---

## 4. 設計上の参考資料（コードの複製なし）

### Hallmark

- 出典: https://github.com/Nutlope/hallmark
- ライセンス: MIT License
- 提供元: Together AI
- 利用形態: **デザイン原則の参照のみ。コード・スタイルシートの複製は行っていません。**

EasyRoo の UI 設計にあたり、Hallmark が定めるデザイン規律
（OKLCH による配色構築、トークンの一元管理、対話要素の 8 状態、
モーションの規律、アンチパターン回避）を**設計方針として参照**しました。

CSS・HTML・JavaScript はすべて EasyRoo のために新規に記述したものであり、
Hallmark のリポジトリからソースコードを複製した箇所はありません。
デザイン上の「考え方」は著作物としての表現ではないため、
本参照による EasyRoo のライセンスへの影響はありません。

なお Hallmark 自体も MIT License であり、仮に複製していた場合でも
著作権表示を保持すれば再頒布可能です。

---

## 5. アプリケーションアイコン

アイコンの元図案は、利用者（yuki_orita）が提供した `IMG_0147.ico` です。
EasyRoo ではこの図案を採寸し、Retina 表示に耐えるよう 1024px で描き直しています
（生成スクリプト: `assets/make-icon.js`）。

> **確認をお願いする事項**
> 提供されたファイルには作成者情報・出典を示すメタデータが含まれておらず、
> 図案の出所を技術的に確認できませんでした。
> 第三者のアイコンセットに由来する図案の場合、以下の点にご注意ください。
>
> - **Apple SF Symbols** — Apple のライセンスにより、
>   **アプリのアイコンやロゴとしての使用は明確に禁止**されています。
> - **Font Awesome / Material Icons など** — CC BY 4.0 や Apache-2.0 が多く、
>   帰属表示（クレジット）が必要になる場合があります。
>
> 図案がご自身の作成物である場合、または上記に該当しないことが確認できる場合は、
> 追加の対応は不要です。該当する可能性がある場合は差し替えをご検討ください。

---

## 6. ビルド専用ツール（配布物に含まれない）

以下は開発・ビルド時のみ使用し、配布される `.app` / `.dmg` には含まれません。

| ソフトウェア | ライセンス | 用途 |
| --- | --- | --- |
| electron-builder | MIT License | DMG パッケージング |
| dmgbuild | MIT License | DMG 生成（electron-builder が取得） |

---

*EasyRoo v1.0 — Copyright © 2026 yuki_orita — MIT License*
