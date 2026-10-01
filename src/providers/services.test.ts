import { describe, expect, it } from "vitest";
import { SERVICES, parseCustomService, serviceByName, serviceRows } from "./services";

describe("the service catalogue", () => {
  it("names every service once, and can be used as a config key", () => {
    const names = SERVICES.map((service) => service.name);
    expect(new Set(names).size).toBe(names.length);

    for (const service of SERVICES) {
      // The name becomes a key in `providers`, and the label is what the panel
      // shows — so the name has to be usable as an identifier and the variable
      // it derives has to be settable from a shell.
      expect(service.name, service.label).toMatch(/^[a-zA-Z][\w.-]*$/);
      if (service.apiKeyEnv) expect(service.apiKeyEnv, service.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("gives every service a base URL KiCode can actually reach", () => {
    for (const service of SERVICES) {
      expect(service.baseUrl, service.name).toMatch(/^https?:\/\//);
      // No trailing slash: the request path is appended to it.
      expect(service.baseUrl.endsWith("/"), service.name).toBe(false);
    }
  });

  it("points at the service by its config name or by the name on the panel", () => {
    expect(serviceByName("groq")?.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(serviceByName("Groq")?.name).toBe("groq");
    expect(serviceByName("ollama")?.apiKeyEnv).toBeUndefined();
    expect(serviceByName("kenari")?.baseUrl).toBe("https://api.kenari.ai/v1");
    expect(serviceByName("experiential")?.apiKeyEnv).toBe("EXPERIENTIAL_LABS_API_KEY");
    expect(serviceByName("nope")).toBeUndefined();
  });

  it("parses custom router declarations with url or name+url", () => {
    const fromUrl = parseCustomService("https://api.proxy.com/v1");
    expect(fromUrl?.baseUrl).toBe("https://api.proxy.com/v1");
    expect(fromUrl?.apiKeyEnv).toBe("API_PROXY_COM_API_KEY");

    const named = parseCustomService("myproxy http://localhost:8000/v1 CUSTOM_KEY");
    expect(named?.name).toBe("myproxy");
    expect(named?.baseUrl).toBe("http://localhost:8000/v1");
    expect(named?.apiKeyEnv).toBe("CUSTOM_KEY");

    expect(parseCustomService("invalid")).toBeUndefined();
  });
});

describe("the rows the connect panel shows", () => {
  it("ticks the services whose key is already in the environment", () => {
    const rows = serviceRows({ OPENAI_API_KEY: "sk-x" });
    const openai = rows.find((row) => row.value === "openai");

    expect(openai?.checked).toBe(true);
    expect(openai?.trailing).toBe("key in OPENAI_API_KEY");
  });

  it("says which variable to set when there is no key, and leaves it unchosen", () => {
    const rows = serviceRows({});
    const groq = rows.find((row) => row.value === "groq");

    expect(groq?.checked).toBe(false);
    expect(groq?.trailing).toBe("set GROQ_API_KEY");
  });

  it("treats a server that needs no key as ready", () => {
    const ollama = serviceRows({}).find((row) => row.value === "ollama");
    expect(ollama?.checked).toBe(true);
    expect(ollama?.trailing).toBe("no key needed");
  });

  it("ignores a variable that is set to nothing", () => {
    const rows = serviceRows({ GROQ_API_KEY: "   " });
    expect(rows.find((row) => row.value === "groq")?.checked).toBe(false);
  });

  it("marks a service the config already declares", () => {
    const rows = serviceRows({}, ["openai"]);
    expect(rows.find((row) => row.value === "openai")?.trailing).toContain("declared");
  });

  it("puts every service in a group, so the list has headings", () => {
    const rows = serviceRows({});
    expect(rows).toHaveLength(SERVICES.length);
    for (const row of rows) expect(["Popular", "Services"]).toContain(row.group);
  });
});
