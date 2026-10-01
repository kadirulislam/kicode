import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activeToken, buildMentionIndex, completeMention, expandMentions, type MentionIndex } from "./index";

const index: MentionIndex = {
  cwd: "/work",
  brain: null,
  files: ["src/app.ts", "src/tui/frame.ts", "README.md"],
  dirs: ["src", "src/tui"],
  skills: [{ name: "seo-audit", description: "Audit a site for SEO.", file: "/brain/skills/seo/SKILL.md" }],
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

      const built = await buildMentionIndex(path.join(root, "proj"), {});

      expect(built.files).toContain("src/a.ts");
      expect(built.dirs).toContain("src");
      expect(built.brain).toBe(path.join(root, "ki-agent-brain"));
      expect(built.skills).toEqual([
        { name: "demo-skill", description: "Does a demo.", file: expect.stringContaining("SKILL.md") },
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
      const built = await buildMentionIndex(root, {});

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
