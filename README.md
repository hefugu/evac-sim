# evac-sim

`hefugu/evac-sim` の `sim` 画面を、ローカルサーバー不要で使えるように Vercel 向けに整理した構成です。

## 現在の結論（`/sim` は静的サイトで運用可能）

- 公開対象の `sim/index.html` は `sim/js/main.js` を読み込むブラウザ完結型の実装です。
- `sim/js` 配下に `fetch` / `/api` / `localhost` 依存はありません。
- 画像アップロードは `FileReader` を使用してブラウザ内で完結します（`sim/js/mapLoader.js`）。
- CSV 出力は `Blob` + `URL.createObjectURL` でブラウザ内完結です（`sim/js/export/csv.js`）。
- 2Dと3Dは同じ `state.agents` / floor / fire / smokeを参照し、3D側は計算を進めない表示専用です。
- `/sim/3d.html` は外部CDNなしで動く閲覧専用3Dページです。主画面があればライブ同期し、単独時は3Fサンプルを表示します。
- 本番 API URL は不要です（`/sim` 公開のみの場合）。

そのため、**シミュレーション画面（`/sim`）は FastAPI なしで Vercel 単体デプロイ可能**です。

## Vercel デプロイ手順（GitHub push で自動更新）

1. GitHub で `hefugu/evac-sim` を Vercel に接続します。
2. Vercel ダッシュボードで `Add New -> Project` を選び、対象リポジトリを Import します。
3. 設定は以下を使用します。  
   `Root Directory`: `.`  
   `Framework Preset`: `Other`  
   `Build Command`: 空欄（不要）  
   `Output Directory`: 空欄（不要）
4. Deploy を実行します。
5. 以後は `main` ブランチへ push するたびに Vercel が自動再デプロイします。

## Vercel 用設定

- ルートの `vercel.json` で次を設定済みです。  
  `"/"` を `"/sim/index.html"` にリダイレクト  
  `"/sim"` を `"/sim/index.html"` にリダイレクト

## 公開後の動作確認チェックリスト

1. Vercel の Project 設定で `hefugu/evac-sim` の `main` ブランチ連携を確認する。
2. 公開 URL の `/` を開き、`/sim/index.html` に遷移することを確認する。
3. `sim` 画面でローカル画像をアップロードし、マップ表示されることを確認する。
4. `開始位置` と `出口` を置き、`シミュ開始` が正常に動作することを確認する。
5. `CSV出力` で `evac_report_*.csv` がダウンロードできることを確認する。
6. `保存` / `読込`（プリセット）が再読み込み後も使えることを確認する（`localStorage`）。
7. ブラウザ DevTools の Console / Network にエラーがないことを確認する。
8. `3Fサンプル読込` 後、`3D` / `同時表示` と `/sim/3d.html` が表示できることを確認する。
9. GitHub に小さな変更を push して、Vercel の自動再デプロイを確認する。

## ローカル回帰テスト

追加のnpm依存なしで、2.5D座標、階段FIFO、火災、煙上昇、行動状態、3F抽出、閲覧同期を検査できます。

```powershell
node --test tests/3d-modules.test.mjs
```

## Git 管理対象外（追加済み）

ルート `.gitignore` で次を除外済みです。

- `.env`, `.env.*`
- `venv/`, `.venv/`, `server/venv/`
- `__pycache__/`, `*.pyc` など Python キャッシュ
- `node_modules/`
- `.cache/` などのキャッシュ類

## バックエンドについて

- シミュレーション画面（`/sim`）の公開には FastAPI は不要です。
- ただし `admin/index.html` は `/api/*` を呼び出すため、こちらを公開運用する場合は FastAPI 配備が必要です。

将来 `admin` も公開する場合は、次の分離構成を推奨します。

- フロント: Vercel
- API: Render または Railway
- API URL: 環境変数で切り替え（`localhost` 直書き禁止）
- Render Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
