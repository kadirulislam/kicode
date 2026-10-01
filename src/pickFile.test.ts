import { describe, expect, it } from "vitest";

import { pickFile, type PickCommand } from "./pickFile";

const ok = (stdout: string): PickCommand => async () => Buffer.from(stdout, "utf8");
const fails: PickCommand = async () => {
  throw new Error("not installed");
};

describe("pickFile", () => {
  it("reads the path the Windows dialog printed", async () => {
    const picked = await pickFile(ok("C:\\Users\\me\\notes.md\r\n"), "win32");
    expect(picked).toEqual({ path: "C:\\Users\\me\\notes.md" });
  });

  it("reads the POSIX path macOS's chooser prints", async () => {
    const picked = await pickFile(ok("/Users/me/shot.png\n"), "darwin");
    expect(picked).toEqual({ path: "/Users/me/shot.png" });
  });

  it("falls through to the second Linux tool when the first is missing", async () => {
    const commands: string[] = [];
    const picked = await pickFile(
      async (command, args) => {
        commands.push(command);
        if (command === "zenity") throw new Error("not installed");
        expect(args).toContain("--getopenfilename");
        return Buffer.from("/home/me/spec.txt\n", "utf8");
      },
      "linux",
    );
    expect(picked).toEqual({ path: "/home/me/spec.txt" });
    expect(commands).toEqual(["zenity", "kdialog"]);
  });

  it("resolves null when the dialog is cancelled", async () => {
    // A cancelled zenity exits non-zero with nothing on stdout; a cancelled
    // Windows dialog exits zero having printed nothing. Both are null.
    expect(await pickFile(fails, "linux")).toBeNull();
    expect(await pickFile(ok(""), "win32")).toBeNull();
  });

  it("resolves null on a platform with no dialog tool", async () => {
    expect(await pickFile(ok("/tmp/x"), "sunos")).toBeNull();
  });

  it("strips the quoting a path can arrive wrapped in", async () => {
    const picked = await pickFile(ok('"/tmp/has space.md"\n'), "linux");
    expect(picked).toEqual({ path: "/tmp/has space.md" });
  });
});
