# 3D・複数階避難シミュレーション アーキテクチャ

## 目的と基本方針

この機能は、既存の2D避難シミュレーションを計算主体として維持しながら、同じ避難者・階層・火災・煙の状態を2Dと3Dの両方で観察できるようにするものです。3D表示のために別のエージェント群や別の時計を作ることはありません。

計算モデルは完全な3次元流体・群集シミュレーションではなく、各階を2Dグリッドとして持ち、階段リンクだけで階をまたぐ「2.5D」です。表示時にグリッド座標を3D座標へ変換します。この構成により、既存の経路探索・2D描画・CSV出力を残したまま複数階へ拡張できます。

実装は静的HTMLとES Modulesだけで動作します。npm、ビルド工程、外部CDNは必須ではありません。3D描画も `canvas` 上の透視投影で行うため、WebGLやThree.jsを読み込めない環境でも既存2D画面には影響しません。

## 全体構成

```text
                       状態更新はここだけ
                 +--------------------------+
                 | simulation/core.js       |
                 | 移動・経路・時間・危険度 |
                 +------------+-------------+
                              |
                              v
                 +--------------------------+
                 | state.js                 |
                 | agents / floorStates     |
                 | fire / smoke / stairs    |
                 | evaluation               |
                 +----+----------------+----+
                      |                |
            同一参照  |                | 同一参照
                      v                v
              +-------------+  +----------------+
              | 2D renderer |  | 3D renderer    |
              | renderer.js |  | renderer3d.js  |
              +-------------+  +----------------+
                                          |
                               表示用snapshotを送信
                                          v
                               +------------------+
                               | BroadcastChannel |
                               +--------+---------+
                                        |
                                        v
                               +------------------+
                               | sim/3d.html      |
                               | 閲覧専用3D表示   |
                               +------------------+
```

同一ページの2D表示、3D表示、同時表示は同じ `state` オブジェクトを直接読みます。別タブの `sim/3d.html` はJavaScriptメモリを共有できないため、主画面が送る表示用スナップショットだけを受信します。別タブ側でシミュレーションを再計算することはありません。

## モジュールの責務

| ファイル | 主な責務 |
| --- | --- |
| `sim/js/state.js` | 2D/3D共通の公開状態、空間設定、FDS状態、評価値 |
| `sim/js/simulation/core.js` | 既存シミュレーションの唯一の時計と更新ループ。新モジュールへの薄い接続も担当 |
| `sim/js/simulation/floors3d.js` | floor/cellの正規化、2.5D階層、グリッド・ワールド座標変換 |
| `sim/js/simulation/stairs3d.js` | 階段セル、型付き階段リンク、待ち行列、移動時間、混雑値 |
| `sim/js/simulation/fire3d.js` | 軽量火災fallback、階層対応の火災値、FDS値の優先適用 |
| `sim/js/simulation/smoke3d.js` | 上部煙層・すす・CO・熱量の保存移送、換気、階段上昇、FDS煙値の優先適用 |
| `sim/js/simulation/agents3d-sync.js` | 共有エージェントの3D投影、行動状態、曝露量、共通評価指標 |
| `sim/js/renderer3d.js` | 状態を変更しない3D描画、カメラ、表示レイヤー |
| `sim/js/scitech3f-map3d.js` | 科学技術高校3F画像の抽出と実寸校正 |
| `sim/js/view3d.js` | 主画面の2D/3D/同時表示切替と3DレイヤーUI |
| `sim/js/state-bridge3d.js` | 専用ページ向けのgeometry/dynamic snapshot送受信 |
| `sim/js/3d-page.js`, `sim/3d.html` | BroadcastChannelまたは3Fサンプルを表示する閲覧専用ページ |

各シミュレーション用モジュールはDOMや描画ライブラリに依存しないnamed exportを中心にしています。単体で入力と出力を検査でき、将来 `core.js` 以外の実行基盤からも利用できます。

## 共通状態と更新権限

`state.js` の主な区分は次のとおりです。

