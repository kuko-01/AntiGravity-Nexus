# AntiGravity Nexus 分離後ボーカル運用標準計画書（短期運用 + 中長期改善）

更新日: 2026-03-01

## 1. 目的
本計画書は、歌唱学習向けの分離後ボーカルを、現行リポジトリ実装と整合する形で運用標準化するための文書である。

狙いは次の3点に集約する。

1. 学習素材として使えるボーカルを、過剰な色付けなしに安定供給する。
2. 高域アーティファクトと微小な伴奏残留を抑えつつ、子音・ブレス・語尾を保護する。
3. 短期運用の処理ルールと、中長期の分離バックボーン改善方針を分離して管理する。

---

## 2. 前提整理

### 2.1 現行実装で既に入っている処理
現行の `singing_learning` は、単純な「分離して固定 EQ」をかける構成ではない。既に以下を持つ。

- `uvr-ultimate / roformer / demucs / uvr5 / ffmpeg-fallback` の候補比較
- speech / silence / leak / mix consistency を使う自動選定
- candidate 間アンサンブル
- mixture reprojection
- subband reprojection
- accompaniment 参照付き de-bleed
- music-only 区間抑制
- high-band smoothing
- adaptive cleanup + denoise + dynamic normalize + limiter

したがって、運用の中心は「固定 EQ を標準化すること」ではなく、「用途別にどこまで色付けを許すか」を定義することである。

### 2.2 本文書の位置づけ
本書は次の2層を分けて扱う。

1. 短期運用層  
   現行コードでそのまま使う運用プロファイル
2. 中長期研究層  
   次世代分離器と評価系の設計ロードマップ

---

## 3. 基本方針

### 3.1 学習用 canonical を最優先する
学習向け素材は、派手さより再現性を優先する。

- 固定 High-Shelf を標準処理にしない
- fixed mid boost を標準処理にしない
- normalize は「最終 export の都合」であり、canonical 素材の音色設計ではない

### 3.2 色付けは export preset に限定する
高域の明るさ補正や前進感の演出は、以下のような別用途 export に限定する。

- `training_bright`
- `remix_clear`

### 3.3 分離品質の問題は前段と採点で先に解く
音抜け、ブリード、機械ノイズは、後段 EQ より先に以下で改善する。

- separator 選定
- candidate 比較ロジック
- de-bleed / smoothing / adaptive cleanup の採用閾値

---

## 4. 運用プロファイル

### 4.1 `training_canonical`
既定プロファイル。学習投入の基準素材。

目的:
- 余計な色付けを避ける
- 語尾、子音、ブレスをなるべく保持する
- separator の癖を増幅しない

方針:
- 現行の adaptive cleanup を使う
- de-bleed / high-band smoothing は採用条件を満たした場合のみ適用
- 固定 High-Shelf / 固定中域ブーストは行わない
- 出力は mono 44.1kHz を維持

許容処理:
- reference de-bleed
- music-only section removal
- adaptive cleanup
- post-cleanup high-band smoothing

禁止事項:
- 学習前の一律 +2dB〜+4dB high-shelf
- 一律 1kHz〜3kHz boost
- 「派手さ」を目的としたコンプやエキサイタ

### 4.2 `training_bright`
学習補助用の比較プロファイル。常用ではない。

目的:
- canonical では少し暗く感じる素材の比較用 export

適用条件:
- canonical で speech / silence / leak が良好
- 高域アーティファクトが増えていない

許容処理:
- High-Shelf 8kHz〜10kHz で +1.0dB〜+2.0dB まで
- 必要時のみ軽い normalize

禁止事項:
- +3dB 超の shelf を標準化すること
- ノイズ床や歯擦音が増えている素材への適用

### 4.3 `remix_clear`
動画 / BGM / 単独試聴向けの可読性重視 export。

目的:
- フルミックス時の埋もれ抑制
- 子音の視認性と歌詞可読性向上

許容処理:
- High-Shelf 8kHz〜12kHz
- 1kHz〜3kHz の軽い presence 調整
- normalize / limiter の強め設定

注意:
- 学習素材に流用しない
- canonical とは保存先と命名を分離する

---

## 5. 短期運用フロー

### Step 1: 分離方式の選定
原則は `auto` を使う。

確認項目:
- warning に出る `Ranking`
- `speech`, `silence`, `mixErr`, `lowMixErr`
- `presAdj`

