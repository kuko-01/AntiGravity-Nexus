# ロールアウト手順書（機能フラグ運用）

更新日: 2026-02-20

## 1. 目的
音声強化機能を段階導入し、異常時に即時退避できる運用を定義する。

## 2. 機能フラグ設計（提案）

| フラグ名 | 役割 | 既定値（内部検証） | 既定値（本番） |
|---|---|---|---|
| `VOICE_ENHANCE_SINGING_ENABLED` | 歌唱補正の有効化 | ON | ON |
| `VOICE_ENHANCE_AUTO_EMOTION_REFINE` | 感情自己改善の有効化 | ON | ON |
| `VOICE_ENHANCE_SBV2_WAVE_EDIT` | SBV2後編集の有効化 | ON | ON |
| `VOICE_ENHANCE_FINAL_AUDIO` | 最終音質改善の有効化 | ON | ON |
| `VOICE_ENHANCE_FAILSAFE_BYPASS` | 後処理失敗時に元音声返却 | ON | ON |
| `VOICE_ENHANCE_LOW_LATENCY_PROFILE` | 低遅延プロファイル強制 | OFF | OFF |

## 3. 展開フェーズ

### Phase 1: 内部検証（7日）
1. 全フラグONで開発環境に展開。
2. 代表20文で毎日聴感チェック。
3. `durationMs` と失敗率を確認し閾値調整。

### Phase 2: 限定公開（7〜14日）
1. 対象を一部キャラクター/ユーザーに限定。
2. `VOICE_ENHANCE_SBV2_WAVE_EDIT` と `VOICE_ENHANCE_FINAL_AUDIO` を段階ON。
3. KPI悪化時は当日中にフラグを戻す。

### Phase 3: 本番展開
1. 全体ONをデフォルト化。
2. 24時間監視体制で失敗率と遅延を監視。
3. 閾値超過時は即座に機能縮退。

## 4. 監視項目
- `mode`
- `emotionLabelHint`
- `emotionIntensityHint`
- `autoEmotionRefine` ON/OFF
- `enhanceFinalAudio` ON/OFF
- `stages.totalMs`
- `error.code`, `error.message`

## 5. 障害時Runbook
1. 直ちに `VOICE_ENHANCE_FINAL_AUDIO=OFF`。
2. 収束しなければ `VOICE_ENHANCE_SBV2_WAVE_EDIT=OFF`。
3. さらに悪化する場合 `VOICE_ENHANCE_AUTO_EMOTION_REFINE=OFF`。
4. 解析:
   - I/O失敗
   - WAV解析失敗
   - 推論失敗（SBV2/RVC）
5. 再発防止:
   - 閾値修正
   - クランプ強化
   - フォールバック条件拡充

## 6. リリース判定ゲート
- 失敗率: 連続3日で 2%未満
- 平均 `totalMs`: 連続3日で目標内
- 聴感MOS（自然さ/感情一致）: 週次で 3.8以上
- 重大障害: 0件/週

## 7. 役割分担（引き継ぎ先）
- 開発: 実装とクランプ/フェイルセーフ強化
- QA: 自動/手動/聴感テスト実施
- 運用: KPI監視、フラグ切替、障害初動
- PM: フェーズ進行判断、意思決定ポイント確定
