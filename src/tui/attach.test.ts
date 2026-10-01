import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docBlock, isImagePath, readAttachedFile } from "./attach";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kicode-attach-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("isImagePath", () => {
  it("knows the extensions the vision path takes", () => {
    for (const path of ["a.png", "b.JPG", "c.jpeg", "d.webp", "e.gif"]) expect(isImagePath(path), path).toBe(true);
    for (const path of ["a.md", "b.ts", "c.pdf", "d.csv"]) expect(isImagePath(path), path).toBe(false);
  });
});

describe("readAttachedFile", () => {
  it("reads a text document and names it", async () => {
    const file = join(dir, "notes.md");
    await writeFile(file, "# Notes\nhello");

    const attached = await readAttachedFile("notes.md", dir);
    expect(attached.kind).toBe("doc");
    if (attached.kind !== "doc") return;
    expect(attached.doc.name).toBe("notes.md");
    expect(attached.doc.body).toContain("hello");
    expect(attached.doc.truncated).toBe(false);
  });

  it("resolves a relative path against the session's directory", async () => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.ts"), "export const a = 1;");

    const attached = await readAttachedFile("src/app.ts", dir);
    expect(attached.kind).toBe("doc");
  });

  it("carries an image as base64, without the data: prefix", async () => {
    const file = join(dir, "shot.png");
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const attached = await readAttachedFile("shot.png", dir);
    expect(attached.kind).toBe("image");
    if (attached.kind !== "image") return;
    expect(attached.image.mime).toBe("image/png");
    expect(attached.image.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
    expect(attached.image.bytes).toBe(4);
  });

  it("uses image/jpeg for .jpg, which the extension alone does not say", async () => {
    const file = join(dir, "photo.jpg");
    await writeFile(file, Buffer.from([1, 2, 3]));

    const attached = await readAttachedFile("photo.jpg", dir);
    expect(attached.kind === "image" ? attached.image.mime : "").toBe("image/jpeg");
  });

  it("truncates a long document rather than sending the whole thing", async () => {
    const file = join(dir, "big.txt");
    await writeFile(file, "x".repeat(30_000));

    const attached = await readAttachedFile("big.txt", dir);
    expect(attached.kind).toBe("doc");
    if (attached.kind !== "doc") return;
    expect(attached.doc.truncated).toBe(true);
    expect(attached.doc.body.length).toBe(24_000);
    // The block says so, so the model is not misled about what it has.
    expect(docBlock(attached.doc)).toContain("truncated");
  });

  it("refuses a missing file, a directory and a binary", async () => {
    await expect(readAttachedFile("nope.txt", dir)).rejects.toThrow(/no file at/);
    await expect(readAttachedFile(".", dir)).rejects.toThrow(/not a regular file/);

    const binary = join(dir, "blob.bin");
    await writeFile(binary, Buffer.from([0x00, 0x01, 0x02]));
    await expect(readAttachedFile("blob.bin", dir)).rejects.toThrow(/binary/);
  });

  it("wraps the text in a named context block, the same shape @file makes", () => {
    const block = docBlock({ name: "a.md", body: "body text", truncated: false });
    expect(block).toContain('Context from attached file "a.md"');
    expect(block).toContain("body text");
    expect(block).not.toContain("truncated");
  });
});
