import { useCallback, useEffect, useState } from "react";
import type { ApiKey, CreatedApiKey } from "../shared/api-keys";
import { apiKeyApi } from "./api";
import { describeError, isError } from "./errors";

export type ApiKeysState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly keys: readonly ApiKey[] };

export type ApiKeys = {
  readonly status: ApiKeysState["status"];
  readonly keys: readonly ApiKey[];
  readonly created: string | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly create: (name: string) => Promise<void>;
  readonly revoke: (id: string) => Promise<void>;
  readonly dismissCreated: () => void;
};

export function useApiKeys(): ApiKeys {
  const [state, setState] = useState<ApiKeysState>({ status: "loading" });
  const [created, setCreated] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;

    const load = async () => {
      try {
        const { apiKeys } = await apiKeyApi.list();

        if (live) setState({ status: "ready", keys: apiKeys });
      } catch (error) {
        if (live)
          setState({
            status: "error",
            message: isError(error) ? describeError(error) : String(error),
          });
      }
    };

    void load();

    return () => {
      live = false;
    };
  }, []);

  const create = useCallback(async (name: string) => {
    setPending(true);

    try {
      const key = await apiKeyApi.create({ name });

      setCreated(key.key);
      setState((current) => ({
        status: "ready",
        keys: [toRow(key), ...(current.status === "ready" ? current.keys : [])],
      }));
    } catch (error) {
      setState({ status: "error", message: isError(error) ? describeError(error) : String(error) });
    } finally {
      setPending(false);
    }
  }, []);

  const revoke = useCallback(async (id: string) => {
    setPending(true);

    try {
      await apiKeyApi.remove(id);
      setState((current) =>
        current.status === "ready"
          ? { status: "ready", keys: current.keys.filter((key) => key.id !== id) }
          : current,
      );
    } catch (error) {
      setState({ status: "error", message: isError(error) ? describeError(error) : String(error) });
    } finally {
      setPending(false);
    }
  }, []);

  const dismissCreated = useCallback(() => setCreated(null), []);

  return {
    status: state.status,
    keys: state.status === "ready" ? state.keys : [],
    created,
    error: state.status === "error" ? state.message : null,
    pending,
    create,
    revoke,
    dismissCreated,
  };
}

function toRow(created: CreatedApiKey): ApiKey {
  return {
    id: created.id,
    name: created.name ?? null,
    start: created.start ?? null,
    createdAt: created.createdAt,
    lastRequest: null,
  };
}
