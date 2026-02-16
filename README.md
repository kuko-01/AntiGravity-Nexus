# 音声キャプチャ・テキスト化アプリケーション

画面の音声をリアルタイムでキャプチャし、テキスト化するElectronアプリケーションです。

## 機能

- 🖥️ **画面選択**: 利用可能な画面/ウィンドウから音声をキャプチャ
- 🎙️ **音声→テキスト変換**: Gemini API を使用したリアルタイム文字起こし
- 📝 **テキストログ**: タイムスタンプ付きでログを表示
- 🔍 **調査機能**: 選択したテキストの意味や背景情報を調査

## 必要条件

- Node.js 18.x 以上
- npm 9.x 以上
- Google Gemini API キー

## セットアップ

### 1. 依存関係のインストール

```bash
cd c:\Users\skyfo\.gemini\test
npm install
```

### 2. 環境変数の設定

`.env.example` をコピーして `.env` を作成し、Gemini API キーを設定します。

```bash
copy .env.example .env
```

`.env` ファイルを編集：

```
GEMINI_API_KEY=your_actual_api_key_here
```

### 3. Gemini API キーの取得方法

1. [Google AI Studio](https://aistudio.google.com/) にアクセス
2. Google アカウントでログイン
3. 「API キーを取得」または「Get API Key」をクリック
4. 新しい API キーを作成
5. キーをコピーして `.env` ファイルに貼り付け

## 起動方法

### 開発モード

```bash
npm run dev
```

### 本番ビルド

```bash
npm run build
npm start
```

### TTS/RVC バンドル生成

```bash
npm run bundle:sbv2
npm run bundle:rvc
```

## 使用方法

1. **アプリを起動**
2. **画面を選択**: ヘッダーのドロップダウンから音声をキャプチャしたい画面/ウィンドウを選択
3. **キャプチャ開始**: トグルスイッチを ON にする
4. **テキスト表示**: 音声が自動的にテキスト化されてログビューに表示される
5. **テキスト調査**: ログ内のテキストをドラッグ選択し、「調査」ボタンを押す

## プロジェクト構成

```
├── main/                    # Electron メインプロセス
│   ├── main.ts              # エントリーポイント
│   └── preload.ts           # Preload スクリプト
├── renderer/                # React UI
│   ├── index.html           # HTML テンプレート
│   ├── index.tsx            # React エントリーポイント
│   ├── App.tsx              # メインアプリコンポーネント
│   └── styles/
│       └── global.css       # グローバルスタイル
├── components/              # React コンポーネント
│   ├── SourceSelector.tsx   # 画面選択
│   ├── ToggleSwitch.tsx     # ON/OFF トグル
│   ├── LogView.tsx          # テキストログ
│   ├── ResearchPanel.tsx    # 調査結果パネル
│   └── ResearchButton.tsx   # 調査ボタン
├── services/                # ビジネスロジック
│   ├── audioCapture.ts      # 音声キャプチャ
│   ├── speechToText.ts      # STT 処理
│   └── research.ts          # 調査機能
├── types/                   # 型定義
│   └── index.ts
├── package.json
├── tsconfig.json            # React 用 TypeScript 設定
├── tsconfig.main.json       # Electron 用 TypeScript 設定
├── vite.config.ts           # Vite 設定
├── .env.example             # 環境変数テンプレート
└── README.md
```

## 注意事項

- 音声キャプチャにはシステムの権限が必要な場合があります
- Windows では、特定のウィンドウのみの音声を分離してキャプチャすることは技術的に困難です
- API 呼び出しには料金が発生する場合があります。Google の料金体系を確認してください

## トラブルシューティング

### 「音声を取得できませんでした」エラー

- 選択した画面に音声出力があることを確認してください
- 別の画面/ウィンドウを選択してみてください

### 「API キーが設定されていません」エラー

- `.env` ファイルが存在することを確認
- `GEMINI_API_KEY` が正しく設定されていることを確認
- アプリを再起動してみてください

## ライセンス

MIT
# AntiGravity-Nexus
