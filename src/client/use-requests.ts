import { useCallback, useEffect, useState } from "react";
import type { RequestEvent } from "../shared/analytics";
import { analyticsApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type RequestsState = {
  readonly status: Status;
  readonly requests: readonly RequestEvent[];
  readonly error: string | null;
  readonly refresh: () => void;
};

export function useRequests(limit = 50): RequestsState {
  const [requests, setRequests] = useState<readonly RequestEvent[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;

    const load = async () => {
      setStatus("loading");
      setError(null);

      try {
        const list = await analyticsApi.requests(limit);

        if (!live) return;

        setRequests(list.requests);
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
  }, [limit, reload]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return { status, requests, error, refresh };
}
