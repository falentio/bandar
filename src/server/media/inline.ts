import type { ConversationMessage, InboundMessage, PendingImagePart } from "../../shared/conversation";
import { MAX_IMAGE_TOTAL_BYTES, assetOf, type ImageAsset } from "../../shared/media";
import type { Normalized } from "../../shared/messages";

export type MediaIo = {
  readonly fetchImage: (url: string, signal: AbortSignal) => Promise<Normalized<ImageAsset>>;
};

/**
 * The one crossing from what an ingress read to what a wire can carry. Every pending image is
 * resolved in place, keeping the order the client wrote, and the first one that cannot be read ends
 * the request: a block this gateway cannot carry is named, never dropped.
 */
export async function inlineImages(
  messages: readonly InboundMessage[],
  io: MediaIo,
  signal: AbortSignal,
): Promise<Normalized<readonly ConversationMessage[]>> {
  const fetched = new Map<string, Promise<Normalized<ImageAsset>>>();
  let total = 0;

  const inline: ConversationMessage[] = [];

  for (const message of messages) {
    const content: ConversationMessage["content"][number][] = [];

    for (const part of message.content) {
      if (part.type !== "image_pending") {
        content.push(part);
        continue;
      }

      const asset = await resolve(part, io, signal, fetched);

      if (!asset.ok) return named(asset.rejection.message, part.at);

      total += asset.value.bytes;

      if (total > MAX_IMAGE_TOTAL_BYTES)
        return named(
          `the request's images are over the ${String(MAX_IMAGE_TOTAL_BYTES)} byte total limit`,
          part.at,
        );

      content.push({ type: "image", image: asset.value });
    }

    inline.push({ role: message.role, content });
  }

  return { ok: true, value: inline };
}

/** One remote address is read once per request, so a repeated image costs one fetch and not two. */
function resolve(
  part: PendingImagePart,
  io: MediaIo,
  signal: AbortSignal,
  fetched: Map<string, Promise<Normalized<ImageAsset>>>,
): Promise<Normalized<ImageAsset>> {
  if (part.origin.kind === "inline") return Promise.resolve(assetOf(part.origin, part.at));

  const url = part.origin.url;
  const known = fetched.get(url);

  if (known !== undefined) return known;

  const pending = io.fetchImage(url, signal).catch(() => unreadable());

  fetched.set(url, pending);

  return pending;
}

function unreadable(): Normalized<never> {
  return { ok: false, rejection: { status: 422, param: "", message: "the image could not be read" } };
}

function named(message: string, at: string) {
  return { ok: false as const, rejection: { status: 422, param: at, message: `${at}: ${message}` } };
}
