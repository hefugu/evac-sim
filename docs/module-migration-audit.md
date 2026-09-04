# モジュール移行の確認

2026-09の火災・煙拡張は既存計算と2D/3Dを維持した追加である。全面書き換えを行わず、物理・統合テストが通る範囲で次の責務を切り出した。

| モジュール | 責務と今回の扱い |
| --- | --- |
| `sim/js/simulation/core.js` | 共通時計、UIと共有state、避難経路・移動、階段、Monte Carloの統合を継続 |
| `simulation/exposure.js` | 新規: 単位付き曝露積分、tenability分類、観測窓と集計。coreと3D互換ヘルパが同じ関数を使用 |
| `simulation/fds-csv.js` | coreから抽出: 旧CSV互換、時刻・高さ・物理量別保持、高さ補間 |
| `simulation/smoke3d.js` | 既存保存量モデルを拡張。部屋・廊下・階段を同じ保存量と収支で計算 |
| `simulation/corridor-smoke.js` | 新規: 廊下検出と保存輸送リクエスト。独立した煙生成や時計は持たない |
| `simulation/fire3d.js` | 既存t²火源・延焼を継続。FDS観測高さの検査を追加 |
| `sim/js/export/csv.js` | 純粋なCSV構築を分離し、曝露・最悪tenability・打切り結果を追加 |
| `simulation/smoke.js`, `fire.js`, `movement.js`, `montecarlo.js`, `optimizer.js` | 空の予約関数だけで、現行HTML/JSにimportなし。誤って実行主体と思われないよう注記し、削除・再配線はしない |

現行入口は `sim/index.html → sim/js/main.js → simulation/core.js`。埋込3Dは `view3d.js`、専用ページは `3d.html → 3d-page.js` で描画のみを行う。専用ページのstateはBroadcastChannelで主画面から複製され、シミュレーション状態を独自に進めない。

旧 `sim/simulation.js` は現行HTMLとJavaScriptの入口から読み込まれていない。ただし `server/main.py` には `/sim/simulation.js` を返す互換ルートが明示的に残っている。既存ブックマークや旧利用者を完全には排除できないため、ファイルとルートを保持する。削除は互換ルート利用状況と旧画面の保守方針を確認した後の候補とする。

今後の移動・最適化・Monte Carlo分割は、公開関数とブラウザ試験を維持して段階的に行う。今回、空モジュールへ大量の状態依存コードを移してしまう分割は避けた。

Vercelの `vercel.json`、静的パス、API不要の配信方式を維持。追加したnpm依存はテスト専用で、ブラウザへの新しいCDN依存もビルド工程もない。GitHub Actionsの通常テストは既存のpatch適用workflowから独立している。
