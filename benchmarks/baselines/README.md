# PR-A 実測baseline

本成果はPR-A「現状調査・標準ベンチマーク」です。既存mainの挙動を保存し、後続変更の比較基準を作りました。性能改善率、精度向上、研究モデルの校正、プロジェクト全体の完了は主張しません。

source基準commit（baselineSHA）: `1ac28ed703fec7459ca2c4eee1c0affec77a8304`

4実測のcommit一致: 一致。主要runtime source hash一致: 一致。

環境: AMD Ryzen 7 7730U with Radeon Graphics          / win32 10.0.26200 / x64 / Node v24.16.0 / Chromium 151.0.7922.34。

実測開始日時: 2026/10/16 09:22:26 JST。レポート生成日時: 2026/10/16 09:44:43 JST。

実測manifestでruntime未コミット変更は記録されていません。

## 100人・12シナリオの実測

制御production RAF・物理step 0.1秒、最大観測窓60秒、試験用乱数 test-lcg32-v1 / seed 13579。本体が早期終了したrunは表の観測秒で停止します。

平均・P95は完了者の `finishTime-startTime` のみです。打切り者を60秒の成功標本へ置き換えません。「—」はnull/未測定で、全員完了時間は全員が避難完了しない限りnullです。階段完了通過は延べ回数で、人数とは限りません。

| ID / シナリオ | 完了/初期 | 打切り | 初期到達不能 | 観測秒 | 全員完了秒 | 完了者平均秒 | 完了者P95秒 | 階段完了通過 | step平均ms | step P95ms | 不変条件 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B01 直線廊下 | 100/100 | 0 | 0 | 49.4 | 49.40 | 24.53 | 42.56 | 0 | 18.60 | 116.60 | PASS |
| B02 狭い出口 | 24/100 | 76 | 0 | 60.0 | — | 36.58 | 54.71 | 0 | 34.72 | 250.90 | PASS |
| B03 曲がり角 | 100/100 | 0 | 0 | 56.7 | 56.70 | 34.06 | 50.01 | 0 | 22.61 | 160.10 | PASS |
| B04 複数出口 | 100/100 | 0 | 0 | 30.4 | 30.40 | 16.10 | 25.12 | 0 | 44.36 | 470.80 | PASS |
| B05 複数階段 | 48/100 | 52 | 0 | 60.0 | — | 30.42 | 55.43 | 52 | 77.04 | 921.10 | PASS |
| B06 火災・煙 | 100/100 | 0 | 0 | 29.5 | 29.50 | 15.62 | 24.02 | 0 | 50.11 | 443.50 | PASS |
| B07 到達不能領域 | 34/100 | 66 | 66 | 60.0 | — | 14.18 | 21.69 | 0 | 14.88 | 108.10 | PASS |
| B08 大規模建物 | 100/100 | 0 | 0 | 44.3 | 44.30 | 16.98 | 34.33 | 0 | 40.68 | 447.40 | PASS |
| B09 双方向階段 | 100/100 | 0 | 0 | 53.2 | 53.20 | 24.17 | 43.93 | 0 | 74.42 | 945.30 | PASS |
| B10 FDS連携 | 100/100 | 0 | 0 | 30.2 | 30.20 | 13.34 | 23.82 | 0 | 40.41 | 435.00 | PASS |
| B11 高密度群衆 | 15/100 | 85 | 0 | 60.0 | — | 44.75 | 58.31 | 0 | 27.92 | 215.00 | PASS |
| B12 複数階避難 | 14/100 | 86 | 0 | 60.0 | — | 51.42 | 57.74 | 45 | 108.89 | 1358.30 | PASS |

B07の初期到達不能は66人、最終打切りは66人でした。開始候補からの復元抽出により、到達不能人数は人口の厳密な半数に固定されません。

## B08負荷反復

100/400/1000人、観測窓30秒、各3反復。同じ試験用seedへ毎回戻すため、これは独立乱数試行ではありません。CPU・heapの範囲は同じ入力の実行時ばらつきです。digest一致はこのブラウザー・driver・観測窓・試験seedでの結果です。

| B08人数 | 反復 | step平均ms範囲 | step P95ms範囲 | step CPU ms/模擬秒 範囲 | 採取最大heap MiB範囲 | 最終物理digest | 不変条件 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 3 | 36.51–38.30 | 378.40–409.90 | 365.09–383.02 | 43.78–60.74 | 一致 | 全PASS |
| 400 | 3 | 71.29–72.54 | 408.60–438.50 | 712.85–725.42 | 71.19–84.75 | 一致 | 全PASS |
| 1000 | 3 | 148.92–154.46 | 495.10–511.20 | 1489.25–1544.59 | 150.64–158.68 | 一致 | 全PASS |

