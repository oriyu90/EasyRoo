# EasyRoo

**ローカルLLMで動く、Mac向けルーティーンAIアプリ**

新しいチャットを始める感覚でルーティーンを作り、手順書と注意書きを書いておくと、
決めた曜日・日・時刻にAIが自動で実行します。
AIはターミナルを操作し、接続したMCPツールを使って実際に作業を進めます。

- **バージョン**: v1.0
- **対応環境**: macOS (Apple Silicon / arm64)
- **ライセンス**: MIT
- **実行時依存**: **ゼロ**（`dependencies: {}`）

---

## 特徴

| | |
| --- | --- |
| **ローカル完結** | LM Studio などの OpenAI 互換サーバに接続。クラウドに送らず手元で完結できます |
| **依存パッケージゼロ** | 実行時の npm 依存を持ちません。MCPクライアントもHTTPサーバも自前実装です |
| **実際に作業する** | 報告だけで終わらせず、ターミナルとMCPツールで実作業を行います |
| **8カテゴリの禁止コマンド規則** | `rm -rf /`、`sudo`、ディスク消去などを正規表現で遮断。ネットワークは信頼ドメインのみ条件付き許可 |
| **3段階の停止機構** | 個別停止 / 全体停止 / 緊急停止。子孫プロセスまで確実に落とします |
| **長期記憶** | STATE と JOURNAL による実行をまたいだ記憶。文脈があふれる前に自動で退避・要約します |
| **日本語 / English** | UI・CLI とも切り替え可能 |
| **CLI 同梱** | GUI と同じ操作をターミナルから実行できます（AIエージェントに任せる用途にも） |

---

## インストール

### 配布版を使う（推奨）

1. [Releases](../../releases) から `EasyRoo-1.0.0-arm64.dmg` をダウンロードします。
2. DMG を開き、**EasyRoo.app** を **Applications** にドラッグします。

> **初回起動時の警告について**
> Apple Developer ID による署名を行っていないため、初回は
> 「開発元を確認できないため開けません」と表示されます。
> **EasyRoo.app を右クリック →「開く」** を選び、確認ダイアログで「開く」を押してください。
> 一度許可すれば、次回からは通常どおり起動できます。

### ソースからビルドする

```bash
git clone <このリポジトリのURL>
cd easyroo
npm install          # devDependencies のみ（Electron / electron-builder / ESLint）
npm start            # 開発起動
npm run dist         # dist/EasyRoo-1.0.0-arm64.dmg を生成
```

---

## 事前準備：LLMを接続する

EasyRoo 自体はLLMを内蔵していません。OpenAI互換APIを話すサーバが必要です。

