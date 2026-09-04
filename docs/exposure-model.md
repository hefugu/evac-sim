# 人体影響ではなく独立した曝露・tenability評価

`simulation/exposure.js` は共有エージェント state に対して、曝露積分と条件スクリーニングを行う。2D の `core.js` と既存 3D の互換ヘルパーが同じ関数を使う。3D レンダラーが別の時間積分を行うことはない。

旧 `SMOKE_DEATH_DOSE`、`HEAT_DEATH_DOSE`、`CO_DOSE_FATAL_PPM_MIN`、`HEAT_FLUX_DOSE_FATAL`、`LETHAL_SMOKE_LEVEL` と火元近傍による死亡判定を廃止した。これは閾値を超えた人の生死を予測する根拠がなく、経路比較が死亡判定の恣意性に支配されていたためである。`dead`/`deathCause` は互換データとして残る。現在の実行コードでは座標範囲外の無効エージェント除外だけが旧 `dead` フラグを使用し、火災による死亡人数として解釈しない。

## 曝露量と単位

時刻間隔を Δt [s] とし、各位置の目線高さ（既定 1.6 m）の代表値をステップ中一定として `E[n+1] = E[n] + x[n] Δt` で積分する。これは時空間離散化した経路上の矩形積分であり、生理モデルではない。外部 FDS データがある量だけを上書きし、欠損量には同じ共有 state の fallback 値を使用する。

| `agent.exposure` のフィールド | 定義 | 単位・注意 |
| --- | --- | --- |
| `durationSeconds` | 観測された軌跡時間 | s |
| `visibilityMSeconds` | ∫S dt | m·s。単純な可視距離積分。小さい値だけで他者より危険とは判定せず、観測時間も比較する |
| `visibilityDeficitSeconds` | ∫clamp(1 − S/Sref, 0, 1) dt | s。Sref = degraded 可視距離、既定 10 m。便宜的な視認困難度指標 |
| `lowVisibilitySeconds` | ∫1(S ≤ Sref) dt | s |
| `coPpmMin` | ∫C_CO dt / 60 | ppm·min。CO 濃度時間積。FED ではない |
| `heatFluxKwM2Seconds` | ∫q″ dt | kW/m²·s。2.5 kW/m²などを減算しない全熱流束積分 |
| `temperatureCSeconds` | ∫T dt | °C·s。温度積分。エネルギーや火傷量ではなく、周囲温度の寄与も含む |
| `temperatureAboveAmbientCSeconds` | ∫max(T − Tambient, 0) dt | °C·s。既定 Tambient = 20 °C |
| `extinctionM1Seconds` | ∫K dt | m⁻¹·s。自然対数基準の消光係数を積分 |
| `smokeDensitySeconds` | ∫s_display dt | s（s_display は無次元）。従来表示用煙 proxy の時間積分。物理濃度は消光係数を優先 |
| `tenabilitySeconds` | 各状態にいた時間 | 状態ごとの s |

`schemaVersion: 1` と `gasPpmMin: {co: ...}` を持ち、将来は単位付きガス種を追加できる。現時点で `fed: null` と CSV の `full_fed_available=0` を出力する。O₂低下、CO₂による呼吸量増大、HCN・他刺激性ガス、呼吸生理、個人差を扱っていないため CO のみを完全な FED と呼ばない。

`smokeDose`、`heatDose` は従来の無次元表示指標を残すが、死亡や主評価に使用しない。`coDosePpmMin`/`coDose` は `exposure.coPpmMin` の互換別名、`heatFluxDose` は全熱流束積分、`temperatureDoseCSeconds` は生の温度積分の互換別名となる。旧版の熱流束・温度の閾値超過積分とは意味が変わるため、研究用 CSV では単位を明記した新しい列を使用する。

## スクリーニング方針

`tenability` は現在値、`worstTenability` は軌跡中の最悪状態である。`firstCriticalTimeSec` は初めて critical を観測したステップの開始時刻、`tenabilityReasons` は現在閾値を超える独立した要因一覧である。いずれも条件フラグであり、生存・死亡・失神を意味しない。低い危険場へ戻れば現在値は tenable に戻るが、累積曝露と最悪状態は残る。

既定 `comparison-screen-v1` は以下の比較用方針を使う。いずれかの critical 条件で critical、それ以外でいずれかの degraded 条件なら degraded、それ以外は tenable とする。tenable は「入力した対象量の既定条件を超えなかった」という意味に限る。

