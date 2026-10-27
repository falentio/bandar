import { useCallback, useEffect, useState } from "react";
import type { Tag, TagList } from "../shared/tags";
import { tagApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type Tags = {
  readonly status: Status;
  readonly tags: readonly Tag[];
  readonly error: string | null;
  readonly pending: boolean;
  readonly create: (slug: string) => Promise<boolean>;
  readonly remove: (id: string) => Promise<boolean>;
  readonly setModels: (id: string, modelIds: readonly string[]) => Promise<boolean>;
  readonly refresh: () => void;
};

export function useTags(): Tags {
  const [tags, setTags] = useState<readonly Tag[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;

    const load = async () => {
      setStatus("loading");
      setError(null);

      try {
        const list = await tagApi.list();

        if (!live) return;

        setTags(list.tags);
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

  const apply = (list: TagList) => {
    setTags(list.tags);
    setStatus("ready");
  };

  const mutate = useCallback(async (run: () => Promise<TagList>): Promise<boolean> => {
    setPending(true);
    setError(null);

    try {
      apply(await run());

      return true;
    } catch (error) {
      setError(isError(error) ? describeError(error) : String(error));

      return false;
    } finally {
      setPending(false);
    }
  }, []);

  const create = useCallback((slug: string) => mutate(() => tagApi.create({ slug })), [mutate]);

  const remove = useCallback((id: string) => mutate(() => tagApi.remove(id)), [mutate]);

  const setModels = useCallback(
    (id: string, modelIds: readonly string[]) => mutate(() => tagApi.setModels(id, modelIds)),
    [mutate],
  );

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return { status, tags, error, pending, create, remove, setModels, refresh };
}
