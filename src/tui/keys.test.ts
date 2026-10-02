import { describe, expect, it } from "vitest";
import { KeyDecoder, parseKeys } from "./keys";

describe("parseKeys", () => {
  it("returns plain typed text as one run", () => {
    expect(parseKeys("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("reads the arrow keys", () => {
    expect(parseKeys("\u001b[A\u001b[B\u001b[C\u001b[D").map((key) => key.type)).toEqual([
      "up",
      "down",
      "right",
      "left",
    ]);
  });

  it("reads home, end, delete and the paging keys", () => {
    expect(parseKeys("\u001b[H\u001b[F\u001b[3~\u001b[5~\u001b[6~").map((key) => key.type)).toEqual([
      "home",
      "end",
      "delete",
      "pageup",
      "pagedown",
    ]);
  });

  it("reads a click, in SGR encoding", () => {
    expect(parseKeys("\u001b[<0;14;1M")).toEqual([
      { type: "mouse", x: 14, y: 1, button: 0, release: false, wheel: null, drag: false },
    ]);

    // The lower-case final is the release half of the same click.
    expect(parseKeys("\u001b[<0;14;1m")).toEqual([
      { type: "mouse", x: 14, y: 1, button: 0, release: true, wheel: null, drag: false },
    ]);
  });

  it("marks a move with the button held as a drag, not a click", () => {
    // Bit 5 is the move bit: the same left button, still down, somewhere else.
    expect(parseKeys("\u001b[<32;20;4M")[0]).toMatchObject({ type: "mouse", x: 20, y: 4, drag: true, release: false });
    // A press is not a drag, and a wheel turn is neither.
    expect(parseKeys("\u001b[<0;20;4M")[0]).toMatchObject({ drag: false });
    // A wheel turn is not a drag either, or scrolling with the button down
    // would drag the selection out from under whoever was reading it.
    expect(parseKeys("\u001b[<64;20;4M")[0]).toMatchObject({ drag: false, wheel: "up" });
  });

  it("reads the wheel as a wheel, not as a button", () => {
    expect(parseKeys("\u001b[<64;5;3M")[0]).toMatchObject({ type: "mouse", wheel: "up", x: 5, y: 3 });
    expect(parseKeys("\u001b[<65;5;3M")[0]).toMatchObject({ type: "mouse", wheel: "down" });
    // With a modifier held the code gains a bit; the direction is still bit 0.
    expect(parseKeys("\u001b[<68;5;3M")[0]).toMatchObject({ type: "mouse", wheel: "up" });
  });

  it("tells a right-click from a left-click by its button", () => {
    expect(parseKeys("\u001b[<2;7;1M")[0]).toMatchObject({ type: "mouse", button: 2, wheel: null, rightClick: true });
  });

  it("reads hover motion without button pressed", () => {
    expect(parseKeys("\u001b[<35;12;8M")[0]).toMatchObject({
      type: "mouse",
      x: 12,
      y: 8,
      hover: true,
      drag: false,
    });
  });

  it("reads the SS3 forms some terminals send instead", () => {
    expect(parseKeys("\u001bOH\u001bOF").map((key) => key.type)).toEqual(["home", "end"]);
  });

  it("distinguishes tab from shift+tab", () => {
    expect(parseKeys("\t").map((key) => key.type)).toEqual(["tab"]);
    expect(parseKeys("\u001b[Z").map((key) => key.type)).toEqual(["backtab"]);
  });

  it("reads enter as both carriage return and newline", () => {
    expect(parseKeys("\r").map((key) => key.type)).toEqual(["enter"]);
    expect(parseKeys("\n").map((key) => key.type)).toEqual(["enter"]);
  });

  it("reads Shift+Enter from every encoding a terminal might use for it", () => {
    // modifyOtherKeys — xterm, and the mode Windows Terminal, VS Code and
    // iTerm2 implement.
    expect(parseKeys("\u001b[27;2;13~").map((key) => key.type)).toEqual(["newline"]);
    // kitty / CSI-u, with and without the event-type suffix.
    expect(parseKeys("\u001b[13;2u").map((key) => key.type)).toEqual(["newline"]);
    expect(parseKeys("\u001b[13;2:1u").map((key) => key.type)).toEqual(["newline"]);
    // `ESC` then Enter: alt+enter in most terminals, shift+enter in some.
    expect(parseKeys("\u001b\r").map((key) => key.type)).toEqual(["newline"]);
    expect(parseKeys("\u001b\n").map((key) => key.type)).toEqual(["newline"]);
  });

  it("keeps unmodified Enter a submit, so the newline stays the exception", () => {
    expect(parseKeys("\r").map((key) => key.type)).toEqual(["enter"]);
    expect(parseKeys("\u001b[13u").map((key) => key.type)).toEqual(["enter"]);
    expect(parseKeys("\u001b[13;1u").map((key) => key.type)).toEqual(["enter"]);
  });

  it("puts the other modified keys back where they were, so nothing is lost", () => {
    // A terminal switched into a reporting mode must not break ctrl and alt.
    expect(parseKeys("\u001b[27;5;97~")).toEqual([{ type: "ctrl", key: "a" }]);
    expect(parseKeys("\u001b[97;3u")).toEqual([{ type: "alt", key: "a" }]);
    expect(parseKeys("\u001b[9;2u").map((key) => key.type)).toEqual(["backtab"]);
    expect(parseKeys("\u001b[27;5;13~")).toEqual([{ type: "ctrl", key: "j" }]);
  });

  it("holds a half-arrived modifier sequence instead of leaking it as text", () => {
    const decoder = new KeyDecoder();

    expect(decoder.push("\u001b[13;2")).toEqual([]);
    expect(decoder.push("u").map((key) => key.type)).toEqual(["newline"]);
  });

  it("reads backspace and delete separately", () => {
    expect(parseKeys("\u007f").map((key) => key.type)).toEqual(["backspace"]);
    expect(parseKeys("\b").map((key) => key.type)).toEqual(["backspace"]);
  });

  it("reads control keys by letter", () => {
    expect(parseKeys("\u0003")).toEqual([{ type: "ctrl", key: "c" }]);
    expect(parseKeys("\u0004")).toEqual([{ type: "ctrl", key: "d" }]);
    expect(parseKeys("\u000c")).toEqual([{ type: "ctrl", key: "l" }]);
  });

  it("reads alt+key", () => {
    expect(parseKeys("\u001bx")).toEqual([{ type: "alt", key: "x" }]);
  });

  it("keeps newlines inside a bracketed paste", () => {
    // The whole point of bracketed paste: a pasted prompt must not submit
    // itself at the first newline.
    const keys = parseKeys("\u001b[200~line one\nline two\u001b[201~");

    expect(keys).toEqual([{ type: "paste", text: "line one\nline two" }]);
  });

  it("splits mixed input into its keys in order", () => {
    expect(parseKeys("ab\u001b[D\u0003").map((key) => key.type)).toEqual(["text", "left", "ctrl"]);
  });

  it("ignores an unparseable sequence instead of crashing", () => {
    expect(parseKeys("\u001b[99X")[0]?.type).toBe("unknown");
  });
});

describe("KeyDecoder and the mouse", () => {
  it("holds a half-received mouse report until the rest arrives", () => {
    const decoder = new KeyDecoder();

    // Reporting a click as `escape`, `[<0;14;1` and `M` would be nonsense.
    expect(decoder.push("\u001b[<0;14")).toEqual([]);
    expect(decoder.held).toBe("\u001b[<0;14");
    expect(decoder.push(";1M")).toEqual([
      { type: "mouse", x: 14, y: 1, button: 0, release: false, wheel: null, drag: false },
    ]);
  });
});

describe("KeyDecoder", () => {
  it("holds back an incomplete escape sequence", () => {
    const decoder = new KeyDecoder();

    // Exactly what a slow read looks like: ESC, then "[", then "A".
    expect(decoder.push("a\u001b")).toEqual([{ type: "text", text: "a" }]);
    expect(decoder.push("[")).toEqual([]);
    expect(decoder.held).toBe("\u001b[");
    expect(decoder.push("A")).toEqual([{ type: "up" }]);
    expect(decoder.held).toBe("");
  });

  it("does not leak a dangling bracket into the input", () => {
    const decoder = new KeyDecoder();
    const keys = [...decoder.push("\u001b["), ...decoder.push("D")];

    expect(keys).toEqual([{ type: "left" }]);
    expect(keys.some((key) => key.type === "text")).toBe(false);
  });

  it("waits for a whole paste before handing it over", () => {
    const decoder = new KeyDecoder();

    expect(decoder.push("\u001b[200~one\ntwo")).toEqual([]);
    expect(decoder.push("\u001b[201~")).toEqual([{ type: "paste", text: "one\ntwo" }]);
  });

  it("passes complete input straight through", () => {
    expect(new KeyDecoder().push("ok\r")).toEqual([{ type: "text", text: "ok" }, { type: "enter" }]);
  });

  it("treats a lone escape as escape when the read ends", () => {
    // Nothing follows, so it is a real Escape press rather than a truncated CSI.
    const decoder = new KeyDecoder();
    expect(decoder.push("\u001b")).toEqual([]);
    expect(decoder.push("x")).toEqual([{ type: "alt", key: "x" }]);
  });
});
