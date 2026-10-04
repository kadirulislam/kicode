import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeToken,
  buildMentionIndex,
  completeMention,
  defaultBrainDir,
  ensureBrainDir,
  expandMentions,
  indexSkillsFromRoots,
  resolveBrainDirSync,
  skillRoots,
  type MentionIndex,
} from "./index";

const index: MentionIndex = {
  cwd: "/work",
  brain: null,
  files: ["src/app.ts", "src/tui/frame.ts", "README.md"],
  dirs: ["src", "src/tui"],
  skills: [{ name: "seo-audit", description: "Audit a site for SEO.", file: "/brain/skills/seo/SKILL.md", source: "learned" }],
  projects: [{ slug: "kicode", file: "/brain/memories/projects/kicode.md" }],
};

describe("activeToken", () => {
  it("finds the query under the cursor", () => {
    expect(activeToken("fix @src/ap", 11)).toEqual({ start: 4, query: "src/ap" });
    expect(activeToken("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("ignores email addresses and finished tokens", () => {
    expect(activeToken("mail me@home", 12)).toBeNull();
    expect(activeToken("look at @frame.ts now", 19)).toBeNull();
    expect(activeToken("no triggers here", 5)).toBeNull();
  });
});

describe("completeMention", () => {
  it("ranks prefix matches across files, skills and projects", () => {
    const labels = completeMention(index, "src").map((item) => item.label);

    expect(labels).toContain("src/app.ts");
    expect(labels).toContain("src/tui/frame.ts");
    expect(labels).toContain("src/");
    expect(labels).not.toContain("README.md");
  });

  it("completes skills and projects by name", () => {
    expect(completeMention(index, "seo").map((item) => item.label)).toContain("skill:seo-audit");
    expect(completeMention(index, "kico").map((item) => item.label)).toContain("project:kicode");
  });

  it("matches descriptions too and caps the list", () => {
    const many: MentionIndex = {
      ...index,
      files: Array.from({ length: 30 }, (_, i) => `file-${i}.ts`),
      dirs: [],
      skills: [],
      projects: [],
    };
    expect(completeMention(many, "file").length).toBeLessThanOrEqual(8);
  });
});

describe("expandMentions", () => {
  it("leaves prompts without mentions alone", async () => {
    expect(await expandMentions("just words", index)).toEqual({ text: "just words", applied: [] });
  });

  it("leaves unknown names as typed, never an error", async () => {
    expect(await expandMentions("ask @nobody about this", index)).toEqual({
      text: "ask @nobody about this",
      applied: [],
    });
  });

  it("expands a directory into a listing", async () => {
    const { text, applied } = await expandMentions("look at @src/", index);

    expect(applied).toEqual(["src/"]);
    expect(text).toContain("Context from @src/ (directory):");
    expect(text).toContain("- app.ts");
  });
});

describe("buildMentionIndex", () => {
  it("indexes files, skill frontmatter and project slugs without reading bodies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kicode-mentions-"));
    try {
      await mkdir(path.join(root, "proj", "src"), { recursive: true });
      await writeFile(path.join(root, "proj", "src", "a.ts"), "const a = 1;\n");
      await mkdir(path.join(root, "ki-agent-brain", "skills", "demo"), { recursive: true });
      await writeFile(
        path.join(root, "ki-agent-brain", "skills", "demo", "SKILL.md"),
        "---\nname: demo-skill\ndescription: Does a demo.\n---\n# Body that must not be read here\n",
      );
      await mkdir(path.join(root, "ki-agent-brain", "memories", "projects"), { recursive: true });
      await writeFile(path.join(root, "ki-agent-brain", "memories", "projects", "demo.md"), "# demo\n");

      const built = await buildMentionIndex(path.join(root, "proj"), { KICODE_HOME: path.join(root, "home") }, path.join(root, "home"));

      expect(built.files).toContain("src/a.ts");
      expect(built.dirs).toContain("src");
      expect(built.brain).toBe(path.join(root, "ki-agent-brain"));
      expect(built.skills).toEqual([
        { name: "demo-skill", description: "Does a demo.", file: expect.stringContaining("SKILL.md"), source: "learned" },
      ]);
      expect(built.projects.map((p) => p.slug)).toEqual(["demo"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("works with no brain at all — files only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kicode-mentions-"));
    try {
      await writeFile(path.join(root, "a.txt"), "hi\n");
      const built = await buildMentionIndex(root, { KICODE_HOME: path.join(root, "home") }, path.join(root, "home"));

      expect(built.brain).toBeNull();
      expect(built.files).toContain("a.txt");
      expect(completeMention(built, "zzz")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers an explicit brain path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kicode-mentions-"));
    try {
      await mkdir(path.join(root, "custom"), { recursive: true });
      const built = await buildMentionIndex(root, { KI_BRAIN_PATH: path.join(root, "custom") });

      expect(built.brain).toBe(path.join(root, "custom"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("skill roots", () => {
  const skillFile = (dir: string, name: string, description: string): Promise<void> =>
    mkdir(path.join(dir, name), { recursive: true }).then(() =>
      writeFile(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${description}"\n---\n\nbody\n`),
    );

  it("orders brain first, then project, then user", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kicode-roots-"));
    try {
      const cwd = path.join(root, "proj");
      await mkdir(cwd, { recursive: true });
      const home = path.join(root, "home");
      await mkdir(path.join(root, "brain"), { recursive: true });
      const env = { KI_BRAIN_PATH: path.join(root, "brain") };

      expect(skillRoots(cwd, env, home)).toEqual([
        { dir: path.join(root, "brain", "skills"), source: "learned" },
        { dir: path.join(cwd, ".agents", "skills"), source: "installed" },
        { dir: path.join(home, ".agents", "skills"), source: "installed" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips the brain root when there is no brain, keeping the convention", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kicode-roots-"));
    try {
      const cwd = path.join(root, "proj");
      await mkdir(cwd, { recursive: true });

      expect(skillRoots(cwd, { KICODE_HOME: path.join(root, "home") }, path.join(root, "home"))).toEqual([
        { dir: path.join(cwd, ".agents", "skills"), source: "installed" },
        { dir: path.join(root, "home", ".agents", "skills"), source: "installed" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges roots with provenance, first root winning a name", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kicode-roots-"));
    try {
      const brainSkills = path.join(root, "brain", "skills");
      const projectSkills = path.join(root, "proj", ".agents", "skills");
      await skillFile(brainSkills, "shared", "Ours.");
      await skillFile(brainSkills, "learned-only", "From sessions.");
      await skillFile(projectSkills, "shared", "Generic.");
      await skillFile(projectSkills, "installed-only", "From the registry.");

      const skills = await indexSkillsFromRoots([
        { dir: brainSkills, source: "learned" },
        { dir: projectSkills, source: "installed" },
      ]);

      expect(skills.map((skill) => `${skill.name}:${skill.source}`)).toEqual([
        "installed-only:installed",
        "learned-only:learned",
        "shared:learned",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks installed skills in completions", () => {
    const completions = completeMention(
      {
        cwd: "/work",
        brain: null,
        files: [],
        dirs: [],
        skills: [{ name: "code-review", description: "Review a diff.", file: "/x/SKILL.md", source: "installed" }],
        projects: [],
      },
      "code",
    );

    expect(completions.map((item) => item.description)).toContain("Review a diff. (installed)");
  });
});

/** A tmp root with a `home/` (the KICODE_HOME) and a `proj/` to work in. */
async function scaffold(): Promise<{ root: string; home: string; cwd: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(tmpdir(), "kicode-brain-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  // KICODE_HOME parks the default brain in the fixture, and keeps the test from
  // reading the machine's real ~/.kicode/kicode.json or ~/.kicode/brain.
  return { root, home, cwd, env: { KICODE_HOME: home } };
}

describe("brain resolution", () => {
  it("uses a brain path declared in kicode.json, relative to the working directory", async () => {
    const { root, cwd, env } = await scaffold();
    try {
      await mkdir(path.join(cwd, "mybrain"), { recursive: true });
      await writeFile(path.join(cwd, "kicode.json"), JSON.stringify({ brain: "./mybrain" }));

      expect(resolveBrainDirSync(env, cwd)).toBe(path.join(cwd, "mybrain"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets KI_BRAIN_PATH beat the config and an existing ki-agent-brain", async () => {
    const { root, cwd, env } = await scaffold();
    try {
      await mkdir(path.join(root, "ki-agent-brain"), { recursive: true });
      await mkdir(path.join(cwd, "mybrain"), { recursive: true });
      await writeFile(path.join(cwd, "kicode.json"), JSON.stringify({ brain: "./mybrain" }));
      await mkdir(path.join(root, "explicit"), { recursive: true });

      expect(resolveBrainDirSync({ ...env, KI_BRAIN_PATH: path.join(root, "explicit") }, cwd)).toBe(
        path.join(root, "explicit"),
      );
      expect(resolveBrainDirSync(env, cwd)).toBe(path.join(cwd, "mybrain"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still finds an existing ki-agent-brain above the directory", async () => {
    const { root, cwd, env } = await scaffold();
    try {
      await mkdir(path.join(root, "ki-agent-brain"), { recursive: true });

      expect(resolveBrainDirSync(env, cwd)).toBe(path.join(root, "ki-agent-brain"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the default brain once it exists, and reports none before that", async () => {
    const { root, cwd, env } = await scaffold();
    try {
      expect(resolveBrainDirSync(env, cwd)).toBeNull();

      await mkdir(defaultBrainDir(env), { recursive: true });
      expect(resolveBrainDirSync(env, cwd)).toBe(defaultBrainDir(env));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates the default brain on the first save when there is none", async () => {
    const { root, cwd, env } = await scaffold();
    try {
      const dir = await ensureBrainDir(env, cwd);

      expect(dir).toBe(path.join(env.KICODE_HOME as string, "brain"));
      expect((await stat(dir)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a configured brain that does not exist yet", async () => {
    const { root, cwd, env } = await scaffold();
    try {
      await writeFile(path.join(cwd, "kicode.json"), JSON.stringify({ brain: "../newbrain" }));

      const dir = await ensureBrainDir(env, cwd);
      expect(dir).toBe(path.join(root, "newbrain"));
      expect((await stat(dir)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
