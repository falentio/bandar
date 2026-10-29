type ProgressStream = {
  write(chunk: string): void;
  readonly isTTY?: boolean;
  readonly columns?: number;
};

/** Cumulative bytes read for one asset, and its length when the response declared one. */
export type ByteProgress = (received: number, total: number | null) => void;

export type UpdateEvent =
  | { readonly kind: "checking" }
  | {
      readonly kind: "downloading";
      readonly asset: string;
      readonly received: number;
      readonly total: number | null;
    }
  | { readonly kind: "verifying"; readonly bytes: number }
  | { readonly kind: "installing"; readonly target: string };

export type ReportUpdate = (event: UpdateEvent) => void;

export type Progress = {
  /** Records a phase event. A new phase draws at once; a repeated one waits for the next frame. */
  readonly report: ReportUpdate;
  /** Wraps a line writer so a message never lands on the animation row. */
  readonly sink: (write: (line: string) => void) => (line: string) => void;
  /** Stops the timer and clears the row. Idempotent, and safe after a throw. */
  readonly finish: () => void;
};

export function createProgress(stream: ProgressStream): Progress {
  if (stream.isTTY !== true) return QUIET;

  let widest = 0;
  let latest: UpdateEvent | null = null;
  let phase: string | null = null;
  let tick = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const draw = (): void => {
    if (latest === null) return;

    const frame = frameOf(latest, tick);
    const columns = stream.columns ?? 0;
    const row = columns > 0 ? frame.slice(0, columns) : frame;

    stream.write(`\r${row}${" ".repeat(Math.max(0, widest - row.length))}`);

    widest = Math.max(widest, row.length);
  };

  const erase = (): void => {
    if (widest === 0) return;

    stream.write(`\r${" ".repeat(widest)}\r`);

    widest = 0;
  };

  const startFrames = (): void => {
    const handle = setInterval(() => {
      tick += 1;
      draw();
    }, FRAME_MS);

    handle.unref?.();

    timer = handle;
  };

  const report: ReportUpdate = (event) => {
    const key = phaseKeyOf(event);

    latest = event;

    if (key !== phase) {
      phase = key;
      tick = 0;
      draw();
    }

    if (timer === null) startFrames();
  };

  return {
    report,
    sink: (write) => (line) => {
      erase();
      write(line);
    },
    finish: () => {
      if (timer !== null) clearInterval(timer);

      timer = null;
      erase();
    },
  };
}

export function frameOf(event: UpdateEvent, tick: number): string {
  const spin = SPIN[tick % SPIN.length] ?? SPIN[0];

  switch (event.kind) {
    case "checking":
      return `${spin} checking the latest release`;
    case "downloading":
      return `${spin} downloading ${event.asset} ${amountOf(event.received, event.total)}`;
    case "verifying":
      return `${spin} verifying sha256 ${formatBytes(event.bytes)}`;
    case "installing":
      return `${spin} installing ${event.target}`;
  }
}

export function formatBytes(count: number): string {
  const measure = measureOf(count);

  return `${measure.value} ${measure.unit}`;
}

const QUIET: Progress = {
  report: () => undefined,
  sink: (write) => write,
  finish: () => undefined,
};

// ASCII frames: one cell per glyph in every code page, and no display-width guessing below.
const SPIN = ["|", "/", "-", "\\"] as const;
const FRAME_MS = 80;
const UNITS = ["B", "KB", "MB", "GB"] as const;

type Measure = {
  readonly value: string;
  readonly unit: string;
};

function measureOf(count: number): Measure {
  let scaled = count;
  let step = 0;

  while (scaled >= 1024 && step < UNITS.length - 1) {
    scaled /= 1024;
    step += 1;
  }

  return {
    value: step === 0 ? String(Math.round(scaled)) : scaled.toFixed(1),
    unit: UNITS[step] ?? "B",
  };
}

function amountOf(received: number, total: number | null): string {
  if (total === null) return formatBytes(received);

  const left = measureOf(received);
  const right = measureOf(total);
  const percentage = Math.min(100, Math.floor((received / total) * 100));
  const head = left.unit === right.unit ? left.value : `${left.value} ${left.unit}`;

  return `${head}/${right.value} ${right.unit} ${String(percentage)}%`;
}

function phaseKeyOf(event: UpdateEvent): string {
  return event.kind === "downloading" ? `downloading ${event.asset}` : event.kind;
}
