import { useCallback, useEffect, useState } from "react";
import type { Provider, ProviderInput } from "../shared/providers";
import { providerApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type Providers = {
  readonly status: Status;
  readonly providers: readonly Provider[];
  readonly error: string | null;
  readonly pending: boolean;
  readonly create: (input: ProviderInput) => Promise<boolean>;
  readonly remove: (id: string) => Promise<void>;
};

export function useProviders(): Providers {
  const [providers, setProviders] = useState<readonly Provider[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;

    const load = async () => {
      setStatus("loading");
      setError(null);

      try {
        const list = await providerApi.list();

        if (!live) return;

        setProviders(list.providers);
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
  }, []);

  const create = useCallback(async (input: ProviderInput): Promise<boolean> => {
    setPending(true);
    setError(null);

    try {
      const provider = await providerApi.create(input);

      setProviders((current) => current.concat(provider));
      setStatus("ready");

      return true;
    } catch (error) {
      setError(isError(error) ? describeError(error) : String(error));

      return false;
    } finally {
      setPending(false);
    }
  }, []);

  const remove = useCallback(async (id: string): Promise<void> => {
    setPending(true);
    setError(null);

    try {
      await providerApi.remove(id);
      setProviders((current) => current.filter((provider) => provider.id !== id));
    } catch (error) {
      setError(isError(error) ? describeError(error) : String(error));
    } finally {
      setPending(false);
    }
  }, []);

  return { status, providers, error, pending, create, remove };
}
