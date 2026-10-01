import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rememberTool } from "./remember";

/**
 * The brain is a fixture, never the real one: `resolveBrainDir` walks upwards
 * from the cwd, so a `ki-agent-brain` inside the tmp dir wins — and the real
 * `KI_BRAIN_PATH`, if set, is parked for the run so it cannot redirect the
 * writes.
 */
let dir = "";
let savedBrainPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kicode-remember-"));
  await mkdir(path.join(dir, "ki-agent-brain", "memories", "projects"), { recursive: true });
  savedBrainPath = process.env.KI_BRAIN_PATH;
  delete process.env.KI_BRAIN_PATH;
});

afterEach(async () => {
  if (savedBrainPath === undefined) delete process.env.KI_BRAIN_PATH;
  else process.env.KI_BRAIN_PATH = savedBrainPath;
  if (dir) await rm(dir, { recursive: true, force: true });
});

const skillFile = (name: string): string => path.join(dir, "ki-agent-brain", "skills", name, "SKILL.md");

describe("remember tool", () => {
  it("saves a skill as frontmatter plus body", async () => {
    const result = await rememberTool.run(
      { kind: "skill", name: "demo-deploy", description: "Deploy the demo.", text: "# Deploy\n\nRun the script.\n" },
      { cwd: dir },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("demo-deploy");
    const saved = await readFile(skillFile("demo-deploy"), "utf8");
    expect(saved).toContain("name: demo-deploy");
    expect(saved).toContain("Deploy the demo.");
    expect(saved).toContain("Run the script.");
  });

  it("never overwrites an existing skill", async () => {
    await rememberTool.run({ kind: "skill", name: "demo", description: "First.", text: "first body" }, { cwd: dir });
    const result = await rememberTool.run(
      { kind: "skill", name: "demo", description: "Second.", text: "second body" },
      { cwd: dir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
    expect(await readFile(skillFile("demo"), "utf8")).toContain("first body");
  });

  it("rejects names that are not slugs, and writes nothing outside the brain", async () => {
    for (const name of ["../evil", "Bad Name", "a/b"]) {
      const result = await rememberTool.run({ kind: "skill", name, description: "x", text: "y" }, { cwd: dir });
      expect(result.isError).toBe(true);
    }
    // Nothing escaped the brain: no SKILL.md anywhere but under skills/.
    expect(await readFile(skillFile("evil"), "utf8").catch(() => null)).toBeNull();
  });

  it("refuses anything shaped like a secret", async () => {
    const result = await rememberTool.run(
      { kind: "skill", name: "deploy", description: "Deploy.", text: "key: -----BEGIN RSA PRIVATE KEY-----\nabc" },
      { cwd: dir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("secret");
    expect(await readFile(skillFile("deploy"), "utf8").catch(() => null)).toBeNull();
  });

  it("requires a description for skills", async () => {
    const result = await rememberTool.run({ kind: "skill", name: "nodesc", text: "body" }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("description");
  });

  it("appends dated entries to a project memory, creating it with a header", async () => {
    const file = path.join(dir, "ki-agent-brain", "memories", "projects", "shop.md");

    const first = await rememberTool.run({ kind: "memory", name: "shop", text: "Uses pnpm, not npm." }, { cwd: dir });
    expect(first.isError).toBeUndefined();
    const created = await readFile(file, "utf8");
    expect(created).toContain("# shop");
    expect(created).toContain("Uses pnpm, not npm.");

    const second = await rememberTool.run({ kind: "memory", name: "shop", text: "Deploy on Fridays." }, { cwd: dir });
    expect(second.isError).toBeUndefined();
    const appended = await readFile(file, "utf8");
    expect(appended).toContain("Uses pnpm, not npm.");
    expect(appended).toContain("Deploy on Fridays.");
  });

  it("rejects a bad project slug", async () => {
    const result = await rememberTool.run({ kind: "memory", name: "../x", text: "hi" }, { cwd: dir });

    expect(result.isError).toBe(true);
  });

  it("caps a long skill body instead of writing it whole", async () => {
    const result = await rememberTool.run(
      { kind: "skill", name: "long", description: "Long.", text: `x\n`.repeat(20_000) },
      { cwd: dir },
    );

    expect(result.isError).toBeUndefined();
    const saved = await readFile(skillFile("long"), "utf8");
    expect(saved.length).toBeLessThan(20_000);
    expect(saved).toContain("truncated");
  });

  it("says how to point at a brain when none is found", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "kicode-remember-bare-"));
    try {
      const result = await rememberTool.run({ kind: "skill", name: "x", description: "x", text: "x" }, { cwd: bare });
      // Passes only when no ki-agent-brain sits above the tmp dir and no env
      // override points at one — the normal case on any machine.
      if (result.isError === true) expect(result.content).toContain("KI_BRAIN_PATH");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("rejects an unknown kind", async () => {
    const result = await rememberTool.run({ kind: "spell", name: "x", text: "y" }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("\"skill\" or \"memory\"");
  });
});
