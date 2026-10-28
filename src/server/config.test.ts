import { describe, expect, test } from "vite-plus/test";
import { ConfigError, parseConfig } from "./config";

describe("config", () => {
  test("a provider origin that is not a URL fails at boot", () => {
    for (const name of [
      "BANDAR_KILOCODE_API",
      "BANDAR_KILOCODE_MODELS_URL",
      "BANDAR_TOKENHARBOR_API",
      "BANDAR_YETA_API",
      "BANDAR_RIVER_API",
      "BANDAR_RIVER_PRICING_URL",
      "BANDAR_NOUS_API",
      "BANDAR_NOUS_PORTAL",
      "BANDAR_HYPER_API",
      "BANDAR_OPENCODE_API",
    ]) {
      const attempt = () => parseConfig({ [name]: "hyper.local" });

      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow(name);
    }
  });

  test("a provider origin pointing at a fake passes", () => {
    const config = parseConfig({
      BANDAR_HYPER_API: "http://127.0.0.1:9/hyper",
      BANDAR_NOUS_PORTAL: "https://portal.example.test",
    });

    expect(config.port).toBeGreaterThan(0);
  });
});
