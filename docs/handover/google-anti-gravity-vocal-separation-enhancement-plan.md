# AntiGravity Nexus 音源分離・強調パイプライン改善計画書

更新日: 2026-02-28

## 1. 目的
本計画書は、歌唱学習向けのボーカル抽出パイプラインを、現行実装と整合する形で段階改善するための実装計画を定義する。

狙いは次の3点に集約する。

1. 分離由来のアーティファクトを減らし、学習素材として再利用できるボーカル品質へ寄せる。
2. 低域ブリード、高域のガビり、位相由来のこもりを抑えつつ、子音・ブレス・輪郭を保護する。
3. 既存の自動選択、フェイルセーフ、ローカル実行前提を壊さずに、Roformer 系モデルを追加統合する。

---

## 2. 現状整理

### 2.1 現行の分離パイプライン
現行の歌唱学習パイプラインは単一の Demucs ベースではない。`auto` では以下の候補を動的に順位付けして使用する。

- `uvr-ultimate`
- `demucs`
- `uvr5`
- `ffmpeg-fallback`

順位は固定ではなく、キャラクターごとの成功率と品質スコア EMA を使って更新される。

### 2.2 現行の Demucs 実装
Demucs は未導入ではなく、`htdemucs_ft` / `htdemucs` を使う複数プロファイルを既に持つ。

- 高品質寄り: `--shifts 2 --overlap 0.35 --float32`
- バランス寄り: `--shifts 1 --overlap 0.25`

そのため、`shifts` や `overlap` は新規機能ではなく、既存パラメータの再設計対象である。

### 2.3 現行の後段強調処理
`vocal_enhanced` は固定 EQ / コンプレッサだけで構成されていない。既に以下の多段処理を持つ。

- 候補間アンサンブル
- 原曲ミックス再投影
- サブバンド再投影
- accompaniment 参照付き de-bleed
- music-only 区間の抑制
- 高域スムージング
- 指標駆動の適応型 ffmpeg フィルタチェーン

したがって、現行課題は「静的エフェクトを全部捨てること」ではなく、「採用判定と適応閾値を見直し、より強い分離器を前段に追加すること」である。

---

## 3. 課題定義
現行コードの構造を踏まえると、主課題は以下である。

### 3.1 前段分離器の限界
- シンセ、リバーブ、広がり成分が強い楽曲で、Demucs / UVR 系が周期的な残留ノイズを残す。
- Auto 選択は既にあるが、候補集合そのものに Roformer 系が含まれていない。

### 3.2 後段改善の採用閾値
- 再投影や de-bleed は有効なケースが多いが、境界条件によっては子音・空気感の減衰を招く。
- 高域保護と高域抑制のバランスが楽曲によって変動しやすい。

### 3.3 実行コストの制御
- `shifts` を大きくすると品質は上がるが、ローカル実行時間が急増する。
- 既定値として `N=10` を常用するのは現実的ではない。

---

## 4. 採用方針

### 4.1 採用する改善
- Roformer 系分離器の追加
- 既存の候補比較ロジックへの Roformer 統合
- 既存アンサンブル処理の Roformer 対応
- 後段 cleanup の採用閾値とプロファイル再設計
- 指標とログの追加による比較評価

### 4.2 採用しない、または後回しにする改善
- 固定 EQ / Comp の全面廃止
  - 理由: 現行は既に適応型 cleanup を持つため
- `shifts=10` 常用
  - 理由: ローカル運用コストに対して既定値として重すぎるため
- 倍音生成による高域補完
  - 理由: 分離アーティファクトを増幅するリスクが高く、先に前段分離と保護ロジックを改善すべきため

---

## 5. 目標アーキテクチャ

### 5.1 分離エンジン層
既存の `SeparationMethod` に `roformer` を追加し、次の候補集合で比較する。

- `uvr-ultimate`
- `roformer`
- `demucs`
- `uvr5`
- `ffmpeg-fallback`

`auto` 時は既存の品質メモリをそのまま使い、Roformer も同一ルールで順位付けする。

### 5.2 推論ランタイム層
Roformer は既存の Demucs / UVR Ultimate と同様に、隔離された Python 実行環境を持つ。

- 依存衝突を避けるため専用 venv を用意する
- モデル重みは専用ディレクトリへ配置する
- 初回のみ自動セットアップ可能にする
- 失敗時は他方式へフォールバックする

### 5.3 候補評価層
既存の `selectBestSeparationCandidate` を拡張し、Roformer を含む複数候補の比較を継続する。

評価基準は現行の考え方を維持する。

- leakage correlation
- low-band leakage
- high-band roughness
- speech activity
- 総合スコア

### 5.4 後段強調層
`enhanceSeparatedVocalTrack` は廃止ではなく、以下の2プロファイルへ整理する。

- `safe`
  - 学習素材保護優先
  - 再投影・de-bleed の採用を保守化
- `aggressive`
  - BGM 漏れ抑制優先
  - 高 leakage 楽曲でのみ利用

既定値は `safe` とし、`aggressive` は Auto 判定または明示フラグでのみ使う。

---

## 6. 実装フェーズ

### Phase 0: ベースライン固定
目的は、現行品質を壊さず比較可能にすること。

- 既存 separator ごとの成功率、所要時間、採用率を記録
- `enhanceSeparatedVocalTrack` の各段採用率を記録
- 評価用サンプルセットを固定化

