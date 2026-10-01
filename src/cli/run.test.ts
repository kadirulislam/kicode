import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSessions } from "../sessions/store";
import { runCli, type Io } from "./run";

/**
 * Drives the real `runCli` against a local mock endpoint with a fake terminal.
 * This is the seam the other tests do not reach: flag parsing, the approval
 * prompt, rendering, and the write actually landing on disk.
 */

const CONTENT = "written by the test\n";

let server: Server;
let dir = "";
let home = "";
/** Every set of messages the mock endpoint received, in order. */
const bodies: { role: string; content?: unknown }[][] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const messages: { role: string; content?: unknown }[] = (() => {
        try {
          return JSON.parse(body).messages ?? [];
        } catch {
          return [];
        }
      })();
      bodies.push(messages);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta: unknown, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

      const last = messages.at(-1);
      if (last?.role === "user" && String(last.content).includes("ask me")) {
        // A turn that puts a question to the user instead of calling a tool.
        frame({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_ask",
              type: "function",
              function: {
                name: "ask",
                arguments: JSON.stringify({
                  questions: [
                    {
                      header: "Typography",
                      question: "Which way?",
                      options: [
                        { label: "Sans", description: "Clean throughout." },
                        { label: "Mono" },
                      ],
                    },
                  ],
                }),
              },
            },
          ],
        });
        frame({}, "tool_calls");
      } else if (messages.some((message) => message.role === "tool")) {
        frame({ role: "assistant", content: "all done" }, "stop");
      } else {
        frame({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "write", arguments: JSON.stringify({ path: "out.txt", content: CONTENT }) },
            },
          ],
        });
        frame({}, "tool_calls");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  dir = await mkdtemp(path.join(tmpdir(), "kicode-cli-"));
  home = await mkdtemp(path.join(tmpdir(), "kicode-cli-home-"));

  process.env.KICODE_API_KEY = "test";
  process.env.KICODE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  // Keep sessions out of the real home directory.
  process.env.KICODE_HOME = home;
});

afterAll(async () => {
  delete process.env.KICODE_API_KEY;
  delete process.env.KICODE_BASE_URL;
  delete process.env.KICODE_HOME;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir) await rm(dir, { recursive: true, force: true });
  if (home) await rm(home, { recursive: true, force: true });
});

function fakeIo(answers: string[]): { io: Io; output: string[] } {
  const output: string[] = [];
  return {
    output,
    io: {
      cwd: dir,
      interactive: true,
      write: (text) => output.push(text),
      writeLine: (line = "") => output.push(`${line}\n`),
      writeError: (line) => output.push(`ERR ${line}\n`),
      // A real terminal echoes the prompt; keep that visible so the test can
      // prove the user was actually asked.
      readLine: async (prompt) => {
        output.push(prompt);
        return answers.length > 0 ? (answers.shift() ?? null) : null;
      },
      close: () => {},
    },
  };
}

