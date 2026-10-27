import { useCallback, useEffect, useState } from "react";
import type { Analytics } from "../shared/analytics";
import { analyticsApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type AnalyticsState = {
  readonly status: Status;
  readonly days: number;
  readonly data: Analytics | null;
  readonly error: string | null;
  readonly setDays: (days: number) => void;
  readonly refresh: () => void;
};

export function useAnalytics(): AnalyticsState {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;

    const load = async () => {
      setStatus("loading");
      setError(null);

      try {
        const analytics = await analyticsApi.overview(days);

        if (!live) return;

        setData(analytics);
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
  }, [days, reload]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return { status, days, data, error, setDays, refresh };
}
