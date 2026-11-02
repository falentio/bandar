import { useCallback, useEffect, useState } from "react";
import type { DownstreamRequest } from "../shared/analytics";
import { analyticsApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type Requests = {
  readonly status: Status;
  readonly requests: readonly DownstreamRequest[];
  readonly error: string | null;
  readonly refresh: () => void;
};

export function useRequests(limit = 50, providerId?: string): Requests {
  const [requests, setRequests] = useState<readonly DownstreamRequest[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;

    const load = async () => {
      setStatus("loading");
      setError(null);

      try {
        const list = await analyticsApi.requests(limit, providerId);

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
  }, [limit, providerId, reload]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return { status, requests, error, refresh };
}

export type RequestDetail = {
  readonly status: Status;
  readonly request: DownstreamRequest | null;
  readonly error: string | null;
  readonly refresh: () => void;
};

export function useRequest(id: string): RequestDetail {
  const [request, setRequest] = useState<DownstreamRequest | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;

    const load = async () => {
      setStatus("loading");
      setError(null);

      try {
        const found = await analyticsApi.request(id);

        if (!live) return;

        setRequest(found);
        setStatus("ready");
      } catch (error) {
        if (!live) return;

        setRequest(null);
        setError(isError(error) ? describeError(error) : String(error));
        setStatus("error");
      }
    };

    void load();

    return () => {
      live = false;
    };
  }, [id, reload]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return { status, request, error, refresh };
}
