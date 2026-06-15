# n8n-nodes-sqlite-wasm

Self-hosted n8n community node for working with SQLite in read-only mode via `sql.js`. It does not rely on native addons, so it is suitable for environments where you do not want to add `better-sqlite3` or `sqlite3`.

## Included Node

- `SQLite WASM`
- `Query Database`
- `List Tables`
- `Describe Table`

## Features

- SQLite loading powered by `sql.js`
- Supports both binary input and file path input
- Read-only SQL restrictions
- Single-statement enforcement
- `items` / `singleItem` return modes
- Unexpected failures raise node errors for n8n retries and error handling

## Usage Notes

- `Query Database` only allows `SELECT`, `WITH ... SELECT`, and `PRAGMA table_info(...)`
- Statements such as `ATTACH`, `DROP`, `ALTER`, `VACUUM`, and `load_extension` are rejected
- File path mode only reads files under the configured allowed prefixes
- This package is intended for self-hosted n8n and uses `sql.js` as an external dependency
- If you want downstream execution after an item-level failure, use n8n's built-in `Continue On Fail`

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
