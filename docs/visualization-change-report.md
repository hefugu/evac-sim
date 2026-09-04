# 可視化改修の変更一覧・検証記録

2026-09-04。対象は既存の2D/3D共有stateに基づく描画。前回の保存量モデル、人体曝露、FDS高さ対応、階段、Monte Carloを土台にした追加である。

## 主な追加

1. 共通Beer–Lambert透明度とPhysical/Analysis分離。2D目線と3D上層を区別し、表示のためにstateを水増ししない。
2. 煙5物理量、火災5指標、由来overlay、2D定量マップ、単位・固定色範囲・現在値の凡例。
3. HRRで大きさが変わる火炎グリフ、着火元・延焼の区別、既存solverの着火履歴、現在の延焼前線。
4. 両画面のクリック分析パネル。項目別FDS/fallback、目線/上層、欠測/ゼロを区別。
5. 専用3Dへの生のフィールド・火災履歴・FDS由来の転送と解除。共有stateの階段煙矢印を2Dにも追加。

## 変更ファイル（30ファイル）

| ファイル | 変更理由・内容 |
| --- | --- |
| `sim/js/visualization/hazard-display.js`（新規） | 透明度、代表光路長、色・単位、火災グリフ、由来、地点情報の純粋関数 |
| `sim/js/visualization/analysis-overlay.js`（新規） | 現在のcell値による定量マップ。表示専用の危険度再計算をcoreから分離 |
| `sim/js/visualization/inspection-panel.js`（新規） | 共通地点分析DOMと表示設定のイベント処理 |
| `sim/js/renderer.js` | 2D煙のBeer–Lambert、火炎勾配、由来、選択、階段煙、画面座標の凡例 |
| `sim/js/renderer3d.js` | 実際のセル寸法の上層スラブ、視線長、物理量色、火災グリフ、床面ピッキング |
| `sim/js/simulation/core.js` | 2D選択、共有sceneの表示設定、着火情報の初期化、表示用計算を分離 |
| `sim/js/simulation/fire3d.js` | 既存火災進展に着火時刻・寄与元・FDS項目のメタデータを追加 |
| `sim/js/simulation/smoke3d.js` | 部分FDS煙入力の実項目を由来メタデータとして記録 |
| `sim/js/state.js` | UI専用の表示設定・選択セル |
| `sim/js/state-bridge3d.js` | 目線・上層のフィールド名、欠測、火災履歴、由来を保った転送 |
| `sim/js/ui.js` | 既存編集モードに地点分析ボタンを追加 |
| `sim/js/view3d.js` | 埋込3Dの共通コントロールとクリック選択を接続 |
| `sim/js/3d-page.js` | 専用3Dも同じコントロールと分析パネルを使用 |
| `sim/index.html` | 煙・火災・由来セレクタ、2D定量マップ、地点分析UI |
| `sim/3d.html` | 専用3Dの表示設定と地点分析UI |
| `sim/styles/hazard-analysis.css`（新規） | 小さい画面でも選べる表示コントロール、スクロール可能な分析表 |
| `sim/styles/main.css` | 追加CSSを既存エントリーポイントへ接続 |
| `tests/hazard-display.test.mjs`（新規） | opacity、光路長、火災単調性、由来、欠測、前線の単体テスト |
| `tests/renderer-2d.test.mjs`（新規） | 2D描画・単位・階段矢印・不変性・転送と解除 |
| `tests/renderer-modes.test.mjs` | 新モード、欠測色、3D不変性と床面クリック座標を追加 |
| `tests/3d-modules.test.mjs` | 新規テストの取込み、実際の延焼メタデータ検査 |
| `tests/browser/runtime.spec.mjs` | 全セレクタ、2D/3Dクリック、数値不変性、専用ページへのFDS由来転送 |
| `docs/hazard-display-math.md`（新規） | 数式・単位・固定表示範囲・仮定・操作・限界 |
| `docs/2d-display-model.md`（新規） | 2Dの描画順、目線表示、選択と状態共有 |
| `docs/3d-display-model.md` | 旧ブロック最大値表示の説明を現行スラブ表示へ更新 |
| `docs/fire_engineering_model_basis.md` | 可視化と曝露・tenabilityを分離したモデル根拠を追記 |
| `docs/module-migration-audit.md` | 新しい可視化モジュールの責務を追記 |
| `docs/visualization-change-report.md`（新規） | この変更一覧と検証・残課題 |
| `README.md` | 利用方法、根拠・変更一覧へのリンク |
| `.github/workflows/test.yml` | 依存不要の物理テストは直接実行し、ブラウザ依存のインストールから監査通信を除いてCIのネットワーク依存を低減 |

## 検証結果

- `node --test tests/3d-modules.test.mjs`: 77件成功。既存68件を維持し、新規9件を追加。保存則、階段fan-out、換気・沈着、時間刻み、対称性、廊下壁・扉、FDS旧新形式・解除、火災・煙を含む。
- `npm run test:browser`: 9件成功。既存7件に、全表示切替・両画面のクリックによる数値不変性、FDS由来と専用ページ同期の2件を追加。既存のMC100試行・Stop/Reset・階段避難も通過。
- ブラウザの3Fサンプルと、実際に火災を30秒進めた部屋を表示確認。Physical/Analysis、同時表示、上層と目線の相違、地点分析を確認。既存HUDと追加凡例の重なりを修正。
- 通常push/PRの既存 `.github/workflows/test.yml` が上記両テストを実行する。Vercelの静的配信構成・エントリーポイント・外部依存を変更していない。今回のGitHub ActionsおよびVercelの実行結果は対象コミットのChecks/Deploymentsで確認できる。
- CIで `npm ci` が長時間継続したため、Node組込みだけの物理・表示単体テストではnpmインストールを省き、ブラウザジョブは `npm ci --no-audit --no-fund` とした。依存バージョン・lockfile・実行するテストは同じで、両ジョブに10分の上限を設ける。

## 残る近似・今後の課題

- 代表光路長と奥行き順の半透明合成は体積レイトレーシングではない。交差する層や壁面付近の厳密な遮蔽・散乱は今後の描画課題。
- HRRグリフの高さ・色範囲は表示スケール。予測火炎長ではない。燃焼の減衰段階は物理モデルにないため追加していない。
- 全セルを実位置で描くため、大規模な煙場の負荷が課題。将来の集約は壁・空セルへの表示拡張を避け、由来と保存量の確認手段を保つ必要がある。
- 複数階の床が重なる地点のクリックは最前面の床面を選ぶ。下階を調べる場合はカメラを変更するか2Dで階を選択する。
- 高忠実度結果・実験データとの比較や、対象建物の入力妥当性確認は別途必要。この可視化は解析支援・研究発表支援用であり、法的評価や厳密な安全認証はFDSなどの高忠実度結果および数値指標を優先する。
