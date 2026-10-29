import { ModelRow } from "./provider-page";
import type { Compat, ProviderModel } from "../../shared/providers";
import type { Providers } from "../use-providers";

const PROVIDER_ID = "harness-provider";
const COMPATS: readonly Compat[] = ["chat", "responses", "messages", "genai"];

const noopProviders: Providers = {
  status: "ready",
  providers: [],
  error: null,
  pending: false,
  create: async () => false,
  remove: async () => false,
  apply: () => undefined,
  addModel: async () => false,
  removeModel: async () => undefined,
  updateModel: async () => false,
  addCredential: async () => false,
  addCredentials: async () => false,
  reorderCredentials: async () => false,
  removeCredential: async () => false,
  testCredential: async () => null,
};

const pendingProviders: Providers = { ...noopProviders, pending: true };

function model(overrides: Partial<ProviderModel>): ProviderModel {
  return {
    id: "model-1",
    upstreamModel: "gpt-4o-mini",
    slug: "local-openai/gpt-4o-mini",
    alias: null,
    ref: "local-openai/gpt-4o-mini",
    shadowed: false,
    compat: null,
    defaultCompat: "chat",
    inputPricePerMtok: null,
    cacheInputPricePerMtok: null,
    outputPricePerMtok: null,
    contextWindow: null,
    maxOutput: null,
    inputModalities: null,
    failures: 0,
    flaggedUntil: null,
    ...overrides,
  };
}

type Scenario = {
  readonly label: string;
  readonly note: string | null;
  readonly model: ProviderModel;
  readonly twin?: ProviderModel;
  readonly tags: readonly { readonly slug: string; readonly priority: number }[];
  readonly pending: boolean;
  readonly width: string | null;
  readonly flexed: boolean;
};

const LONG_LABEL = "a".repeat(100);
const LONG_REF = `local-openai/${"b".repeat(180)}`;

const TEN_TAGS = [
  "production",
  "edge",
  "eu-west",
  "budget",
  "experimental",
  "legacy",
  "batch",
  "realtime",
  "vision",
  "fallback",
].map((slug, index) => ({ slug, priority: index + 1 }));

