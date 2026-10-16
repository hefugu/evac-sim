# 標準ベンチマーク（PR-A）

現行シミュレーターの出力を保存し、後続PRの変更を同じ条件で比較するための実行基盤です。物理モデルや経路選択の係数は変更しません。精度の校正、商用製品との数値比較、安全認証は本ベンチマークの達成範囲に含まれません。

## 実行

リポジトリ直下で実行します。Node.js、npm、Playwright Chromiumが必要です。runner自身が一時的なlocalhost HTTPサーバーを起動・終了します。

```sh
npm ci
npx playwright install chromium
npm run test:benchmarks
npm run bench:smoke
npm run bench:verify
```

標準実行は全12シナリオ × 100/400/1000人 × 1試行、各60シミュレーション秒です。早期に本体の終了条件を満たす場合はそこで終了します。負荷が大きいため、CIでは短いsmoke、標準マトリクスは手動実行を基本とします。固定FPSしきい値は設けません。

```sh
npm run bench -- --out benchmarks/results/full
npm run bench -- --scenarios B01,B02 --populations 100,400 --seconds 60 --repeats 3 --native-random --out benchmarks/results/variation
npm run bench -- --scenarios B01 --populations 100 --seed 0 --save-agents --out benchmarks/results/inspect
npm run bench -- --scenarios B01 --populations 100 --realtime --out benchmarks/results/realtime
npm run bench -- --no-instrumentation --out benchmarks/results/plain
npm run bench -- --compare benchmarks/baselines/baseline.json.gz --out benchmarks/results/compare
```

| オプション | 内容 |
|---|---|
| `--smoke` | B01/B05/B06/B07/B10/B12、6人、2秒、同じ試験seedで2反復。読込と実行経路の軽量確認で、標準人口・完了までの検証ではない |
| `--scenarios B01,B02` / `all` | 実行対象。既定は全シナリオ |
| `--populations 100,400,1000` | 人数。1〜1000の整数を受理し、標準人口は100/400/1000 |
| `--seconds 60` / `--repeats 3` | 観測窓（正の0.1秒刻み）と反復数（正の整数） |
| `--seed 数値または文字列` | 既定13579。試験harnessだけで`Math.random`を`test-lcg32-v1`へ差し替える。各repeatは同じseedへ復元する |
| `--native-random` | 乱数差替えを無効にする。ばらつき取得時は複数回実行し、完全再現は保証しない |
| `--realtime` | ブラウザー本来のRAFで実行。既定は100msずつ進める制御RAF |
| `--no-instrumentation` | 関数内時計計測のHTTP応答変換を無効化。関数別CPU時間は未測定になる |
| `--save-agents` | 生成直後・最終の歩行者状態をJSON/CSVへ追加。通常はdigestと集計のみ保存 |
| `--out 接頭辞` | `.json` / `.csv` / `.md`を出力。既定は`benchmarks/results/latest`で、同じ接頭辞は上書き |
| `--compare ファイル` | JSONまたはgzip圧縮JSONの既存baselineと比較 |

`--seed`は製品のseed機能ではありません。seed保存・Reset・Monte Carlo各試行の独立seed・MC100の再現性は後続PRの課題です。同一seedのrepeatを独立乱数試行として扱わないでください。`speedVar=0`でも、本体の身体属性・希望速度分布の乱数は残ります。

`bench:verify`はB06で試験seed=0の反復、計測変換あり/なしの最終物理digest一致、0.1秒step採取数、比較条件の一致/不一致を検証します。固定seedのrepeatで状態が異なる場合はrunnerも失敗します。長時間実行は完了した試行ごとに`.partial.json`へcheckpointを上書きし、例外時にもその証跡を残します。

## シナリオと初期密度

`scenarios.mjs`の`listScenarios()`と`buildScenario(id, population=100)`がJSON化可能な入力を生成します。セル寸法は0.5m、マップは最大96×58セル/階です。表の面積・密度は入力の設計値で、実行結果の測定値ではありません。

