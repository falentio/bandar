import { type FormEvent, useState } from "react";
import { PlusIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Tag } from "../../shared/tags";
import { optionLabelWithSlug } from "../model-labels";
import type { ModelChoiceGroup } from "../model-options";
import { rankedModels } from "../ranked-models";
import { useProviders } from "../use-providers";
import { useTags } from "../use-tags";
import { RankedModelPicker } from "./ranked-model-picker";

export function TagsPanel() {
  const tags = useTags();
  const providers = useProviders();
  const [slug, setSlug] = useState("");

  const catalog: readonly ModelChoiceGroup[] = providers.providers.map((provider) => ({
    label: provider.name,
    options: provider.models.map((model) => ({
      value: model.id,
      label: optionLabelWithSlug(model),
    })),
  }));

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
          catalog={catalog}
          pending={tags.pending}
          onModelsChange={(modelIds) => {
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
  catalog,
  pending,
  onModelsChange,
  onRemove,
}: {
  tag: Tag;
  catalog: readonly ModelChoiceGroup[];
  pending: boolean;
  onModelsChange: (modelIds: readonly string[]) => void;
  onRemove: () => void;
}) {
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

        <RankedModelPicker
          catalog={catalog}
          value={rankedModels(tag.models)}
          onChange={onModelsChange}
          disabled={pending}
        />
      </CardContent>
    </Card>
  );
}