const SCENARIOS: readonly Scenario[] = [
  {
    label: "Typical content",
    note: null,
    model: model({
      slug: "local-openai/gpt-4o-mini",
      alias: "gpt-4o-mini-fast",
      inputPricePerMtok: 0.15,
      outputPricePerMtok: 0.6,
    }),
    tags: [{ slug: "production", priority: 1 }],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Content length · no label",
    note: "clean: the card falls back to the upstream id, so a name always shows.",
    model: model({ slug: "local-openai/gpt-4o-mini", alias: null }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Content · one label on two models",
    note: "clean: both rows name themselves the same and the addresses keep them apart.",
    model: model({ id: "model-1", slug: "river/gpt-4o-mini", alias: "gpt-4o-mini" }),
    twin: model({ id: "model-2", slug: "yeta/gpt-4o-mini", alias: "gpt-4o-mini" }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Content · custom address, different label",
    note: "clean: the label leads and the address sits beside it in muted mono.",
    model: model({ slug: "fast-cheap", alias: "Fast and cheap" }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Content length · one word",
    note: "clean: single glyph sits on the baseline, no collapse.",
    model: model({ alias: "x" }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Content length · 100-char unbreakable label",
    note: "clean: the name truncates inside the card and the upstream id keeps its own line.",
    model: model({ slug: "local-openai/gpt-4o-mini", alias: LONG_LABEL }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Content length · 192-char address",
    note: "clean: the address truncates on its own line under a short label.",
    model: model({ slug: LONG_REF, alias: "long-ref" }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Content length · two long strings together",
    note: "clean: both truncate on their own line, 96px tall.",
    model: model({
      slug: LONG_REF,
      alias: LONG_LABEL,
      inputPricePerMtok: 0.15,
      outputPricePerMtok: 0.6,
    }),
    tags: [{ slug: "production", priority: 1 }],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Content shape · emoji label",
    note: "clean: emoji keep the row's line-height, no clipped glyph.",
    model: model({ slug: "local-openai/rocket", alias: "🚀🚀rocket" }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Content shape · Arabic label",
    note: "A label renders RTL while the row's other text runs LTR; it can sit on the wrong side of its own address.",
    model: model({ slug: "local-openai/arabic", alias: "نموذج-الذكاء" }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Content shape · mixed-direction address",
    note: "The address reorders around the Japanese segment, so the path no longer reads left to right.",
    model: model({ slug: "local-openai/モデル-v2", alias: "mixed" }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Quantity · zero tags",
    note: null,
    model: model({ alias: "untagged" }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Quantity · ten tags",
    note: "clean: ten chips wrap to two lines, row grows to 94px, nothing clipped.",
    model: model({ alias: "many-tags", inputPricePerMtok: 0.15, outputPricePerMtok: 0.6 }),
    tags: TEN_TAGS,
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "Container · 320px",
    note: "clean: 120px over three bands, every value visible.",
    model: model({
      slug: LONG_REF,
      alias: LONG_LABEL,
      inputPricePerMtok: 0.15,
      outputPricePerMtok: 0.6,
    }),
    tags: TEN_TAGS.slice(0, 3),
    pending: false,
    width: "320px",
    flexed: false,
  },
  {
    label: "Container · squeezed by a flex sibling",
    note: "clean: shrinks to 440px with everything visible.",
    model: model({ alias: "gpt-4o-mini-fast", inputPricePerMtok: 0.15, outputPricePerMtok: 0.6 }),
    tags: [{ slug: "production", priority: 1 }],
    pending: false,
    width: null,
    flexed: true,
  },
  {
    label: "Container · very wide",
    note: "clean: above the breakpoint the row layout returns, unchanged.",
    model: model({ alias: "wide", inputPricePerMtok: 0.15, outputPricePerMtok: 0.6 }),
    tags: [{ slug: "production", priority: 1 }],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "State · pending",
    note: "clean: controls dim, layout holds.",
    model: model({ alias: "busy-model", inputPricePerMtok: 0.15, outputPricePerMtok: 0.6 }),
    tags: [{ slug: "production", priority: 1 }],
    pending: true,
    width: null,
    flexed: false,
  },
  {
    label: "State · shadowed",
    note: "clean: reads 'shadowed by another model's address' inline with the meta.",
    model: model({ alias: "shadowed-model", shadowed: true }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "State · flagged until later",
    note: "clean: the cooldown note fits on one line.",
    model: model({
      alias: "cooling-model",
      failures: 3,
      flaggedUntil: new Date(Date.now() + 3600_000).toISOString(),
    }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
  {
    label: "State · recovered",
    note: "A model that failed twice reads 'recovered' in muted grey, indistinguishable from ordinary metadata.",
    model: model({ alias: "recovered-model", failures: 2, flaggedUntil: null }),
    tags: [],
    pending: false,
    width: null,
    flexed: false,
  },
];

function Row({ scenario }: { scenario: Scenario }) {
  const twins = scenario.twin === undefined ? [scenario.model] : [scenario.model, scenario.twin];

  return (
    <ul className="divide-y rounded-lg border">
      {twins.map((model) => (
        <ModelRow
          key={model.id}
          providerId={PROVIDER_ID}
          model={model}
          compats={COMPATS}
          pending={scenario.pending}
          tags={scenario.tags}
          providers={scenario.pending ? pendingProviders : noopProviders}
          onChanged={() => undefined}
          onEditingChange={() => undefined}
          onRemove={() => undefined}
        />
      ))}
    </ul>
  );
}

export function ModelRowHarness() {
  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">ModelRow · scenario harness</h1>
        <p className="text-sm text-muted-foreground">
          The real component, one instance per scenario. Notes under each label mark what broke.
        </p>
      </div>

      <div className="space-y-8">
        {SCENARIOS.map((scenario) => (
          <section key={scenario.label} className="space-y-2">
            <div className="space-y-0.5">
              <h2 className="text-sm font-medium">{scenario.label}</h2>
              {scenario.note === null ? null : (
                <p
                  className={
                    scenario.note.startsWith("clean")
                      ? "text-xs text-muted-foreground"
                      : "text-xs text-destructive"
                  }
                >
                  {scenario.note}
                </p>
              )}
            </div>
            {scenario.width === null ? (
              scenario.flexed ? (
                <div className="flex gap-2">
                  <div className="min-w-0 flex-1">
                    <Row scenario={scenario} />
                  </div>
                  <div className="w-1/3 shrink-0 rounded-lg border bg-muted/40 p-2 text-xs text-muted-foreground">
                    flex sibling
                  </div>
                </div>
              ) : (
                <Row scenario={scenario} />
              )
            ) : (
              <div style={{ width: scenario.width }}>
                <Row scenario={scenario} />
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