| 量 | degraded | critical | 根拠・仮定 |
| --- | --- | --- | --- |
| 可視距離 S | ≤10 m | ≤5 m | 長距離と近距離の経路比較に用いる明示的な選択。学校避難者に対する検証済み閾値ではない |
| 消光係数 K | ≥0.3 m⁻¹ | ≥0.6 m⁻¹ | 反射式標識近似 S = 3/K に上記可視距離を対応。S と K を二重加算せず状態判定のみ |
| CO | ≥200 ppm | ≥1200 ppm | NIOSH ceiling / IDLH の濃度をスクリーニング参照として借用。職業曝露基準を火災生存限界へ転用しない |
| 熱流束 | ≥1 kW/m² | ≥2.5 kW/m² | degraded は早期注意の方針値。critical は NIST IR 7120 の熱暴露比較 benchmark を参照 |
| 温度 | ≥60 °C | ≥120 °C | degraded は早期注意の方針値。critical は同 NIST 文献の benchmark を参照。湿度・服装依存性は未計算 |

数値を死亡に結びつけず、研究では閾値感度、連続曝露量、観測時間、未避難割合を併記する。[NIST HAZARD I 技術資料](https://nvlpubs.nist.gov/nistpubs/Legacy/hb/nisthandbook146v2.pdf) のように温度・熱流束・ガス濃度時間積を分離する設計を参考にしたが、その生理アルゴリズムを実装したものではない。[NIST IR 7120](https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=861308) は熱条件の 120 °C / 2.5 kW/m² を絶対的な値ではなく比較 benchmark として扱う。[NIOSH CO 資料](https://www.cdc.gov/niosh/idlh/630080.html) は 200 ppm ceiling、1200 ppm IDLH を掲載する。

既定値は `DEFAULT_TENABILITY_OPTIONS` に集約し、実行時は `state.hazards.tenabilityOptions` から参照できる。例えばシナリオスクリプトから以下を設定できる。変更はシミュレーション開始前に行い、感度分析では `policyId` も変更する。終了 summary と Monte Carlo 各 run に使用方針を保存する。

```js
import { state } from './sim/js/state.js';
state.hazards.tenabilityOptions = {
  ...state.hazards.tenabilityOptions,
  policyId: 'school-sensitivity-8m',
  visibilityDegradedMeters: 8,
  maxSimulationTimeSec: 900
};
```

## 終了・Monte Carlo・出力

critical に達しても移動・階段遷移を停止せず、従来の避難行動を続ける。死亡判定を削除すると閉塞した経路の run が無限に続くので、既定 600 s の明示的な観測窓を設けた。これは救命期限ではない。時刻到達時に未避難者を `unresolved`、`censored` として記録し、`finished` や `dead` を設定しない。全員の避難が早ければ通常終了する。

完了時刻の平均・最大は避難を完了した標本だけで計算し、標本数 `evacuationTimeSampleCount` を出す。未避難者へ打切り時刻を避難成功時刻として代入しない。互換 summary の `avgTime=0` / `maxTime=0` は標本数 0 のとき「標本なし」であり、MC の対応値は `null` となる。MC 各 run は曝露合計、現在・最悪 tenability 人数、打切り数、観測時刻・終了理由も保持する。

CSV は `tenability` / `worst_tenability` と上記物理単位付き列を出力する。比較には `critical` 経験人数、独立曝露分布、未避難率を主指標として使う。生理学的な FED、絶対的な実火災予測、法令適合性を保証する評価ではない。

Monte Carlo の次 run が前 run のフレーム内から開始されても、予約中の `requestAnimationFrame` は常に 1 個に保つ。旧 run の固定ステップ時間は次 run の初期化前に消費し、新しい積分時間を負にしない。これにより各 run の独立性と UI の応答を維持する。

明示的な Stop / Reset は Monte Carlo も停止し、次の run を自動開始しない。Stop は既に完了した run の結果を保持し、進行中 run を手動終了の summary として残す。内部の run 間 reset のみ継続フラグを指定する。

## 検証

`node --test tests/exposure.test.mjs` は独立単位積分、悪化と回復、dt=0.1/0.05 s の積分一致、状態別時間・人数、打切りが死亡を変更しないこと、方針差し替え、3D 互換関数との同一性、研究 CSV の単位付き数値を検証する。

`tests/browser/runtime.spec.mjs` は実際の PNG 読込と UI マーカー配置を使用し、100 run の Monte Carlo が各 run の曝露と打切りを記録して完了すること、煙・火災延焼・曝露の reset、UI で接続した階段を通った別階出口への避難を検証する。
