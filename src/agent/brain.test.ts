import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainBriefing, projectSlug, readBrain, recallFromBrain } from "./brain";
import { createDefaultTools } from "./tools";

/**
 * A brain on disk, and a project inside it.
 *
 * Laid out exactly as `remember` writes it — `skills/<name>/SKILL.md` and
 * `memories/projects/<slug>.md` — so the reader is tested against the writer's
 * real shape rather than a convenient one. The project directory sits under the
 * brain's parent, so the upward walk finds it the way a checkout would.
 */
describe("the brain", () => {
  let root = "";
  let home = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kicode-brain-"));
    // An empty KICODE_HOME for every read, so the default ~/.kicode/brain and
    // the machine's real global kicode.json can never answer for the fixture.
    home = path.join(root, "home");
    await mkdir(home, { recursive: true });
    const brain = path.join(root, "ki-agent-brain");
    await mkdir(path.join(brain, "skills", "release-check"), { recursive: true });
    await writeFile(
      path.join(brain, "skills", "release-check", "SKILL.md"),
      '---\nname: release-check\ndescription: "How to cut a release safely"\n---\n\n1. Run the tests.\n2. Tag and push.\n',
    );
    await mkdir(path.join(brain, "memories", "projects"), { recursive: true });
    await writeFile(
      path.join(brain, "memories", "projects", "my-app.md"),
      "# my-app — Session Notes\n\n> Captured by KiCode while working.\n\n## 2026-10-01\n- Build with pnpm, never npm.\n",
    );
    await mkdir(path.join(root, "my-app"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cwd = (): string => path.join(root, "my-app");
  const env = (): NodeJS.ProcessEnv => ({ KICODE_HOME: home });

  it("names a directory's project memory by its own name, slugged", () => {
    expect(projectSlug(cwd())).toBe("my-app");
    expect(projectSlug(path.join(root, "My App v2"))).toBe("my-app-v2");
  });

  it("reads the skills and project memories the writer made", () => {
    const brain = readBrain(cwd(), env());
    expect(brain?.skills.map((skill) => skill.name)).toEqual(["release-check"]);
    expect(brain?.skills[0]?.description).toBe("How to cut a release safely");
    expect(brain?.projects.map((project) => project.slug)).toEqual(["my-app"]);
  });

  it("finds skills nested under a category folder, the way a kept brain files them", async () => {
    // `remember` writes one level, but a maintained brain groups them — and a
    // reader that only looked one level down would miss the library.
    const nested = path.join(root, "ki-agent-brain", "skills", "android", "adb-automation");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "SKILL.md"), '---\nname: adb-automation\ndescription: "Drive a device over adb"\n---\nbody\n');

    const brain = readBrain(cwd(), env());
    expect(brain?.skills.map((skill) => skill.name)).toEqual(["adb-automation", "release-check"]);
  });

  it("briefs the model with this project's memory and the skills it has", () => {
    const briefing = brainBriefing(cwd(), env());
    expect(briefing).toContain("# Your brain");
    // The project's own memory, by text — this is the part worth not having to
    // ask for.
    expect(briefing).toContain("Build with pnpm, never npm.");
    // Skills by name and description only: a body is a page, and every body in
    // every request is how a brain becomes a cost.
    expect(briefing).toContain("- release-check — How to cut a release safely");
    expect(briefing).not.toContain("1. Run the tests.");
  });

  it("lists other projects when this directory has no memory yet", () => {
    const elsewhere = path.join(root, "another-app");
    const briefing = brainBriefing(elsewhere, env());
    expect(briefing).toContain("No memory saved for this directory yet");
    expect(briefing).toContain("my-app");
  });

  it("has nothing to say when there is no brain", () => {
    const empty = path.join(tmpdir(), "kicode-no-brain-at-all");
    expect(readBrain(empty, env())).toBeNull();
    expect(brainBriefing(empty, env())).toBeNull();
  });

  it("loads a skill by name and a project memory by name", () => {
    const skill = recallFromBrain(cwd(), { name: "release-check" }, env());
    expect(skill.isError).toBe(false);
    expect(skill.content).toContain("How to cut a release safely");
    expect(skill.content).toContain("1. Run the tests.");

    const project = recallFromBrain(cwd(), { name: "my-app" }, env());
    expect(project.content).toContain("Build with pnpm, never npm.");
  });

  it("says what does exist when the name is wrong, rather than guessing", () => {
    const miss = recallFromBrain(cwd(), { name: "nope" }, env());
    expect(miss.isError).toBe(true);
    expect(miss.content).toContain("nope");
    expect(miss.content).toContain("release-check");
    expect(miss.content).toContain("my-app");
  });

  it("finds a skill from the words in its description", () => {
    const hit = recallFromBrain(cwd(), { query: "release" }, env());
    expect(hit.content).toContain("release-check");
  });

  it("answers for the current project when asked for nothing in particular", () => {
    const hit = recallFromBrain(cwd(), {}, env());
    expect(hit.content).toContain("Build with pnpm, never npm.");
  });
});

describe("the brain's tools", () => {
  it("ships both halves — one to save, one to read back", () => {
    const tools = createDefaultTools().list();
    const remember = tools.find((tool) => tool.name === "remember");
    const recall = tools.find((tool) => tool.name === "recall");

    expect(remember).toBeDefined();
    expect(recall).toBeDefined();
    // Saving is intentionally ungated (a prompt per save trains people to stop
    // saving) and reading certainly is: neither may need approval.
    expect(remember?.requiresApproval).toBeUndefined();
    expect(recall?.requiresApproval).toBeUndefined();
  });
});