- `state.agents`: 2Dと3Dが共有する唯一のエージェント配列
- `state.map.floorStates`: 各階のグリッド、出口、開始位置、煙など
- `state.map.stairLinks`: 階を接続する正規化可能な階段リンク
- `state.sim`: 時刻、稼働状態、ポテンシャル、階段交通、火災・煙の集計
- `state.spatial`: `cellSizeMeters`、`floorHeightMeters`、`wallHeightMeters`
- `state.hazards.fds`: 読み込んだFDS CSVと時系列フレーム
- `state.evaluation`: 階別滞留、階段混雑、スタックなどの表示・出力用集計
- `state.render`: 表示モード、描画revision、幾何revision

`core.js` が内部状態を更新した後に公開状態へ同期します。`renderer.js` と `renderer3d.js` は読み取り専用です。3D rendererは `requestAnimationFrame` を描画更新にだけ使い、シミュレーション時間を進めません。

互換性のため `state.simRunning`、`state.simTime`、`state.floors` などの旧フラットフィールドも残し、`syncLegacyState()` で構造化フィールドと揃えます。新しい処理では `state.map`、`state.sim`、`state.spatial` を優先します。

### エージェントの共有

3D用にエージェントを複製して運動させません。`projectSimulationState3D()` と `projectAgents3D()` は `state.agents` から描画レコードを作り、元オブジェクトを `sourceAgent` として保持します。`normalizeAgent3D()` を既存エージェントへ同期する場合も、追加するのは `floorIndex`、`worldX/Y/Z`、曝露量、行動状態などの共通フィールドです。

主な行動状態は次のとおりです。

- `normal`
- `follow_teacher`
- `avoid_hazard`
- `seek_clear_air`
- `stair_transition`
- `stuck_escape`
- `panic_escape`

teacher / student / panic は表示上の分類だけではありません。危険回避、追従、判断ノイズ、出口への固執、スタック脱出の判断に利用できます。既存の adult / child / elderly / leader も互換分類として維持されます。

## 2.5D階層モデル

標準floorは概ね次の形です。

```js
{
  floorIndex,
  name,
  zMeters,             // elevationMetersの互換名
  elevationMeters,
  floorHeightMeters,
  wallHeightMeters,
  gridWidth,
  gridHeight,
  cellSizeMeters,
  grid,
  exits,
  spawns,
  stairs,
  smokeMap,
  smokeCeil
}
```

cellは少なくとも `walkable`、`wall`、`door`、`stair`、`stairType`、`fire` を持ち、必要に応じて `atrium`、`flammable`、換気除去率 `ventilation [1/s]`、火災・煙の物理量を持ちます。旧コードとの接続用に `smoke`、`heat`、`co`、`visibility` のaliasも保持できます。

グリッドからワールド座標への基準変換は次です。

```text
worldX = cx * cellSizeMeters
worldY = elevationMeters
       = floorIndex * floorHeightMeters  // 個別標高がない場合
worldZ = cy * cellSizeMeters
```

人は通常 `worldY` の床面上におり、描画時だけ身長分を上へ伸ばします。階ごとに `cellSizeMeters` や標高を持てるため、将来は階高の異なる階も追加できます。

## 階段リンク、待ち行列、上下階移動

標準階段リンクは次の形です。

```js
{
  id,
  type,                 // indoor | outdoor | emergency
  from: { floorIndex, cx, cy },
  to:   { floorIndex, cx, cy },
  widthMeters,
  travelCostSec,
  verticalSmokeTransfer,
  congestionCapacity
}
```

既存形式の `{a:{floor,cx,cy}, b:{floor,cx,cy}}` も正規化できます。両端は通行可能な階段セルである必要があります。セルを階段として指定するだけでは上下階へ移動せず、対応する2つの階段セルをリンクして初めて階をまたげます。

交通状態はリンクごとにFIFOの `queue` と `inTransit` を持ちます。処理順は次のとおりです。

1. エージェントがリンク端へ到達したら `enqueueStairTransition()` で待ち行列へ入る。
2. `inTransit.length < congestionCapacity` の間、先頭から通行を開始する。
3. エージェントを `behaviorState = "stair_transition"` とし、平面上の通常移動から外す。
4. `travelCostSec` に従って `remainingSec` と `progress` を更新する。
5. 完了時に `floorIndex`、`x/y`、`cx/cy` をリンク先へ更新する。
6. 空いた容量へ次の待機者を入れる。

3D表示中は `progress` を使って両端のワールド座標を補間します。これは表示上の連続移動であり、別の移動計算ではありません。

