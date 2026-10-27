import { useCallback, useEffect, useState } from "react";
import type { ProviderDetail } from "../shared/providers";
import { providerApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type ProviderDetailState = {
  readonly status: Status;
  readonly detail: ProviderDetail | null;
  readonly days: number;
  readonly error: string | null;
  readonly setDays: (days: number) => void;
  readonly refresh: () => void;
};

export function useProviderDetail(id: string): ProviderDetailState {
  const [detail, setDetail] = useState<ProviderDetail | null>(null);
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;

    const load = async () => {
      setStatus("loading");
      setError(null);

      try {
        const next = await providerApi.detail(id, days);

        if (!live) return;

        setDetail(next);
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
  }, [id, days, reload]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return { status, detail, days, error, setDays, refresh };
}
