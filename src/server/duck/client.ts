import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { duckLibrary, freeString, readString, type DuckLibrary } from "./ffi";

export type SqlValue =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "int"; readonly value: number | bigint }
  | { readonly kind: "real"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "null" };

export const sqlText = (value: string): SqlValue => ({ kind: "text", value });

export const sqlInt = (value: number | bigint): SqlValue => ({ kind: "int", value });

export const sqlReal = (value: number): SqlValue => ({ kind: "real", value });

export const sqlBool = (value: boolean): SqlValue => ({ kind: "bool", value });

export const SQL_NULL: SqlValue = { kind: "null" };

export type QueryRow = Readonly<Record<string, string | null>>;

export class DuckDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuckDbError";
  }
}

const RESULT_WORDS = 512;

export class DuckDb {
  readonly path: string;
  private readonly database = new BigUint64Array(1);
  private readonly connection = new BigUint64Array(1);
  private readonly result = new BigUint64Array(RESULT_WORDS);
  private readonly library: DuckLibrary;
  private closed = false;

  constructor(path: string, libraryPath: string) {
    this.path = path;
    this.library = duckLibrary(libraryPath);

    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

    const opened = this.library.symbols.duckdb_open(path, this.database);

    if (opened !== 0) throw new DuckDbError(`could not open ${path} (status ${opened})`);

    const connected = this.library.symbols.duckdb_connect(handleOf(this.database), this.connection);

    if (connected !== 0) {
      this.library.symbols.duckdb_close(this.database);
      throw new DuckDbError(`could not connect to ${path} (status ${connected})`);
    }
  }

  query(sql: string, params: readonly SqlValue[] = []): readonly QueryRow[] {
    this.assertOpen();

    const statement = new BigUint64Array(1);
    const prepared = this.library.symbols.duckdb_prepare(handleOf(this.connection), sql, statement);

    if (prepared !== 0) {
      const message =
        readString(this.library.symbols.duckdb_prepare_error(handleOf(statement))) ??
        "unknown error";

      this.library.symbols.duckdb_destroy_prepare(statement);
      throw new DuckDbError(`could not prepare statement: ${message}`);
    }

    try {
      params.forEach((param, index) => bind(this.library, handleOf(statement), index + 1, param));

      const executed = this.library.symbols.duckdb_execute_prepared(
        handleOf(statement),
        this.result,
      );

      if (executed !== 0) {
        throw new DuckDbError(
          `query failed: ${readString(this.library.symbols.duckdb_result_error(this.result)) ?? "unknown error"}`,
        );
      }

      return this.readResult();
    } finally {
      this.library.symbols.duckdb_destroy_result(this.result);
      this.library.symbols.duckdb_destroy_prepare(statement);
    }
  }

  run(sql: string, params: readonly SqlValue[] = []): void {
    this.query(sql, params);
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;
    this.library.symbols.duckdb_disconnect(this.connection);
    this.library.symbols.duckdb_close(this.database);
  }

  private readResult(): readonly QueryRow[] {
    const columns = Number(this.library.symbols.duckdb_column_count(this.result));
    const rows = Number(this.library.symbols.duckdb_row_count(this.result));

    const names = Array.from({ length: columns }, (_, column) =>
      readString(this.library.symbols.duckdb_column_name(this.result, column)),
    ).filter((name): name is string => name !== null);

    return Array.from({ length: rows }, (_, row) => {
      const values: Record<string, string | null> = {};

      for (const [column, name] of names.entries()) {
        const isNull = this.library.symbols.duckdb_value_is_null(this.result, column, row);
        values[name] = isNull
          ? null
          : freeString(
              this.library,
              this.library.symbols.duckdb_value_varchar(this.result, column, row),
            );
      }

      return values;
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new DuckDbError("this DuckDB handle is closed");
  }
}

function bind(library: DuckLibrary, statement: bigint, index: number, param: SqlValue): void {
  switch (param.kind) {
    case "text":
      check(library.symbols.duckdb_bind_varchar(statement, index, param.value), index);

      return;
    case "int":
      check(library.symbols.duckdb_bind_int64(statement, index, BigInt(param.value)), index);

      return;
    case "real":
      check(library.symbols.duckdb_bind_double(statement, index, param.value), index);

      return;
    case "bool":
      check(library.symbols.duckdb_bind_boolean(statement, index, param.value), index);

      return;
    case "null":
      check(library.symbols.duckdb_bind_null(statement, index), index);

      return;
    default: {
      const _exhaustive: never = param;

      return _exhaustive;
    }
  }
}

function handleOf(handle: BigUint64Array): bigint {
  const value = handle[0];

  if (value === undefined) throw new DuckDbError("DuckDB returned a null handle");

  return value;
}

function check(status: number, index: number): void {
  if (status !== 0) throw new DuckDbError(`could not bind parameter ${index} (status ${status})`);
}
