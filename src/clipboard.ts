/**
 * Reading the system clipboard — text or image.
 *
 * A terminal hands over text and nothing else, so an image has to be lifted out
 * of the clipboard by the platform's own tool. Text arrives through the
 * terminal's bracketed paste, except for `ctrl+v`, which the user expects to
 * mean "whatever I copied" — so the clipboard is read here too and the answer
 * decides what happens: an image is attached to the next turn, text is put on
 * the prompt line, and neither is reported rather than silently doing nothing.
 *
 * Nothing here is required: when the tool is missing or the clipboard holds
 * neither, the answer says so.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";

export type PastedImage = {
  /** Base64, without the `data:` prefix. */
  data: string;
  mime: string;
  bytes: number;
};

/** What a read of the clipboard found. */
export type ClipboardRead =
  | { kind: "image"; image: PastedImage }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "empty" };

/** The largest paste KiCode will attach. Endpoints cap this; a screenshot fits. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * The longest text `ctrl+v` will put on the prompt line. Copied files can be
 * megabytes, and a prompt line is not the place to find that out.
 */
const MAX_TEXT_CHARS = 100_000;

/**
 * Whatever the clipboard holds, image first.
 *
 * `run` is injectable so the parsing and the limits can be tested without a
 * clipboard — the only part that cannot be tested here is the clipboard itself.
 */
export async function readClipboard(run: ClipCommand = defaultClipCommand, platform: NodeJS.Platform = process.platform): Promise<ClipboardRead> {
  // An image anywhere in the list beats text anywhere in it: a copied
  // screenshot usually also carries a file name as text, and a picture the user
  // copied is the more interesting half of that.
  let text: { text: string; truncated: boolean } | null = null;

  for (const source of clipsFor(platform)) {
    let output: Buffer;
    try {
      output = await run(source.command, source.args);
    } catch {
      continue;
    }

    if (source.kind === "image") {
      if (source.encoding === "text") continue;
      const image = toImage(output, source.encoding);
      if (image) return { kind: "image", image };
      continue;
    }

    if (text === null) text = toText(output);
  }

  return text ? { kind: "text", text: text.text, truncated: text.truncated } : { kind: "empty" };
}

/** Just the image, for callers that only handle pictures. */
export async function readClipboardImage(
  run: ClipCommand = defaultClipCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<PastedImage | null> {
  const read = await readClipboard(run, platform);
  return read.kind === "image" ? read.image : null;
}

/** Runs one clipboard command and returns what it wrote to stdout. */
export type ClipCommand = (command: string, args: readonly string[]) => Promise<Buffer>;

const defaultClipCommand: ClipCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];

    child.on("error", reject);
    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      // A runaway command must not fill memory: a clipboard read is not this
      // big, and a wrong tool could stream something that is.
      const size = chunks.reduce((total, part) => total + part.length, 0);
      if (size > MAX_IMAGE_BYTES * 2) {
        child.kill();
      }
    });
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`exit ${code}`))));
  });

export type ClipSource = {
  /** What this source is asked for. */
  kind: "image" | "text";
  command: string;
  args: string[];
  /** How the bytes on stdout are read: raw image bytes, base64, or text. */
  encoding: "raw" | "base64" | "text";
};

