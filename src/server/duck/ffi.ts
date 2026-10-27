import { CString, dlopen, FFIType, type Pointer } from "bun:ffi";

const SYMBOLS = {
  duckdb_open: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  duckdb_connect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  duckdb_close: { args: [FFIType.ptr], returns: FFIType.void },
  duckdb_disconnect: { args: [FFIType.ptr], returns: FFIType.void },
  duckdb_prepare: { args: [FFIType.ptr, FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  duckdb_prepare_error: { args: [FFIType.ptr], returns: FFIType.ptr },
  duckdb_bind_varchar: { args: [FFIType.ptr, FFIType.u64, FFIType.cstring], returns: FFIType.i32 },
  duckdb_bind_int64: { args: [FFIType.ptr, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
  duckdb_bind_double: { args: [FFIType.ptr, FFIType.u64, FFIType.f64], returns: FFIType.i32 },
  duckdb_bind_boolean: { args: [FFIType.ptr, FFIType.u64, FFIType.bool], returns: FFIType.i32 },
  duckdb_bind_null: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  duckdb_execute_prepared: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  duckdb_destroy_prepare: { args: [FFIType.ptr], returns: FFIType.void },
  duckdb_result_error: { args: [FFIType.ptr], returns: FFIType.ptr },
  duckdb_row_count: { args: [FFIType.ptr], returns: FFIType.u64 },
  duckdb_column_count: { args: [FFIType.ptr], returns: FFIType.u64 },
  duckdb_column_name: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  duckdb_value_varchar: { args: [FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.ptr },
  duckdb_value_is_null: { args: [FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.bool },
  duckdb_destroy_result: { args: [FFIType.ptr], returns: FFIType.void },
  duckdb_free: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

function openLibrary(path: string) {
  return dlopen(path, SYMBOLS);
}

export type DuckLibrary = ReturnType<typeof openLibrary>;

const cache = new Map<string, DuckLibrary>();

export function duckLibrary(path: string): DuckLibrary {
  const existing = cache.get(path);

  if (existing !== undefined) return existing;

  const library = openLibrary(path);
  cache.set(path, library);

  return library;
}

export function readString(pointer: bigint | Pointer | null): string | null {
  return pointer === null ? null : new CString(Number(pointer)).toString();
}

export function freeString(library: DuckLibrary, pointer: bigint | Pointer | null): string | null {
  const value = readString(pointer);

  if (pointer !== null) library.symbols.duckdb_free(pointer);

  return value;
}
