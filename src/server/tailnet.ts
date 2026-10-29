import * as v from "valibot";

const STATUS_TIMEOUT_MS = 2000;

const StatusSchema = v.looseObject({
  BackendState: v.optional(v.string()),
  Self: v.optional(
    v.looseObject({
      DNSName: v.optional(v.string()),
      TailscaleIPs: v.optional(v.array(v.string())),
    }),
  ),
});

export type TailnetIdentity = {
  readonly address: string;
  readonly dnsName: string;
};

export type TailnetResolution =
  | { readonly kind: "found"; readonly identity: TailnetIdentity }
  | { readonly kind: "missing"; readonly reason: string };

export type TailnetLookup = () => TailnetResolution;

type StatusRun = () => {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

const runStatus: StatusRun = () => {
  try {
    const status = Bun.spawnSync(["tailscale", "status", "--json"], {
      timeout: STATUS_TIMEOUT_MS,
    });

    return {
      ok: status.success,
      stdout: status.stdout.toString(),
      stderr: status.stderr.toString(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : "tailscale could not be started",
    };
  }
};

const missing = (reason: string): TailnetResolution => ({ kind: "missing", reason });

/** Asks the Tailscale CLI for this machine's tailnet identity. */
export function discoverTailnet(run: StatusRun = runStatus): TailnetResolution {
  const status = run();

  if (!status.ok) {
    const reason = status.stderr.trim().split("\n")[0] ?? "";

    return missing(reason === "" ? "tailscale status failed" : reason);
  }

  return parseTailnetStatus(status.stdout);
}

export function parseTailnetStatus(stdout: string): TailnetResolution {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), StatusSchema), stdout);

  if (!parsed.success) return missing("tailscale status printed an unexpected document");

  const state = parsed.output.BackendState ?? "unknown";

  if (state !== "Running") return missing(`tailscale backend is ${state}`);

  const self = parsed.output.Self;
  const dnsName = (self?.DNSName ?? "").replace(/\.$/u, "");
  const addresses = self?.TailscaleIPs ?? [];
  const address = addresses.find((candidate) => !candidate.includes(":")) ?? addresses[0];

  if (dnsName === "" || address === undefined)
    return missing("tailscale reports no MagicDNS name or address");

  return { kind: "found", identity: { address, dnsName } };
}