総面積はASCII地形の設計面積で、火源markerによる通行禁止を差し引く前の値です。開始候補の支持面積では火源・出口・階段markerを除いています。

「支持面積」は開始候補セル数×0.25m²です。通常ケースでは1000人時でも支持領域の平均密度≤2人/m²を確保します。B11だけは人口に合わせて支持領域を変え、約4人/m²を指定します。その他のマップ・候補領域は標準人口間で共通です。

| ID | シナリオ・主な確認対象 | 階数 | 総歩行可能面積 m² | 支持面積 m²（1000人） | 支持密度 人/m²（1000人） |
|---|---|---:|---:|---:|---:|
| B01 | 直線廊下：速度・避難時間 | 1 | 611 | 546 | 1.832 |
| B02 | 狭い出口：幅1mの隔壁開口・滞留 | 1 | 1302.5 | 891 | 1.122 |
| B03 | 曲がり角：壁角・経路追従 | 1 | 854 | 513.5 | 1.947 |
| B04 | 複数出口：選択・利用人数 | 1 | 1316 | 1000 | 1.000 |
| B05 | 複数階段：2リンク・混雑・容量 | 2 | 2632 | 1241.5 | 0.805 |
| B06 | 火災・煙：内部簡易モデル・曝露 | 1 | 1316 | 899.75 | 1.111 |
| B07 | 到達不能領域：閉鎖区画の人数保持 | 1 | 1302 | 1161 | 0.861 |
| B08 | 大規模建物：交互開口の複数区画・処理負荷 | 1 | 1280 | 1207 | 0.829 |
| B09 | 双方向階段：両階に開始点・出口、共有1リンク | 2 | 2632 | 2483 | 0.403 |
| B10 | FDS連携：高さ・時刻・明示0・疎な更新 | 1 | 1316 | 1241.5 | 0.805 |
| B11 | 高密度群衆：身体接触・重なり診断 | 1 | 1302.5 | 258.75 | 3.865 |
| B12 | 複数階避難：3F→2F→1Fの連続性 | 3 | 3948 | 1241.75 | 0.805 |

`spawns`は避難者ごとの固定実配置ではなく、既存本体が復元抽出する全候補セルです。同じ点に複数生成されるため、支持領域平均だけで局所密度や初期非重複を保証できません。実配置はdigest、重なりは初期・最終・採取最大の未校正診断として記録し、必要時は`--save-agents`で確認します。B07も到達不能人数を人口の厳密な半数には固定しません。

B01は1000人の収容条件を満たす内法幅13mの廊下で、単独歩行の校正ケースではありません。B02/B11は隔壁の開口幅を設定していますが、出口marker自体の幅モデルを追加したものではありません。B09は既存の出口選択で同一階段の両方向通過を強制できず、fixtureの存在だけで対向流・デッドロックを検証済みとはしません。B10のCSVは取込試験用の人工データで、FDSの実行結果ではありません。

## 読込と計測範囲

ASCIIマップをPNGへ変換し、既存UIの画像入力から読み込みます。出口・火源・階段・階段リンクはUIのmodeとpointer eventを通します。開始候補だけは大量markerの準備描画を避けるため共有floorの`spawns`配列へ直接設定します。地形・寸法・marker数を照合後、本体の開始ボタン・人数生成・実行ループ・共通物理clockを使用します。

計測時は`core.js`と`pedestrian-dynamics.js`のHTTP応答だけに実時計`performance.now()`と`try/finally`を追加します。ディスク上のproduction source、物理式、係数、時間刻みは変えません。挿入位置の一意性・終端のガードが一致しなければ停止し、不明な位置へ計測を継続しません。

