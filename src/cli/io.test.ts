import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createIo } from "./run";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function harness() {
  return { input: new PassThrough(), output: new PassThrough() };
}

describe("createIo line buffering", () => {
  it("delivers lines that arrive before the first readLine", async () => {
    const { input, output } = harness();
    const io = createIo(process.cwd(), { input, output });

    // Everything arrives in one chunk, as it does from `printf ... | kicode`.
    input.write("first\nsecond\nthird\n");

    expect(await io.readLine("> ")).toBe("first");
    expect(await io.readLine("> ")).toBe("second");
    expect(await io.readLine("> ")).toBe("third");
  });

  it("still returns buffered lines after the input has ended", async () => {
    const { input, output } = harness();
    const io = createIo(process.cwd(), { input, output });

    input.write("only\n");
    input.end();
    // Let readline drain and emit `close` before anything asks for a line.
    await tick();

    // This is the regression: previously these were lost and readLine hung up.
    expect(await io.readLine("> ")).toBe("only");
    expect(await io.readLine("> ")).toBeNull();
  });

  it("resolves with null at end of input rather than hanging", async () => {
    const { input, output } = harness();
    const io = createIo(process.cwd(), { input, output });
    input.end();

    expect(await io.readLine("> ")).toBeNull();
  });

  it("waits for a line that has not arrived yet", async () => {
    const { input, output } = harness();
    const io = createIo(process.cwd(), { input, output });

    const pending = io.readLine("> ");
    input.write("late\n");

    expect(await pending).toBe("late");
  });

  it("stops reporting input once closed", async () => {
    const { input, output } = harness();
    const io = createIo(process.cwd(), { input, output });
    input.write("queued\n");
    io.close();

    expect(await io.readLine("> ")).toBeNull();
  });

  it("treats an injected non-TTY stream as non-interactive", () => {
    const { input, output } = harness();

    expect(createIo(process.cwd(), { input, output }).interactive).toBe(false);
  });
});
