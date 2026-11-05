/** Splits an SSE body into frames, dropping blank frames and comment frames (every line blank or `:`). */
export function sseFrames(body: string): readonly string[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.split("\n").some((line) => line !== "" && !line.startsWith(":")));
}