判断:
- `auto` が過度に静かな stem を選ぶ場合は `roformer` 明示比較を行う
- `uvr5` が低 `mixErr` だけで勝っている場合は、speech / silence を優先して見直す

### Step 2: 後段 cleanup の採否確認
確認項目:
- `Reference de-bleed applied / not adopted`
- `High-band smoothing applied / not adopted`
- `Post-cleanup high-band smoothing applied / not adopted`
- `Adaptive cleanup tuned from analysis (...)`

判断:
- 微小な伴奏漏れが気になる場合は de-bleed の採否を優先確認
- シュワシュワ感が気になる場合は smoothing の採否と roughness 差分を見る

### Step 3: 学習投入用の保存
`training_canonical` を基準に dataset input へ登録する。

注意:
- 現行の singing ingest は input へ単体 WAV をコピーするだけで、2〜10秒スライスはここでは行わない
- セグメント化は SBV2 側の dataset 工程で扱う

### Step 4: 比較 export
必要な場合のみ `training_bright` または `remix_clear` を別書き出しする。

---

## 6. DAW / Audacity 運用ルール

### 6.1 使ってよい用途
- A/B 比較
- `training_bright` の比較生成
- `remix_clear` の書き出し

### 6.2 既定値として採用しないもの
- 学習用 canonical に対する固定 shelf
- 学習用 canonical に対する固定 normalize -2dB
- 学習用 canonical に対する固定 mid boost

### 6.3 手動 EQ を行う場合の上限
- High-Shelf: +2.0dB までを推奨、上限 +3.0dB
- Presence: 2kHz 周辺 +1.0dB 程度まで
- 問題が残る場合は EQ を足す前に separator 再比較を優先する

---

## 7. 学習前整形の責務分離

### 7.1 `singing_learning` 側の責務
- 分離
- cleanup
- dataset input への登録

### 7.2 SBV2 dataset 側の責務
- スライス
- transcription
- 異常区間の除外
- 学習設定初期化

結論:
- 「2秒〜10秒への分割」は本パイプラインの標準後処理ではなく、dataset 工程で扱う

---

## 8. 中長期ロードマップ

### 8.1 前段分離器
評価対象:
- Roformer 系の継続改善
- SSM 系候補
  - Bidirectional Mamba
  - Omni-directional Attention Mamba

目的:
- 長距離依存を保ちながら推論コストを削減する

### 8.2 後段復元器
評価対象:
- diffusion 系の後段 restoration

役割分担:
- 前段: 粗分離
- 後段: 高域欠落補間、知覚アーティファクト低減

### 8.3 条件付き分離
評価対象:
- AudioSep / ZeroSep 系

目的:
- 未知ノイズやオープンセット条件への拡張

### 8.4 評価系
現行の客観指標に加え、主観評価を必須ゲートにする。

優先指標:
- leak
- lowLeak
- high roughness
- speech activity
- silence ratio
- A/B listening

---

## 9. 採用しない運用

### 9.1 学習用 canonical への一律 brightening
理由:
- 分離残渣と歯擦音を一緒に持ち上げやすい

### 9.2 客観指標だけでの採用判断
理由:
- `mixErr` が良くても、実際には音抜けしているケースがある

### 9.3 単一巨大モデル依存
理由:
- 現行コードは multi-candidate 比較が強みであり、単体固定へ戻す理由が薄い

---

## 10. 実行手順

1. `auto` で run を作成する
2. warning の `Ranking` と後段採否ログを保存する
3. `training_canonical` を既定成果物として保存する
4. 必要時のみ `training_bright` または `remix_clear` を追加 export する
5. 学習用セグメント化は SBV2 側で行う
6. 比較結果は曲単位で残し、separator 選定と cleanup 閾値の見直し材料にする

---

## 11. 完了定義

- `training_canonical / training_bright / remix_clear` の役割が文書で分離されている
- 学習用 canonical では固定 EQ を標準化しない方針が明文化されている
- 分離後の確認項目として `speech / silence / leak / roughness / de-bleed / smoothing` が定義されている
- セグメント化責務が `singing_learning` と `SBV2 dataset` で切り分けられている
- 中長期ロードマップとして、前段分離 / 後段復元 / 条件付き分離 / 評価系改善の4系統が整理されている
