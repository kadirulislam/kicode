import type { Tool } from "./types";

type PlanStep = { title: string; detail?: string; files?: string[] };

type GoalTask = { id: string; title: string; status: "open" | "in_progress" | "done" };

type PlanState = {
  /** The latest presented plan, if the model has presented one. */
  plan: { goal: string; steps: PlanStep[] } | null;
  /** Tracked tasks for the session, in the order they were added. */
  todos: { text: string; done: boolean; inProgress?: boolean }[];
  /** Active autonomous goal */
  goal: {
    title: string;
    status: "running" | "completed" | "paused";
    tasks: GoalTask[];
    current?: string;
    verify?: string;
    startedAt: number;
  } | null;
};

/**
 * The plan-mode toolset, sharing one session's state.
 *
 * Plan mode refuses the tools that change files or run commands — but refusing
 * is not a deliverable. These two tools are what a plan *is*: `plan` presents
 * the implementation for the user to review, and `todo` tracks its steps
 * across turns. Both only touch this session's memory, so neither needs
 * approval, and both work in build mode too — a big change deserves a tracked
 * plan whatever mode it is made in.
 */
export function createPlanTools(): Tool[] {
  const state: PlanState = { plan: null, todos: [], goal: null };

  const plan: Tool = {
    name: "plan",
    description: [
      "Present an implementation plan for the user to review instead of changing anything.",
      "Use it in plan mode as the deliverable: investigate with read, glob, grep and read-only commands first, then call plan once with the goal and the numbered steps. The user switches back to build mode to have it executed.",
      "Calling plan again replaces the previous plan.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the plan achieves, in one sentence." },
        steps: {
          type: "array",
          description: "The numbered steps, in order. Each is one concrete change.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "The step, in a few words." },
              detail: { type: "string", description: "One or two sentences on how, when it is not obvious from the title." },
              files: {
                type: "array",
                description: "Files the step touches, when known.",
                items: { type: "string" },
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["goal", "steps"],
    },

    async run(args) {
      const goal = typeof args.goal === "string" ? args.goal.trim() : "";
      const rawSteps = Array.isArray(args.steps) ? args.steps : [];
      const steps: PlanStep[] = [];
      for (const raw of rawSteps) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        const step = raw as Record<string, unknown>;
        const title = typeof step.title === "string" ? step.title.trim() : "";
        if (!title) continue;
        const entry: PlanStep = { title };
        if (typeof step.detail === "string" && step.detail.trim()) entry.detail = step.detail.trim();
        if (Array.isArray(step.files)) {
          const files = step.files.filter((file): file is string => typeof file === "string" && file.trim().length > 0);
          if (files.length > 0) entry.files = files;
        }
        steps.push(entry);
      }

      if (!goal) return { content: "Error: a plan needs a \"goal\" string saying what it achieves.", isError: true };
      if (steps.length === 0)
        return { content: "Error: a plan needs at least one step with a \"title\".", isError: true };

      state.plan = { goal, steps };
      const lines = [`Plan: ${goal}`, ""];
      steps.forEach((step, index) => {
        lines.push(`${index + 1}. ${step.title}`);
        if (step.detail) lines.push(`   ${step.detail}`);
        if (step.files) lines.push(`   files: ${step.files.join(", ")}`);
      });
      lines.push("", "The plan is recorded for this session. Stop here so the user can review it — do not start executing it.");
      return { content: lines.join("\n") };
    },
  };

  const todo: Tool = {
    name: "todo",
    description: [
      "Track the steps of a multi-step task for this session: add them up front, mark each done as it is finished, list to see what is left.",
      "The list lives for this session only and changes nothing on disk. Use it with plan for work that spans several turns so progress survives each one.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of \"add\", \"done\", \"list\", \"clear\".", enum: ["add", "done", "list", "clear"] },
        items: {
          type: "array",
          description: "Task titles to add (for \"add\").",
          items: { type: "string" },
        },
        ids: {
          type: "array",
          description: "1-based task numbers to mark done (for \"done\"), as shown by \"list\".",
          items: { type: "number" },
        },
      },
      required: ["action"],
    },

    async run(args) {
      const action = args.action;
      if (action === "list") return { content: renderTodos(state) };
      if (action === "clear") {
        state.todos = [];
        return { content: "The task list is empty." };
      }
      if (action === "add") {
        const items = Array.isArray(args.items)
          ? args.items.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
        if (items.length === 0) return { content: "Error: \"add\" needs an \"items\" array of task titles.", isError: true };
        for (const item of items) state.todos.push({ text: item.trim(), done: false });
        return { content: renderTodos(state) };
      }
      if (action === "done") {
        const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is number => typeof id === "number") : [];
        if (ids.length === 0) return { content: "Error: \"done\" needs an \"ids\" array of 1-based task numbers from \"list\".", isError: true };
        const unknown = ids.filter((id) => !Number.isInteger(id) || id < 1 || id > state.todos.length);
        if (unknown.length > 0)
          return { content: `Error: no such tasks: ${unknown.join(", ")} — \"list\" shows the numbers that exist.`, isError: true };
        for (const id of ids) state.todos[id - 1]!.done = true;
        return { content: renderTodos(state) };
      }
      return { content: "Error: \"action\" must be one of \"add\", \"done\", \"list\" or \"clear\".", isError: true };
    },
  };

  const goal: Tool = {
    name: "goal",
    description: [
      "Track and execute an autonomous goal: initialize subtasks, advance active task, record verification, and mark complete.",
      "Call with action 'init' at the start of a goal, 'task_start' when beginning a task, 'task_done' when finishing it, 'verify' when running verification, and 'complete' when done.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["init", "task_start", "task_done", "verify", "complete", "status"],
          description: "Action to perform on the goal.",
        },
        title: { type: "string", description: "Goal objective or title." },
        tasks: {
          type: "array",
          description: "List of subtasks with 'id' (e.g. 't1') and 'title'.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
        taskId: { type: "string", description: "Task ID (e.g. 't1') to update." },
        verify: { type: "string", description: "Verification command or condition." },
        note: { type: "string", description: "Progress note or details." },
      },
      required: ["action"],
    },

    async run(args) {
      const action = args.action;
      if (action === "init") {
        const title = typeof args.title === "string" ? args.title.trim() : "Autonomous Goal";
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        const tasks: GoalTask[] = rawTasks.map((t, idx) => {
          const item = t as Record<string, unknown>;
          return {
            id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `t${idx + 1}`,
            title: typeof item.title === "string" ? item.title.trim() : `Task ${idx + 1}`,
            status: "open",
          };
        });
        state.goal = {
          title,
          status: "running",
          tasks,
          verify: typeof args.verify === "string" ? args.verify.trim() : undefined,
          startedAt: Date.now(),
        };
        if (tasks.length > 0) {
          tasks[0]!.status = "in_progress";
          state.goal.current = `${tasks[0]!.id} · ${tasks[0]!.title}`;
        }
        return { content: renderGoalCard(state.goal) };
      }

      if (!state.goal) {
        return { content: "No active goal. Call goal with action: 'init' first to start a goal.", isError: true };
      }

      if (action === "task_start") {
        const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
        const target = state.goal.tasks.find((t) => t.id === taskId);
        if (target) {
          for (const t of state.goal.tasks) {
            if (t.status === "in_progress") t.status = "open";
          }
          target.status = "in_progress";
          state.goal.current = `${target.id} · ${target.title}`;
        }
        return { content: renderGoalCard(state.goal) };
      }

      if (action === "task_done") {
        const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
        const target = state.goal.tasks.find((t) => t.id === taskId);
        if (target) {
          target.status = "done";
          const next = state.goal.tasks.find((t) => t.status === "open");
          if (next) {
            next.status = "in_progress";
            state.goal.current = `${next.id} · ${next.title}`;
          } else {
            state.goal.current = undefined;
          }
        }
        return { content: renderGoalCard(state.goal) };
      }

      if (action === "verify") {
        if (typeof args.verify === "string") state.goal.verify = args.verify.trim();
        return { content: renderGoalCard(state.goal) };
      }

      if (action === "complete") {
        state.goal.status = "completed";
        for (const t of state.goal.tasks) t.status = "done";
        state.goal.current = undefined;
        return { content: renderGoalCard(state.goal) };
      }

      return { content: renderGoalCard(state.goal) };
    },
  };

  return [plan, todo, goal];
}

