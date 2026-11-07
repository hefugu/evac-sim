# 現行 main の構成・モデル・未検証事項の監査

調査日: **2026-10-16（日本時間）**。対象: [hefugu/evac-sim](https://github.com/hefugu/evac-sim)。基準コミット: **`1ac28ed703fec7459ca2c4eee1c0affec77a8304`**（PR #7 の merge commit）。

本書は PR-A の現状調査であり、物理式、係数、時間刻み、経路選択を変更しない。ソースで確認した仕様、GitHub 上の履歴、今回の実測、未検証の仮説を区別する。ベンチマークの実行方法・記録は [`../benchmarks/`](../benchmarks/) を参照し、本書中の過去 PR の件数を今回の試験結果として扱わない。

## 1. 調査で確認した結論

- 公開 `/sim` の計算主体はブラウザ内の `sim/js/simulation/core.js`。FastAPI は静的シミュレータの必須依存ではない。
- 現行 main は、危険度付き多階 Dijkstra、連続 Social Force、階別実寸換算、階段容量・FIFO・着地予約、火災・保存量付き煙輸送、FDS CSV、曝露、Monte Carlo、共有 2D/3D を既に持つ。以前の PR の修正を再導入する段階ではない。
- 出口負荷引数は現行の出口選択で使われておらず、画像から検出した出口領域は経路計算上の代表点に縮約される。これはコード上確認した残課題である。出口流量や避難時間への影響量は本調査だけでは確定しない。
- 利用者が指定・保存できる全体 seed は未実装。既存ブラウザ試験は `Math.random` の差し替えを利用できるが、製品機能としての再現性とは別である。
- 火災・煙・行動には文献を参照した式と独自の近似・数値安定化・シナリオ例が混在する。既存テストの保存則・幾何・状態整合性確認は、実験データによる妥当性検証を代替しない。

## 2. GitHub の既存 PR / Issue

以下は 2026-10-16 に GitHub connector で取得した状態。PR 本文の検証結果は著者の過去報告であり、今回の基準 SHA に対する再実行結果ではない。

| 対象 | 取得時の状態 | main と今回の扱い |
| --- | --- | --- |
| [PR #1: Improve evacuation routing correctness and exit balancing](https://github.com/hefugu/evac-sim/pull/1) | **open / unmerged**。head `1e7c74780ff6da8a4dfb5a2fa6ce70249644b461`、古い base `fd9b569…` | 出口負荷ペナルティ・再計画時の負荷更新・全幅出口 seed が提案されている。角の斜め抜け防止などは現行 main にも存在する。後続 PR-C で差分を選別し、古い PR を無条件に適用しない。 |
| [PR #4: UI・標準条件と出口・階段](https://github.com/hefugu/evac-sim/pull/4) | **merged**。merge `43e352059af966059c89e01b4818a807b91de24d` | UI 整理、連続 Social Force、階別実寸、t² 成長条件、到達不能者保持等は基準 SHA に含まれる。本文の Node 128 / Playwright 30 は過去報告。 |
| [PR #6: 出口への安全な経路選択と階段](https://github.com/hefugu/evac-sim/pull/6) | **merged**。merge `768f6c36de6b5c31b20fe39f8818b96d57f548d1` | PR #4 に取り込まれた変更。危険域からの脱出、煙迂回、壁角、着地予約、双方向の交換、到達不能者の集計が既にある。本文の Node 97 / browser 16 は旧段階の結果。 |
| [PR #7: 3D 準備前の操作](https://github.com/hefugu/evac-sim/pull/7) | **merged**。merge **`1ac28ed703fec7459ca2c4eee1c0affec77a8304`** | 3D 初期化・イベント登録まで関連操作を待機させる。今回の基準そのもの。遅延モジュール試験があるため同じ問題を新規不具合とみなさない。 |
| [Issue #2: seeded RNG](https://github.com/hefugu/evac-sim/issues/2) | **open** | [`seed-reproducibility-plan.md`](seed-reproducibility-plan.md) は計画であり、実装済みを意味しない。PR-B の対象。 |
| [Issue #3: FastAPI upload](https://github.com/hefugu/evac-sim/issues/3) | **open** | `server/main.py` は利用者ファイル名を保存先へ直接連結し、全体を read / write した後に画像を開く。サイズ・拡張子・安全な保存先の検証を後続 PR-I で実装する。今回、外部公開 API への攻撃試験やファイル書込み再現は行わない。 |

## 3. 実行構成と状態の所有者

| 領域 | 主なファイル | 現行の責務・境界 |
| --- | --- | --- |
| 入口・UI | `sim/index.html` → `sim/js/main.js`、`ui.js`、`mapLoader.js` | 画像は FileReader / canvas でブラウザ内処理。`view3d.js` は遅延 import。 |
| 実行統合 | `sim/js/simulation/core.js` | マップ・人口生成、時計、距離場、経路選択、階段、火災・煙、曝露、MC、集計と UI の統合。依然として状態依存責務が集中している。 |
| 共有 state | `sim/js/state.js` | `map` / `sim` / `mc` / `spatial` / `hazards` / `evaluation` / `render`。旧 flat フィールドは `syncLegacyState()` で互換維持。 |
| 経路 | `potential.js`、`routing.js`、`grid-movement.js` | 多階 Dijkstra、火災回避場、線分・壁角検査。出口の最終選択は core にある。 |
| 連続歩行 | `pedestrian-dynamics.js`、`wall-index.js` | 円形身体、SI 単位での力・速度、対人空間ハッシュ、壁面 index、再利用 workspace。 |
| 階段 | `stairs3d.js`、`stairs.js` | 移動時間・容量のリンクと queue / inTransit。物理的な階段内部を歩行して解く方式ではない。 |
| 火災・煙 | `fire3d.js`、`smoke3d.js`、`corridor-smoke.js` | 現行 2D もこの互換アダプタを使う。`3d` という名前は独立した 3D CFD 計算を意味しない。 |
| FDS・曝露 | `fds-csv.js`、`exposure.js`、`agents3d-sync.js` | 外部観測値の項目別・高さ別上書きと、経路上の単位付き積分。 |
| 描画 | `renderer.js`、`renderer3d.js`、`view3d.js`、`visualization/*` | 共有状態を読む。煙・火災の物理計算は描画側で進めない。 |
| 専用 3D | `3d.html` → `3d-page.js`、`state-bridge3d.js` | BroadcastChannel で geometry / dynamic snapshot を受信。主画面不在時はサンプル閲覧。 |
| 保存・出力 | `storage/presets.js`、`storage/history.js`、`export/csv.js` と core | localStorage の条件保存、履歴、Blob による CSV 出力。現状の保存は PRNG を含む完全な実験アーカイブではない。 |
| optional API | `server/main.py`、`admin/`、`client/` | FastAPI の画像・マーカー・WebSocket 経路 API。静的 `/sim` と別の経路実装を持ち、精度・安全性を同一視しない。 |

`simulation/smoke.js` / `fire.js` / `movement.js` / `montecarlo.js` / `optimizer.js` は空の移行予約関数で、現在の入口から使われない。旧 `sim/simulation.js` も現行 HTML の入口ではないが、FastAPI に互換配信ルートが残る。削除や空モジュールへの全面移植は今回行わない。詳細は [`module-migration-audit.md`](module-migration-audit.md)。

### 共通時計

`core.js` は requestAnimationFrame の実時間差を蓄積し、**0.1 s 固定物理ステップ**で状態を進める。歩行力学は内部で最大 **0.05 s** に分割する。煙は同じ時間軸の 0.1 s 刻みを使い、火災は同じ時計上で原則 0.5 s ごとに更新する。全系が同じ頻度で更新されるという意味ではない。

長い実時間差は 1 frame 当たり最大 0.5 s まで受け入れ、1 frame の物理処理は最大 2 step、余剰 backlog は最大 0.1 s までに切り詰める。このため、重い描画や停止タブでは**実時間に対する進行速度が下がり得る**。比較停止条件は wall-clock 秒ではなく `state.sim.time` とし、FPS と計算速度を分けて測る。同一物理時刻での 2D/3D 不変性と、異なる実時間到達率は別の検証項目である。

## 4. 経路・出口・幾何

`potential.js` は非負辺コストの二分 heap を用いた Dijkstra。平面は 8 近傍（直交 1、斜め 1.414）を用い、斜め辺では両直交隣接セルの通行可能性も検査する。core は階別セル幅 `s_f [m]` を基準 0.5 m に換算し、概ね次のコストを渡す。

```text
平面辺 = 近傍係数 × (s_f / 0.5 m) × (1 + 危険度ペナルティ)
階段辺 = travelCostSec × (基準速度[m/s] / 0.5 m)
         × (1 + (queue人数 + inTransit人数) / congestionCapacity)
```

これは距離と階段秒数を比較する**重み付き一般化コスト**であり、個人の正確な到着予測時間ではない。煙・CO・熱・温度・視界の重み、近傍混雑・方向慣性・停止解除条件は独自の行動条件で未校正。火災回避領域は `max(3セル, 4 m / s_f)` で、物理的な安全離隔を保証する式ではない。

出口選択は火災回避可能な場を辞書式に優先し、安全場がなければ通常の危険度付き場へ fallback する。2 m の出口接近固定と切替余裕など、切替振動を抑える既存処理もある。危険な近い出口より安全な遠い出口を選ぶ回帰試験を維持する。

**残課題のコード経路:** `collectMarkerRegions()` は画像の連結出口領域から `{cx, cy, cellCount}` を返す。`normalizeImageExits()` / `collectAllExits()` は中心代表点だけを引き継ぎ、`rebuildPotentialCache()` は各出口に単一 seed を渡す。`chooseExitForAgent(agent, exitLoad = [])` は引数 `exitLoad` を選択に使わない。これらは静的に確認できるが、「何 % 流量が改善する」「全員が必ず近い出口へ集中する」などの量的結論は未検証である。

PR-C は全幅出口を一つの論理出口として保持し、幅・混雑・予定人数・危険度を含む待ち時間推定を別途検証する。PR #1 の角抜け防止を重複修正しない。全出口到達不能者は既に生成人数から除外せず未完了として保持する。

### 基準 SHA のコード行根拠

以下のリンクはすべて固定コミットを指す。後続のコード変更で行番号が変わっても監査対象を特定できる。

| 確認事項 | 固定ソース |
| --- | --- |
| 物理刻み・frame上限 | [core.js L324–328](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/core.js#L324-L328)、[共通時計と backlog 切捨て L2819–2859](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/core.js#L2819-L2859)、[火災更新 L2913–2947](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/core.js#L2913-L2947) |
| 出口代表点化 | [領域検出 L161–199](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/scitech3f-map3d.js#L161-L199)、[normalization L856–866](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/core.js#L856-L866)、[全出口収集 L978–991](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/core.js#L978-L991) |
| 単一seed・階段/平面コスト・負荷引数未使用 | [core.js L2191–2212](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/core.js#L2191-L2212)、[出口選択 L2306–2319](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/core.js#L2306-L2319) |
| 身体・力係数・乱数と積分 | [pedestrian-dynamics.js L20–49](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/pedestrian-dynamics.js#L20-L49)、[対人力 L317–359](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/pedestrian-dynamics.js#L317-L359)、[加速度/速度制限 L550–566](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/pedestrian-dynamics.js#L550-L566) |
| 全体seedなし・人口生成乱数 | [core.js L2420–2451](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/core.js#L2420-L2451)、[歩行への注入 L3762–3793](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/core.js#L3762-L3793) |
| 階段パラメータ・方向別FIFOの交換 | [stairs3d.js L45–67](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/stairs3d.js#L45-L67)、[満員時交換 L282–327](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/stairs3d.js#L282-L327) |
| 火災・煙の既定値 | [fire3d.js L9–56](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/fire3d.js#L9-L56)、[smoke3d.js L13–76](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/smoke3d.js#L13-L76) |
| FDS高さ・項目保持・時刻保持 | [fds-csv.js L26–44](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/fds-csv.js#L26-L44)、[疎な更新保持 L173–199](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/fds-csv.js#L173-L199)、[core時刻検索 L1386–1411](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/sim/js/simulation/core.js#L1386-L1411) |
| upload書込み前の検証不足 | [server/main.py L125–143](https://github.com/hefugu/evac-sim/blob/1ac28ed703fec7459ca2c4eee1c0affec77a8304/server/main.py#L125-L143) |

本書の「コード上確認」は静的な実装確認を指す。流量・時間・保存誤差等を実行して再現した数値結果を意味しない。

## 5. 連続歩行モデル・単位・係数

`pedestrian-dynamics.js` では座標がセル、力が N、速度が m/s、時間が s。各階の実寸で相互換算する。主要な式は以下のとおり。

```text
m dv/dt = m (v_desired e - v) / τ + Σf_person + Σf_wall + m a_random
f_social = A exp((r_i+r_j-d)/B) w(方向) n
f_contact_normal = k overlap - c min(0, v_relative·n)
f_contact_tangent = -κ overlap (v_relative·t) t
```

希望方向は危険度付き経路選択に従い、連続移動でも選択した経路の危険度予算と壁線分を検査する。計算した力を質量で割って加速度を求め、加速度・速度に上限を設けて積分する。床の通常歩行全体に「2人/セル」を容量制約として課す方式ではなく、その人数制約は階段着地等に残る。

| 実装値 | 単位・意味 | 出典の追跡と未校正範囲 |
| --- | --- | --- |
| 成人半径 `0.255 ± 0.035`、希望速度 `1.25 ± 0.30` | m、m/s の一様分布 | コードは VTT FDS+Evac の人口分布を参照すると説明する。教師・リーダー等の役割は身体分類から分離。実建物の人口分布は未校正。 |
| `mass = 80 (radius/0.27)²`、τ `0.8–1.2` | kg、s | FDS+Evac 系の参照身体と緩和時間を採用。円形身体の近似であり、同製品の全仕様ではない。 |
| 対人 `A=2000`、`B=0.08`、異方性 `λ=0.30` | N、m、無次元 | Social Force / FDS+Evac 系をコードが出典として掲げる。速度依存 A など実装独自の変形を含み、個別係数の原典ページ対応・対象人口への校正は未完了。 |
| 壁 `A=2000`、`B=0.04` | N、m | 同じ系統の壁反発。壁の法線・角での離散化と身体重なりを検証対象にする。 |
| 接触 `k=120000`、接線 `κ=40000`、減衰 `c=500` | 式上 k は N/m、κ は N·s/m²、c は kg/s | 変数名 `contactK_KgM2` は次元を正確に表す名称ではない。係数の適用範囲と校正を PR-D で照合し、名称だけを根拠に単位を推定しない。 |
| 近傍 1.2、壁近傍 0.8 | m | 局所相互作用の打切り。計算コストと力の近似の両方に関わる。 |
| 加速度上限 12、速度倍率上限 1.70、内部刻み最大 0.05 | m/s²、無次元、s | 数値安定化・モデル実装値。実測由来の普遍的定数として扱わない。 |
| ランダム加速度標準偏差 0.10、±3σ 打切り | m/s² | Box–Muller による揺らぎ。全体 seed なしでは系列を保存できない。 |
| `v(K)=max(0.1v0, v0(0.706−0.057K)/0.706)` | K [m⁻¹]、速度 [m/s] | コードは FDS+Evac / Frantzich & Nilsson 系の煙減速関係を参照。10% 下限は実装条件。FDS 視界のみのときは `K=3/S` に変換する。 |

理論的背景は [Helbing & Molnár, Social Force Model for Pedestrian Dynamics](https://arxiv.org/abs/cond-mat/9805244) と [VTT, FDS+Evac Technical Reference and User’s Guide, W119 (2009)](https://sarjaweb.vtt.fi/pdf/workingpapers/2009/W119.pdf)。前者の名前を引用するだけで、現在の全接触係数や高密度流量の妥当性が証明されるわけではない。一次資料と数値・ページを照合する係数台帳、高密度・対向流・初期重なりの検証は PR-D の成果物とする。なお `wallLambda` は定義されているが現行の壁力式では使われていない（静的確認）。

## 6. 階段・複数階・3F サンプル

`stairs3d.js` は `from/to`、`travelCostSec`、`congestionCapacity` を持つリンク方式。既定は幅 1.5 m、移動 8 s、同時移動容量 2 人だが、幅から校正済みの流量を導出してはいない。通常入場は全体 FIFO。満員の双方向交通で着地が自分の出発待ち列に塞がれた場合には到着・出発を一対一交換し、**方向ごとの FIFO** を保つため全体列の先頭を飛び越す場合がある。単に「常に全体 FIFO」と記述しない。

階段内の人は床占有から外れ、複数リンク共通の着地予約と `canArrive` で危険・通行可能性を検査する。既存の対向交通テストは限定条件の不変条件確認であり、あらゆる建物でのデッドロック不在証明ではない。勾配・踊り場・方向別速度・幅別流量・多階の合流実測は未検証。

3F サンプルは緑の**階段候補 5 領域**を抽出するが、下階図面・階段リンク・建物外出口を根拠なく生成しない。下階や出口が無い状態の未完了を歩行力学の不具合と混同しない。詳細は [`scitech_3f_sample_map.md`](scitech_3f_sample_map.md) と [`navigation-investigation.md`](navigation-investigation.md)。

## 7. 火災・煙・FDS・曝露

### 火災と煙の式・適用域

| 計算 | 実装・単位 | 根拠と境界 |
| --- | --- | --- |
| 火災成長 | `Q=min(Qmax, αt²)`、Q [kW]、t は着火後 [s]。α: Slow 0.00293 / Medium 0.01172 / Fast 0.0469 / Ultrafast 0.1876 [kW/s²] | [`fire3d.js`](../sim/js/simulation/fire3d.js)。成長率は既存資料が [CFAST User Guide](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1889v2.pdf) を参照するシナリオ入力。Qmax 既定 3000 kW は火源セルごとのデモ条件。燃料から燃焼成長を予測する式ではない。 |
| 簡易熱環境 | `T=20+(800−20)I^0.7` [°C]、`q″=12I` [kW/m²] | `deriveFireMetrics()` の fallback。指数・最大温度・最大熱流束は近似入力で、輻射・対流の詳細解ではない。 |
| 延焼 | 既定 `spreadRatePerSec=0` | 明示的に指定した率がある場合のみ確率的延焼。材料に基づく熱分解・燃料枯渇・減衰・消火を解かない。 |
| 火源・プルーム | `D=√(4A/π)`、`z0=−1.02D+0.083Q^0.4`、`Qc=(1−χr)Q`、`ṁ=0.071Qc^(1/3)(z−z0)^(5/3)+0.0018Qc` | D,z [m]、Qc [kW]、ṁ [kg/s]。[CFAST Technical Reference §3.3](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1889v1.pdf) の Heskestad 系。低い評価点の火炎内補間や正値下限を実装に加えている。壁・隅角・複数火源相互作用を解かない。 |
| 燃焼生成 | 燃料流量 `Q/ΔHc` [kg/s] × soot/CO 収率 [kg/kg] | 既定燃焼熱 44500 kJ/kg、soot 0.015、CO 0.008、放射割合 0.35、火源面積 1 m² は `n_heptane_demo` の例示。建物固有の校正値ではない。 |
| 輸送する保存量 | 上層体積 [m³]、soot/CO [kg]、超過顕熱 [kJ] | `smoke3d.js`。固定代表密度 1.2 kg/m³・比熱 1.005 kJ/(kg·K) の低次元近似。CFD の圧力・運動量・熱膨張を解く方式ではない。 |
| 消光・視界 | `K=κm sootMass/V` [m⁻¹]、`S=3/K` [m]、κm 既定 8700 m²/kg | すす収率・物性・標識条件に依存。視界表示の上限は 30 m。旧 `opticalDensityM1` 名は自然対数 K の互換名。常用対数 OD 入力は ln(10) 倍して区別する。 |
| 廊下重力流 | `g′=g(Tu−Ta)/Tu`、`u=Fr√(g′h)` | 温度比は K、h [m]、u [m/s]。Fr 0.7、流出率上限 0.3、先端厚さ 0.01 m は近似・診断・安定化条件。曲がり・分岐等は一般セル輸送へ戻る。[`corridor-model.md`](corridor-model.md)。 |
| 自然換気 | `v=Cd√(2gHΔT/Ta + wind²)`、`q=Av` | m/s、m³/s。上層に接する開口の排出近似と清浄補気。圧力・中性帯・双方向開口流を解かない。 |
| 漏気・機械排煙 | 漏気 1/s、機械排煙 m³/s を別勘定 | 旧 cell `ventilation` は漏気の別名。soot 沈着と熱損失も別勘定。閉鎖壁を通る輸送や二重排気を試験対象にする。 |

各保存量の generated / transferred / exhausted / deposited / lost の収支と負値・非有限値を検査する。セル容量を超える上層体積の再配分・処理も既存実装にあり、単に濃度だけを拡散しているわけではない。出典・安定化・既定値の詳細は [`physics-implementation.md`](physics-implementation.md)、[`fire_engineering_model_basis.md`](fire_engineering_model_basis.md)。保存則が成立しても、煙到達時間・温度・COの絶対的な実験精度は別途評価が必要。

### FDS CSV アダプタ

`fds-csv.js` は時刻、1 始まり階番号、セル座標、床上採取高さ [m]、K [m⁻¹]、視界 [m]、CO [ppm]、温度 [°C]、熱流束 [kW/m²] を扱う。これは外部結果の変換アダプタであり、FDS 自体をブラウザ内で実行しない。

- 欠損値と明示的 0 を区別し、疎な更新を項目別に sample-and-hold する。時間は直前 frame を使用し、未来値を先取りする時間線形補間はしない。
- 高さ未指定は 1.6 m とみなして警告する。目線一致許容差は 0.001 m。目線を挟む場合のみ各量を高さ線形補間し、外挿しない。
- 与えられた量だけを目線フィールドへ上書きする。上層一点の値から層全体の平均・保存量・HRRを作らない。
- CSV 解除時は保存された内部状態から fallback を再導出する。FDS / fallback / mixed の由来を項目別に保持する。

元の FDS メッシュ、採取位置、高さ、時刻基準、単位変換、入力デッキの妥当性は利用者側の外部解析条件であり、CSV が読めることだけでは検証されない。

### 曝露・tenability・終了

`exposure.js` は `E[n+1]=E[n]+x[n]Δt` の矩形積分。CO は ppm·min、熱流束は kW/m²·s、温度は °C·s、K は m⁻¹·s、低視界滞在は s。待機中も積算する。`tenability` は瞬時状態、`worstTenability` は累積最悪状態であり、回復しても積分値は消さない。`critical` は死亡・失神を意味しない。

既定スクリーニングの視界 10/5 m、CO 200/1200 ppm、熱流束 1/2.5 kW/m²、温度 60/120 °C 等は比較方針。[`exposure-model.md`](exposure-model.md) は職業曝露基準や熱 benchmark と独自注意値を区別している。完全な FED は未実装で `fed=null`、CSV は `full_fed_available=0`。O₂・HCN・CO₂・呼吸応答・湿度・服装・個人差を含む毒性や生死の予測ではない。

観測窓の既定は 600 s。未完了者は unresolved、時間上限なら censored とし、成功や死亡へ置換しない。平均・最大避難時間は完了者だけを対象に標本数も保持する。完了標本 0 の旧 summary の時間 0 は「即時避難」の意味ではなく、MC の対応値は null。未避難率・終了理由・観測窓と併記する。

## 8. 行動・乱数・MC・保存・出力

反応時間は覚知遅れ＋入力三角分布。標準は成人・一斉開始で遅れ 0。子供・生徒の教師追従は同じ階・壁の遮蔽・煙視界・認知距離を検査する簡略モデル。視線上の最小視界を使い、光学厚さの経路積分や人物認識実験の校正ではない。未知の出口探索、家族集合、車椅子・介助は未実装。詳細は [`agent-model-basis.md`](agent-model-basis.md)。

`Math.random` は core の配置・種類・速度・panic 等、身体サンプリング、歩行揺らぎ、反応時間、任意延焼に残る。多くの下位関数は乱数関数を注入できるが、core から全てへ統一 PRNG を渡していない。3D receiver の識別子にも `Math.random` があり、PR-B は物理乱数と表示・通信識別子の乱数を区別する。

MC の実行本体は core。前試行の煙・曝露・階段 queue・火災進展を reset し、手動火源と条件を復元する既存処理がある。Stop / Reset で次試行を止め、run 間の RAF 重複や負の蓄積時間を避ける試験もある。しかし baseSeed / runSeed / PRNG 状態・版の保存と特定試行の再現は未実装。既存 browser tests の `addInitScript` 等による固定乱数は**試験内だけの制御**である。

CSV は完了・未完了・打切り、曝露・最悪状態、階・階段混雑、個人時刻・属性・反応時間、火災条件などを出す。現在の標準出力には研究用の commit SHA / モデル版 / scenario ID / seed / 実行環境 / P95 / 一貫した出口流量系列等が揃っていない。ベンチマーク側で取得可能なものを補い、取得不能項目は null と理由を記録する。CSV の旧 `dead` 列は互換列で、火災死亡数と解釈しない。

## 9. 既存検証と計測の不足

`npm test` は `tests/3d-modules.test.mjs` を入口に、歩行・壁角・経路・階段・火災・煙保存・収束・FDS高さ・曝露・描画等を import する。`npm run test:browser` は実画像・UI・FDS解除・長経路・混在階・MC100・停止 reset・3D遅延等を検査する。`.github/workflows/test.yml` は Node 22 / Ubuntu の physics と Chromium browser を push / PR ごとに実行する。

これらには既知の不具合への回帰 coverage がある一方、100/400/1000 人の標準条件を揃えた性能・統計・実験比較の全体基盤は基準 main に無い。現在の HUD profiler は frame / render / agent / smoke / fire の平均的な区間値と FPS を公開し、適応描画品質も既にある。P95 step、経路再計算の独立内訳、最大メモリ、出口通過系列、個人の階段待ち、密度速度曲線、人体重なり率を網羅する研究計測器ではない。

### 要求指標と現在の取得経路

| 指標 | 現行 state / 出力 | PR-A での扱い |
| --- | --- | --- |
| 完了率・平均/最大完了時間・未避難・曝露 | `lastSummary` / agents / CSV | 完了標本・観測窓を区別して保存。 |
| P95 完了時間 | 個人の finishTime / startTime から導出可能 | 分位点の定義と標本数を記録。未完了者に打切り時刻を代入しない。 |
| 到達不能人数 | 初期・現在 potential と未完了状態 | 初期到達不能、後発閉塞、時間切れを区別する定義が必要。未避難全員を到達不能としない。 |
| 出口利用・流量 | 出口選択情報と実際の完了位置・時刻 | 予定出口と実通過を混同しない。現在の標準 summary は完全な流量系列を持たない。 |
| 階段人数・待ち時間 | traffic の completed / queued / inTransit、transition | 人数は既存値を取得。個人別累積待ちの完全計測が無い部分は null / 未取得。 |
| 速度・滞留 | agents の位置・速度、stuckCount 等 | stuckCount は累積滞留秒そのものではない。履歴の取得範囲を明記。 |
| step 時間・計算内訳・メモリ・FPS | profiler / browser・process 計測 | process RSS と JS heap と描画 FPS を別指標にする。取得不能は推定で埋めない。 |

### 問題の証拠レベル

| 項目 | 証拠レベル | 残る確認 |
| --- | --- | --- |
| 出口負荷引数未使用、画像出口代表点化 | **コード上確認** | 幅別・複数出口の流量、選択率、平均/最大時間を同一条件で比較する。 |
| 全体 seed 不在 | **コード上確認 + open Issue #2** | PR-B で全乱数列、reset、MC、表示変更の再現試験。 |
| upload ファイル名・size検証不足 | **コード上確認 + open Issue #3** | PR-I でローカル隔離した安全性試験。実際の公開API侵害は未試験。 |
| 危険近傍・煙・壁角・階段・3D準備の旧不具合 | **merged PR と既存回帰試験あり** | 今回の基準テスト実行結果とリンクして継続監視。新規再現と混同しない。 |
| 高密度の過剰重なり、異常加速、出口や階段の非現実的流量 | **検証課題 / 未確定** | B02/B05/B09/B11 と実測・公開 validation データ。症状を再現する前に係数を変更しない。 |
| Dijkstra・煙・割当・描画のどれが支配的か | **性能仮説** | 同一環境・物理時間・人口密度で profiling。未測定の改善率は記載しない。 |

今回の実測結果は benchmark の raw JSON / CSV / report と試験ログを正とする。未実行のシナリオや未取得の指標について、成功・改善・精度の数値を生成しない。物理不変条件の成功、ブラウザ統合の成功、公開サイトの確認、実験との validation はそれぞれ独立した状態として報告する。

## 10. 段階的ロードマップと受入条件

| PR | 変更範囲 | 着手条件と主な受入確認 |
| --- | --- | --- |
| **A（今回）** | 本調査、基準 SHA、標準 fixture と計測・比較・出力、軽量回帰/手動負荷実行の基盤 | main の Node / browser 基準結果を記録。B01–B12 を必要情報・不変条件・取得可否付きで定義。性能改善は主張しない。 |
| B | version付き PRNG、数値/文字列/0 seed、初期配置前初期化、reset、MC独立 runSeed、保存/CSV | 同一 seed の個人状態・曝露・完了時刻、MC100 と単一試行再実行を比較。同一物理時刻の描画不変性。 |
| C | 論理出口と全幅 seed、容量・待ち・危険・予定負荷を含む選択 | 既存安全迂回を維持。単一/複数/異幅/危険出口/全到達不能の前後比較。PR #1 と重複を整理。 |
| D | 歩行・身体・接触・壁の検証と再現不具合のみの修正 | 係数台帳、dt感度、壁/対人重なり、高密度と対向流。実測差は構造限界も評価。 |
| E | リンク妥当性・UI同期・待ち計測、必要な方向/幅/勾配拡張 | FIFO の正確な定義、容量、着地、対向流、複数階連続性。3F 未設定を推測補完しない。 |
| F | 火災・保存収支・換気・煙輸送・FDS・曝露検証 | 0/欠測/時刻/高さ/解除/reset、物質・熱・体積収支、実験比較と適用域。完全 FED を偽称しない。 |
| G | profiling で特定した処理の最適化 | 同一 seed・物理時間で結果と誤差を検査。時計・衝突・経路を不当に省略しない。FPSと物理step性能を分離。 |
| H | 未設定/未反映/到達不能・seed・負荷・実験条件の表示 | 現行操作・狭幅・2D/3Dを維持し、操作状態とエラーが明確。 |
| I | 段階的責務分離、upload安全性 | 公開API/互換ルートと静的 `/sim` を維持。safe filename、path containment、size、拡張子・実画像検証。 |
| J | 分位点・未完了・seed別分析、JSON/CSV/Markdown、外部比較レポート | 成功標本と打切りを分離。モデル版・環境・入力を保存。実行ライセンスがない製品は一次公開資料で比較し未比較指標を明示。 |

Pathfinder / MassMotion / buildingEXODUS / FDS・Smokeview / 歴史的 FDS+Evac の最新資料比較と数値 validation は後続作業。今回の式の由来確認は製品の精度・性能を比較したことを意味しない。全 PR で既存 2D/3D、FDS、火災・煙、MC と既存テストを維持し、変更理由・再現・原因・前後実測・未検証事項を記載する。**main への merge は利用者の承認後に行う。**

## 11. 後続比較のための公式資料入口

**確認日はいずれも 2026-10-16。** 今回は公開入口・表示版・取得制約を確認しただけで、製品を実行した数値比較や精度順位づけはしていない。URL の年を製品版や文書更新年と決めつけず、後続比較時は使用 PDF と版を固定する。

| 対象 | 公式入口・取得できた版情報 | 今回の到達範囲 |
| --- | --- | --- |
| Pathfinder | [2026.1 Documentation](https://www.thunderheadeng.com/docs/2026-1/pathfinder/)。ページ表示は **2026.1.0211 / February 11, 2026** | 2026.1 は従来別冊の資料を統合した文書構成と記載。旧 repo docs が参照する 2024.2 等とは版を区別する。詳細モデル照合・数値比較は未実施。 |
| MassMotion | [現行公式製品ページ](https://www.oasys-software.com/products/pedestrian-simulation-software/massmotion/)、[公式公開 User Guide](https://www.oasys-software.com/wp-content/uploads/2026/04/Oasys-MassMotion-User-Guide.pdf) | 取得先の存在を確認したが、約18.9 MB の PDF は閲覧ツールのサイズ制限で全文を取得できなかった。検索索引の本文には ©2024 とある。URL の 2026/04 から最新版番号を推定しない。今回の正確な現行製品版・PDF版番号は**未確認**。 |
| buildingEXODUS | [FSEG Capabilities](https://fseg.gre.ac.uk/exodus/exodus_products.html)、[公式FAQ](https://fseg.gre.ac.uk/exodus/exodus_faq.html) | 公開ページは **v6.3（May 2017）** と記載。FAQ は Theory / User / Application の冊子を案内するが v6.1 表記も残り、ダウンロード領域は登録が必要。最新契約配布版・マニュアル本文は**未確認**。ページ上の古い表記を最新性保証に使わない。 |
| FDS / Smokeview | [NIST 公式 manuals](https://pages.nist.gov/fds/manuals.html)。current release 表示は **FDS 6.11.1 / SMV 6.11.2** | User / Technical Reference / Verification / Validation 等の公式入口を確認。FDS計算、同一火災ケースの比較、ライセンス製品との共通シナリオ実行は未実施。 |
| FDS+Evac（歴史的参考） | [VTT W119 (2009)](https://sarjaweb.vtt.fi/pdf/workingpapers/2009/W119.pdf) | 既存 Social Force・煙減速の歴史的出典として参照。現行製品との同等性やサポート状態を旧マニュアルだけで判断しない。 |