`getStairCongestion()` は `queued`、`inTransit`、`capacity`、`utilization`、`completed`、`maxQueue` を返します。階段種別は煙にも影響し、屋外階段は屋内階段より換気が大きく、上階への煙移送が小さくなる設定です。

## 火災モデルとFDS優先規則

FDSデータがない場合も動作するよう、軽量fallbackを常に用意します。

- t-squared成長則による発熱速度（HRR）
- セルの距離、壁、扉、階段、吹き抜け、可燃性、経過時間による簡易延焼
- `fireIntensity`、`fireAgeSec`、`hrrKw`、`temperatureC`、`heatFluxKwM2` の更新

`stepFire3D()` は正規化した新しいfloor配列と `ignited`、`activeFireCount`、`totalHrrKw` を返します。既存グリッドの参照を維持する必要がある経路では、`stepLegacyFireMetricsInPlace()` または `applyFire3DResultToLegacyFloors()` を薄いadapterとして使用します。

FDS連携は `fdsLookup(floorIndex, cx, cy, timeSec)` を境界にします。該当時刻・セルのFDS recordに `temperature` や `heat_flux` があれば、そのフィールドだけfallback値を置き換えます。recordにない物理量はfallbackで補います。CSV時系列は未来値を参照せず、セル別・物理量別の最終既知値を明示更新まで保持します。したがって優先順位は次です。

```text
そのセル・時刻に存在するFDS値 > 軽量fallback値 > 安全側の初期値
```

## 煙モデルと階段上昇

fallback煙モデルは各階の通行可能セル、火災セル、扉、階段、吹き抜けを対象にする、FDS/CFAST-informed reduced-order modelです。CFDではなく、避難シナリオの相対比較用です。詳細な火災安全評価には、外部で解析したFDS CSVをより高忠実度の入力として使用します。

- HRR、燃焼熱、すす収率、CO収率から求める発煙
- 天井ジェット相関と有効乱流拡散係数による同一階の水平移送
- 明示した漏気、屋外階段、開放換気口による排出
- 階段リンクを通じた下階から上階への移送
- 保存量 `hotGasVolumeM3`、`sootMassKg`、`coMassKg`、`excessHeatKJ` から `opticalDensityM1`、`coPpm`、`visibilityMeters` を導出

`core.js` は描画フレームとは独立した固定時間刻みで `stepLegacySmokePhysicsInPlace()` を呼びます。物理状態は型付き配列に保持し、同一セル・階段リンク間の移送と換気について、移送元を超えないよう質量・体積・熱量の収支を取ります。画面上の上方向を浮力方向に見立てることはなく、上階への移送は階段リンクだけを通ります。ブラウザ停止後も煙だけを遅らせず、エージェント、火災、FDS時刻を同じ小刻みで進め、上限を超えた実時間は一時停止扱いにします。

UIで指定する主な量は、発煙源倍率 `[-]`、有効乱流拡散係数 `D [m²/s]`、天井ジェット倍率 `[-]`、隅角部混合係数 `[-]`、一様漏気率 `[1/s]`、すす・CO収率 `[kg/kg]`、燃焼熱 `[kJ/kg]` です。既定の収率と燃焼熱はn-ヘプタンのデモシナリオであり、実際の燃料には対応する入力が必要です。黄色出口は避難先の記号であるため、明示的に選択しない限り換気開口として扱いません。

`smokeMap` とcellの `smokeDensity` は既存2D/3D表示との互換用に物理状態から導出します。計算上の正本は保存量と、そこから導出した減光係数・CO・視認距離です。

FDS recordに自然対数基準の減光係数 `K [1/m]`、CO、visibility、smoke density があれば、存在するフィールドをfallbackより優先します。欠けた値はfallbackと相互変換で補完します。温度だけのrecordも経路危険度と曝露へ反映し、軽量モデルの既定では60 ℃超からペナルティ、120 ℃以上を強い回避対象とします。これらは設計用の人体耐容限界ではなく、避難挙動用のスクリーニング値です。これはFDS結果をブラウザ内で再計算するものではなく、外部計算結果を同じfloor/cell/time座標へ重ねる仕組みです。

ResetとMonte Carloの試行切替では、手動火元を初期強度・火災年齢0へ戻し、前試行で延焼したセルを消去します。煙・曝露だけでなく火災進展も試行間で初期化します。

