import { ApiError } from "./api";

export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

export function describeError(error: Error): string {
  return error instanceof ApiError ? (error.issues[0] ?? error.message) : error.message;
}
