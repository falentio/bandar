import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createProgress, formatBytes, frameOf } from "./update-progress";

type FakeStream = {
  readonly written: string[];
  readonly stream: {
    write(chunk: string): void;
    readonly isTTY?: boolean;
    columns?: number;
  };
};

const streamOf = (
  options: { readonly isTTY?: boolean; readonly columns?: number } = {},
): FakeStream => {
  const written: string[] = [];

  return {
    written,
    stream: {
      write: (chunk: string) => void written.push(chunk),
      ...options,
    },
  };
};

describe("formatBytes", () => {
  test("bytes stay whole numbers and larger units carry one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(251658240)).toBe("240.0 MB");
  });
});

describe("frameOf", () => {
  test("each phase draws one row carrying the spinner frame", () => {
    expect(frameOf({ kind: "checking" }, 0)).toBe("| checking the latest release");
    expect(
      frameOf(
        {
          kind: "downloading",
          asset: "bandar-0.3.1-linux-x64",
          received: 64172851,
          total: 251658240,
        },
        1,
      ),
    ).toBe("/ downloading bandar-0.3.1-linux-x64 61.2/240.0 MB 25%");
    expect(frameOf({ kind: "verifying", bytes: 251658240 }, 2)).toBe("- verifying sha256 240.0 MB");
    expect(frameOf({ kind: "installing", target: "/usr/local/bin/bandar" }, 3)).toBe(
      "\\ installing /usr/local/bin/bandar",
    );
  });

  test("an undeclared length counts bytes without a percentage", () => {
    expect(
      frameOf(
        { kind: "downloading", asset: "bandar-0.3.1-linux-x64", received: 64172851, total: null },
        0,
      ),
    ).toBe("| downloading bandar-0.3.1-linux-x64 61.2 MB");
  });

  test("the spinner cycles through its four frames", () => {
    expect(frameOf({ kind: "checking" }, 4)).toBe("| checking the latest release");
  });
});

describe("createProgress on a terminal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("the first event draws at once and every frame advances the spinner", () => {
    const { written, stream } = streamOf({ isTTY: true });
    const progress = createProgress(stream);

    progress.report({ kind: "checking" });

    expect(written).toEqual(["\r| checking the latest release"]);

    vi.advanceTimersByTime(80);

    expect(written).toEqual(["\r| checking the latest release", "\r/ checking the latest release"]);

    progress.finish();
  });

  test("a repeated phase waits for the next frame instead of redrawing", () => {
    const { written, stream } = streamOf({ isTTY: true });
    const progress = createProgress(stream);

    progress.report({ kind: "downloading", asset: "bandar", received: 1024, total: 2048 });
    progress.report({ kind: "downloading", asset: "bandar", received: 2048, total: 2048 });

    expect(written).toEqual(["\r| downloading bandar 1.0/2.0 KB 50%"]);

    vi.advanceTimersByTime(80);

    expect(written).toEqual([
      "\r| downloading bandar 1.0/2.0 KB 50%",
      "\r/ downloading bandar 2.0/2.0 KB 100%",
    ]);

    progress.finish();
  });

  test("a shorter row pads over the widest row drawn so far", () => {
    const { written, stream } = streamOf({ isTTY: true });
    const progress = createProgress(stream);

    progress.report({
      kind: "downloading",
      asset: "bandar-0.2.0-linux-x64",
      received: 1024,
      total: 2048,
    });
    progress.report({ kind: "installing", target: "/usr/local/bin/bandar" });

    const wide = "| downloading bandar-0.2.0-linux-x64 1.0/2.0 KB 50%";
    const narrow = "| installing /usr/local/bin/bandar";

    expect(written).toEqual([`\r${wide}`, `\r${narrow}${" ".repeat(wide.length - narrow.length)}`]);

    progress.finish();
  });

  test("a message erases the row before it lands", () => {
    const { written, stream } = streamOf({ isTTY: true });
    const progress = createProgress(stream);
    const lines: string[] = [];
    const write = progress.sink((line) => void lines.push(line));

    progress.report({ kind: "installing", target: "/usr/local/bin/bandar" });
    write("bandar 0.3.1 installed at /usr/local/bin/bandar");

    const row = "| installing /usr/local/bin/bandar";

    expect(written).toEqual([`\r${row}`, `\r${" ".repeat(row.length)}\r`]);
    expect(lines).toEqual(["bandar 0.3.1 installed at /usr/local/bin/bandar"]);

    progress.finish();
  });

  test("finish stops the frames, clears the row once, and is safe twice", () => {
    const { written, stream } = streamOf({ isTTY: true });
    const progress = createProgress(stream);

    progress.report({ kind: "checking" });
    progress.finish();

    const settled = written.length;

    progress.finish();
    vi.advanceTimersByTime(1000);

    expect(vi.getTimerCount()).toBe(0);
    expect(written).toHaveLength(settled);
  });

  test("a narrow terminal clips every row to its columns", () => {
    const { written, stream } = streamOf({ isTTY: true, columns: 10 });
    const progress = createProgress(stream);

    progress.report({ kind: "checking" });

    expect(written).toEqual(["\r| checking"]);

    progress.finish();
  });

  test("a terminal that widens mid-row draws the row at its new width", () => {
    const { written, stream } = streamOf({ isTTY: true, columns: 20 });
    const progress = createProgress(stream);

    progress.report({ kind: "checking" });

    stream.columns = 80;
    vi.advanceTimersByTime(80);

    expect(written).toEqual(["\r| checking the lates", "\r/ checking the latest release"]);

    progress.finish();
  });

  test("a pty that reports no columns draws the whole row", () => {
    const { written, stream } = streamOf({ isTTY: true, columns: 0 });
    const progress = createProgress(stream);

    progress.report({ kind: "checking" });

    expect(written).toEqual(["\r| checking the latest release"]);

    progress.finish();
  });
});

describe("createProgress without a terminal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("no event writes anything and no timer starts", () => {
    const { written, stream } = streamOf();
    const progress = createProgress(stream);

    progress.report({ kind: "checking" });
    progress.report({ kind: "downloading", asset: "bandar", received: 1024, total: 2048 });
    progress.report({ kind: "verifying", bytes: 1024 });
    progress.report({ kind: "installing", target: "/usr/local/bin/bandar" });

    vi.advanceTimersByTime(1000);
    progress.finish();

    expect(written).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("sink hands the line straight to the writer", () => {
    const { written, stream } = streamOf();
    const progress = createProgress(stream);
    const write = (line: string) => void written.push(line);

    expect(progress.sink(write)).toBe(write);

    progress.sink(write)("bandar 0.3.1 installed at /usr/local/bin/bandar");

    expect(written).toEqual(["bandar 0.3.1 installed at /usr/local/bin/bandar"]);
  });
});