step平均・P95は実時計による関数経過時間です。終了step内の描画を含み、routing・歩行者・agentBlock・render等は包含関係があるため合算できません。warmup除外は行っていません。heapはbatchごとのCDP JSHeapUsedSize採取最大で、真のpeak・ブラウザー全体RSS・GPUメモリではありません。browser内で全step sampleを保持しているため、CDP heapには計測harnessの履歴メモリも含みます。モデル単体のmemoryではありません。

## 未固定Math.randomの3試行

B01・100人、ブラウザー本来のMath.randomを使用します。完全再現の保証はなく、以下は3試行の記述統計です。信頼区間や性能優劣の認定ではありません。

| 試行 | 完了/初期 | 打切り | 全員完了秒 | 完了者平均秒 | 完了者P95秒 | 不変条件 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 100/100 | 0 | 49.60 | 24.43 | 43.62 | PASS |
| 2 | 100/100 | 0 | 47.10 | 23.49 | 42.02 | PASS |
| 3 | 100/100 | 0 | 48.50 | 26.01 | 45.91 | PASS |

| native 3試行の指標 | 有効試行数 | 最小–最大秒 | 試行平均秒 | 試行間母標準偏差秒 |
| --- | --- | --- | --- | --- |
| 全員完了時間 | 3 | 47.10–49.60 | 48.40 | 1.02 |
| 完了者平均時間 | 3 | 23.49–26.01 | 24.64 | 1.04 |
| 完了者P95 | 3 | 42.02–45.91 | 43.85 | 1.60 |

全員完了時間がnullの試行は、その指標の試行間統計から除外し、有効試行数を示します。完了者平均・P95も各試行の完了者限定値です。

## native RAFの短時間観測

この実測の乱数: test-lcg32-v1 / seed 13579。native RAFはブラウザー本来の描画clockを意味し、native乱数を意味しません。

| 対象 | 観測模擬秒 | 実行実時間秒 | 2D render呼出し数 | observed render呼出しFPS | 不変条件 |
| --- | --- | --- | --- | --- | --- |
| B01 / 100人 / native RAF | 3.0 | 2.935 | 31 | 10.56 | PASS |

observed render呼出しFPS = 計測した2D render呼出し数 ÷ 実行実時間です。画面present FPS・GPU FPSではありません。3秒の短時間観測で長時間の滑らかさは判定できません。native RAFではframe末尾sampleのため、複数物理stepが同一frameで進んだときの中間状態を採取していません。

## 検証結果と読み方

| 検証 | 実測結果 / 範囲 |
|---|---|
| 既存Node回帰 | 128件成功（ローカル実測） |
| 既存ブラウザー回帰 | 31件成功（ローカル実測） |
| benchmark単体 | 65件成功（ローカル実測） |
| B06 `bench:verify` | PASS。seed=0の反復、計測HTTP応答変換あり/なしの初期・最終物理digest一致、0.1秒step採取数、比較条件の一致/不一致を検証（ローカル実測） |
| 保存baseline 25 run | 採取可能な不変条件チェックは全PASS |
| GitHub CI | 当該PRのChecksを参照。この表のローカル実測とは別に確認する |

共通PASSは、人数・ID保持、有限の歩行者状態、取得できる累積曝露、壁中心侵入・隣接sample間直線の壁横断、採取時の階段容量等で違反を検出しなかったという意味です。シナリオ定義に書いたすべての要求を保証するものではありません。

## 適用範囲・未検証

