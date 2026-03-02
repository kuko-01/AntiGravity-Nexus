# 仕様差分サマリ（`training_bright` / `remix_clear` 実装仕様）

更新日: 2026-03-01

## 1. 対象範囲

- 計画書:
  - `docs/handover/google-anti-gravity-vocal-restoration-operations-plan.md`
- 現行実装:
  - `renderer/screens/CharacterStudioScreen.tsx`
  - `types/character.ts`
  - `types/index.ts`
  - `main/main.ts`
  - `main/services/SingingLearningService.ts`

本仕様は、`training_canonical` を既定成果物として維持しつつ、`training_bright` と `remix_clear` を「比較 export」として追加するための差分を定義する。

---

## 2. 設計判断

### 2.1 採用する設計
- `training_canonical` は常に生成する
- `training_bright` と `remix_clear` は canonical 完成後の追加 export として生成する
- dataset input へ自動登録するのは canonical のみ

### 2.2 採用しない設計
- `training_bright` を dataset input の既定成果物にする
- `remix_clear` を学習素材として自動保存する
- separator 選定段階で preset に応じて別ロジックを使い分ける

理由:
- 学習用 canonical を汚さずに比較結果を残せる
- 現行の `enhanceSeparatedVocalTrack` を大きく壊さずに拡張できる
- UI と結果メッセージへの追加も最小差分で済む

---

## 3. 追加する型/API

### 3.1 新規型

```ts
export type SingingLearningExportPreset =
  | 'training_bright'
  | 'remix_clear';

export interface SingingLearningComparisonExportSettings {
  trainingBright?: boolean;
  remixClear?: boolean;
}

export interface SingingLearningComparisonExportResult {
  preset: SingingLearningExportPreset;
  wavPath: string;
  warning?: string;
}
```

### 3.2 `StoredVoiceEnhanceSettings` 追加案
対象: `renderer/screens/CharacterStudioScreen.tsx`

```ts
interface StoredVoiceEnhanceSettings {
  singingTrainingMode?: boolean;
  separationPreference?: 'auto' | 'uvr-ultimate' | 'roformer' | 'demucs' | 'uvr5' | 'ffmpeg-fallback';
  singingComparisonExports?: {
    trainingBright?: boolean;
    remixClear?: boolean;
  };
  ...
}
```

既定値:

```ts
singingComparisonExports: {
  trainingBright: false,
  remixClear: false,
}
```

### 3.3 `CharacterLearningRequest` 追加案
対象: `types/character.ts`

```ts
export interface CharacterLearningRequest {
  singingTrainingMode?: boolean;
  separationPreference?: 'auto' | 'uvr-ultimate' | 'roformer' | 'demucs' | 'uvr5' | 'ffmpeg-fallback';
  singingComparisonExports?: {
    trainingBright?: boolean;
    remixClear?: boolean;
  };
  ytDlpCookiesFile?: string;
}
```

### 3.4 `SingingLearningIngestParams` 追加案
対象: `main/services/SingingLearningService.ts`

```ts
export interface SingingLearningIngestParams {
  characterId: string;
  sourceUrl: string;
  separationPreference?: SeparationPreference;
  exportPresets?: SingingLearningExportPreset[];
  ytDlpCookiesFile?: string;
}
```

### 3.5 `SingingLearningIngestResult` 追加案
対象: `main/services/SingingLearningService.ts`

```ts
export interface SingingLearningIngestResult {
  ...
  comparisonExports?: Array<{
    preset: 'training_bright' | 'remix_clear';
    wavPath: string;
    warning?: string;
  }>;
}
```

### 3.6 結果メッセージ反映
対象: `main/main.ts`

`buildSingingLearningResultMessage(...)` に比較 export を追加する。

出力例:

```text
Comparison Export [training_bright]: C:\...\vocal_training_bright_....wav
Comparison Export [remix_clear]: C:\...\vocal_remix_clear_....wav
```

---

## 4. UI仕様

### 4.1 追加UI
対象: `renderer/screens/CharacterStudioScreen.tsx`

`Singing learning mode (YouTube URL)` 周辺に、比較 export のチェックボックスを追加する。

- `Generate training_bright export`
- `Generate remix_clear export`

### 4.2 挙動
- 両方 OFF: 現行挙動そのまま
- `trainingBright` ON: canonical 完了後に bright export を追加生成
- `remixClear` ON: canonical 完了後に remix export を追加生成
- 両方 ON: canonical + 2 export を生成

### 4.3 保存
- キャラクター別 `voiceEnhance` 設定に保存
- 最後の選択値を local profile に残す

---

## 5. サービス処理フロー差分

### 5.1 現行
1. source download
2. separation
3. `enhanceSeparatedVocalTrack(...)`
4. dataset input へコピー

### 5.2 目標
1. source download
2. separation
3. `enhanceSeparatedVocalTrack(...)` で canonical を生成
4. canonical を dataset input へコピー
5. `renderComparisonExports(...)` で `training_bright` / `remix_clear` を必要時のみ生成
6. result / warning に export 一覧を含める

