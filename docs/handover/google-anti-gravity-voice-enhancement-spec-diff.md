# 仕様差分サマリ（型/API/処理フロー）

更新日: 2026-02-20

## 1. 対象範囲
- 計画書: `docs/handover/google-anti-gravity-voice-enhancement-plan.md`
- 現行実装:
  - `types/rvc.ts`
  - `types/character.ts`
  - `main/main.ts`
  - `main/services/CharacterChatService.ts`
  - `main/services/tts/VoicePipelineService.ts`

## 2. 差分一覧

| 項目 | 計画書仕様 | 現行実装 | 差分判断 | 対応方針 |
|---|---|---|---|---|
| 歌唱モード制御 | `expression.singing` で制御 | なし | 未実装 | `VoiceSynthesizeParams` に `expression.singing?: boolean` 追加 |
| 感情自己改善ON/OFF | `expression.autoEmotionRefine` | なし | 未実装 | 感情推定後の強度平滑化をフラグで切替 |
| 感情ヒント入力 | `emotionLabelHint` / `emotionIntensityHint` | なし | 未実装 | `voice-synthesize` リクエストで受理し補正に利用 |
| SBV2波形後編集 | `sbv2WaveEdit.{vibratoDepth,vibratoRateHz,dynamicBoost}` | なし | 未実装 | SBV2直後のPCM処理ステージを追加 |
| 最終音質改善フラグ | `output.enhanceFinalAudio` | `output.normalize` は存在 | 一部実装 | `enhanceFinalAudio` を追加し、最終WAVポスト処理の有効化に利用 |
| 感情推定 | 語彙 + 記号 + 履歴補正 | 語彙 + 記号のみ | 一部実装 | 履歴窓を導入して強度平滑化 |
| SBV2感情連動 | 感情を音声パラメータへ反映 | `buildSbv2EmotionDefaults` あり | 実装済み | 現行を基盤にヒント/平滑化を統合 |
| フェイルセーフ | 解析失敗時は元音声返却 | 例外時は `success:false` | 一部実装 | 後処理失敗時のみ元音声を返し、全体失敗にしない |

## 3. 現行実装の強み（再利用点）
- 感情推定基盤は既存利用可能: `main/services/CharacterChatService.ts`
- 感情に応じたSBV2パラメータ補正あり: `main/main.ts` の `buildSbv2EmotionDefaults`
- パイプライン分岐は整理済み: `main/services/tts/VoicePipelineService.ts`
- キャラ会話経由での音声自動起動は実装済み: `main/main.ts` の `ensureVoiceServersForCharacter`

## 4. 推奨型変更案

`types/rvc.ts` の `VoiceSynthesizeParams` に以下を追加:

```ts
expression?: {
  singing?: boolean;
  autoEmotionRefine?: boolean;
  emotionLabelHint?: 'neutral' | 'joy' | 'sad' | 'angry' | 'excited';
  emotionIntensityHint?: number; // 0..1
  sbv2WaveEdit?: {
    vibratoDepth?: number;   // 0..1
    vibratoRateHz?: number;  // 0..12
    dynamicBoost?: number;   // 0..2
  };
};
output?: {
  format?: 'wav' | 'flac';
  sampleRate?: number;
  normalize?: boolean;
  enhanceFinalAudio?: boolean;
};
```

## 5. 処理フロー差分

### 現行フロー（簡略）
1. 会話応答生成
2. 感情推定
3. `buildSbv2EmotionDefaults` でSBV2パラメータ補正
4. `VoicePipelineService.synthesize` で `sbv2` / `rvc` / `sbv2+rvc`

### 目標フロー（追加点）
1. 会話応答生成
2. 感情推定 + 履歴平滑化（任意）
3. `expression` で歌唱/感情ヒント適用
4. SBV2生成
5. SBV2波形後編集（任意）
6. RVC変換（任意）
7. 最終WAVポスト処理（任意）
8. 失敗時フェイルセーフで無加工音声返却

## 6. 実装優先順位
1. 型拡張 (`types/rvc.ts`, `types/character.ts`, preload IPC型)
2. パラメータクランプとバリデーション
3. 後処理ステージ（SBV2直後 + 最終）
4. 履歴平滑化ロジック
5. ログ/メトリクスとフラグ運用
