# TabTidy - タブ整理アシスタント

散らかった Chrome タブをワンクリックで整理でき、処理がローカルだけで完結する Manifest V3 対応の Chrome 拡張機能です。  
Vite + React + TypeScript + Tailwind CSS + shadcn/ui 風コンポーネントで作られています。

## 主な機能

- 類似度で整理（不要も自動仕分け）  
  開いているタブのタイトル・見出し・本文の一部を軽く読み取り、`Intl.Segmenter` による日本語の単語分割とコサイン類似度を使い、似た内容のタブ同士を自動でグループ化します。  
  エラーページ（404 等）・認証完了後に残ったタブ・古い検索結果・重複タブ・長時間未操作のタブは `不要` グループ（グレー）にまとめ、フォームに入力中のタブ・音声再生中のタブ・ピン留めタブは保護します。
- 重複タブの削除 & 元に戻す  
  同一 URL の重複タブを検出して削除し、アクティブなタブやピン留めタブを優先して保護します。直前に閉じたタブはワンクリックで復元できます。
- タブ検索・絞り込み  
  複数キーワードの AND 検索と、重複のみ・未グループ・音声再生中の絞り込みができ、クリックですぐタブを切り替えられます。
- スマート退避（スタッシュ）  
  未操作タブや現在のタブ一覧をセッションとして `chrome.storage.local` に保存してタブを閉じ、必要なときに現在のウィンドウまたは新しいウィンドウへ復元できます。
- ローカルモデル状態チェック  
  設定画面から Chrome 内蔵 LLM（Prompt API / Gemini Nano `LanguageModel.availability()`）と `Intl.Segmenter` の利用可否を確認でき、ダウンロード可能な端末ではモデルの準備も行えます。
- 自動ドメイン分類・バッジ表示・ショートカット  
  新規タブの自動グループ化（設定で ON/OFF）、ツールバーのバッジへのタブ数表示、キーボードショートカット（`group-by-similarity` / `close-duplicates`）に対応しています。

## プライバシー・権限について

タブの解析、類似度の計算、セッションの保存はすべて **お使いのブラウザ内（ローカル）** だけで完結します。外部サーバーへ URL やページ内容を送信することはありません。

| 権限 | 用途 |
| --- | --- |
| `tabs` | タブ一覧の取得、検索、重複削除、切り替え、復元 |
| `tabGroups` | 類似度グループ・`不要` グループの作成と更新 |
| `storage` | 設定、退避セッション、Undo スナップショットのローカル保存 |
| `scripting` | 類似度の判定と入力中のフォームの保護に使う軽量メタデータの読み取り |

## セットアップ & Chrome への読み込み

Node.js 22.18 以上（推奨: Node 24 LTS）が必要です。

```bash
git clone https://github.com/tesso57/tabtidy.git
cd tabtidy
npm install
npm run build
```

1. Chrome で `chrome://extensions/` を開きます。
2. 右上の「デベロッパー モード」をオンにします。
3. 左上の「パッケージ化されていない拡張機能を読み込む」をクリックし、ビルドで生成された `dist/` フォルダを選択します。
4. ツールバーに TabTidy をピン留めして利用できます。

## 開発・検証コマンド

```bash
npm run dev           # Vite 開発サーバー
npm run typecheck     # TypeScript 型チェック (tsc --noEmit)
npm run build         # 型チェック + dist/ へ本番ビルド
npm test                  # Node 標準テストランナーでテスト実行
npm run knip              # 未使用ファイル・依存・エクスポート検査
npm run check:secrets     # 機密情報・禁止ファイル混入チェック
```

## ディレクトリ構成

```text
├── public/
│   ├── icons/              # 拡張機能アイコン (16/32/48/128px)
│   └── manifest.json       # Chrome Manifest V3 設定
├── src/
│   ├── background/         # Service Worker (バッジ更新・自動分類・ショートカット)
│   ├── components/ui/      # shadcn/ui スタイルの UI コンポーネント
│   ├── lib/                # タブ操作・類似度分類・ローカルAI判定・Chrome API ラッパー
│   ├── popup/              # ポップアップ React UI (App.tsx / main.tsx)
│   └── types/              # TypeScript 型定義
├── tests/                  # ユニットテスト (*.test.mts)
├── popup.html              # Vite ポップアップエントリ
└── vite.config.ts          # Vite マルチエントリ設定 (popup + service-worker)
```

## ライセンス

[MIT License](./LICENSE) © 2026 tesso57
