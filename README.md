# n8n-nodes-sqlite-wasm

`sql.js` を使って SQLite を read-only で扱う、self-hosted n8n 向け community node です。native addon に依存しないため、`better-sqlite3` や `sqlite3` を増やしたくない環境でも扱えます。

## Included Node

- `SQLite WASM`
  - `Query Database`
  - `List Tables`
  - `Describe Table`

## Features

- `sql.js` ベースの SQLite 読み込み
- binary input と file path input の両対応
- read-only SQL 制限
- 単一 statement 制限
- `items` / `singleItem` の返却モード

## Usage Notes

- `Query Database` は `SELECT` / `WITH ... SELECT` / `PRAGMA table_info(...)` のみ許可します
- `ATTACH`, `DROP`, `ALTER`, `VACUUM`, `load_extension` などは拒否します
- file path mode は allowed prefixes 内のファイルのみ読み込みます
- verified node 前提ではありません。external dependency として `sql.js` を使用します

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
