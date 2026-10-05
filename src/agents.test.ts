import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentNameProblem,
  agentsFile,
  childPrompt,
  isValidAgentName,
  readAgentProfiles,
  readAgentsFile,
  removeAgentProfile,
  saveAgentProfile,
  toolsFor,
} from "./agents";

let home: string;
let project: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kicode-home-"));
  project = await mkdtemp(path.join(tmpdir(), "kicode-proj-"));
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  if (project) await rm(project, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ KICODE_HOME: home });

/** Writes a global and/or project agents file with this content. */
async function write(which: "global" | "project", json: unknown): Promise<void> {
  const file = agentsFile(which, project, env());
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof json === "string" ? json : JSON.stringify(json), "utf8");
}

const profile = (over: Record<string, unknown> = {}) => ({
  name: "cody-git",
  description: "GitHub and git work",
  instructions: "Focus on branches, commits and PRs.",
  model: "",
  permissions: "read" as const,
  ...over,
});

describe("an agent's skill folder", () => {
  /** Writes `<scope>/agents/<name>/<file>` for the profile under test. */
  async function folder(
    which: "global" | "project",
    name: string,
    file: string,
    body: string,
  ): Promise<void> {
    const dir = path.join(
      path.dirname(agentsFile(which, project, env())),
      "agents",
      name,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, file), body, "utf8");
  }

  it("is not required — an agent with no folder still works", async () => {
    await write("global", { agents: { "cody-git": profile() } });

    const { agents, warnings } = await readAgentProfiles(project, env());

    expect(warnings).toEqual([]);
    expect(agents).toHaveLength(1);
    // Nothing to show is not a problem to report; a user with one agent and no
    // folder should never be told their setup is broken.
    expect(agents[0]!.skills).toEqual([]);
    expect(agents[0]!.skillFile).toBeUndefined();
  });

  it("reads the agent's own SKILL.md as its standing brief", async () => {
    await write("global", { agents: { "cody-git": profile() } });
    await folder(
      "global",
      "cody-git",
      "SKILL.md",
      "---\nname: cody-git\n---\nAlways check the remote before pushing.\n",
    );

    const { agents } = await readAgentProfiles(project, env());

    expect(agents[0]!.instructions).toContain("Always check the remote before pushing.");
    expect(agents[0]!.skillFile).toContain(path.join("agents", "cody-git", "SKILL.md"));
  });

  it("lists every other file as a skill, with its own description", async () => {
    await write("global", { agents: { "cody-git": profile() } });
    await folder(
      "global",
      "cody-git",
      "pr-review.md",
      '---\nname: pr-review\ndescription: Review a pull request diff for correctness\n---\nLook for...\n',
    );
    await folder("global", "cody-git", "branch-audit.md", "No frontmatter at all.\n");

    const { agents } = await readAgentProfiles(project, env());

    // The one without frontmatter is still a skill, called by its filename —
    // requiring the header would make filling the folder a chore, and a chore is
    // a folder nobody fills in.
    expect(agents[0]!.skills?.map((skill) => skill.name)).toEqual(["branch-audit", "pr-review"]);
    const review = agents[0]!.skills?.find((skill) => skill.name === "pr-review");
    expect(review?.description).toBe("Review a pull request diff for correctness");
    expect(review?.file).toContain("pr-review.md");
    // A skill is not the brief: only SKILL.md becomes the prompt.
    expect(agents[0]!.instructions).not.toContain("Look for...");
  });

  it("keeps the file's own line and the folder's brief together", async () => {
    await write("global", { agents: { "cody-git": profile() } });
    await folder("global", "cody-git", "SKILL.md", "From the folder.\n");

    const { agents } = await readAgentProfiles(project, env());

    // Both, not either: the modal edits the `agents.json` line, and a folder that
    // replaced it would make the editor lie about what the child is told.
    expect(agents[0]!.instructions).toContain("From the folder.");
    expect(agents[0]!.instructions).toContain("Focus on branches, commits and PRs.");
  });

  it("lets a project's folder narrow the global one", async () => {
    await write("global", { agents: { "cody-git": profile() } });
    await write("project", { agents: { "cody-git": profile({ permissions: "read" }) } });
    await folder("global", "cody-git", "push.md", "---\ndescription: Push a branch\n---\n");
    await folder("project", "cody-git", "review.md", "---\ndescription: Review a PR\n---\n");

    const { agents } = await readAgentProfiles(project, env());

    // The project's agent replaces the global one, skills included — so a repo
    // can take an agent away from something it should not do here.
    expect(agents[0]!.skills?.map((skill) => skill.name)).toEqual(["review"]);
  });

  it("keeps the global skills when the project only overrides the agent", async () => {
    await write("global", { agents: { "cody-git": profile() } });
    await write("project", { agents: { "cody-git": profile({ permissions: "read" }) } });
    await folder("global", "cody-git", "push.md", "---\ndescription: Push a branch\n---\n");

    const { agents } = await readAgentProfiles(project, env());

    // Overriding who an agent is, or narrowing its permissions, is not a request
    // to strip the skills it already had.
    expect(agents[0]!.skills?.map((skill) => skill.name)).toEqual(["push"]);
  });

  it("reports an unreadable skill file rather than losing the agent", async () => {
    await write("global", { agents: { "cody-git": profile() } });
    const dir = path.join(path.dirname(agentsFile("global", project, env())), "agents", "cody-git");
    await mkdir(dir, { recursive: true });
    // A directory where a file should be: the folder is browsable, so this is
    // what a mistyped path looks like from the reader's side.
    await mkdir(path.join(dir, "broken.md"), { recursive: true });

    const { agents, warnings } = await readAgentProfiles(project, env());

    expect(agents).toHaveLength(1);
    expect(warnings.join("\n")).toContain("broken.md");
  });

  it("ignores a folder that belongs to no agent", async () => {
    await write("global", { agents: { "cody-git": profile() } });
    await folder("global", "someone-else", "thing.md", "---\ndescription: Nobody's\n---\n");

    const { agents, warnings } = await readAgentProfiles(project, env());

    // A skill file is not an agent. Adding one must not create the agent.
    expect(agents.map((agent) => agent.name)).toEqual(["cody-git"]);
    expect(warnings).toEqual([]);
  });

  it("keeps only markdown, so a notes file or a script is not a skill", async () => {
    await write("global", { agents: { "cody-git": profile() } });
    await folder("global", "cody-git", "notes.txt", "not a skill");
    await folder("global", "cody-git", "helper.sh", "#!/bin/sh");
    await folder("global", "cody-git", "real.md", "---\ndescription: Yes\n---\n");

    const { agents } = await readAgentProfiles(project, env());

    expect(agents[0]!.skills?.map((skill) => skill.name)).toEqual(["real"]);
  });
});

