import { useEffect, useRef, useState } from "react";
import { CheckIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Provider, ProviderOAuthStart } from "../../shared/providers";
import { providerApi } from "../api";
import { describeError, isError } from "../errors";

const POLL_INTERVAL_MS = 3000;

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "waiting"; readonly login: ProviderOAuthStart }
  | { readonly kind: "connected" }
  | { readonly kind: "failed"; readonly message: string };

export function ConnectFlow({
  provider,
  onConnected,
}: {
  provider: Provider;
  onConnected: (provider: Provider) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const attempt = useRef(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;

    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (phase.kind !== "waiting") return;

    const run = attempt.current;

    const timer = setInterval(() => {
      void providerApi
        .pollOauth(provider.id)
        .then((result) => {
          if (!live.current || run !== attempt.current || result.state === "pending") return;

          setPhase({ kind: "connected" });
          void providerApi.list().then((list) => {
            if (!live.current) return;

            const updated = list.providers.find((entry) => entry.id === provider.id);

            if (updated !== undefined) onConnected(updated);
          });
        })
        .catch((error: Error) => {
          if (!live.current || run !== attempt.current) return;

          const message = isError(error) ? describeError(error) : "the login could not be checked";

          // The poll returns 200 while pending, so any failure ends this wait.
          setPhase({ kind: "failed", message });
        });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [phase, provider.id, onConnected]);

  const start = async () => {
    const run = attempt.current + 1;

    attempt.current = run;
    setPhase({ kind: "starting" });

    try {
      const login = await providerApi.startOauth(provider.id);

      if (!live.current || run !== attempt.current) return;

      setPhase({ kind: "waiting", login });
    } catch (error) {
      if (!live.current || run !== attempt.current) return;

      setPhase({
        kind: "failed",
        message: isError(error) ? describeError(error) : "the login could not start",
      });
    }
  };

  const cancel = () => {
    attempt.current += 1;
    setPhase({ kind: "idle" });
  };

  if (phase.kind === "idle" || phase.kind === "starting") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={phase.kind === "starting"}
          onClick={() => void start()}
        >
          {phase.kind === "starting" ? "Starting…" : "Connect Kilo Code"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Opens kilocode.ai in a new tab. A device code is polled until you approve it.
        </p>
      </div>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div className="grid gap-2">
        <p className="text-sm text-destructive">{phase.message}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void start()}>
          Try again
        </Button>
      </div>
    );
  }

  if (phase.kind === "connected") {
    return (
      <div className="flex items-center gap-2 text-sm">
        <CheckIcon className="size-4 text-emerald-500" />
        <span>Kilo Code is connected.</span>
      </div>
    );
  }

  return (
    <div className="grid gap-3 rounded-lg border bg-muted/40 p-4">
      <div className="flex items-center gap-2 text-sm">
        <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
        <span>Waiting for approval</span>
      </div>
      <div className="grid gap-1">
        <p className="text-xs text-muted-foreground">Enter this code at kilocode.ai:</p>
        <code className="font-mono text-lg font-medium tracking-[0.2em]">
          {phase.login.userCode}
        </code>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <a href={phase.login.verificationUrl} target="_blank" rel="noreferrer">
            <ExternalLinkIcon data-icon="inline-start" />
            Open kilocode.ai
          </a>
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
