/**
 * What the model is told about the machine, and which shell it will get.
 *
 * A tool is only as good as the model's picture of it. The `bash` tool is
 * called `bash`, but on Windows there is no such shell unless Git for Windows is
 * installed — so a model that has not been told otherwise opens with `ls -la`
 * and is answered with `'ls' is not recognized as an internal or external
 * command`, which wastes a turn and reads to the user as a broken tool.
 *
 * Two things prevent that here. The shell is chosen deliberately instead of
 * being left to `cmd.exe`, and whichever shell it turns out to be, the model is
 * told before it calls anything. `KICODE_SHELL` still overrides both.
 */

import { existsSync } from "node:fs";

export type ShellChoice = {
  /** The shell to run commands with, or null to let Node choose its default. */
  shell: string | null;
  /** What decided it, so the prompt can say where the choice came from. */
  source: "KICODE_SHELL" | "git-bash" | "default";
};

export type ShellHost = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
};

/**
 * Environment lookups are case-insensitive on Windows, so these are too — a
 * plain `env.KICODE_SHELL` would miss `kicode_shell`, and a test would have to
 * spell the Windows variables exactly as this file does.
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && value) return value;
  }
  return "";
}

/** Joins with forward slashes, which is what `spawn` wants on every platform. */
function join(root: string, child: string): string {
  return root ? `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/${child}` : "";
}

/**
 * A POSIX shell on this Windows machine, if it has one.
 *
 * Only the shells Git for Windows installs are looked for.
 * `C:\Windows\System32\bash.exe` is deliberately never a candidate: that is
 * WSL, where every path the agent passes across becomes a Linux path and the
 * working directory means something else.
 */
export function windowsShell(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string | null {
  const roots = [
    envValue(env, "GIT_INSTALL_ROOT"),
    join(envValue(env, "ProgramFiles"), "Git"),
    join(envValue(env, "ProgramFiles(x86)"), "Git"),
    join(envValue(env, "LOCALAPPDATA"), "Programs/Git"),
    "C:/Program Files/Git",
    "C:/Program Files (x86)/Git",
  ].filter(Boolean);

  for (const root of roots) {
    for (const relative of ["bin/bash.exe", "bin/sh.exe", "usr/bin/bash.exe"]) {
      const candidate = join(root, relative);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The shell the bash tool will use.
 *
 * `KICODE_SHELL` wins outright — including `KICODE_SHELL=cmd.exe`, which is how
 * a Windows user who wants the Windows commands keeps them. Otherwise a Git
 * Bash is preferred on Windows, because a POSIX shell is the one the model's
 * instincts and this tool's name both assume. Anywhere else Node's own default
 * is already the right answer.
 */
export function chooseShell(host: ShellHost = {}): ShellChoice {
  const platform = host.platform ?? process.platform;
  const env = host.env ?? process.env;

  const override = envValue(env, "KICODE_SHELL").trim();
  if (override) return { shell: override, source: "KICODE_SHELL" };

  if (platform === "win32") {
    const git = windowsShell(env, host.exists ?? existsSync);
    if (git) return { shell: git, source: "git-bash" };
  }

  return { shell: null, source: "default" };
}

const PLATFORM_LABELS: Partial<Record<NodeJS.Platform, string>> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

/** The shells that speak Windows rather than POSIX. */
const WINDOWS_SHELLS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);

/** True when the chosen shell is a Windows one, or Windows' default when none is chosen. */
export function isWindowsShell(shell: string | null, platform: NodeJS.Platform): boolean {
  if (shell === null) return platform === "win32";
  const name = shell.replace(/\\/g, "/").split("/").pop() ?? "";
  return WINDOWS_SHELLS.has(name.toLowerCase());
}

/**
 * The environment paragraph of the system prompt.
 *
 * Short, and only facts the model would otherwise have to discover by failing:
 * the operating system, the shell, and the commands that shell does and does
 * not have. It is appended to whatever prompt the run was given, so it is there
 * for an `AGENTS.md` directory and for the built-in prompt alike.
 */
export function environmentPrompt(choice: ShellChoice = chooseShell(), platform: NodeJS.Platform = process.platform): string {
  const label = PLATFORM_LABELS[platform] ?? platform;
  const windows = isWindowsShell(choice.shell, platform);
  const shell = choice.shell ?? (windows ? "cmd.exe" : "/bin/sh");

  const lines = [
    "# Environment",
    `- This machine runs ${label} (${platform}).`,
    `- The \`bash\` tool runs commands through ${shell}${
      choice.source === "KICODE_SHELL" ? ", chosen by the KICODE_SHELL environment variable" : ""
    }.`,
  ];

  if (windows) {
    lines.push(
      "- That is not a POSIX shell: `ls`, `cat`, `grep`, `rm` and `head` do not exist. Use `dir`, `type`, `findstr`, `more`, `del` and `mkdir` instead, and join commands with `&` or `&&`.",
      "- Quote paths that contain spaces.",
    );
  } else {
    lines.push("- That is a POSIX shell: `ls`, `cat`, `grep`, `rm`, `head`, pipes and `&&` all work as usual.");
  }

  return lines.join("\n");
}
