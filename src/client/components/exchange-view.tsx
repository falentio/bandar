import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useExchange } from "../use-requests";

const MAX_SHOWN = 256 * 1024;

export function ExchangeView({
  requestId,
  attemptId,
  flat = false,
}: {
  requestId: string;
  attemptId: string;
  flat?: boolean;
}) {
  const detail = useExchange(requestId, attemptId);

  if (detail.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading exchange…</p>;
  }

  const exchange = detail.exchange;

  if (exchange === null) {
    const unavailable = (
      <>
        <h3 className="font-heading text-sm font-medium">Exchange not available</h3>
        <p className="text-sm text-muted-foreground">
          {detail.error ?? "This attempt recorded no upstream exchange."}
        </p>
      </>
    );

    return flat ? (
      <div className="space-y-1.5">{unavailable}</div>
    ) : (
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
        flat={flat}
      />
      <Body
        title={`Response ${exchange.responseStatus === null ? "—" : exchange.responseStatus}`}
        description="What the provider sent back, as it arrived."
        body={exchange.responseBody ?? "No response was received."}
        flat={flat}
      />
      <Body
        title="Request headers"
        description="Credential headers are masked."
        body={exchange.requestHeaders}
        flat={flat}
      />
    </div>
  );
}

function Body({
  title,
  description,
  body,
  flat,
}: {
  title: string;
  description: ReactNode;
  body: string;
  flat: boolean;
}) {
  const pre = (
    <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">
      {pretty(body)}
    </pre>
  );

  if (flat) {
    return (
      <section className="space-y-1.5">
        <h3 className="font-heading text-sm font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
        {pre}
      </section>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{pre}</CardContent>
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
