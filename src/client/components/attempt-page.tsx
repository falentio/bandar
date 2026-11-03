import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { ExchangeView } from "./exchange-view";

export function AttemptPage({ requestId, attemptId }: { requestId: string; attemptId: string }) {
  return (
    <div className="space-y-4">
      <Link
        to="/requests/$requestId"
        params={{ requestId }}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to request
      </Link>

      <h1 className="text-lg font-semibold">Upstream exchange</h1>

      <ExchangeView requestId={requestId} attemptId={attemptId} />
    </div>
  );
}
