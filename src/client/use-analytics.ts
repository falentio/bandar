import { useCallback, useEffect, useState } from "react";
import {
  EMPTY_ANALYTICS_FILTERS,
  type Analytics,
  type AnalyticsFilters,
} from "../shared/analytics";
import { analyticsApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type AnalyticsState = {
  readonly status: Status;
  readonly days: number;
  readonly filters: AnalyticsFilters;
  readonly data: Analytics | null;
  readonly error: string | null;
  readonly setDays: (days: number) => void;
  readonly setFilters: (filters: AnalyticsFilters) => void;
  readonly refresh: () => void;
};

export function useAnalytics(): AnalyticsState {
  const [days, setDays] = useState(30);
  const [filters, setFilters] = useState<AnalyticsFilters>(EMPTY_ANALYTICS_FILTERS);
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
        const analytics = await analyticsApi.overview(days, filters);

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
  }, [days, filters, reload]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return { status, days, filters, data, error, setDays, setFilters, refresh };
}