describe("runCli approval flow", () => {
  it("shows the diff, asks, and writes on yes", async () => {
    const { io, output } = fakeIo(["y"]);

    expect(await runCli(["write it"], io)).toBe(0);

    const text = output.join("");
    expect(text).toContain("Allow?");
    expect(text).toContain("+written by the test");
    expect(await readFile(path.join(dir, "out.txt"), "utf8")).toBe(CONTENT);
  });

  it("does not write when the answer is no", async () => {
    const target = path.join(dir, "out.txt");
    await rm(target, { force: true });

    const { io, output } = fakeIo(["n"]);
    expect(await runCli(["write it"], io)).toBe(0);

    expect(output.join("")).toContain("denied");
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("rejects files changes in one-shot mode without --yes", async () => {
    const { io } = fakeIo([]);
    const nonInteractive: Io = { ...io, interactive: false };

    await runCli(["write it"], nonInteractive);

    await expect(readFile(path.join(dir, "out.txt"), "utf8")).rejects.toThrow();
  });
});

describe("the question channel without the full-screen UI", () => {
  it("asks by number and passes the choice back to the model", async () => {
    bodies.length = 0;
    // The prompt, the answer to the question, and the exit.
    const { io, output } = fakeIo(["ask me", "2", "/exit"]);

    expect(await runCli(["--no-tui"], io)).toBe(0);

    const text = output.join("");
    expect(text).toContain("? Typography: Which way?");
    expect(text).toContain("1. Sans — Clean throughout.");
    // The free-text row is offered even here, so `--no-tui` is a real fallback.
    expect(text).toContain("3. Type your own answer");
    expect(JSON.stringify(bodies.at(-1))).toContain("Typography: Mono");
  });

  it("takes anything that is not a number as the answer itself", async () => {
    bodies.length = 0;
    const { io } = fakeIo(["ask me", "something else entirely", "/exit"]);

    expect(await runCli(["--no-tui"], io)).toBe(0);

    expect(JSON.stringify(bodies.at(-1))).toContain("Typography: something else entirely");
  });
});

describe("slash commands without the full-screen UI", () => {
  it("explains itself rather than sending the command to the model", async () => {
    bodies.length = 0;
    const { io, output } = fakeIo(["/models", "/q"]);

    expect(await runCli(["--no-tui"], io)).toBe(0);

    const text = output.join("");
    expect(text).toContain("/models needs the full-screen UI");
    // The whole point: it never became a prompt.
    expect(JSON.stringify(bodies)).not.toContain("/models");
  });

  it("still sends a slash that is not a command name", async () => {
    bodies.length = 0;
    const { io } = fakeIo(["/not-a-command", "/exit"]);

    expect(await runCli(["--no-tui"], io)).toBe(0);

    expect(JSON.stringify(bodies)).toContain("/not-a-command");
  });

  it("quits on the documented aliases, not just /exit", async () => {
    const { io, output } = fakeIo(["/q"]);

    expect(await runCli(["--no-tui"], io)).toBe(0);

    expect(output.join("")).not.toContain("needs the full-screen UI");
  });
});

describe("project instructions", () => {
  it("reads AGENTS.md into the system prompt", async () => {
    bodies.length = 0;
    const file = path.join(dir, "AGENTS.md");
    await writeFile(file, "# AGENTS.md\n\nUse tabs, not spaces.\n", "utf8");

    try {
      const { io } = fakeIo([]);
      expect(await runCli(["--yes", "write it"], io)).toBe(0);

      // The first message is the system prompt, and the project's notes are in
      // it — which is the whole reason /init offers to write the file.
      expect(String(bodies[0]?.[0]?.content)).toContain("Use tabs, not spaces.");
      expect(String(bodies[0]?.[0]?.content)).toContain("KiCode");
    } finally {
      await rm(file, { force: true });
    }
  });

  it("works without one", async () => {
    bodies.length = 0;
    const { io } = fakeIo([]);
    expect(await runCli(["--yes", "write it"], io)).toBe(0);

    expect(String(bodies[0]?.[0]?.content)).not.toContain("AGENTS.md");
  });
});

describe("session persistence", () => {
  it("saves an interactive transcript", async () => {
    // Four readLine calls: the prompt, the approval answer, and the exit.
    const { io } = fakeIo(["write it", "y", "/exit"]);

    expect(await runCli([], io)).toBe(0);

    const [saved] = await listSessions();
    expect(saved).toBeDefined();
    expect(saved?.cwd).toBe(dir);
    expect(JSON.stringify(saved?.messages)).toContain("write it");
  });

  it("does not record scripted one-shot runs", async () => {
    const before = (await listSessions()).length;

    const { io } = fakeIo([]);
    await runCli(["--yes", "write it"], io);

    expect((await listSessions()).length).toBe(before);
  });

  it("replays the stored transcript after --continue", async () => {
    bodies.length = 0;
    const { io } = fakeIo([]);

    expect(await runCli(["--continue", "carry on"], io)).toBe(0);

    // The provider got the earlier conversation back, not a blank slate.
    expect(JSON.stringify(bodies[0])).toContain("write it");
    expect(JSON.stringify(bodies[0])).toContain("carry on");
  });

  it("announces the resumed session in the banner", async () => {
    const { io, output } = fakeIo(["/exit"]);

    expect(await runCli(["--continue"], io)).toBe(0);

    expect(output.join("")).toContain("Resumed session");
  });

  it("does not record a session nobody asked anything in", async () => {
    // Otherwise quitting straight after startup leaves an empty record, and the
    // next `--continue` silently resumes that instead of the real conversation.
    const before = (await listSessions()).length;

    const { io } = fakeIo(["/exit"]);
    expect(await runCli([], io)).toBe(0);

    expect((await listSessions()).length).toBe(before);
  });

  it("fails loudly for an unknown session id", async () => {
    const { io, output } = fakeIo([]);

    expect(await runCli(["--session", "does-not-exist"], io)).toBe(1);
    expect(output.join("")).toContain("No session found");
  });
});

/**
 * The config file is the whole point of "persist this per project": these drive
 * the real CLI with a `kicode.json` on disk and check which settings win.
 */
describe("project kicode.json", () => {
  const mockUrl = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const configPath = (): string => path.join(dir, "kicode.json");

  async function withConfig(json: unknown, body: () => Promise<void>): Promise<void> {
    await writeFile(configPath(), JSON.stringify(json), "utf8");
    try {
      await body();
    } finally {
      await rm(configPath(), { force: true });
    }
  }

  it("takes model and endpoint from the file, beating the environment", async () => {
    const previousUrl = process.env.KICODE_BASE_URL;
    // An ambient endpoint that would fail if it were used. The file must win,
    // so a successful run is itself the evidence.
    process.env.KICODE_BASE_URL = "http://127.0.0.1:9/v1";

    try {
      await withConfig({ model: "file-model", baseUrl: mockUrl() }, async () => {
        const { io, output } = fakeIo(["/exit"]);

        expect(await runCli([], io)).toBe(0);

        const text = output.join("");
        expect(text).toContain("file-model");
        expect(text).toContain(mockUrl());
        expect(text).toContain("Config:");
      });
    } finally {
      process.env.KICODE_BASE_URL = previousUrl;
    }
  });

  it("'mock': true needs no environment variables at all", async () => {
    // The shorthand hardcodes the mock's default port, so this asserts the
    // routing decision rather than a reachable endpoint.
    await withConfig({ mock: true, model: "mock-model" }, async () => {
      const { io, output } = fakeIo(["/exit"]);
      await runCli([], io);

      expect(output.join("")).toContain("mock-model @ http://localhost:8787/v1");
    });
  });

  it("refuses a key in the file and says why", async () => {
    await withConfig({ model: "file-model", baseUrl: mockUrl(), apiKey: "sk-should-not-be-used" }, async () => {
      const { io, output } = fakeIo(["/exit"]);
      await runCli([], io);

      // Warned about, not fatal — and the run still works.
      expect(output.join("")).toContain("Ignoring the API key");
      expect(output.join("")).toContain("file-model");
    });
  });

  it("--init writes a usable file even with no API key set", async () => {
    const previousKey = process.env.KICODE_API_KEY;
    delete process.env.KICODE_API_KEY;

    try {
      const { io, output } = fakeIo([]);

      expect(await runCli(["--init", "--model", "flag-model", "--base-url", mockUrl()], io)).toBe(0);

      expect(output.join("")).toContain("Wrote");
      expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ model: "flag-model", baseUrl: mockUrl() });
    } finally {
      process.env.KICODE_API_KEY = previousKey;
      await rm(configPath(), { force: true });
    }
  });

  it("--init is idempotent on a file that already matches", async () => {
    await withConfig({ model: "file-model", baseUrl: mockUrl() }, async () => {
      const { io, output } = fakeIo([]);

      expect(await runCli(["--init"], io)).toBe(0);

      expect(output.join("")).toContain("already records");
      expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ model: "file-model", baseUrl: mockUrl() });
    });
  });

  it("--init refuses a file it cannot read rather than discarding it", async () => {
    await writeFile(configPath(), "{ not json", "utf8");
    try {
      const { io, output } = fakeIo([]);

      expect(await runCli(["--init"], io)).toBe(1);
      expect(output.join("")).toContain("Refusing to touch");
      expect(await readFile(configPath(), "utf8")).toBe("{ not json");
    } finally {
      await rm(configPath(), { force: true });
    }
  });

  it("reports a malformed file instead of dying", async () => {
    await writeFile(configPath(), "{ not json", "utf8");
    try {
      const { io, output } = fakeIo(["/exit"]);

      expect(await runCli([], io)).toBe(0);
      expect(output.join("")).toContain("not valid JSON");
      // Falls back to the environment endpoint, which is the mock here.
      expect(output.join("")).toContain(mockUrl());
    } finally {
      await rm(configPath(), { force: true });
    }
  });
});
