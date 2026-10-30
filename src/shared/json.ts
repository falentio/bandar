/** The JSON domain a wire can carry, independent of any dialect. */

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
