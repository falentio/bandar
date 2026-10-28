import { labelForId, labelForSlug, type ModelLabels } from "./model-labels";

export function ModelName({
  labels,
  modelId,
  slug,
  className,
}: {
  labels: ModelLabels;
  modelId?: string;
  slug: string;
  className?: string;
}) {
  const label =
    modelId === undefined ? labelForSlug(labels, slug) : labelForId(labels, modelId, slug);

  return (
    <>
      <span className={className} title={slug}>
        {label}
      </span>
      {label === slug ? null : (
        <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{slug}</span>
      )}
    </>
  );
}
