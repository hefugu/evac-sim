# 火災工学・FDS連携の根拠メモ

## 目的

このシミュレータは、学校内の避難行動を扱うブラウザ上の避難シミュレーションである。
本体はCFDソルバではないため、火災・煙の信頼度は、FDS等で得た時刻別・セル別データをCSVとして読み込み、避難行動側へ反映する構成にする。

## CSV形式

以下の列を読む。

```csv
time_s,floor,cx,cy,heat_flux_kw_m2,optical_density_m_1,co_ppm,visibility_m,temperature_c
```

- `time_s`: 時刻[s]
- `floor`: フロア番号。CSVでは1始まり、内部では0始まりへ変換する。
- `cx`, `cy`: evac-simのグリッドセル座標。
- `heat_flux_kw_m2`: 熱流束[kW/m^2]
- `optical_density_m_1`: 光学濃度または減光係数[1/m]
- `co_ppm`: CO濃度[ppm]
- `visibility_m`: 視界距離[m]
- `temperature_c`: 温度[℃]。現段階では読込予約列。

## 実装上の扱い

FDS CSVが読み込まれている場合は、CSV値を優先する。
読み込まれていない場合は、簡易煙拡散と t² fire によるフォールバック値を使う。
フォールバックは相対比較用であり、絶対的な火災予測ではない。

## 導入根拠

- NIST FDSは、火災による煙・熱輸送を扱う低速流向けLESコードである。
- FDS/SmokeviewにはUser Guide、Technical Reference Guide、Verification Guide、Validation Guideが公開されている。
- 避難安全では、ASET/RSETの考え方により、視界、煙、有毒ガス、熱を避難可能時間の制約として扱う。
- 視界は煙の減光係数や光学濃度と関連し、避難経路の安全性に影響する。
- t² fire は火災成長を Q = alpha t² とする代表的な火災成長モデルである。

## 注意

- evac-sim単体ではNavier-Stokes方程式を解かない。
- FDS CSVがない場合の熱流束・CO・視界は簡易推定である。
- 発表では「FDS CSVを読み込める設計」「FDSなしの場合は簡易リスク場」と説明する。
