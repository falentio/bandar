import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useExchange } from "../use-requests";

export function AttemptPage({ requestId, attemptId }: { requestId: string; attemptId: string }) {
  const detail = useExchange(requestId, attemptId);

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

      {detail.status === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading exchange…</p>
      ) : detail.exchange === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Exchange not available</CardTitle>
            <CardDescription>
              {detail.error ?? "This attempt recorded no upstream exchange."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link to="/requests/$requestId" params={{ requestId }}>
                Back to request
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">Upstream exchange</h1>
            <p className="truncate font-mono text-sm text-muted-foreground">
              {detail.exchange.requestUrl}
            </p>
          </div>

          {detail.exchange.truncated ? (
            <p className="text-sm text-muted-foreground">
              Captured up to the {Math.round(MAX_SHOWN / 1024)} KB limit; the rest is not shown.
            </p>
          ) : null}

          <Body
            title="Request"
            description="What the gateway sent to the provider."
            body={detail.exchange.requestBody}
          />
          <Body
            title={`Response ${detail.exchange.responseStatus === null ? "—" : detail.exchange.responseStatus}`}
            description="What the provider sent back, as it arrived."
            body={detail.exchange.responseBody ?? "No response was received."}
          />
          <Body
            title="Request headers"
            description="Credential headers are masked."
            body={detail.exchange.requestHeaders}
          />
        </>
      )}
    </div>
  );
}

const MAX_SHOWN = 256 * 1024;

function Body({ title, description, body }: { title: string; description: string; body: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">
          {pretty(body)}
        </pre>
      </CardContent>
    </Card>
  );
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
