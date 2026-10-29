import { useCallback, useEffect, useState } from "react";
import { analyticsApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type Projects = {
  readonly status: Status;
  readonly projects: readonly string[];
  readonly error: string | null;
  readonly refresh: () => void;
};

export function useProjects(): Projects {
  const [projects, setProjects] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;

    const load = async () => {
      setStatus("loading");
      setError(null);

      try {
        const list = await analyticsApi.projects();

        if (!live) return;

        setProjects(list.projects);
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
  }, [reload]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return { status, projects, error, refresh };
}