/** How each platform is asked, images first and then text, best first. */
function clipsFor(platform: NodeJS.Platform): ClipSource[] {
  if (platform === "win32") {
    // Windows PowerShell is always present. `Get-Clipboard -Format Image` is
    // not, so the clipboard is read through the same assemblies the WinForms
    // clipboard uses: the bitmap is saved as PNG into a memory stream, and the
    // text is asked for separately so an empty clipboard is an empty answer
    // rather than a failure.
    const image = [
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
      "$img = [System.Windows.Forms.Clipboard]::GetImage();",
      "if (!$img) { try { $files = [System.Windows.Forms.Clipboard]::GetFileDropList(); if ($files -and $files.Count -gt 0) { $f = $files[0]; if ($f -match '\\.(png|jpg|jpeg|gif|bmp|webp)$' -and (Test-Path $f)) { $img = [System.Drawing.Image]::FromFile($f); } } } catch { } }",
      "if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray())); $img.Dispose(); }",
    ].join(" ");
    const text = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "try { [Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText()) } catch { }",
    ].join(" ");

    return [
      { kind: "image", command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", image], encoding: "base64" },
      { kind: "text", command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", text], encoding: "text" },
    ];
  }

  if (platform === "darwin") {
    // `pngpaste` is the usual way; without it there is no one-liner that does
    // not write a temp file through AppleScript. `pbpaste` is built in.
    return [
      { kind: "image", command: "pngpaste", args: ["-"], encoding: "raw" },
      { kind: "text", command: "pbpaste", args: [], encoding: "text" },
    ];
  }

  // Wayland first where it exists, then X11. Whichever is installed answers.
  return [
    { kind: "image", command: "wl-paste", args: ["--type", "image/png", "--no-newline"], encoding: "raw" },
    { kind: "image", command: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"], encoding: "raw" },
    { kind: "text", command: "wl-paste", args: ["--no-newline"], encoding: "text" },
    { kind: "text", command: "xclip", args: ["-selection", "clipboard", "-o"], encoding: "text" },
  ];
}

/**
 * The PNG bytes, or the base64 of them, turned into what the API is sent.
 *
 * The raw form is sniffed rather than assumed to be PNG: `pngpaste` and `xclip`
 * return whatever format the copying application offered, and a JPEG from a
 * screenshot tool is still a picture the user meant to show KiCode.
 */
function toImage(output: Buffer, encoding: "raw" | "base64"): PastedImage | null {
  const trimmed = output.toString("utf8").trim();
  if (trimmed === "") return null;

  let data: string;
  let mime: string;
  if (encoding === "base64") {
    if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) return null;
    data = trimmed;
    // The Windows script converts whatever was on the clipboard to PNG itself.
    mime = "image/png";
  } else {
    mime = sniffMime(output) ?? "";
    if (!mime) return null;
    data = output.toString("base64");
  }

  // Base64 carries the size in its length, minus the padding it ends with —
  // and this number is shown to the user, so it has to be the real one.
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const bytes = (data.length * 3) / 4 - padding;
  if (bytes === 0 || bytes > MAX_IMAGE_BYTES) return null;

  return { data, mime, bytes };
}

/**
 * The magic numbers of the image formats worth recognising.
 *
 * A PNG-only check is what makes a copied JPEG look like "no image on the
 * clipboard"; the headers are cheap to read and the answer is only ever used to
 * label the data URL, never to decode it.
 */
function sniffMime(bytes: Buffer): string | null {
  const head = bytes.subarray(0, 12).toString("hex").toLowerCase();
  if (head.startsWith("89504e47")) return "image/png";
  if (head.startsWith("ffd8ff")) return "image/jpeg";
  if (head.startsWith("47494638")) return "image/gif";
  if (head.startsWith("424d")) return "image/bmp";
  if (head.startsWith("52494646") && head.slice(16, 24) === "57454250") return "image/webp";
  return null;
}

/** The text that came off the clipboard, or null when it is not text. */
function toText(output: Buffer): { text: string; truncated: boolean } | null {
  const text = output.toString("utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) return null;

  // Bytes that are not text at all — a screenshot read by the wrong tool, say —
  // must not be pasted into a prompt as mojibake.
  if (text.includes("\u0000") || text.includes("\uFFFD")) return null;

  // A trailing newline is how most tools end their output, not something the
  // user meant to put on the prompt line.
  const trimmed = text.replace(/[\r\n]+$/, "");
  if (trimmed.length <= MAX_TEXT_CHARS) return { text: trimmed, truncated: false };

  // Never cut a surrogate pair in half: it would paste as a replacement char.
  let end = MAX_TEXT_CHARS;
  const last = trimmed.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: trimmed.slice(0, end), truncated: true };
}

/** The `data:` URL the provider is sent. */
export function imageUrl(image: PastedImage): string {
  return `data:${image.mime};base64,${image.data}`;
}

export type PixelSpan = { text: string; style: string };

export type ImagePreviewInfo = {
  width?: number;
  height?: number;
  mime: string;
  bytes: number;
  grid?: string[];
  pixelRows?: PixelSpan[][];
};

/**
 * Decodes PNG thumbnail pixel grid using 24-bit ANSI colors.
 */
export function decodeImagePreview(image: PastedImage, targetCols = 24, targetRows = 6): ImagePreviewInfo {
  const result: ImagePreviewInfo = {
    mime: image.mime,
    bytes: image.bytes,
  };
  try {
    const buf = Buffer.from(image.data, "base64");
    if (buf.length < 8) return result;
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      let pos = 8;
      let width = 0;
      let height = 0;
      let colorType = 2;
      const idats: Buffer[] = [];
      while (pos < buf.length - 8) {
        const len = buf.readUInt32BE(pos);
        const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
        pos += 8;
        if (type === "IHDR") {
          width = buf.readUInt32BE(pos);
          height = buf.readUInt32BE(pos + 4);
          colorType = buf[pos + 9] ?? 2;
        } else if (type === "IDAT") {
          idats.push(buf.subarray(pos, pos + len));
        } else if (type === "IEND") break;
        pos += len + 4;
      }
      result.width = width;
      result.height = height;
      if (width > 0 && height > 0 && idats.length > 0) {
        const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 4;
        const raw = inflateSync(Buffer.concat(idats));
        const stride = 1 + width * bpp;
        const lines: string[] = [];
        const pixelRows: PixelSpan[][] = [];
        for (let r = 0; r < targetRows; r++) {
          const yTop = Math.floor(((r * 2) / (targetRows * 2)) * height);
          const yBot = Math.floor(((r * 2 + 1) / (targetRows * 2)) * height);
          const topOffset = yTop * stride;
          const botOffset = yBot * stride;
          let rowStr = "";
          const rowSpans: PixelSpan[] = [];
          for (let c = 0; c < targetCols; c++) {
            const x = Math.floor((c / targetCols) * width);
            const topPx = topOffset + 1 + x * bpp;
            const botPx = botOffset + 1 + x * bpp;
            let tR = 120, tG = 120, tB = 120;
            let bR = 120, bG = 120, bB = 120;
            if (topPx + 2 < raw.length) {
              tR = raw[topPx] ?? tR;
              tG = bpp >= 3 ? raw[topPx + 1] ?? tG : tR;
              tB = bpp >= 3 ? raw[topPx + 2] ?? tB : tR;
              if (bpp === 4) {
                const a = (raw[topPx + 3] ?? 0) / 255;
                tR = Math.round(tR * a + 26 * (1 - a));
                tG = Math.round(tG * a + 27 * (1 - a));
                tB = Math.round(tB * a + 38 * (1 - a));
              }
            }
            if (botPx + 2 < raw.length) {
              bR = raw[botPx] ?? bR;
              bG = bpp >= 3 ? raw[botPx + 1] ?? bG : bR;
              bB = bpp >= 3 ? raw[botPx + 2] ?? bB : bR;
              if (bpp === 4) {
                const a = (raw[botPx + 3] ?? 0) / 255;
                bR = Math.round(bR * a + 26 * (1 - a));
                bG = Math.round(bG * a + 27 * (1 - a));
                bB = Math.round(bB * a + 38 * (1 - a));
              }
            }
            const colorCode = `\u001b[38;2;${tR};${tG};${tB}m\u001b[48;2;${bR};${bG};${bB}m`;
            rowStr += `${colorCode}▀\u001b[0m`;
            rowSpans.push({ text: "▀", style: colorCode });
          }
          lines.push(rowStr);
          pixelRows.push(rowSpans);
        }
        result.grid = lines;
        result.pixelRows = pixelRows;
      }
    }
  } catch {
    // Decoding is best-effort
  }
  return result;
}