describe("agent names", () => {
  it("takes letters, digits, dashes and underscores", () => {
    for (const name of ["cody-git", "cody_frontend", "Cody2", "a"]) {
      expect(isValidAgentName(name)).toBe(true);
    }
  });

  it("refuses a name that could not be quoted in a tool call", () => {
    for (const name of ["", "2fast", "has space", "quote\"d", "semi;colon", "a".repeat(41)]) {
      expect(isValidAgentName(name)).toBe(false);
    }
  });

  it("says what is wrong with a name rather than only refusing it", () => {
    expect(agentNameProblem("")).toContain("required");
    expect(agentNameProblem("has space")).toContain("starting with a letter");
    expect(agentNameProblem("delegate")).toContain("reserved");
    expect(agentNameProblem("cody-git")).toBeNull();
  });
});

describe("reading the files", () => {
  it("is empty when there are no files, which is normal", async () => {
    const result = await readAgentProfiles(project, env());

    expect(result.agents).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("reads the keyed shape a hand-written file looks like", async () => {
    await write("global", {
      agents: {
        "cody-git": { description: "git", instructions: "PRs", model: "flash", permissions: "read" },
      },
    });

    const { agents } = await readAgentProfiles(project, env());

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: "cody-git",
      description: "git",
      instructions: "PRs",
      model: "flash",
      permissions: "read",
      scope: "global",
    });
  });

  it("reads the array shape too", async () => {
    await write("global", { agents: [profile({ name: "cody-frontend" })] });

    const { agents } = await readAgentProfiles(project, env());

    expect(agents.map((agent) => agent.name)).toEqual(["cody-frontend"]);
  });

  it("defaults to read-only, because write has to be granted deliberately", async () => {
    await write("global", { agents: { "cody-git": { instructions: "PRs" } } });

    const { agents } = await readAgentProfiles(project, env());

    expect(agents[0]?.permissions).toBe("read");
  });

  it("lets the project override a global agent of the same name", async () => {
    await write("global", { agents: { "cody-git": { instructions: "global", permissions: "write" } } });
    await write("project", { agents: { "cody-git": { instructions: "project" } } });

    const { agents } = await readAgentProfiles(project, env());

    expect(agents).toHaveLength(1);
    expect(agents[0]?.instructions).toBe("project");
    // Overriding replaces, so a project can *narrow* permissions as well as widen.
    expect(agents[0]?.permissions).toBe("read");
    expect(agents[0]?.scope).toBe("project");
  });

  it("keeps agents of different names from both scopes", async () => {
    await write("global", { agents: { "cody-git": { instructions: "g" } } });
    await write("project", { agents: { "cody-frontend": { instructions: "p" } } });

    const { agents } = await readAgentProfiles(project, env());

    expect(agents.map((agent) => agent.name).sort()).toEqual(["cody-frontend", "cody-git"]);
  });

  it("drops one bad agent and keeps the rest, and says which it dropped", async () => {
    // A typo in one agent must not cost the user the other nine.
    await write("global", { agents: { "cody-git": { instructions: "ok" }, "2fast": { instructions: "bad name" } } });

    const { agents, warnings } = await readAgentProfiles(project, env());

    expect(agents.map((agent) => agent.name)).toEqual(["cody-git"]);
    expect(warnings[0]).toContain("no usable name");
  });

  it("takes the name from the key, so a body cannot rename an agent", async () => {
    await write("global", { agents: { "cody-git": { name: "something-else", instructions: "ok" } } });

    const { agents } = await readAgentProfiles(project, env());

    expect(agents.map((agent) => agent.name)).toEqual(["cody-git"]);
  });

  it("refuses a permissions value it does not understand", async () => {
    await write("global", { agents: { "cody-git": { permissions: "sudo" } } });

    const { agents, warnings } = await readAgentProfiles(project, env());

    expect(agents).toEqual([]);
    expect(warnings[0]).toContain('must be "read" or "write"');
  });

  it("reports unreadable JSON instead of throwing", async () => {
    await write("global", "{ not json");

    const { agents, warnings } = await readAgentProfiles(project, env());

    expect(agents).toEqual([]);
    expect(warnings[0]).toContain("Could not read");
  });

  it("treats a file that is not an object as nothing to read, and says so", async () => {
    // A silent empty list looks exactly like a working setup, which is the worst
    // possible reading of a file someone meant to be full of agents.
    await write("global", [1, 2, 3]);

    const { agents, warnings } = await readAgentProfiles(project, env());

    expect(agents).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("expected an object");
  });
});

