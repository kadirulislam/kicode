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
let home = "";
let savedBrainPath: string | undefined;
let savedHome: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kicode-remember-"));
  home = await mkdtemp(path.join(tmpdir(), "kicode-remember-home-"));
  await mkdir(path.join(dir, "ki-agent-brain", "memories", "projects"), { recursive: true });
  savedBrainPath = process.env.KI_BRAIN_PATH;
  delete process.env.KI_BRAIN_PATH;
  // Park KICODE_HOME too, so the default brain a fresh user would get lands in
  // the fixture rather than the machine's real ~/.kicode.
  savedHome = process.env.KICODE_HOME;
  process.env.KICODE_HOME = home;
});

afterEach(async () => {
  if (savedBrainPath === undefined) delete process.env.KI_BRAIN_PATH;
  else process.env.KI_BRAIN_PATH = savedBrainPath;
  if (savedHome === undefined) delete process.env.KICODE_HOME;
  else process.env.KICODE_HOME = savedHome;
  if (dir) await rm(dir, { recursive: true, force: true });
  if (home) await rm(home, { recursive: true, force: true });
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

  it("corrects a skill only when the update is explicit", async () => {
    await rememberTool.run({ kind: "skill", name: "demo", description: "First.", text: "first body" }, { cwd: dir });

    // A plain save still refuses: overwriting has to be asked for, so a skill
    // is never replaced by a second model call that meant to add one.
    const refused = await rememberTool.run(
      { kind: "skill", name: "demo", description: "Second.", text: "second body" },
      { cwd: dir },
    );
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('action: "update"');

    const updated = await rememberTool.run(
      { kind: "skill", name: "demo", description: "Second.", text: "second body", action: "update" },
      { cwd: dir },
    );
    expect(updated.isError).toBeUndefined();
    expect(updated.content).toContain("Updated");
    const saved = await readFile(skillFile("demo"), "utf8");
    expect(saved).toContain("second body");
    expect(saved).not.toContain("first body");

    // And updating something that is not there says so rather than creating it.
    const missing = await rememberTool.run(
      { kind: "skill", name: "ghost", description: "x", text: "y", action: "update" },
      { cwd: dir },
    );
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("no skill");
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

  it("creates a default brain on the first save when none exists", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "kicode-remember-bare-"));
    try {
      const result = await rememberTool.run(
        { kind: "skill", name: "fresh-start", description: "The very first save.", text: "body" },
        { cwd: bare },
      );

      // No ki-agent-brain above the tmp dir and no override: the save creates
      // one under KICODE_HOME instead of failing — the fresh-user case.
      expect(result.isError).toBeUndefined();
      const created = path.join(home, "brain", "skills", "fresh-start", "SKILL.md");
      expect(await readFile(created, "utf8")).toContain("name: fresh-start");
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
