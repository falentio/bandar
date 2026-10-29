// npm stores a staged package and its tarball under a flattened name: @scope/name becomes
// scope-name, which is the file name npm pack gives it too.
export function flatName(name: string): string {
  return name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
}

export type Platform = {
  readonly name: string;
  readonly asset: string;
  readonly file: string;
  readonly libc?: string;
};

export type Manifest = {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly repository: { readonly type: string; readonly url: string };
  readonly homepage: string;
  readonly bugs: { readonly url: string };
  readonly publishConfig: { readonly access: string };
  readonly files: readonly string[];
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
  readonly bin?: { readonly bandar: string };
  readonly engines?: { readonly node: string };
  readonly optionalDependencies?: Readonly<Record<string, string>>;
};

export type RegistryReport =
  | { readonly kind: "present" }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

export type VersionReport =
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "skipped" }
  | { readonly kind: "unreadable" };
