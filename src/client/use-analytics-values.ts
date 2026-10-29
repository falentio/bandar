import { useCallback, useEffect, useState } from "react";
import { analyticsApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type AnalyticsValueKind = "projectUrl" | "sessionId";

export type AnalyticsValues = {
  readonly status: Status;
  readonly values: readonly string[];
  readonly error: string | null;
  readonly refresh: () => void;
};

const LOAD: Record<AnalyticsValueKind, () => Promise<readonly string[]>> = {
  projectUrl: async () => (await analyticsApi.projects()).projects,
  sessionId: async () => (await analyticsApi.sessions()).sessions,
};

export function useAnalyticsValues(kind: AnalyticsValueKind): AnalyticsValues {
  const [values, setValues] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;

    const load = async () => {
      setStatus("loading");
      setError(null);

      try {
        const list = await LOAD[kind]();

        if (!live) return;

        setValues(list);
        setStatus("ready");
      } catch (error) {
        if (!live) return;

        setError(isError(error) ? describeError(error) : String(error));
        setStatus("error");
      }
    };

    void load();

    return () => {
      live = false;
    };
  }, [kind, reload]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return { status, values, error, refresh };
}
