/**
 * Attaching a file from the prompt — `/attach <path>`.
 *
 * Two kinds of file, two ways across, because the model consumes them
 * differently:
 *
 * - **Images** (`png`, `jpeg`, `webp`, `gif`) become the same base64 payload a
 *   pasted screenshot is: they ride the existing image path, visible to
 *   vision-capable models and silently dropped by the rest.
 * - **Everything else** — source files, markdown, json, csv — is read as text
 *   and appended to the turn's words as a context block, the same shape an
 *   `@file` mention produces. That works on every model, including the free
 *   ones that accept no image parts at all.
 *
 * Reading happens at attach time, not send time: a file that vanished or
 * cannot be decoded says so the moment it was named, while the user can still
 * fix the path.
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, extname, resolve } from "node:path";
import type { PastedImage } from "../clipboard";

/** The image extensions that ride the vision path; everything else is text. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/** The largest attachment read into the prompt, in bytes. A context block is not a file dump. */
const MAX_DOC_BYTES = 512 * 1024;
/** The largest image, matching the clipboard's own cap. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** How much of a text document survives into the prompt, in characters. */
const MAX_DOC_CHARS = 24_000;

/** One document attached with `/attach`, read and waiting for the next turn. */
export type AttachedDoc = {
  /** The name shown in the badges row and the context block header. */
  name: string;
  /** The text that travels to the model. */
  body: string;
  /** Set when the read was capped, so the user knows what the model sees. */
  truncated: boolean;
};

/** What `/attach <path>` resolved to — exactly one of the two. */
export type AttachedFile = { kind: "image"; image: PastedImage } | { kind: "doc"; doc: AttachedDoc };

/** True when the extension names something the vision path takes. */
export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase().replace(".", ""));
}

/**
 * Reads a file from the prompt, wherever it is on disk.
 *
 * A relative path is resolved against the session's working directory, so
 * `/attach src/app.ts` and `/attach ./notes.md` behave the way the shell would.
 * Images are rejected over the clipboard's cap and text over the context cap —
 * both limits exist because the payload travels inside every later request.
 */
export async function readAttachedFile(filePath: string, cwd: string): Promise<AttachedFile> {
  const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);

  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`no file at ${resolved}`);
  }
  if (!info.isFile()) throw new Error(`${resolved} is not a regular file`);

  const name = fileNameOf(resolved);

  if (isImagePath(resolved)) {
    if (info.size > MAX_IMAGE_BYTES) {
      throw new Error(`${name} is ${Math.round(info.size / (1024 * 1024))} MB — images are capped at 8 MB`);
    }
    const buffer = await readFile(resolved);
    const ext = extname(resolved).toLowerCase().replace(".", "");
    return {
      kind: "image",
      image: {
        data: buffer.toString("base64"),
        mime: ext === "jpg" ? "image/jpeg" : `image/${ext}`,
        bytes: info.size,
      },
    };
  }

  if (info.size > MAX_DOC_BYTES) {
    throw new Error(`${name} is ${Math.round(info.size / 1024)} KB — documents are capped at 512 KB (mention it with @ to read parts instead)`);
  }

  const buffer = await readFile(resolved);
  if (buffer.includes(0)) throw new Error(`${name} is binary — only text documents can be attached`);

  const text = buffer.toString("utf8");
  const truncated = text.length > MAX_DOC_CHARS;
  return {
    kind: "doc",
    doc: {
      name,
      body: truncated ? `${text.slice(0, MAX_DOC_CHARS).trimEnd()}` : text.trimEnd() || "(empty file)",
      truncated,
    },
  };
}

/** Reads one already-resolved attachment, for callers holding an AttachedDoc. */
export function readAttachedDoc(doc: AttachedDoc): string {
  return doc.body;
}

/** The context block a document becomes inside the turn's words. */
export function docBlock(doc: AttachedDoc): string {
  const head = `Context from attached file "${doc.name}":`;
  const tail = doc.truncated ? `\n… (truncated at ${MAX_DOC_CHARS} characters)` : "";
  return `${head}\n${doc.body}${tail}`;
}

function fileNameOf(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return index >= 0 ? filePath.slice(index + 1) : filePath;
}

/** What the badges row shows for one attached document. */
export function docBadgeText(doc: AttachedDoc): string {
  return `[${doc.name}]`;
}