describe("saving", () => {
  it("puts a project agent in the project and a personal one in the user's", async () => {
    await saveAgentProfile(profile({ name: "cody-git" }), "global", project, env());
    await saveAgentProfile(profile({ name: "cody-frontend" }), "project", project, env());

    const global = await readAgentsFile(agentsFile("global", project, env()), "global");
    const local = await readAgentsFile(agentsFile("project", project, env()), "project");

    expect(global.agents.map((agent) => agent.name)).toEqual(["cody-git"]);
    expect(local.agents.map((agent) => agent.name)).toEqual(["cody-frontend"]);
  });

  it("replaces an agent of the same name rather than duplicating it", async () => {
    await saveAgentProfile(profile({ instructions: "first" }), "global", project, env());
    await saveAgentProfile(profile({ instructions: "second" }), "global", project, env());

    const { agents } = await readAgentProfiles(project, env());

    expect(agents).toHaveLength(1);
    expect(agents[0]?.instructions).toBe("second");
  });

  it("round-trips write access, which is the thing worth not losing", async () => {
    await saveAgentProfile(profile({ permissions: "write" }), "global", project, env());

    const { agents } = await readAgentProfiles(project, env());

    expect(agents[0]?.permissions).toBe("write");
  });

  it("writes a file a person can edit", async () => {
    await saveAgentProfile(profile(), "global", project, env());
    const raw = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(agentsFile("global", project, env()), "utf8")),
    ) as { agents: Record<string, { permissions: string }> };

    // Keyed by name, because that is what a hand-edited file looks like.
    expect(Object.keys(raw.agents)).toEqual(["cody-git"]);
    expect(raw.agents["cody-git"]?.permissions).toBe("read");
  });

  it("leaves no temporary file behind", async () => {
    await saveAgentProfile(profile(), "global", project, env());

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.dirname(agentsFile("global", project, env())));

    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("removes one agent and says whether it was there", async () => {
    await saveAgentProfile(profile({ name: "cody-git" }), "global", project, env());
    await saveAgentProfile(profile({ name: "cody-frontend" }), "global", project, env());

    expect(await removeAgentProfile("cody-git", "global", project, env())).toBe(true);
    expect(await removeAgentProfile("cody-git", "global", project, env())).toBe(false);

    const { agents } = await readAgentProfiles(project, env());
    expect(agents.map((agent) => agent.name)).toEqual(["cody-frontend"]);
  });

  it("only removes from the scope asked for", async () => {
    await saveAgentProfile(profile({ name: "cody-git" }), "global", project, env());

    // A project shadowing a global agent must not be able to delete the global.
    expect(await removeAgentProfile("cody-git", "project", project, env())).toBe(false);
    const { agents } = await readAgentProfiles(project, env());
    expect(agents.map((agent) => agent.name)).toEqual(["cody-git"]);
  });
});

