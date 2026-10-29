import { describe, expect, test } from "vite-plus/test";
import { httpOrigin, originToDial } from "./topology";

describe("origins", () => {
  test("an IPv6 address is bracketed", () => {
    expect(httpOrigin("fd7a::1", 4133)).toBe("http://[fd7a::1]:4133");
  });

  test("a wildcard bind is dialled on loopback", () => {
    for (const host of ["0.0.0.0", "::"])
      expect(originToDial(host, 4133)).toBe("http://127.0.0.1:4133");
  });

  test("a named host is dialled as itself", () => {
    expect(originToDial("10.0.0.5", 4133)).toBe("http://10.0.0.5:4133");
    expect(originToDial("fd7a::1", 4133)).toBe("http://[fd7a::1]:4133");
  });
});