### 5.3 新規メソッド案
対象: `main/services/SingingLearningService.ts`

```ts
private async renderComparisonExports(params: {
  runDir: string;
  canonicalVocalWavPath: string;
  presets: SingingLearningExportPreset[];
}): Promise<{
  exports: SingingLearningComparisonExportResult[];
  warning?: string;
}>
```

責務:
- canonical 完了後の WAV を入力に使う
- ffmpeg で preset 別 export を生成する
- 失敗時は canonical を壊さない
- 失敗は warning に落とす

---

## 6. preset ごとの実装仕様

### 6.1 `training_bright`

目的:
- canonical より少し前に出る比較素材を作る
- ただし学習 canonical より癖を強くしない

入力:
- `enhanceSeparatedVocalTrack(...)` の最終 canonical WAV

出力:
- `runDir/enhanced/vocal_training_bright_<timestamp>.wav`

推奨フィルタチェーン:
- 軽い high-shelf
- 必要時のみ軽い peak normalization
- limiter は canonical より強くしない

ffmpeg 実装目安:

```text
highshelf=f=9000:g=1.5:t=q:w=0.8,
alimiter=limit=0.98
```

制約:
- `+2.0dB` を上限
- 中域 boost を入れない
- 追加 denoise / de-bleed は行わない

採用条件:
- export なので canonical の採否判定とは分離する
- ただし生成後に以下の安全確認を行う

安全確認:
- `speechActivityRatio` の低下が `0.01` 以下
- `highBandRoughness` の悪化が `0.0005` 以下
- `silenceRatio` の増加が `0.02` 以下

失敗時:
- export を破棄し warning だけ残す

### 6.2 `remix_clear`

目的:
- 動画 / BGM で埋もれにくい試聴用ボーカルを作る

入力:
- `enhanceSeparatedVocalTrack(...)` の最終 canonical WAV

出力:
- `runDir/enhanced/vocal_remix_clear_<timestamp>.wav`

推奨フィルタチェーン:
- `training_bright` より強い高域 shelf
- 2kHz 近傍の presence 補正
- 軽い loudness stabilization

ffmpeg 実装目安:

```text
highshelf=f=10000:g=2.0:t=q:w=0.8,
equalizer=f=2200:t=q:w=1.0:g=1.0,
dynaudnorm=f=250:g=7:p=0.95:m=6,
alimiter=limit=0.98
```

制約:
- High-Shelf は `+3.0dB` を上限
- presence boost は `+1.5dB` を上限
- 学習素材への自動登録は禁止

安全確認:
- `speechActivityRatio` の低下が `0.015` 以下
- `highBandRoughness` の悪化が `0.0008` 以下
- `leakageCorrelation` の悪化が `0.015` 以下

失敗時:
- export を破棄し warning だけ残す

---

## 7. ファイル別実装ポイント

### 7.1 `renderer/screens/CharacterStudioScreen.tsx`
- `StoredVoiceEnhanceSettings` に `singingComparisonExports` を追加
- checkbox 2個を追加
- `characterChatSend.learning` に比較 export 設定を含める
- 成功時メッセージに export 一覧があれば表示

### 7.2 `types/character.ts`
- `CharacterLearningRequest` に `singingComparisonExports` を追加
- `CharacterLearningResult` に `comparisonExports` を追加

### 7.3 `types/index.ts`
- renderer 側レスポンス型に `comparisonExports` を反映

### 7.4 `main/main.ts`
- `request.learning.singingComparisonExports` を service へ渡す
- `buildSingingLearningResultMessage(...)` に比較 export 行を追加

### 7.5 `main/services/SingingLearningService.ts`
- `SingingLearningIngestParams` に `exportPresets`
- `SingingLearningIngestResult` に `comparisonExports`
- canonical 完了後に `renderComparisonExports(...)` を呼ぶ
- canonical の dataset 登録順序を維持
- comparison export は dataset 登録に使わない

---

## 8. ログ仕様

### 8.1 成功時 warning 例

```text
Comparison export generated (training_bright, speech=0.62->0.62, rough=0.0124->0.0126).
Comparison export generated (remix_clear, speech=0.62->0.61, rough=0.0124->0.0129, leak=0.048->0.051).
```

### 8.2 失敗時 warning 例

```text
Comparison export skipped (training_bright: roughness regression exceeded threshold).
Comparison export skipped (remix_clear: ffmpeg filter failed ...).
```

---

## 9. 受け入れ基準

1. `training_canonical` の現行挙動を壊さない
2. `training_bright` を ON にしても dataset input は canonical のまま
3. `remix_clear` は result に出るが dataset input へは登録されない
4. comparison export 失敗時も singing ingest 全体は失敗にしない
5. 結果メッセージと warning から、どの export が生成されたか判別できる

---

## 10. 実装優先順位

1. 型追加
2. UI 設定追加
3. `SingingLearningService` で comparison export 生成
4. 結果メッセージ整備
5. ログ / 安全判定の閾値微調整
