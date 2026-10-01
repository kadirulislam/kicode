import { describe, expect, it } from "vitest";
import { createDefaultTools } from "./index";
import { createPlanTools } from "./plan";

function tools() {
  const [plan, todo, goal] = createPlanTools();
  return { plan: plan!, todo: todo!, goal: goal! };
}

describe("plan tools", () => {
  it("are registered by default and never gated", () => {
    const names = createDefaultTools().list().map((tool) => tool.name);

    expect(names).toContain("plan");
    expect(names).toContain("todo");
    for (const tool of createPlanTools()) expect(tool.requiresApproval).toBeUndefined();
  });

  it("keeps one session's list out of another's", async () => {
    const first = tools();
    const second = tools();

    await first.todo.run({ action: "add", items: ["first task"] }, { cwd: "." });
    expect((await second.todo.run({ action: "list" }, { cwd: "." })).content).toContain("No tracked tasks");
  });
});

describe("plan tool", () => {
  it("presents the goal with numbered steps", async () => {
    const result = await tools().plan.run(
      {
        goal: "Add plan tools",
        steps: [{ title: "Write the tool" }, { title: "Wire it up", detail: "Register in the defaults.", files: ["index.ts"] }],
      },
      { cwd: "." },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Plan: Add plan tools");
    expect(result.content).toContain("1. Write the tool");
    expect(result.content).toContain("2. Wire it up");
    expect(result.content).toContain("Register in the defaults.");
    expect(result.content).toContain("files: index.ts");
  });

  it("tells the model to stop after presenting", async () => {
    const result = await tools().plan.run({ goal: "Do it", steps: [{ title: "Step one" }] }, { cwd: "." });

    expect(result.content).toContain("Stop here");
  });

  it("refuses a plan with no goal or no usable steps", async () => {
    const { plan } = tools();

    expect((await plan.run({ goal: "  ", steps: [{ title: "Step" }] }, { cwd: "." })).isError).toBe(true);
    expect((await plan.run({ goal: "Goal", steps: [] }, { cwd: "." })).content).toContain("at least one step");
    expect((await plan.run({ goal: "Goal", steps: [{ title: "  " }] }, { cwd: "." })).isError).toBe(true);
  });

  it("replaces the previous plan when called again", async () => {
    const { plan } = tools();

    await plan.run({ goal: "First", steps: [{ title: "Old step" }] }, { cwd: "." });
    const second = await plan.run({ goal: "Second", steps: [{ title: "New step" }] }, { cwd: "." });

    expect(second.content).toContain("Plan: Second");
    expect(second.content).not.toContain("Old step");
  });
});

describe("todo tool", () => {
  it("adds tasks and lists them as a tree", async () => {
    const { todo } = tools();

    const added = await todo.run({ action: "add", items: ["Write the tool", "Write the tests"] }, { cwd: "." });
    expect(added.isError).toBeUndefined();
    expect(added.content).toContain("● Todos (0/2)");
    expect(added.content).toContain("├── ◐ Write the tool");
    expect(added.content).toContain("└── ○ Write the tests");
  });

  it("marks tasks done by their listed number", async () => {
    const { todo } = tools();

    await todo.run({ action: "add", items: ["First", "Second"] }, { cwd: "." });
    const done = await todo.run({ action: "done", ids: [2] }, { cwd: "." });

    expect(done.content).toContain("● Todos (1/2)");
    expect(done.content).toContain("├── ◐ First");
    expect(done.content).toContain("└── ✓ Second");
  });

  it("says an empty list is empty rather than showing nothing", async () => {
    expect((await tools().todo.run({ action: "list" }, { cwd: "." })).content).toContain("No tracked tasks");
  });

  it("clears the list on request", async () => {
    const { todo } = tools();

    await todo.run({ action: "add", items: ["Something"] }, { cwd: "." });
    expect((await todo.run({ action: "clear" }, { cwd: "." })).content).toContain("empty");
    expect((await todo.run({ action: "list" }, { cwd: "." })).content).toContain("No tracked tasks");
  });

  it("refuses what it cannot do with the numbers that exist", async () => {
    const { todo } = tools();

    await todo.run({ action: "add", items: ["Only"] }, { cwd: "." });
    const unknown = await todo.run({ action: "done", ids: [2] }, { cwd: "." });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("no such tasks: 2");

    expect((await todo.run({ action: "add", items: [] }, { cwd: "." })).isError).toBe(true);
    expect((await todo.run({ action: "done", ids: [] }, { cwd: "." })).isError).toBe(true);
    expect((await todo.run({ action: "stall" }, { cwd: "." })).isError).toBe(true);
  });
});

describe("goal tool", () => {
  it("initializes an autonomous goal with subtasks and progress card", async () => {
    const { goal } = tools();

    const init = await goal.run(
      {
        action: "init",
        title: "Improve dashboard",
        tasks: [
          { id: "t1", title: "Inspect renderer" },
          { id: "t2", title: "Run tests" },
        ],
        verify: "npm test",
      },
      { cwd: "." },
    );

    expect(init.isError).toBeUndefined();
    expect(init.content).toContain("kicode-goal");
    expect(init.content).toContain("Improve dashboard");
    expect(init.content).toContain("t1  Inspect renderer");
    expect(init.content).toContain("Verify   npm test");
  });

  it("advances tasks and completes the goal", async () => {
    const { goal } = tools();

    await goal.run(
      {
        action: "init",
        title: "Task runner",
        tasks: [{ id: "t1", title: "Step 1" }],
      },
      { cwd: "." },
    );

    const done = await goal.run({ action: "task_done", taskId: "t1" }, { cwd: "." });
    expect(done.content).toContain("✓ t1  Step 1");

    const finished = await goal.run({ action: "complete" }, { cwd: "." });
    expect(finished.content).toContain("goal: completed");
  });
});
