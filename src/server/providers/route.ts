import type { Compat, ProviderKind } from "../../shared/providers";
import { joinUrl } from "./http";
import { definitionFor } from "./registry";
import { UpstreamError, type ProviderAdapter, type ProviderTarget, type WireRoute } from "./types";

export type RoutedAttempt = {
  readonly adapter: ProviderAdapter;
  /** The target with the route's mount already folded into baseUrl. */
  readonly target: ProviderTarget;
};

/**
 * A declared override wins, then the provider's own default, then a 400. An override this kind no
 * longer declares is treated as absent, so a stale row degrades instead of failing the request.
 */
export function routeAttempt(
  kind: ProviderKind,
  target: ProviderTarget,
  override: Compat | null,
): RoutedAttempt {
  const definition = definitionFor(kind);

  const overrideRoute = override === null ? undefined : definition.routes[override];

  if (overrideRoute !== undefined) return routed(overrideRoute, target);

  const choice = definition.defaultCompat(target.upstreamModel);

  if (choice.compat === null) throw new UpstreamError(choice.reason, "invalid_request");

  const route = definition.routes[choice.compat];

  if (route === undefined) {
    throw new UpstreamError(`${kind} declares no ${choice.compat} wire`, "invalid_request");
  }

  return routed(route, target);
}

function routed(route: WireRoute, target: ProviderTarget): RoutedAttempt {
  if (route.mount === undefined) return { adapter: route.adapter, target };

  return {
    adapter: route.adapter,
    target: { ...target, baseUrl: joinUrl(target.baseUrl, route.mount) },
  };
}
