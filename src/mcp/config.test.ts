import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMcpConfig } from "./config";

let home = "";
let project = "";
const env = (): NodeJS.ProcessEnv => ({ ...process.env, KICODE_HOME: home });

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kicode-mcp-home-"));
  project = await mkdtemp(path.join(tmpdir(), "kicode-mcp-project-"));
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  if (project) await rm(project, { recursive: true, force: true });
});

describe("loadMcpConfig", () => {
  it("returns nothing when there is no config at all", async () => {
    const loaded = await loadMcpConfig(project, env());

    expect(loaded.servers).toEqual({});
    expect(loaded.warnings).toEqual([]);
  });

  it("reads local and remote servers", async () => {
    await writeFile(
      path.join(project, "kicode.json"),
      JSON.stringify({
        mcp: {
          files: { type: "local", command: ["node", "server.js"], environment: { TOKEN: "abc" } },
          docs: { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
        },
      }),
      "utf8",
    );

    const loaded = await loadMcpConfig(project, env());

    expect(loaded.servers.files).toEqual({
      type: "local",
      command: ["node", "server.js"],
      environment: { TOKEN: "abc" },
      autoApprove: false,
    });
    expect(loaded.servers.docs).toMatchObject({ type: "remote", url: "https://example.com/mcp" });
    expect(loaded.files).toEqual([path.join(project, "kicode.json")]);
  });

  it("skips disabled servers", async () => {
    await writeFile(
      path.join(project, "kicode.json"),
      JSON.stringify({ mcp: { off: { type: "local", command: ["node", "x.js"], enabled: false } } }),
      "utf8",
    );

    expect((await loadMcpConfig(project, env())).servers.off).toBeUndefined();
  });

  it("warns instead of throwing on malformed entries", async () => {
    await writeFile(
      path.join(project, "kicode.json"),
      JSON.stringify({
        mcp: {
          noCommand: { type: "local" },
          noUrl: { type: "remote" },
          badType: { type: "carrier-pigeon" },
          notAnObject: 42,
        },
      }),
      "utf8",
    );

    const loaded = await loadMcpConfig(project, env());

    expect(loaded.servers).toEqual({});
    expect(loaded.warnings).toHaveLength(4);
    expect(loaded.warnings.join("\n")).toContain("noCommand");
  });

  it("warns instead of throwing on invalid JSON", async () => {
    await writeFile(path.join(project, "kicode.json"), "{ not json", "utf8");

    const loaded = await loadMcpConfig(project, env());

    expect(loaded.warnings.join("\n")).toContain("not valid JSON");
  });

  it("lets the project config win over the global one per server name", async () => {
    await writeFile(
      path.join(home, "kicode.json"),
      JSON.stringify({
        mcp: {
          shared: { type: "local", command: ["global-binary"] },
          globalOnly: { type: "local", command: ["only-global"] },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(project, "kicode.json"),
      JSON.stringify({ mcp: { shared: { type: "local", command: ["project-binary"] } } }),
      "utf8",
    );

    const loaded = await loadMcpConfig(project, env());

    expect(loaded.servers.shared).toMatchObject({ command: ["project-binary"] });
    expect(loaded.servers.globalOnly).toMatchObject({ command: ["only-global"] });
    expect(loaded.files).toHaveLength(2);
  });

  it("carries autoApprove through", async () => {
    await write_file_auto_approve();

    expect((await loadMcpConfig(project, env())).servers.trusted).toMatchObject({ autoApprove: true });
  });
});

async function write_file_auto_approve(): Promise<void> {
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, "kicode.json"),
    JSON.stringify({ mcp: { trusted: { type: "local", command: ["docs-server"], autoApprove: true } } }),
    "utf8",
  );
}