1. [LM Studio](https://lmstudio.ai/) をインストールし、**ツール呼び出し（tool calling）に対応したモデル**を読み込みます。
2. LM Studio の Developer タブでローカルサーバを起動します（既定 `http://localhost:1234`）。
3. EasyRoo の 設定 → LLM接続 でベースURLとモデルを指定し、「接続を確認」を押します。

別のMacやVPN越しのサーバにも接続できます（`http://192.168.1.10:1234` のような入力も自動で補完されます）。
macOS 15 以降ではローカルネットワークの許可ダイアログが出るので、許可してください。

> ツール呼び出しに対応していないモデルでは、AIが作業できず報告だけで終わります。

---

## 使い方

詳しい手順は **[docs/使い方ガイド.md](docs/使い方ガイド.md)** を参照してください。

おおまかな流れ:

1. **ルーティーンを作る** — 名前・目的・**手順書**・**注意書き**を書く
2. **実行タイミングを決める** — 手動 / 間隔 / 毎週 / 毎月
3. **許可する操作を選ぶ** — ターミナル、MCPツール
4. **`▶ 今すぐ実行` で動きを確認** してから、スケジュールを有効にする

> 手順書は「何をするか」、注意書きは「絶対にしてはいけないこと」を具体的に書くほど確実に効きます。

### ターミナルから操作する

```bash
easyroo status                        # 状態を見る
easyroo list                          # ルーティーン一覧
easyroo run <id>                      # 実行
easyroo logs <run-id> --follow        # ログを追う
easyroo stop-all                      # 全部止める
easyroo deny-check 'rm -rf /'         # 禁止コマンドを試す
```

インストールは 設定 → CLI から。GUIが起動していなくても動作します。

---

## 安全に使うために

- **禁止コマンド規則**が既定で有効です。破壊的操作・権限昇格・システム制御などを
  8カテゴリ・50以上の規則で遮断します。
- **ネットワークは条件付き許可**です。宛先が信頼ドメイン（既定は `localhost` 系と GitHub 系）
  のときだけ通り、見知らぬドメインへの通信は止まります。
- **作業ディレクトリを専用フォルダに限定**することを強く推奨します。
- AIがコマンドを拒否されると、回避を試みず別の手段を検討するか報告するよう指示されます。

> ⚠️ EasyRoo はAIに実際のターミナル操作を許可するアプリです。
> 手順書と注意書きの内容、および作業ディレクトリの設定は、利用者の責任で行ってください。

---

## プロジェクト構成

```
src/
├── main/            メインプロセス
│   ├── engine.js       全機能の単一窓口
│   ├── runner.js       ルーティーン実行ループ
│   ├── scheduler.js    スケジュール管理
│   ├── llm.js          OpenAI互換クライアント
│   ├── api.js          制御API (HTTP)
│   ├── store.js        データ永続化
│   ├── memory.js       STATE / JOURNAL
│   ├── contextBudget.js 文脈量の予算管理
│   ├── netdiag.js      接続診断
│   ├── mcp/            MCPクライアント（自前実装）
│   └── tools/          組み込みツール・禁止コマンド規則
├── preload/         contextBridge
├── renderer/        GUI（フレームワーク非依存・ビルド工程なし）
└── shared/          i18n
bin/easyroo.js       CLI
test/run-tests.js    テスト（18節・229項目）
```

---

## 開発

```bash
npm run check        # lint + test（コミット前に必ず通す）
npm run lint         # ESLint
npm test             # 229項目。Electron を起動せず Engine を直接検証
npm run icon         # アイコン再生成
```

テストは `EASYROO_HOME` を一時ディレクトリへ向けるため、**本番データを壊しません**。
LM Studio が起動していれば実LLMによるE2E検証まで自動で走り、未起動なら該当項目はスキップされます。

---

## ドキュメント

| 文書 | 内容 |
| --- | --- |
| [docs/使い方ガイド.md](docs/使い方ガイド.md) | 利用者向けの操作手順 |
| [docs/設計書兼仕様書.md](docs/設計書兼仕様書.md) | 設計・仕様・テスト結果・不具合監査・ライセンス監査 |
| [docs/開発引き継ぎメモ.md](docs/開発引き継ぎメモ.md) | 開発者向け。踏んだ落とし穴と未解決事項 |
| [docs/OpenClaw参考_ループ機構_設計レポート.md](docs/OpenClaw参考_ループ機構_設計レポート.md) | ループ機構の調査記録 |

---

## 既知の制約

- **Apple Silicon (arm64) のみ**。Intel Mac 向けビルドは未検証です。
- **コード署名・公証なし**。初回起動時に Gatekeeper の警告が出ます。
- **応答はストリーミング表示ではありません**。長い実行では完了まで文字が出ません。
- MCP は **Tools のみ**対応（Resources / Prompts は未対応）。

---

## ライセンス

MIT License — Copyright © 2026 yuki_orita

詳細は [LICENSE.md](LICENSE.md)、第三者ソフトウェアの表記は
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) を参照してください。

EasyRoo は実行時の外部依存パッケージを持ちません。
アプリケーション実行基盤として Electron (MIT) / Chromium (BSD-3-Clause) / Node.js (MIT) を同梱しています。
書体は macOS 標準搭載のものを名前で参照するのみで、同梱していません。

UI設計にあたり [Hallmark](https://github.com/Nutlope/hallmark) (MIT / Together AI) の
デザイン規律を設計方針として参照しています（コードの複製は行っていません）。
