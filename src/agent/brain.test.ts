import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainBriefing, brainSections, projectSlug, readBrain, recallFromBrain, trashSkill } from "./brain";
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
    const brain = readBrain(cwd(), env(), home);
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

    const brain = readBrain(cwd(), env(), home);
    expect(brain?.skills.map((skill) => skill.name)).toEqual(["adb-automation", "release-check"]);
  });

  it("retires a skill into the trash, and the scan stops seeing it", async () => {
    const brain = readBrain(cwd(), env(), home);
    const skill = brain?.skills.find((entry) => entry.name === "release-check");

    const moved = await trashSkill(brain?.dir ?? "", skill!.file);

    // Moved, not removed: the body is where the return value says it is.
    expect(moved.startsWith(path.join(brain?.dir ?? "", ".trash"))).toBe(true);
    expect(await readFile(path.join(moved, "SKILL.md"), "utf8")).toContain("release-check");

    // And out of the index, which is what `@skill:` and `/skills` read. The
    // trash sits outside `skills/`, so the walk never sees it again.
    expect(readBrain(cwd(), env(), home)?.skills.map((entry) => entry.name)).toEqual([]);
  });

  it("retires a nested skill by its own folder, leaving the category alone", async () => {
    // The index hands back a file path. A delete that rebuilt the path from the
    // name would move the whole category instead of the one skill.
    const nested = path.join(root, "ki-agent-brain", "skills", "android", "adb-automation");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "SKILL.md"), '---\nname: adb-automation\ndescription: "Drive a device over adb"\n---\nbody\n');

    const brain = readBrain(cwd(), env(), home);
    const skill = brain?.skills.find((entry) => entry.name === "adb-automation");
    const moved = await trashSkill(brain?.dir ?? "", skill!.file);

    expect(path.basename(moved)).toContain("adb-automation");
    await expect(readFile(path.join(nested, "SKILL.md"), "utf8")).rejects.toThrow();
    expect(readBrain(cwd(), env(), home)?.skills.map((entry) => entry.name)).toEqual(["release-check"]);
  });

  it("briefs the model with this project's memory and the skills it has", () => {
    const briefing = brainBriefing(cwd(), env(), home);
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
    const briefing = brainBriefing(elsewhere, env(), home);
    expect(briefing).toContain("No memory saved for this directory yet");
    expect(briefing).toContain("my-app");
  });

  it("splits the briefing into the memory and skill halves `/context` costs out", () => {
    const sections = brainSections(cwd(), env(), home);

    expect(sections?.memory?.text).toContain("Build with pnpm, never npm.");
    expect(sections?.memory?.files).toBe(1);
    expect(sections?.skills?.text).toContain("- release-check — How to cut a release safely");
    expect(sections?.skills?.loaded).toBe(1);
    expect(sections?.skills?.total).toBe(1);
    // The halves rejoin into the briefing, nothing added and nothing lost.
    const briefing = brainBriefing(cwd(), env(), home);
    expect(briefing).toContain(sections?.memory?.text ?? "missing");
    expect(briefing).toContain(sections?.skills?.text ?? "missing");
  });

  it("has nothing to say when there is no brain", () => {
    const empty = path.join(tmpdir(), "kicode-no-brain-at-all");
    // The machine's real home is never read: a `~/.agents/skills/` there must
    // not answer for a fixture that has nothing of its own.
    expect(readBrain(empty, env(), home)).toBeNull();
    expect(brainBriefing(empty, env(), home)).toBeNull();
  });

  it("loads a skill by name and a project memory by name", () => {
    const skill = recallFromBrain(cwd(), { name: "release-check" }, env(), home);
    expect(skill.isError).toBe(false);
    expect(skill.content).toContain("How to cut a release safely");
    expect(skill.content).toContain("1. Run the tests.");

    const project = recallFromBrain(cwd(), { name: "my-app" }, env(), home);
    expect(project.content).toContain("Build with pnpm, never npm.");
  });

  it("says what does exist when the name is wrong, rather than guessing", () => {
    const miss = recallFromBrain(cwd(), { name: "nope" }, env(), home);
    expect(miss.isError).toBe(true);
    expect(miss.content).toContain("nope");
    expect(miss.content).toContain("release-check");
    expect(miss.content).toContain("my-app");
  });

  it("finds a skill from the words in its description", () => {
    const hit = recallFromBrain(cwd(), { query: "release" }, env(), home);
    expect(hit.content).toContain("release-check");
  });

  it("answers for the current project when asked for nothing in particular", () => {
    const hit = recallFromBrain(cwd(), {}, env(), home);
    expect(hit.content).toContain("Build with pnpm, never npm.");
  });
});

describe("installed skills", () => {
  let root = "";
  let home = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kicode-installed-"));
    // The user-level root lives under this home, never the machine's own —
    // the suite must pass with or without a real `~/.agents/skills/`.
    home = path.join(root, "home");
    await mkdir(home, { recursive: true });
    await mkdir(path.join(root, "my-app"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cwd = (): string => path.join(root, "my-app");
  const env = (): NodeJS.ProcessEnv => ({ KICODE_HOME: home });
  const skillFile = (dir: string, name: string, description: string): Promise<void> =>
    mkdir(path.join(dir, name), { recursive: true }).then(() =>
      writeFile(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${description}"\n---\n\nbody\n`),
    );

  it("reads the .agents/skills convention beside the brain, tagged installed", async () => {
    await skillFile(path.join(cwd(), ".agents", "skills"), "code-review", "Review a diff.");
    await skillFile(path.join(home, ".agents", "skills"), "standup-notes", "Write the standup.");

    const brain = readBrain(cwd(), env(), home);
    expect(brain?.dir).toBeNull();
    expect(brain?.skills.map((skill) => `${skill.name}:${skill.source}`)).toEqual([
      "code-review:installed",
      "standup-notes:installed",
    ]);
  });

  it("lets a learned skill shadow an installed one of the same name", async () => {
    const brainDir = path.join(root, "ki-agent-brain");
    await skillFile(path.join(brainDir, "skills"), "code-review", "Our own review checklist.");
    await skillFile(path.join(cwd(), ".agents", "skills"), "code-review", "A generic review.");

    const brain = readBrain(cwd(), env(), home);
    expect(brain?.skills.map((skill) => `${skill.name}:${skill.source}`)).toEqual(["code-review:learned"]);
    expect(brain?.skills[0]?.description).toBe("Our own review checklist.");
  });

  it("briefs installed skills with their provenance, and recalls them by name", async () => {
    await skillFile(path.join(cwd(), ".agents", "skills"), "code-review", "Review a diff.");

    const briefing = brainBriefing(cwd(), env(), home);
    expect(briefing).toContain("- code-review — Review a diff. (installed)");

    const hit = recallFromBrain(cwd(), { name: "code-review" }, env(), home);
    expect(hit.isError).toBe(false);
    expect(hit.content).toContain("# Skill: code-review (installed)");
  });

  it("names installed skills in a miss, so the model can correct itself", async () => {
    await skillFile(path.join(home, ".agents", "skills"), "standup-notes", "Write the standup.");

    const miss = recallFromBrain(cwd(), { name: "nope" }, env(), home);
    expect(miss.content).toContain("standup-notes (installed)");
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