| 指標 | 範囲と読み方 |
|---|---|
| `setupWallMs` | fixtureの読込・設定 |
| `startupWallMs` | 開始ボタン、人口生成、初期経路・index準備 |
| `executionWallMs` | 実行loop、snapshot、CDP採取、通信を含む。集計後処理・ファイル書込は除外 |
| `timing.step` | 本体`stepSimulation`全体。終了stepで内包する描画を含む。平均・P95等を保存 |
| `routing` / `pedestrian` / `agentBlock` / `fire` / `smoke` / `render` | それぞれ関数または既存profile区間の時間。`step`との包含や成分同士の包含があるため合算不可 |
| `msPerSimulationSecond` / `physicsCpuMsPerSimulationSecond` | 前者は実行実時間、後者は計測したstep累計時間をシミュレーション秒で除した値 |
| `sampledMaxJsHeapBytes` | batchごとのCDP `JSHeapUsedSize`採取最大。真のpeak、ブラウザー全体RSS、GPU使用量ではない |
| `renderFps` | 制御RAFでは未測定。`--realtime`かつ描画計測時は2D render呼出し数/実時間で、画面present/GPU FPSではない |

warmup除外は行いません。snapshot・計測・通信の負荷も残るため、これらを除去した純粋なモデル性能とは呼びません。初期化で行う経路計算はstartup側に入り、実行中の`routing`採取が0件のこともあります。

歩行者sample履歴は実行終了までbrowser内に保持します。CDP heapにはこの計測履歴のメモリも含まれ、モデル単体のメモリ消費として扱えません。

既定の制御RAFは本体の0.1秒step後を採取します。`--realtime`はRAF末尾で採取するため、1frame内に2stepが進む場合の中間状態は得られません。速度・滞留・階段待機時間は左端値による時間積分で、realtime時はframe間近似です。3D表示切替による同一物理結果の保証は本runnerでは行いません。

## 出力・比較・合否

JSONにはcommit SHA、モデル版の説明、主要source/harnessのhash、環境、乱数条件、driver、fixture、試行別集計、初期・最終物理状態digest、未測定理由を保存します。CSVはネストした項目を列展開し、配列をJSONで保持します。Markdownは主要指標の要約です。固定baselineは`benchmarks/baselines/`、都度の大きな出力は`benchmarks/results/`へ分け、不要な大容量出力をGitへ追加しない運用とします。runnerは通常JSONを出力し、gzip baselineも比較入力として読み込めます。

未完了者は観測打切り人数に含め、全員完了していなければ`completionTimeSec=null`です。平均・P95等は完了者の`finishTime-startTime`だけを集計します。出口別人数・10秒区間流量は実際の終端位置と直前sampleから帰属し、目標出口を通過出口と見なさず、不明分は未帰属・未測定理由を残します。煙・熱・COの曝露量は既存本体の値で、完全なFEDではなく、`critical`を死亡と読み替えません。

避難時間の分位点は線形補間（R-7）、標準偏差は完了標本を母集団として計算します。処理時間のP95は昇順の`ceil(0.95*n)`番目（nearest rank）です。初期到達不能は初期`potential0`が非有限の人数で、途中の閉塞や単なる打切り人数とは区別します。

`--compare`はシナリオ/人口/反復/観測窓に加え、fixture、環境、乱数、driver、harnessの一致を照合し、一致しない試行の差分を計算しません。出力は数値差と相対差で、未測定値は`null`です。同一環境情報でも他プロセスのCPU負荷、電源・温度状態、OS schedulingまでは管理できません。複数試行のばらつきと計測条件を示し、差分だけで性能改善や精度向上を断定しないでください。

`PASS`は取得可能な共通チェックで違反を検出しなかったことを示し、fixtureの`invariants`全文を保証しません。人数・ID保持、有限状態、取得できる曝露値、中心点とsample間直線の壁通過、採取時の階段容量等を検査します。違反があれば終了コード1です。身体円の重なりは未校正診断として別記し、自動合否のしきい値にしません。

FIFOの全イベント順、身体外周の壁接触、物理step内部の曲線軌跡、煙の保存量、FDSの全時刻での反映・解除、対向流の実発生などはrunnerの共通PASSの保証範囲外です。個別の既存Node/Playwright回帰と後続PRの検証を併用します。未測定・未帰属・coverage不足はJSONの`unavailableReasons`、`validationCoverage`、`coverage`を確認してください。
