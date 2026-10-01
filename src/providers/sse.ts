/**
 * Server-Sent Events parsing for an OpenAI-compatible stream.
 *
 * The subtlety that breaks naive implementations: a network chunk is not a
 * frame. `\n\n` can straddle two reads, and both `\n\n` and `\r\n\r\n` are valid
 * frame separators. Everything is therefore accumulated in a buffer and only
 * complete frames are yielded.
 */

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      let boundary: Boundary | null;
      while ((boundary = findBoundary(buffer)) !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = extractData(frame);
        if (data !== null) yield data;
      }
    }

    // Flush whatever the decoder still holds, plus any final frame that arrived
    // without a trailing separator.
    buffer += decoder.decode();
    const data = extractData(buffer);
    if (data !== null) yield data;
  } finally {
    reader.releaseLock();
  }
}

type Boundary = { index: number; length: number };

function findBoundary(buffer: string): Boundary | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf === -1) return { index: lf, length: 2 };
  if (lf === -1) return { index: crlf, length: 4 };
  return lf <= crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

/**
 * Join the `data:` fields of one frame. Comment lines (`: keep-alive`) and
 * field names other than `data` are ignored.
 */
function extractData(frame: string): string | null {
  const parts: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (rawLine.startsWith(":")) continue;
    if (!rawLine.startsWith("data:")) continue;
    parts.push(rawLine.slice(5).replace(/^ /, ""));
  }
  return parts.length === 0 ? null : parts.join("\n");
}
