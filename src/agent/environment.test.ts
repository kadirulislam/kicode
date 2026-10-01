import { describe, expect, it } from "vitest";
import { chooseShell, environmentPrompt, isWindowsShell, windowsShell } from "./environment";

const exists = (...files: string[]) => (file: string) => files.includes(file);

describe("chooseShell", () => {
  it("obeys KICODE_SHELL wherever it is set", () => {
    expect(chooseShell({ platform: "win32", env: { KICODE_SHELL: "cmd.exe" } })).toEqual({ shell: "cmd.exe", source: "KICODE_SHELL" });
    expect(chooseShell({ platform: "linux", env: { KICODE_SHELL: "/bin/zsh" } })).toEqual({ shell: "/bin/zsh", source: "KICODE_SHELL" });
    // Environment names are case-insensitive on Windows, and this is too.
    expect(chooseShell({ platform: "win32", env: { kicode_shell: "cmd.exe" } }).shell).toBe("cmd.exe");
  });

  it("prefers a Git Bash on Windows, so `ls` is a command that exists", () => {
    const choice = chooseShell({
      platform: "win32",
      env: {},
      exists: exists("C:/Program Files/Git/bin/bash.exe"),
    });

    expect(choice).toEqual({ shell: "C:/Program Files/Git/bin/bash.exe", source: "git-bash" });
  });

  it("finds a Git Bash through the environment rather than the default path", () => {
    const choice = chooseShell({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      exists: exists("C:/Users/me/AppData/Local/Programs/Git/bin/bash.exe"),
    });

    expect(choice.source).toBe("git-bash");
    expect(choice.shell).toBe("C:/Users/me/AppData/Local/Programs/Git/bin/bash.exe");
  });

  it("leaves Windows alone when no POSIX shell is installed", () => {
    // Node's default there is cmd.exe, and the prompt says so.
    expect(chooseShell({ platform: "win32", env: {}, exists: () => false })).toEqual({ shell: null, source: "default" });
  });

  it("never takes WSL's bash for Git Bash", () => {
    // `C:\Windows\System32\bash.exe` runs commands inside Linux, where the
    // working directory and every path handed to it mean something else.
    const wsl = "C:/Windows/System32/bash.exe";

    expect(windowsShell({}, exists(wsl))).toBeNull();
    expect(chooseShell({ platform: "win32", env: {}, exists: exists(wsl) }).source).toBe("default");
  });

  it("uses Node's own default everywhere else", () => {
    expect(chooseShell({ platform: "darwin", env: {}, exists: () => true })).toEqual({ shell: null, source: "default" });
  });
});

describe("environmentPrompt", () => {
  it("names the shell and the commands it has when it is a POSIX one", () => {
    const prompt = environmentPrompt({ shell: "C:/Program Files/Git/bin/bash.exe", source: "git-bash" }, "win32");

    expect(prompt).toContain("Windows (win32)");
    expect(prompt).toContain("C:/Program Files/Git/bin/bash.exe");
    expect(prompt).toContain("POSIX shell");
    expect(prompt).not.toContain("`dir`");
  });

  it("says which commands to use when the shell is cmd.exe", () => {
    // This is the transcript the user should never see again:
    // `'ls' is not recognized as an internal or external command`.
    const prompt = environmentPrompt({ shell: null, source: "default" }, "win32");

    expect(prompt).toContain("cmd.exe");
    expect(prompt).toContain("`ls`");
    expect(prompt).toContain("`dir`");
    expect(prompt).toContain("do not exist");
  });

  it("says where an explicit shell came from", () => {
    const prompt = environmentPrompt({ shell: "cmd.exe", source: "KICODE_SHELL" }, "win32");

    expect(prompt).toContain("KICODE_SHELL");
    expect(isWindowsShell("C:\\Windows\\System32\\cmd.exe", "win32")).toBe(true);
    expect(isWindowsShell(null, "linux")).toBe(false);
  });

  it("describes Linux and macOS as the POSIX machines they are", () => {
    expect(environmentPrompt({ shell: null, source: "default" }, "linux")).toContain("Linux (linux)");
    expect(environmentPrompt({ shell: null, source: "default" }, "darwin")).toContain("macOS (darwin)");
    expect(isWindowsShell("pwsh.exe", "linux")).toBe(true);
  });
});