- 本体のSocial Force、火災、煙、階段、CSV/FDS、2D/3Dの物理式・係数はPR-Aの改善対象にしていません。計測はHTTP応答に時計を追加し、ディスク上のproduction sourceを変更しません。B06の変換前後digest一致は限定した実行条件の確認です。
- 試験用LCGはharness限定です。製品seed保存・Reset・MC100・試行別seed・ブラウザー間やPC間の完全再現は未検証です。
- 標準全12ケースを100/400/1000人で各3回、長時間完了まで測定したわけではありません。今回の人口・観測窓は各表に示した範囲です。
- 身体外周と壁の接触、step内部substepの曲線軌跡、階段FIFOの全イベント順、B09での両方向流の実発生・対向流デッドロックは共通チェックの範囲外です。
- 初期配置は復元抽出で重なり得ます。身体円の重なりは初期・最終・採取最大を分けた未校正診断で、勝手な合否しきい値を置いていません。
- geometry.walkableAreaM2はASCII地形の設計面積で、火源markerによる通行禁止を差し引く前の値です。初期配置の支持面積とは別で、B06のinitialPlacement.supportAreaM2はfireセルを候補から除外済みです。
- 煙の質量・熱保存の全過程、FDSの全時刻反映・解除、実験データへの校正、完全なFED・死亡判定、実建物の安全性は今回のbaselineから判断できません。B10は人工の取込fixtureです。
- 商用製品の数値比較、実測歩行データ比較、3D切替による同一物理結果、画面FPS/GPU性能、別PC・OS・ブラウザーの互換性は未検証です。
- CPU経過時間・実時間には計測、snapshot、CDP、通信等の負荷や他プロセスの影響があります。純粋な物理モデル性能とは呼びません。
- 欠測値、出口未帰属、部分的なsampling、検査範囲はraw JSONのunavailableReasons / invariants.validationCoverage / coverageを確認してください。

## 後続PR

| PR | 後続範囲 |
| --- | --- |
| PR-B | 製品PRNG・seed保存、seed=0、Reset、Monte Carloの試行seedと再現性 |
| PR-C | 出口幅・出口負荷、経路探索・距離場・出口選択の改善 |
| PR-D | Social Force・身体接触・壁衝突・高密度歩行の検証と改善 |
| PR-E | 階段FIFO・容量・着地・対向流・複数階接続の検証と改善 |
| PR-F | 火災・煙・保存量・人体曝露・FDS反映と適用限界の検証 |
| PR-G | 実測で支配的な処理を特定した性能最適化と同条件比較 |
| PR-H | 既存操作を維持した研究用UI・設定状態・結果表示の改善 |
| PR-I | 責務分離・モジュール整理・API安全性 |
| PR-J | Monte Carlo統計・比較レポート・外部製品との根拠を伴う比較 |

後続変更はこの基準の条件・harness・入力・環境を照合して比較し、同時に独立乱数試行と必要な物理検証を追加します。無関係な改修をまとめず、PRごとに再現・原因・変更・検証・限界を記録します。

## 保存データと再実行

raw JSONをgzip level 9で保存しています。通常の全量Markdown/CSVはGitへ追加せず、README要約と圧縮raw4本をbaselineとして保持します。100人12ケースのrawには初期・最終agentを含みます。

| 圧縮raw | run数 | 展開後サイズ | source commit | 展開後JSON SHA-256 |
| --- | --- | --- | --- | --- |
| baseline-main-100.json.gz | 12 | 31,896,445 bytes | 1ac28ed703fec7459ca2c4eee1c0affec77a8304 | 02512ef61fc3bb897863825de7ba64bb2aab1976bcc8169903e599bf07356308 |
| baseline-main-load.json.gz | 9 | 2,100,033 bytes | 1ac28ed703fec7459ca2c4eee1c0affec77a8304 | 9ede9b1aaaebc9fb931817b9a122f7024385f4d231cd891905f8013a3287ee74 |
| baseline-main-uncontrolled.json.gz | 3 | 263,038 bytes | 1ac28ed703fec7459ca2c4eee1c0affec77a8304 | 7cb74ba184e227790df61cfe2492fdb821e8571ee849380f89820ffde6a7604f |
| baseline-main-realtime.json.gz | 1 | 201,739 bytes | 1ac28ed703fec7459ca2c4eee1c0affec77a8304 | d97d7bd0b22a21b22a090066be30e32cc3729b9402ca494cea17f195eb436b94 |

```sh
npm run test:benchmarks
npm run bench:verify
npm run bench -- --scenarios all --populations 100 --seconds 60 --save-agents --out benchmarks/results/baseline-main-100
npm run bench -- --scenarios B08 --populations 100,400,1000 --seconds 30 --repeats 3 --out benchmarks/results/baseline-main-load
npm run bench -- --scenarios B01 --populations 100 --seconds 60 --repeats 3 --native-random --out benchmarks/results/baseline-main-uncontrolled
npm run bench -- --scenarios B01 --populations 100 --seconds 3 --realtime --out benchmarks/results/baseline-main-realtime
npm run bench -- --scenarios all --populations 100 --seconds 60 --compare benchmarks/baselines/baseline-main-100.json.gz --out benchmarks/results/comparison
```

圧縮rawの比較入力にも対応します。driver・乱数・観測窓・fixture・環境・harnessが不一致の比較はrunnerが数値差の対象から除外します。

実行・各指標の定義は [benchmarks/README.md](../README.md) を参照してください。
