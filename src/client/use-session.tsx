import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AuthResult, SessionUser, SignInInput, SignUpInput } from "../shared/auth";
import { authApi } from "./api";
import { describeError, isError } from "./errors";

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

const SessionContext = createContext<SessionControls | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const session = useSessionControls();

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionControls {
  const session = useContext(SessionContext);

  if (!session) throw new Error("useSession must be inside SessionProvider");

  return session;
}

function useSessionControls(): SessionControls {
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

        setError(isError(cause) ? describeError(cause) : String(cause));
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
      setError(isError(cause) ? describeError(cause) : String(cause));
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
      setError(isError(cause) ? describeError(cause) : String(cause));
    } finally {
      setPending(false);
    }
  }, []);

  return { ...state, pending, error, signUp, signIn, signOut };
}
