import { OpenAIProvider, listModels, type ModelRecord } from "../providers/openai";

/**
 * `kicode --probe` — a staged diagnosis of one endpoint, for the "is it them
 * or is it me?" moment.
 *
 * Three checks, cheapest first: can we see the model list, does a tiny chat
 * request go through, and — when it does not — what does the gateway's own
 * error say about why? The probe sends at most two requests, streams one
 * short reply, and never retries: it is a diagnosis, not a workaround. A
 * gateway that restricts clients stays restricted — the probe only says so
 * with the gateway's own words beside it.
 */

export type ProbeStep = {
  name: string;
  ok: boolean;
  /** Human-readable one-liner: what was seen, or what went wrong. */
  detail: string;
};

export type ProbeResult = {
  baseUrl: string;
  steps: ProbeStep[];
  /** The verdict line the CLI prints last. */
  verdict: string;
};

const PROBE_MODEL = "glm-5.3-flash";
const PROBE_SESSION = "kicode-probe";
const PROBE_USER_AGENT = "kicode-probe/1.0";

/**
 * Models the gateway lists, or the reason it could not be read.
 *
 * The model list is the cheapest useful check: it needs the endpoint up, and
 * some gateways answer it without a key at all — which is itself information
 * (the endpoint is up; the key is what the next stage tests).
 */
export async function probeModels(options: {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<ProbeStep> {
  try {
    const models: ModelRecord[] = await listModels({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      userAgent: PROBE_USER_AGENT,
    });
    if (models.length === 0) {
      return { name: "models", ok: false, detail: "endpoint answered, but lists no models" };
    }
    const free = models.filter((model) => model.free);
    return {
      name: "models",
      ok: true,
      detail: `${models.length} models listed (${free.length} free) — e.g. ${models
        .slice(0, 3)
        .map((model) => model.id)
        .join(", ")}`,
    };
  } catch (error) {
    return { name: "models", ok: false, detail: (error as Error).message };
  }
}

/**
 * One minimal streaming request, read to completion.
 *
 * A tiny prompt keeps the cost near zero, and the reply being short keeps the
 * probe honest — it is not trying to answer anything, only to see whether the
 * gateway accepts the client at all. The OpenCode session header goes along,
 * because that is the header their gateway asks validated clients for.
 */
export async function probeChat(options: {
  apiKey: string;
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<ProbeStep> {
  const provider = new OpenAIProvider({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    sessionId: PROBE_SESSION,
    userAgent: PROBE_USER_AGENT,
  });

  try {
    let chars = 0;
    for await (const event of provider.stream({
      model: options.model ?? PROBE_MODEL,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    })) {
      if (event.type === "text") chars += event.delta.length;
      if (event.type === "reasoning") continue;
    }
    return { name: "chat", ok: true, detail: `streamed ${chars} characters — the key and client are accepted` };
  } catch (error) {
    return { name: "chat", ok: false, detail: (error as Error).message };
  }
}

/** A diagnosis for one endpoint, models first. */
export async function probeEndpoint(options: {
  apiKey: string;
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<ProbeResult> {
  const shared = {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };

  const models = await probeModels(shared);
  const steps: ProbeStep[] = [models];
  if (!models.ok) {
    // Without a model list the endpoint is unreachable or wrong; a chat call
    // would only repeat the same failure. One clear stop is the diagnosis.
    return {
      baseUrl: options.baseUrl,
      steps,
      verdict: `could not reach the model list at ${options.baseUrl} — fix this first, then probe again`,
    };
  }

  const chat = await probeChat({ ...shared, ...(options.model ? { model: options.model } : {}) });
  steps.push(chat);

  let verdict: string;
  if (chat.ok) {
    verdict = `this endpoint accepts KiCode — if a session still fails, the difference is the model or route, not the client`;
  } else if (/restricted to the OpenCode client/i.test(chat.detail)) {
    verdict =
      "the gateway refused KiCode by name of its own policy: free models are client-restricted. Paid Zen keys or Go-plan access are the documented paths for third-party clients — or switch routes with /models";
  } else if (/401|403/i.test(chat.detail)) {
    verdict = "the key was refused — check it is set for this endpoint and has not expired";
  } else if (/429/i.test(chat.detail)) {
    verdict = "rate-limited on this model — the client is fine; try another model or wait";
  } else if (/404/i.test(chat.detail)) {
    verdict = "the probe model does not exist here — pass --model with one from the list above";
  } else {
    verdict = "the endpoint did not accept the request — see the chat step above";
  }

  return { baseUrl: options.baseUrl, steps, verdict };
}

/** Prints the diagnosis the way the CLI prints everything else: plain lines. */
export function renderProbe(result: ProbeResult): string[] {
  const lines: string[] = [`probing ${result.baseUrl}`, ""];
  for (const step of result.steps) {
    lines.push(`  ${step.ok ? "ok  " : "fail"}  ${step.name}: ${step.detail}`);
  }
  lines.push("", result.verdict);
  return lines;
}
