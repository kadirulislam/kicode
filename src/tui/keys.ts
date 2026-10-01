/**
 * Raw terminal input, decoded.
 *
 * In raw mode every key arrives as bytes, and the interesting ones are escape
 * sequences that can be split across reads — so this returns a list of keys per
 * chunk and the caller feeds it as much as arrives.
 */

export type Key =
  | { type: "text"; text: string }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "backtab" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "escape" }
  | { type: "paste"; text: string }
  | { type: "ctrl"; key: string }
  | { type: "alt"; key: string }
  | MouseKey
  | { type: "unknown"; raw: string };

/**
 * A click or a wheel turn, in SGR encoding.
 *
 * Columns and rows are 1-based, the way the terminal reports them. `button` is
 * the raw code, because modifiers are packed into it (a ctrl-click or shift-
 * click arrives as a different number) and the caller only cares about a few.
 */
export type MouseKey = {
  type: "mouse";
  x: number;
  y: number;
  button: number;
  /** True for the release half of a click. */
  release: boolean;
  /** Set for a wheel turn, which is not a click at all. */
  wheel: "up" | "down" | null;
  /**
   * A move *with a button held* — the sixth bit of the button code.
   *
   * Only terminals in button-event tracking (`1002`) send these, which is why
   * KiCode asks for that mode as well as plain presses: without it there is no
   * way to know a drag is happening, and a selection cannot be dragged out.
   */
  drag: boolean;
  /**
   * A move with NO button held — pointer hover (button code 35 in SGR 1006 mode).
   */
  hover?: boolean;
  /**
   * Right mouse button press or release.
   */
  rightClick?: boolean;
};

const CSI_KEYS: Record<string, Key["type"]> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "backtab",
};

const TILDE_KEYS: Record<string, Key["type"]> = {
  "1": "home",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

export function parseKeys(input: string): Key[] {
  if (!input) return [];

  const keys: Key[] = [];
  let index = 0;
  let text = "";

  const flush = (): void => {
    if (text) keys.push({ type: "text", text });
    text = "";
  };

  while (index < input.length) {
    const char = input[index] ?? "";

    // A paste arrives bracketed, so it can contain newlines and escapes that
    // must not be interpreted as keys.
    if (char === "\u001b") {
      const paste = /^\u001b\[200~([\s\S]*?)\u001b\[201~/.exec(input.slice(index));
      if (paste) {
        flush();
        keys.push({ type: "paste", text: paste[1] ?? "" });
        index += paste[0].length;
        continue;
      }

      // SGR mouse: `ESC [ < button ; column ; row M` (or `m` on release). It
      // has to be matched before the plain CSI branch, which cannot read `;`
      // followed by more digits.
      const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(input.slice(index));
      if (mouse) {
        flush();
        const button = Number(mouse[1] ?? 0);
        const isMotion = (button & 32) === 32;
        const isHover = isMotion && (button & 3) === 3;
        const isDrag = isMotion && (button & 3) !== 3;
        const isRight = (button & 3) === 2;

        keys.push({
          type: "mouse",
          x: Number(mouse[2] ?? 0),
          y: Number(mouse[3] ?? 0),
          button,
          release: mouse[4] === "m",
          // Bit 6 is set for the wheel, and bit 0 is the direction.
          wheel: (button & 64) === 64 ? ((button & 1) === 1 ? "down" : "up") : null,
          drag: isDrag,
          ...(isHover ? { hover: true } : {}),
          ...(isRight ? { rightClick: true } : {}),
        });
        index += mouse[0].length;
        continue;
      }

      const csi = /^\u001b\[([0-9;]*)([A-Za-z~])/.exec(input.slice(index));
      if (csi) {
        flush();
        const [, params = "", final = ""] = csi;
        const name = final === "~" ? TILDE_KEYS[params.split(";")[0] ?? ""] : CSI_KEYS[final];
        keys.push(name ? toKey(name) : { type: "unknown", raw: csi[0] });
        index += csi[0].length;
        continue;
      }

      const ss3 = /^\u001bO([A-Za-z])/.exec(input.slice(index));
      if (ss3) {
        flush();
        const name = CSI_KEYS[ss3[1] ?? ""];
        keys.push(name ? toKey(name) : { type: "unknown", raw: ss3[0] });
        index += ss3[0].length;
        continue;
      }

      const next = input[index + 1];
      if (next === undefined) {
        flush();
        keys.push({ type: "escape" });
        index += 1;
        continue;
      }
      flush();
      keys.push({ type: "alt", key: next });
      index += 2;
      continue;
    }

    const code = char.charCodeAt(0);
    if (char === "\r" || char === "\n") {
      flush();
      keys.push({ type: "enter" });
      index += 1;
      continue;
    }
    if (char === "\t") {
      flush();
      keys.push({ type: "tab" });
      index += 1;
      continue;
    }
    if (char === "\u007f" || char === "\b") {
      flush();
      keys.push({ type: "backspace" });
      index += 1;
      continue;
    }
    if (code < 0x20) {
      flush();
      keys.push({ type: "ctrl", key: String.fromCharCode(code + 96) });
      index += 1;
      continue;
    }

    text += char;
    index += 1;
  }

  flush();
  return keys;
}

function toKey(type: Key["type"]): Key {
  return { type } as Key;
}

/**
 * A key parser that tolerates a sequence arriving in two reads.
 *
 * Raw terminals have no message boundaries: an arrow key is three bytes and
 * nothing stops the operating system delivering `ESC` alone. Decoding that as
 * "escape, then `[`, then `A`" would turn every arrow press into a stray
 * bracket in the prompt, so an incomplete trailing sequence is held back until
 * the rest of it arrives.
 */
export class KeyDecoder {
  private pending = "";

  push(chunk: string): Key[] {
    const buffer = this.pending + chunk;
    const held = incompleteStart(buffer);

    if (held === -1) {
      this.pending = "";
      return parseKeys(buffer);
    }

    this.pending = buffer.slice(held);
    return parseKeys(buffer.slice(0, held));
  }

  /** Whatever is still incomplete, so it can be reported or flushed. */
  get held(): string {
    return this.pending;
  }

  /**
   * Gives up waiting and parses what is held.
   *
   * A bare `ESC` is genuinely ambiguous — a real Escape press and the first
   * byte of an arrow key are the same thing on the wire. The caller waits a
   * few milliseconds for the rest, then calls this, which is what makes Escape
   * work at all.
   */
  flush(): Key[] {
    const held = this.pending;
    this.pending = "";
    return parseKeys(held);
  }
}

/**
 * Where a partial escape sequence begins, or -1 when the buffer is complete.
 */
function incompleteStart(buffer: string): number {
  const start = buffer.lastIndexOf("\u001b");
  if (start === -1) return -1;
  return completeEscape(buffer.slice(start)) ? -1 : start;
}

function completeEscape(tail: string): boolean {
  if (tail === "\u001b") return false;
  if (/^\u001b\[[0-9;]*$/.test(tail)) return false;
  if (/^\u001b\[<[0-9;]*$/.test(tail)) return false;
  if (/^\u001bO$/.test(tail)) return false;
  // Bracketed paste is the one sequence with no length limit; until its
  // terminator arrives, the whole rest of the stream is paste content.
  if (tail.startsWith("\u001b[200~")) return tail.includes("\u001b[201~");
  return true;
}