火災・煙fallbackはいずれも避難挙動を検証するための近似であり、CFD、詳細な温度成層、圧力差、扉開閉流、燃焼反応を厳密に解くものではありません。

## 2D/3D表示

主画面では次の表示を切り替えられます。

- 2Dのみ
- 3Dのみ
- 2D/3D同時表示

3D rendererは床、壁、階段、出口、開始位置、火災、煙、エージェントをレイヤーとして描きます。火災・煙・人・壁は個別に表示を切り替えられます。カメラ操作はorbit、pan、zoom、resetに限定され、編集操作は既存2D UIで行います。

静的な床・壁形状はfloor参照と `geometryRevision` を利用してキャッシュでき、火災、煙、エージェントは各frameで共有状態から読み直します。煙は描画負荷を抑えるため表示サンプル数に上限があります。

## 別ページのBroadcastChannel同期

`sim/3d.html` は主画面を置き換えるページではなく、別モニターや別タブで3D表示だけを開くための閲覧専用ページです。

- 主画面だけがシミュレーション時間と状態を更新する。
- 主画面は描画に必要なclone可能データをsnapshotとして送信する。
- 3Dページは最新snapshotをローカル表示用stateへ置き換えて再描画する。
- 3Dページから開始、停止、編集、階段追加などの命令は送り返さない。
- snapshotのagentsは転送用cloneであり、2つ目のシミュレーション用agentsではない。

BroadcastChannelが利用できない、主画面が閉じている、またはまだmapが読み込まれていない場合は、3Dページは内蔵の3Fサンプルを閲覧用に表示します。このfallbackはシミュレーションを進めません。BroadcastChannelは永続保存や確実配送の仕組みではないため、評価の正本は常に主画面の `state` とCSV出力です。

## 評価指標

2D/3Dに依存しない共通指標として、次を保持・集計します。

| 指標 | 内容 |
| --- | --- |
| `evacuated` / `dead` | 避難完了者数、死亡者数 |
| `averageEvacuationTime` | 完了者の平均避難時間 |
| `maximumEvacuationTime` | 最大避難時間 |
| `floorOccupancy` | 現在の階別残留人数 |
| `stairCongestion` | リンク別待機、通行中、利用率、最大待ち行列 |
| `smokeExposure` | エージェントの煙曝露累計 |
| `coExposurePpmMin` | CO曝露のppm-min累計 |
| `heatExposure` | 熱・熱流束曝露の累計 |
| `stuckCount` | スタック状態または閾値超過者数 |
| `teacherFollowRate` | student/childのteacher追従率 |
| `panicEscapeCount` | panic_escapeの発生回数 |

これらはrendererが数えるのではなく、共有agentsと階段交通状態から集計します。そのため表示モードや別ページの有無で結果は変わりません。

## 拡張点

- map profileを追加し、別の平面図に色分類・縮尺・階情報を定義する。
- `floorStates` へ1F、2F、4F以降を追加し、対応する階段端をリンクする。
- `fdsLookup` の実装を差し替え、より大きなFDS/CFD時系列を遅延読込する。
- fire/smokeの係数を校正済みモデルへ差し替える。
- agent profileと行動状態遷移を追加する。
- rendererのレイヤーを追加する。計算状態を変えない限り既存2Dへの影響はない。
- 評価値をCSV列、時系列グラフ、Monte Carlo集計へ追加する。

## 制約と運用上の注意

- 既存2Dの `core.js` が計算の正本であり、3Dだけを独立実行する設計ではありません。
- 同一シミュレーション内の階は、現状では同じグリッド寸法を使うのが最も安全です。
- 平面図の黒領域から部屋形状や扉意味を自動推論しません。必要な扉・階段リンクは明示的に設定します。
- 3Dは2.5D可視化であり、階段形状上の詳細歩行、人体衝突、煙の完全な体積流れは扱いません。
- 別ページsnapshotは表示用です。オブジェクトidentity、DOM要素、画像オブジェクトなどclone不能な値は共有しません。
- 極端に大きなグリッド、多数階、全煙セル表示はブラウザ負荷を増やします。描画サンプリングと更新間隔で調整してください。
- FDS CSVの単位、原点、floor/cell対応、時刻基準は入力側で検証する必要があります。
