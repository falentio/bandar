import { useCallback, useEffect, useState } from "react";
import type { CooldownEvent } from "../shared/cooldowns";
import { cooldownApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type Cooldowns = {
  readonly status: Status;
  readonly events: readonly CooldownEvent[];
  readonly error: string | null;
  readonly refresh: () => void;
};

export function useCooldowns(limit = 100): Cooldowns {
  const [events, setEvents] = useState<readonly CooldownEvent[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;

    const load = async () => {
      setStatus("loading");
      setError(null);

      try {
        const list = await cooldownApi.list(limit);

        if (!live) return;

        setEvents(list.events);
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

  return { status, events, error, refresh };
}