function renderTodos(state: PlanState): string {
  if (state.todos.length === 0) return "No tracked tasks. Add some with the todo tool (\"add\") when the work spans several steps.";
  const doneCount = state.todos.filter((t) => t.done).length;
  const total = state.todos.length;
  const lines: string[] = [`● Todos (${doneCount}/${total})`, ""];
  state.todos.forEach((todo, index) => {
    const isLast = index === total - 1;
    const branch = isLast ? "└──" : "├──";
    const isFirstPending = !todo.done && state.todos.findIndex((t) => !t.done) === index;
    const icon = todo.done ? "✓" : todo.inProgress || isFirstPending ? "◐" : "○";
    lines.push(`${branch} ${icon} ${todo.text}`);
  });
  return lines.join("\n");
}

function renderGoalCard(g: NonNullable<PlanState["goal"]>): string {
  const cardWidth = 72;
  const doneCount = g.tasks.filter((t) => t.status === "done").length;
  const openCount = g.tasks.filter((t) => t.status !== "done").length;
  const total = g.tasks.length;
  const progressRatio = total > 0 ? doneCount / total : 0;
  const filled = Math.round(progressRatio * 8);
  const progressBar = `[${"▓".repeat(filled)}${"░".repeat(8 - filled)}]`;

  const titleSnippet = g.title.slice(0, 40);
  const header = `╭─ kicode-goal ── ${titleSnippet} ──────────────────────────────────────╮`.slice(0, cardWidth);
  const linePad = (text: string) => {
    const pad = Math.max(cardWidth - 4 - text.length, 0);
    return `│ ${text}${" ".repeat(pad)} │`;
  };

  const lines = [
    header,
    linePad(`goal: ${g.status} · ${total} subtasks`),
    linePad(`Tasks · ${doneCount} done · ${openCount} open  ${progressBar} · Sub ${doneCount}/${total}`),
  ];

  for (const t of g.tasks) {
    const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "▸" : "·";
    lines.push(linePad(` ${icon} ${t.id}  ${t.title}`));
  }

  if (g.current) lines.push(linePad(`Current  ${g.current}`));
  if (g.verify) lines.push(linePad(`Verify   ${g.verify}`));
  lines.push(`╰${"─".repeat(cardWidth - 2)}╯`);

  return lines.join("\n");
}