成果物:
- ベースライン計測ログ
- 比較用サンプル一覧

### Phase 1: Roformer 統合
目的は、候補集合に高精度分離器を追加すること。

- `SeparationMethod` に `roformer` を追加
- `buildSeparationPlan` と UI の選択肢を更新
- Roformer 実行ランタイムの作成
- ボーカル / accompaniment の出力整形と保存
- Auto fallback を既存方式と同じ規約で接続

完了条件:
- 明示選択で `roformer` が単独実行できる
- 失敗時に他 separator へ正常フォールバックできる

### Phase 2: 候補比較とアンサンブル最適化
目的は、Roformer を単体導入で終わらせず、既存の比較基盤に組み込むこと。

- `selectBestSeparationCandidate` の比較対象へ Roformer を追加
- 既存アンサンブル処理を `Demucs + Roformer` の代表組み合わせで検証
- alternative candidate 採用条件を見直す
- path 重複や同一 stem 再利用のガードを強化する

完了条件:
- `auto` で Roformer 候補が採点対象になる
- ensemble 採用時の回帰条件が明文化される

### Phase 3: 後段 cleanup 再設計
目的は、分離後の改善処理を保守的に整理すること。

- `buildAdaptiveFilterChain` のしきい値を再調整
- `safe` / `aggressive` の cleanup プロファイルを導入
- 高域スムージングと再投影の採用判定を保守化
- 低域ブリードが強い場合のみ強めの補正を許可する

完了条件:
- 子音欠落や空気感の喪失がベースラインより増えない
- leakage 改善時のみ aggressive 採用が増える

### Phase 4: Demucs プロファイル再調整
目的は、既存 Demucs を Roformer 導入後の補助エンジンとして最適化すること。

- `hq` プロファイルの `shifts` / `overlap` を再検証
- 高品質モードのみ `shifts=4` 前後を候補化する
- 既定値は現行水準から大きく増やさない

完了条件:
- 実行時間と品質のトレードオフが定量化される
- 常用プロファイルが 1 本に固定される

---

## 7. 実装対象ファイル

### 必須更新
- `main/services/SingingLearningService.ts`
  - separator 種別追加
  - runtime 解決
  - 自動選択統合
  - enhancement プロファイル整理
- `main/services/audio/SeparationQualityLibrary.ts`
  - cleanup しきい値見直し
  - profile 化
  - Roformer 比較時の補助指標調整
- `renderer/screens/CharacterStudioScreen.tsx`
  - separator 選択 UI に `roformer` を追加
- `main/main.ts`
  - IPC 経由の型とレスポンス表示の整合

### 追加想定
- `tools/` 配下の Roformer ランタイム補助スクリプト
- `resources/` または `user_data/` 配下の重み配置ルール

---

## 8. 品質評価方針

### 8.1 主観評価
以下を最低限確認する。

- 子音の自然さ
- ブレスの残り方
- リバーブ尾の機械臭
- 低域の楽器漏れ
- 高域のシュワシュワ感

### 8.2 客観指標
既存ライブラリで取得できる指標を主要 KPI とする。

- leakage correlation
- low-band leakage correlation
- high-band roughness
- speech activity ratio
- silence ratio
- separator success rate
- median processing time

### 8.3 受け入れ基準
- Roformer 導入後、評価サンプルの過半数で現行 Auto より総合スコアが改善する
- 高 leakage サンプルで低域ブリード改善が確認できる
- ベースライン比で speech activity の悪化が顕著に増えない
- separator 失敗率が悪化しない

---

## 9. ロールアウト方針

### Stage 1: 開発者限定
- `roformer` 明示指定のみ有効
- `auto` には未参加

### Stage 2: 限定 Auto 参加
- 一部キャラクターのみ `auto` 候補に追加
- ログを見て score EMA の偏りを確認

### Stage 3: 標準化
- `auto` の通常候補へ昇格
- 必要なら `uvr-ultimate` と `roformer` の優先関係を再調整

---

## 10. リスクと対策

### 10.1 ランタイム依存衝突
- 対策: 専用 venv を使い、既存 RVC 環境と分離する

### 10.2 処理時間増加
- 対策: `roformer` は `auto` の最初から常時実行せず、段階導入する

### 10.3 後段 cleanup の過補正
- 対策: `safe` を既定値にし、採用閾値を厳格化する

### 10.4 高域補完の副作用
- 対策: 倍音生成は本計画の対象外にし、前段改善後に再評価する

---

## 11. 意思決定ポイント
Google Anti Gravity 側で先に決めるべき項目は以下である。

1. `roformer` を初期段階から `auto` に参加させるか、明示選択のみで始めるか。
2. cleanup プロファイルを UI 露出するか、内部 Auto のみで運用するか。
3. 高品質 Demucs プロファイルの許容実行時間を何分まで認めるか。

---

## 12. 要約
本改善は「Demucs を Roformer に置き換える」計画ではない。既存の多候補選択と適応 cleanup を活かしながら、Roformer を候補集合へ追加し、後段の採用判定を保守化して品質を底上げする計画である。

最優先は以下の順序とする。

1. ベースライン固定
2. Roformer 統合
3. 候補比較とアンサンブル最適化
4. cleanup 再調整
5. Demucs プロファイル再設計
