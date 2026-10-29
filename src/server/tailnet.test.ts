import { describe, expect, test } from "vite-plus/test";
import { discoverTailnet, parseTailnetStatus } from "./tailnet";

type SelfStatus = { readonly DNSName?: string; readonly TailscaleIPs?: readonly string[] };

const status = (self?: SelfStatus, backendState = "Running"): string =>
  JSON.stringify({ BackendState: backendState, Self: self });

describe("the tailnet", () => {
  test("a running backend reports the IPv4 address and the MagicDNS name", () => {
    expect(
      parseTailnetStatus(
        status({ DNSName: "host.tailnet.ts.net.", TailscaleIPs: ["100.90.57.79", "fd7a::1"] }),
      ),
    ).toEqual({
      kind: "found",
      identity: { address: "100.90.57.79", dnsName: "host.tailnet.ts.net" },
    });
  });

  test("an IPv6-only tailnet reports the IPv6 address", () => {
    expect(
      parseTailnetStatus(status({ DNSName: "host.ts.net.", TailscaleIPs: ["fd7a::1"] })),
    ).toEqual({ kind: "found", identity: { address: "fd7a::1", dnsName: "host.ts.net" } });
  });

  test("a backend that is not running is missing, and names the state", () => {
    expect(
      parseTailnetStatus(
        status({ DNSName: "host.ts.net.", TailscaleIPs: ["100.0.0.1"] }, "NeedsLogin"),
      ),
    ).toEqual({ kind: "missing", reason: "tailscale backend is NeedsLogin" });
  });

  test("a document without a name or an address is missing", () => {
    expect(parseTailnetStatus(status({ DNSName: "host.ts.net.", TailscaleIPs: [] }))).toEqual({
      kind: "missing",
      reason: "tailscale reports no MagicDNS name or address",
    });
    expect(parseTailnetStatus(status({ TailscaleIPs: ["100.0.0.1"] }))).toEqual({
      kind: "missing",
      reason: "tailscale reports no MagicDNS name or address",
    });
  });

  test("stdout that is not a status document is missing", () => {
    expect(parseTailnetStatus("not json")).toEqual({
      kind: "missing",
      reason: "tailscale status printed an unexpected document",
    });
  });

  test("a failed status command reports the CLI's reason", () => {
    expect(
      discoverTailnet(() => ({ ok: false, stdout: "", stderr: "tailscale is not running\n" })),
    ).toEqual({
      kind: "missing",
      reason: "tailscale is not running",
    });
  });

  test("a silent failure names itself", () => {
    expect(discoverTailnet(() => ({ ok: false, stdout: "", stderr: "" }))).toEqual({
      kind: "missing",
      reason: "tailscale status failed",
    });
  });
});
