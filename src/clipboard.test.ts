import { describe, expect, it } from "vitest";
import { imageUrl, readClipboard, readClipboardImage, type ClipCommand } from "./clipboard";

/** A one-pixel PNG, which is all a clipboard image needs to be for a test. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const run =
  (output: Buffer | Error): ClipCommand =>
  async () => {
    if (output instanceof Error) throw output;
    return output;
  };

describe("readClipboardImage", () => {
  it("turns the bytes the tool wrote into a data URL", async () => {
    const image = await readClipboardImage(run(PNG), "darwin");

    expect(image?.mime).toBe("image/png");
    expect(image?.bytes).toBe(PNG.length);
    expect(imageUrl(image!)).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  it("reads the base64 Windows PowerShell writes", async () => {
    const image = await readClipboardImage(run(Buffer.from(PNG.toString("base64"), "utf8")), "win32");

    expect(image?.bytes).toBe(PNG.length);
    expect(Buffer.from(image!.data, "base64").equals(PNG)).toBe(true);
  });

  it("has no image when the pointer holds something else", async () => {
    // A text clipboard is the common case, and it must not become an attachment.
    expect(await readClipboardImage(run(Buffer.from("just some copied text")), "darwin")).toBeNull();
  });

  it("has no image when the tool is missing", async () => {
    expect(await readClipboardImage(run(new Error("ENOENT")), "darwin")).toBeNull();
    expect(await readClipboardImage(run(Buffer.alloc(0)), "darwin")).toBeNull();
  });

  it("falls through to the next tool when the first one fails", async () => {
    // X11 and Wayland both exist on Linux and a machine may have either.
    const tried: string[] = [];
    const command: ClipCommand = async (name) => {
      tried.push(name);
      if (name === "wl-paste") throw new Error("ENOENT");
      return PNG;
    };

    expect(await readClipboardImage(command, "linux")).not.toBeNull();
    expect(tried).toEqual(["wl-paste", "xclip"]);
  });

  it("refuses something too large to attach", async () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
    expect(await readClipboardImage(run(huge), "darwin")).toBeNull();
  });

  it("asks each platform through its own tool", async () => {
    const seen: string[] = [];
    const command: ClipCommand = async (name) => {
      seen.push(name);
      return PNG;
    };

    await readClipboardImage(command, "win32");
    const afterWindows = seen.length;
    await readClipboardImage(command, "darwin");

    expect(seen[0]).toBe("powershell");
    expect(seen[afterWindows]).toBe("pngpaste");
  });
});

describe("readClipboard", () => {
  it("falls back to the text when there is no image to be had", async () => {
    const command: ClipCommand = async (name) => {
      if (name === "pngpaste") throw new Error("ENOENT");
      return Buffer.from("git status\n");
    };

    // The trailing newline is how `pbpaste` ends its output, not something the
    // user meant to put on the prompt line.
    expect(await readClipboard(command, "darwin")).toEqual({ kind: "text", text: "git status", truncated: false });
  });

  it("prefers the image when the clipboard holds both", async () => {
    // Copying a file carries its name as text too; the picture is the point.
    const command: ClipCommand = async (name) => (name === "pngpaste" ? PNG : Buffer.from("screenshot.png"));
    const read = await readClipboard(command, "darwin");

    expect(read.kind).toBe("image");
    if (read.kind === "image") expect(imageUrl(read.image)).toContain("data:image/png;base64,");
  });

  it("says the clipboard is empty rather than attaching nothing", async () => {
    expect(await readClipboard(async () => Buffer.alloc(0), "darwin")).toEqual({ kind: "empty" });
  });

  it("takes a JPEG too, not only a PNG", async () => {
    // A screenshot tool that hands over a JPEG is still a picture to look at.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    const read = await readClipboard(async () => jpeg, "darwin");

    expect(read.kind).toBe("image");
    if (read.kind === "image") {
      expect(read.image.mime).toBe("image/jpeg");
      expect(imageUrl(read.image).startsWith("data:image/jpeg;base64,")).toBe(true);
    }
  });

  it("keeps a paste smaller than a prompt line in one piece", async () => {
    const read = await readClipboard(async () => Buffer.from("a\nb\n"), "darwin");

    // Multi-line text pastes as it is; only the trailing newline goes.
    expect(read).toEqual({ kind: "text", text: "a\nb", truncated: false });
  });

  it("truncates a paste too big for a prompt line, and says that it did", async () => {
    const read = await readClipboard(async () => Buffer.from("x".repeat(150_000)), "darwin");

    expect(read).toMatchObject({ kind: "text", truncated: true });
    if (read.kind === "text") expect(read.text).toHaveLength(100_000);
  });

  it("refuses bytes that are not text at all", async () => {
    // A screenshot read by a tool that was asked for text must not paste as
    // mojibake, and there is no image on the clipboard either.
    expect(await readClipboard(async () => Buffer.from([0x00, 0x01, 0x02, 0x00]), "darwin")).toEqual({ kind: "empty" });
  });

  it("reads the Windows clipboard text through PowerShell", async () => {
    const scripts: string[] = [];
    const command: ClipCommand = async (_name, args) => {
      const script = args.at(-1) ?? "";
      scripts.push(script);
      // The image is asked for first; with none, only the text answers.
      return script.includes("GetImage") ? Buffer.alloc(0) : Buffer.from("from the clipboard");
    };

    expect(await readClipboard(command, "win32")).toEqual({ kind: "text", text: "from the clipboard", truncated: false });
    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain("GetText");
  });
});
