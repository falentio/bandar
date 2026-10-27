import { useCallback, useEffect, useState } from "react";
import type {
  Provider,
  ProviderCreateInput,
  ProviderCredentialInput,
  ProviderModelInput,
} from "../shared/providers";
import { providerApi } from "./api";
import { describeError, isError } from "./errors";

type Status = "loading" | "ready" | "error";

export type Providers = {
  readonly status: Status;
  readonly providers: readonly Provider[];
  readonly error: string | null;
  readonly pending: boolean;
  readonly create: (input: ProviderCreateInput) => Promise<boolean>;
  readonly remove: (id: string) => Promise<boolean>;
  readonly apply: (provider: Provider) => void;
  readonly addModel: (id: string, input: ProviderModelInput) => Promise<boolean>;
  readonly removeModel: (id: string, modelId: string) => Promise<void>;
  readonly addCredential: (id: string, input: ProviderCredentialInput) => Promise<boolean>;
  readonly addCredentials: (id: string, apiKeys: readonly string[]) => Promise<boolean>;
  readonly reorderCredentials: (id: string, credentialIds: readonly string[]) => Promise<boolean>;
  readonly removeCredential: (id: string, credentialId: string) => Promise<boolean>;
};

export function useProviders(): Providers {
  const [providers, setProviders] = useState<readonly Provider[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const replace = (provider: Provider): void => {
    setProviders((current) =>
      current.map((entry) => (entry.id === provider.id ? provider : entry)),
    );
  };

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

  const create = useCallback(async (input: ProviderCreateInput): Promise<boolean> => {
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

  const remove = useCallback(async (id: string): Promise<boolean> => {
    setPending(true);
    setError(null);

    try {
      await providerApi.remove(id);
      setProviders((current) => current.filter((provider) => provider.id !== id));

      return true;
    } catch (error) {
      setError(isError(error) ? describeError(error) : String(error));

      return false;
    } finally {
      setPending(false);
    }
  }, []);

  const mutate = useCallback(async (run: () => Promise<Provider>): Promise<boolean> => {
    setPending(true);
    setError(null);

    try {
      replace(await run());

      return true;
    } catch (error) {
      setError(isError(error) ? describeError(error) : String(error));

      return false;
    } finally {
      setPending(false);
    }
  }, []);

  const addModel = useCallback(
    (id: string, input: ProviderModelInput) => mutate(() => providerApi.addModel(id, input)),
    [mutate],
  );

  const removeModel = useCallback(
    async (id: string, modelId: string): Promise<void> => {
      await mutate(() => providerApi.removeModel(id, modelId));
    },
    [mutate],
  );

  const addCredential = useCallback(
    (id: string, input: ProviderCredentialInput) =>
      mutate(() => providerApi.addCredential(id, input)),
    [mutate],
  );

  const addCredentials = useCallback(
    (id: string, apiKeys: readonly string[]) =>
      mutate(() => providerApi.addCredentials(id, apiKeys)),
    [mutate],
  );

  const reorderCredentials = useCallback(
    (id: string, credentialIds: readonly string[]) =>
      mutate(() => providerApi.reorderCredentials(id, credentialIds)),
    [mutate],
  );

  const removeCredential = useCallback(
    (id: string, credentialId: string) =>
      mutate(() => providerApi.removeCredential(id, credentialId)),
    [mutate],
  );

  const apply = useCallback((provider: Provider) => replace(provider), []);

  return {
    status,
    providers,
    error,
    pending,
    create,
    remove,
    apply,
    addModel,
    removeModel,
    addCredential,
    addCredentials,
    reorderCredentials,
    removeCredential,
  };
}
