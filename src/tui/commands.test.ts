import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  COMMAND_WIDTH,
  commandQuery,
  filterCommands,
  isAvailable,
  resolveCommand,
  stepSelectable,
} from "./commands";

describe("the command table", () => {
  it("has no duplicates", () => {
    const names = COMMANDS.map((command) => command.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it("describes every command", () => {
    for (const command of COMMANDS) {
      expect(command.name).toMatch(/^[a-z]+$/);
      expect(command.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("reports the widest name so the palette can align", () => {
    expect(COMMAND_WIDTH).toBe(Math.max(...COMMANDS.map((command) => command.name.length)));
  });

  it("covers the names OpenCode's palette lists", () => {
    // The catalogue is a copy on purpose: a list someone has already learned
    // elsewhere should not have to be learned again.
    const names = COMMANDS.map((command) => command.name);

    for (const name of ["btw", "cd", "copy", "diff", "effort", "fork", "init", "mcps", "rename", "review", "undo", "worktrees"]) {
      expect(names).toContain(name);
    }
    // …aliases included.
    for (const name of ["q", "quit", "open", "project", "projects", "resume", "thinking"]) {
      expect(names).toContain(name);
    }
  });
});

describe("resolveCommand", () => {
  it("follows an alias to the command that runs", () => {
    expect(resolveCommand("q")?.name).toBe("exit");
    expect(resolveCommand("effort")?.name).toBe("variants");
    expect(resolveCommand("projects")?.name).toBe("sessions");
  });

  it("leaves a real command alone", () => {
    expect(resolveCommand("help")?.name).toBe("help");
  });

  it("has nothing for a name that is not in the list", () => {
    expect(resolveCommand("nope")).toBeUndefined();
  });
});

describe("isAvailable", () => {
  it("marks the names that only explain themselves", () => {
    const unavailable = COMMANDS.filter((command) => !isAvailable(command)).map((command) => command.name);

    expect(unavailable).toContain("plugins");
    expect(unavailable).toContain("worktrees");
    // Every one of them carries the reason it cannot be used.
    for (const command of COMMANDS) {
      if (isAvailable(command)) expect(command.unavailable).toBeUndefined();
      else expect(command.unavailable?.trim().length).toBeGreaterThan(10);
    }
    // Most of the catalogue still does something here.
    expect(unavailable.length).toBeLessThan(COMMANDS.length / 3);
  });
});

describe("stepSelectable", () => {
  // The first five live commands: none of them unavailable, because `/agents`
  // became one and the fixtures below are about stepping, not about skipping.
  const items = COMMANDS.slice(0, 5).map((command) => ({ ...command }));

  it("skips the names that cannot run", () => {
    // With `/plan` marked unavailable, a step down from it lands on something
    // that can — the wrap rule, checked against a name that is actually gated.
    const gated = items.map((command, index) =>
      command.name === "btw" ? { ...command, unavailable: "no" } : { ...command, index },
    );
    const from = gated.findIndex((command) => command.name === "btw");
    expect(stepSelectable(gated, from, 1)).not.toBe(from);
    expect(stepSelectable(gated, from, 1)).toBe(from + 1);
  });

  it("wraps around both ends", () => {
    const last = items.length - 1;
    // Down past the last lands on the first, and up past the first lands on
    // the last. All five are available, so no skipping is involved and the
    // wrap is the whole behaviour.
    expect(stepSelectable(items, last, 1)).toBe(0);
    expect(stepSelectable(items, 0, -1)).toBe(last);
  });

  it("stays put when nothing can be chosen", () => {
    const blocked = [{ name: "plugins", description: "Plugins", unavailable: "no" }];

    expect(stepSelectable(blocked, 0, 1)).toBe(0);
    expect(stepSelectable([], 0, 1)).toBe(0);
  });
});

describe("filterCommands", () => {
  it("lists only the commands that run here for an empty query", () => {
    const names = filterCommands("").map((command) => command.name);

    expect(names.length).toBeGreaterThan(0);
    // No aliases and nothing that only explains itself.
    for (const name of ["q", "quit", "open", "project", "projects", "resume", "effort", "thinking"])
      expect(names).not.toContain(name);
    for (const name of ["pair", "plugins", "restart", "share", "web", "worktrees"])
      expect(names).not.toContain(name);
    // …but the real ones are all there.
    for (const name of ["agents", "btw", "budget", "models", "sessions", "exit", "variants", "skills"])
      expect(names).toContain(name);
  });

  it("matches a prefix", () => {
    expect(filterCommands("sessi").map((command) => command.name)).toEqual(["sessions"]);
  });

  it("puts prefix matches before interior ones", () => {
    // "e" appears inside several names; a command that *starts* with it wins.
    const names = filterCommands("e").map((command) => command.name);

    expect(names[0]).toBe("editor");
    expect(names).not.toContain(undefined);
    // Everything starting with "e" comes before anything that merely contains it.
    const firstInterior = names.findIndex((name) => !name.startsWith("e"));
    expect(names.slice(0, firstInterior).every((name) => name.startsWith("e"))).toBe(true);
  });

  it("ignores case and surrounding space", () => {
    expect(filterCommands("  EX ").map((command) => command.name)).toContain("exit");
  });

  it("returns nothing for something that cannot match", () => {
    expect(filterCommands("zzz")).toEqual([]);
  });
});

describe("commandQuery", () => {
  it("reads the word after the slash", () => {
    expect(commandQuery("/sess")).toBe("sess");
  });

  it("is empty for a bare slash, so the whole list shows", () => {
    expect(commandQuery("/")).toBe("");
  });

  it("ignores anything that is not a command", () => {
    expect(commandQuery("hello")).toBeNull();
    expect(commandQuery("")).toBeNull();
  });

  it("stops filtering once the argument begins", () => {
    // Otherwise the palette would filter on the argument and empty itself.
    expect(commandQuery("/session foo")).toBeNull();
  });
});
