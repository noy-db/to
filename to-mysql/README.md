# @noy-db/to-mysql

[![npm](https://img.shields.io/npm/v/%40noy-db/to-mysql.svg)](https://www.npmjs.com/package/@noy-db/to-mysql)

> MySQL / MariaDB adapter for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-mysql
```

## What it is

MySQL / MariaDB adapter for noy-db — encrypted-envelope KV with JSON column. Works with any duck-typed mysql2-style pool/connection. casAtomic: true via UPDATE … WHERE v = ?.

## Ids compare byte-exact — upgrading an existing table

New tables are created with `COLLATE utf8mb4_bin` on `vault`, `collection` and `id`, so two ids
are the same only if their bytes are (noy-db/family#174). Under the server default,
`utf8mb4_0900_ai_ci`, `Abc` = `abc`, `café` = `cafe` and `a\x00b` = `ab`.

**A table created before this change keeps its old collation.** Nothing migrates it
automatically. To switch it (with the default table name):

```sql
ALTER TABLE noydb_envelopes
  MODIFY vault      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  MODIFY collection VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  MODIFY id         VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
```

The ALTER cannot fail on duplicates, because the binary collation tells apart everything the old
one did. It can't repair what the old collation already did either:

- **Earlier collisions were overwrites, and the table cannot show them.** When two ids differing
  only in case, accent or an ignorable character such as NUL were both written, the second write
  updated the first one's row. One row is left, keyed by the **first** spelling and holding the
  **last** writer's envelope. There is no second row to find, and the envelope is ciphertext, so
  no SQL query can list the affected records. Measured on MySQL 8.4.
- **After the ALTER, such a row keeps the first spelling's key.** Reading the first id returns the
  other record's envelope, and reading the second id returns nothing until it is written again.
- **The vault's owner can detect it; the database cannot.** A record's encryption binds its
  collection and id, so an overwritten record fails with `TamperedError` when its owner reads it
  at its own id. Holding the keys, list each collection, get each id, and note what fails. An
  operator with only database access cannot run this check. Two limits:
  - It covers only records with a sealed body. Overwritten tombstones and delete markers, and
    every record in an `encrypt: false` vault, stay undetectable.
  - `TamperedError` means "not authentic at this address", not specifically "id collision".

  See noy-db/family#177.

## Status

**Pre-release.** API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-mysql`](https://github.com/noy-db/to/tree/main/to-mysql)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[Apache-2.0](./LICENSE) © vLannaAi