export type TextPreviewInfo = {
  text: string;
  lines: string[];
  totalLines: number;
  totalChars: number;
};

export function formatTextPreview(text: string, maxLines = 4, maxCols = 60): TextPreviewInfo {
  const allLines = text.split(/\r?\n/);
  const totalLines = allLines.length;
  const totalChars = text.length;
  const previewLines = allLines.slice(0, maxLines).map((line, idx) => {
    const num = `${idx + 1}`.padStart(2, " ");
    const trimmed = line.length > maxCols ? `${line.slice(0, maxCols - 1)}…` : line;
    return `${num} │ ${trimmed}`;
  });
  return {
    text,
    lines: previewLines,
    totalLines,
    totalChars,
  };
}

export type ClipboardHistoryItem = {
  id: string;
  kind: "text" | "image";
  text?: string;
  image?: PastedImage;
  timestamp: number;
  preview: {
    kind: "text" | "image" | "empty";
    text?: string;
    lines?: string[];
    totalLines?: number;
    totalChars?: number;
    image?: ImagePreviewInfo;
  };
};

export const MAX_CLIPBOARD_HISTORY = 5;

export function createHistoryItem(read: ClipboardRead): ClipboardHistoryItem | null {
  if (read.kind === "text") {
    const textInfo = formatTextPreview(read.text);
    return {
      id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      kind: "text",
      text: read.text,
      timestamp: Date.now(),
      preview: {
        kind: "text",
        text: textInfo.text,
        lines: textInfo.lines,
        totalLines: textInfo.totalLines,
        totalChars: textInfo.totalChars,
      },
    };
  }
  if (read.kind === "image") {
    const imgInfo = decodeImagePreview(read.image);
    return {
      id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      kind: "image",
      image: read.image,
      timestamp: Date.now(),
      preview: {
        kind: "image",
        image: imgInfo,
      },
    };
  }
  return null;
}

