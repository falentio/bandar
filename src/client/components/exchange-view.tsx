import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useExchange } from "../use-requests";

const MAX_SHOWN = 256 * 1024;

export function ExchangeView({ requestId, attemptId }: { requestId: string; attemptId: string }) {
  const detail = useExchange(requestId, attemptId);

  if (detail.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading exchange…</p>;
  }

  const exchange = detail.exchange;

  if (exchange === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Exchange not available</CardTitle>
          <CardDescription>
            {detail.error ?? "This attempt recorded no upstream exchange."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {exchange.truncated ? (
        <p className="text-sm text-muted-foreground">
          Captured up to the {Math.round(MAX_SHOWN / 1024)} KB limit; the rest is not shown.
        </p>
      ) : null}

      <Body
        title="Request"
        description={<span className="break-all font-mono text-xs">{exchange.requestUrl}</span>}
        body={exchange.requestBody}
      />
      <Body
        title={`Response ${exchange.responseStatus === null ? "—" : exchange.responseStatus}`}
        description="What the provider sent back, as it arrived."
        body={exchange.responseBody ?? "No response was received."}
      />
      <Body
        title="Request headers"
        description="Credential headers are masked."
        body={exchange.requestHeaders}
      />
    </div>
  );
}

function Body({
  title,
  description,
  body,
}: {
  title: string;
  description: ReactNode;
  body: string;
}) {
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
