import { useCallback, useEffect, useState } from "react";
import type { AuthResult, SessionUser, SignInInput, SignUpInput } from "../shared/auth";
import { ApiError, authApi } from "./api";

export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | { readonly status: "signed-in"; readonly user: SessionUser };

export type SessionControls = SessionState & {
  readonly pending: boolean;
  readonly error: string | null;
  readonly signUp: (input: SignUpInput) => Promise<void>;
  readonly signIn: (input: SignInInput) => Promise<void>;
  readonly signOut: () => Promise<void>;
};

export function useSession(): SessionControls {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    const load = async () => {
      try {
        const session = await authApi.session();

        if (!live) return;

        setState(session ? { status: "signed-in", user: session.user } : { status: "signed-out" });
      } catch (cause) {
        if (!live) return;

        setError(isError(cause) ? describe(cause) : String(cause));
        setState({ status: "signed-out" });
      }
    };

    void load();

    return () => {
      live = false;
    };
  }, []);

  const authenticate = useCallback(async (run: () => Promise<AuthResult>) => {
    setPending(true);
    setError(null);

    try {
      const result = await run();
      setState({ status: "signed-in", user: result.user });
    } catch (cause) {
      setError(isError(cause) ? describe(cause) : String(cause));
    } finally {
      setPending(false);
    }
  }, []);

  const signUp = useCallback(
    (input: SignUpInput) => authenticate(() => authApi.signUp(input)),
    [authenticate],
  );

  const signIn = useCallback(
    (input: SignInInput) => authenticate(() => authApi.signIn(input)),
    [authenticate],
  );

  const signOut = useCallback(async () => {
    setPending(true);
    setError(null);

    try {
      await authApi.signOut();
      setState({ status: "signed-out" });
    } catch (cause) {
      setError(isError(cause) ? describe(cause) : String(cause));
    } finally {
      setPending(false);
    }
  }, []);

  return { ...state, pending, error, signUp, signIn, signOut };
}

function isError(value: unknown): value is Error {
  return value instanceof Error;
}

function describe(error: Error): string {
  return error instanceof ApiError ? (error.issues[0] ?? error.message) : error.message;
}