export function addToHistory(
  history: readonly ClipboardHistoryItem[],
  item: ClipboardHistoryItem,
): ClipboardHistoryItem[] {
  if (history.length > 0) {
    const top = history[0];
    if (top && top.kind === item.kind) {
      if (item.kind === "text" && top.text === item.text) return [...history];
      if (item.kind === "image" && top.image?.data === item.image?.data) return [...history];
    }
  }
  const filtered = history.filter((h) => {
    if (h.kind !== item.kind) return true;
    if (item.kind === "text") return h.text !== item.text;
    if (item.kind === "image") return h.image?.data !== item.image?.data;
    return true;
  });
  return [item, ...filtered].slice(0, MAX_CLIPBOARD_HISTORY);
}

export function getClipboardHistoryPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return "";
  return join(home, ".kicode", "clipboard_history.json");
}

export function loadSavedClipboardHistory(): ClipboardHistoryItem[] {
  try {
    const filePath = getClipboardHistoryPath();
    if (!filePath || !existsSync(filePath)) return [];
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, MAX_CLIPBOARD_HISTORY)
      .map((entry): ClipboardHistoryItem | null => {
        if (entry.kind === "text" && typeof entry.text === "string") {
          const textInfo = formatTextPreview(entry.text);
          return {
            id: entry.id || `clip_${Date.now()}`,
            kind: "text" as const,
            text: entry.text,
            timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
            preview: {
              kind: "text" as const,
              text: textInfo.text,
              lines: textInfo.lines,
              totalLines: textInfo.totalLines,
              totalChars: textInfo.totalChars,
            },
          };
        }
        if (entry.kind === "image" && entry.image && typeof entry.image.data === "string") {
          const imgInfo = decodeImagePreview(entry.image);
          return {
            id: entry.id || `clip_${Date.now()}`,
            kind: "image" as const,
            image: entry.image,
            timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
            preview: {
              kind: "image" as const,
              image: imgInfo,
            },
          };
        }
        return null;
      })
      .filter((item): item is ClipboardHistoryItem => item !== null);
  } catch {
    return [];
  }
}

export function saveClipboardHistory(history: readonly ClipboardHistoryItem[]): void {
  try {
    const filePath = getClipboardHistoryPath();
    if (!filePath) return;
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const toSave = history.slice(0, MAX_CLIPBOARD_HISTORY).map((item) => {
      if (item.kind === "image" && (item.image?.bytes ?? 0) > 2 * 1024 * 1024) {
        return null;
      }
      return {
        id: item.id,
        kind: item.kind,
        text: item.text,
        image: item.image,
        timestamp: item.timestamp,
      };
    }).filter(Boolean);
    writeFileSync(filePath, JSON.stringify(toSave, null, 2), "utf8");
  } catch {
    // Best-effort persistence
  }
}