describe("what a profile gives a child", () => {
  it("is read-only by default and adds edit when asked", () => {
    expect(toolsFor("read")).toEqual(["read", "glob", "grep", "recall"]);
    expect(toolsFor("write")).toEqual(["read", "glob", "grep", "recall", "write", "edit"]);
  });

  it("never grants a shell, at either permission level", () => {
    // A child has no approval channel, so a grantable `bash` would mean a
    // delegated model can run anything unsupervised, several at a time.
    for (const level of ["read", "write"] as const) {
      expect(toolsFor(level)).not.toContain("bash");
    }
  });

  it("never grants a child to delegate further, so the tree stays flat", () => {
    for (const level of ["read", "write"] as const) {
      expect(toolsFor(level)).not.toContain("delegate");
    }
  });

  it("never grants the brain, so two agents cannot race on one memory", () => {
    for (const level of ["read", "write"] as const) {
      expect(toolsFor(level)).not.toContain("remember");
    }
  });

  it("puts the specialisation first, where it will be read", () => {
    const prompt = childPrompt("Only look at files under src/tui.");

    expect(prompt.startsWith("Only look at files under src/tui.")).toBe(true);
    expect(prompt).toContain("You are a subagent working inside KiCode");
  });

  it("still carries the standing rules with no specialisation", () => {
    expect(childPrompt("")).toContain("You are a subagent working inside KiCode");
  });
});