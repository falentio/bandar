import { type FormEvent, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { modelLabelOf } from "../../shared/providers";
import type { Tag } from "../../shared/tags";
import { useProviders } from "../use-providers";
import { useTags } from "../use-tags";

type TagCandidate = {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly providerName: string;
  readonly ref: string;
};

export function TagsPanel() {
  const tags = useTags();
  const providers = useProviders();
  const [slug, setSlug] = useState("");

  const models: TagCandidate[] = providers.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      id: model.id,
      slug: model.slug,
      label: modelLabelOf(model),
      providerName: provider.name,
      ref: model.ref,
    })),
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (await tags.create(slug.trim())) setSlug("");
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Tags</h1>
        <p className="text-sm text-muted-foreground">
          A tag is a named fallback chain. Clients send <code>tags/&lt;slug&gt;</code> and the
          gateway tries each model in order. There is no attempt cap, so a tag with N models can
          make up to N upstream calls for one client request.
        </p>
      </div>

      <Card>
        <CardContent>
          <form onSubmit={submit} className="flex flex-wrap items-start gap-3">
            <div className="grid min-w-48 flex-1 gap-1.5">
              <Label htmlFor="tag-slug" className="text-xs">
                Slug
              </Label>
              <Input
                id="tag-slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="failover"
                maxLength={40}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                required
                disabled={tags.pending}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, digits, and single hyphens. Clients call it as{" "}
                <code>tags/&lt;slug&gt;</code>.
              </p>
            </div>
            <Button type="submit" size="sm" disabled={tags.pending || slug.trim() === ""}>
              <PlusIcon data-icon="inline-start" />
              Add tag
            </Button>
          </form>
        </CardContent>
      </Card>

      {tags.error === null ? null : <p className="text-sm text-destructive">{tags.error}</p>}

      {tags.status === "loading" ? (
        <Card>
          <CardContent>
            <p className="py-6 text-center text-sm text-muted-foreground">Loading tags…</p>
          </CardContent>
        </Card>
      ) : null}

      {tags.status === "ready" && tags.tags.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">No tags yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create a tag, then add the models it should try.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {tags.tags.map((tag) => (
        <TagCard
          key={tag.id}
          tag={tag}
          models={models}
          pending={tags.pending}
          onOrderChange={(modelIds) => {
            void tags.setModels(tag.id, modelIds);
          }}
          onRemove={() => {
            void tags.remove(tag.id);
          }}
        />
      ))}
    </div>
  );
}

function TagCard({
  tag,
  models,
  pending,
  onOrderChange,
  onRemove,
}: {
  tag: Tag;
  models: readonly TagCandidate[];
  pending: boolean;
  onOrderChange: (modelIds: readonly string[]) => void;
  onRemove: () => void;
}) {
  const current = tag.models.map((model) => model.modelId);
  const available = models.filter((model) => !current.includes(model.id));

  const move = (index: number, delta: number) => {
    const next = [...current];
    const [moved] = next.splice(index, 1);

    if (moved === undefined) return;

    next.splice(index + delta, 0, moved);
    onOrderChange(next);
  };

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <code className="font-mono text-sm font-medium">{tag.ref}</code>
            <span className="text-xs text-muted-foreground">
              {tag.models.length === 1 ? "1 model" : `${tag.models.length} models`}
            </span>
          </div>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (window.confirm(`Delete the tag ${tag.ref}?`)) onRemove();
            }}
          >
            <TrashIcon data-icon="inline-start" />
            Delete
          </Button>
        </div>

        {tag.models.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
            No models yet. Add one to start the chain.
          </p>
        ) : (
          <ol className="divide-y rounded-lg border">
            {tag.models.map((model, index) => (
              <li key={model.modelId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
                  #{model.priority}
                </span>
                <span className="text-sm font-medium">{modelLabelOf(model)}</span>
                <span className="text-xs text-muted-foreground">{model.providerName}</span>
                <code className="font-mono text-xs text-muted-foreground">{model.ref}</code>
                <span className="ms-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${modelLabelOf(model)} up`}
                    disabled={pending || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${modelLabelOf(model)} down`}
                    disabled={pending || index === tag.models.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${modelLabelOf(model)} from ${tag.ref}`}
                    title={
                      tag.models.length === 1
                        ? "Delete the tag to remove its last model"
                        : undefined
                    }
                    disabled={pending || tag.models.length === 1}
                    onClick={() => onOrderChange(current.filter((id) => id !== model.modelId))}
                  >
                    <XIcon />
                  </Button>
                </span>
              </li>
            ))}
          </ol>
        )}

        {available.length === 0 ? null : (
          <select
            aria-label={`Add a model to ${tag.ref}`}
            disabled={pending}
            value=""
            onChange={(event) => {
              if (event.target.value !== "") onOrderChange([...current, event.target.value]);
            }}
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
          >
            <option value="">Add model…</option>
            {available.map((model) => (
              <option key={model.id} value={model.id}>
                {model.providerName} · {model.label}
                {model.label === model.slug ? "" : ` (${model.slug})`}
              </option>
            ))}
          </select>
        )}
      </CardContent>
    </Card>
  );
}
