import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensureBrainDir } from "../mentions";
import { messageText, type ChatMessage, type Provider } from "../types";
import { looksLikeSecret, saveMemory, saveSkill } from "./tools/remember";

/**
 * The learning pass: what a session taught, extracted after the fact.
 *
 * `remember` is a tool the model calls *while* it works, which means a session
 * only teaches the brain when the model happens to think of it — and a model
 * that never thinks of it leaves nothing behind. This is the other half: one
 * extra, cheap request over the transcript that asks a single question ("what
 * here is worth keeping?") and files the answer.
 *
 * It is a plain request on the user's own provider, deliberately. A hosted
 * harness would break the rule that KiCode needs no account and no server; the
 * intelligence stays in the binary and on the user's key.
 *
 * The pass is additive and conservative. It never overwrites a skill (a `create`
 * that finds one is skipped, not forced), it skips a memory whose text is
 * already recorded, and everything it writes goes through the same writers the
 * `remember` tool uses — slug names, capped bodies, no secrets.
 */

export type Learning = {
  kind: "skill" | "memory";
  name: string;
  description?: string;
  text: string;
};

export type LearnResult = {
  /** What was written to the brain. */
  added: Learning[];
  /** What was already known, or was not usable. */
  skipped: Learning[];
  /** Set when the request or the answer could not be used. */
  error?: string;
};

/** What the extractor is asked for. Kept tight: a transcript, an array back. */
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 1_500;
const MAX_ITEM_TEXT = 4_000;
const MAX_ITEMS = 5;
/** Below this the transcript is a greeting, and a request for it is waste. */
const MIN_TRANSCRIPT_CHARS = 200;

const LEARN_SYSTEM = [
  "You extract durable learnings from a coding session so that future sessions start already knowing them.",
  "Answer with ONLY a JSON array — no prose before or after it, no code fence. Each item is:",
  '  {"kind":"skill","name":"lowercase-slug","description":"one line","text":"markdown procedure"}',
  '  {"kind":"memory","name":"project-slug","text":"one fact, dated if the date matters"}',
  "A skill is a reusable procedure of three or more steps worth repeating.",
  "A memory is a project fact, a decision, or a non-obvious gotcha together with its fix.",
  "Return an empty array when the session produced nothing durable.",
  "Never invent, never restate code, never record one-off output, and never",
  "include a secret, key, token, or password.",
  `At most ${MAX_ITEMS} items, and only the ones that clearly matter.`,
].join("\n");

/**
 * The transcript as the extractor sees it: words only, tail-first.
 *
 * Tool results are included because a gotcha and its fix usually live there,
 * but every message is capped. The *tail* is kept when the whole thing is too
 * long, because what was learned is at the end of the session, not the start.
 */
export function transcriptForLearning(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.content === null) continue;
    const text = messageText(message.content).trim();
    if (!text) continue;
    const who = message.role === "user" ? "USER" : message.role === "assistant" ? "ASSISTANT" : "TOOL";
    lines.push(`${who}: ${text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text}`);
  }
  const joined = lines.join("\n\n");
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(joined.length - MAX_TRANSCRIPT_CHARS) : joined;
}

/**
 * The array out of whatever the model said.
 *
 * Models fence JSON, add a sentence in front of it, or both; taking the span
 * between the first `[` and the last `]` is what makes that harmless. Anything
 * unusable in the array is dropped rather than saved: a bad name would be
 * refused by the writer anyway, and this way it never reaches disk.
 */
export function parseLearnings(raw: string): Learning[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Learning[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const kind = source.kind === "skill" || source.kind === "memory" ? source.kind : null;
    const name = typeof source.name === "string" ? source.name.trim() : "";
    const text = typeof source.text === "string" ? source.text.trim() : "";
    if (!kind || !name || !text) continue;
    const description = typeof source.description === "string" ? source.description.trim() : "";
    out.push({ kind, name, text: text.slice(0, MAX_ITEM_TEXT), ...(description ? { description } : {}) });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** Asks the model what is worth keeping. Does not write anything. */
export async function extractLearnings(options: {
  messages: readonly ChatMessage[];
  provider: Provider;
  model: string;
  signal?: AbortSignal;
}): Promise<{ learnings: Learning[]; error?: string }> {
  const transcript = transcriptForLearning(options.messages);
  if (transcript.length < MIN_TRANSCRIPT_CHARS) return { learnings: [] };

  let raw = "";
  try {
    for await (const event of options.provider.stream({
      model: options.model,
      messages: [
        { role: "system", content: LEARN_SYSTEM },
        { role: "user", content: transcript },
      ],
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      if (event.type === "text") raw += event.delta;
    }
  } catch (error) {
    return { learnings: [], error: (error as Error).message };
  }

  return { learnings: parseLearnings(raw) };
}

/** Files what was extracted, skipping what is already known. */
export async function applyLearnings(
  cwd: string,
  learnings: readonly Learning[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<LearnResult> {
  const added: Learning[] = [];
  const skipped: Learning[] = [];
  if (learnings.length === 0) return { added, skipped };

  const brain = await ensureBrainDir(env, cwd);

  for (const item of learnings) {
    // The same refusal the tool makes. This pass has no user in the loop, so an
    // unattended writer is exactly where a secret must be stopped.
    if (looksLikeSecret(item.text, item.description ?? "")) {
      skipped.push(item);
      continue;
    }

    if (item.kind === "skill") {
      // A skill that already exists is left alone: the pass is additive, and
      // correcting one is a deliberate act (`remember` with action update).
      const result = await saveSkill(brain, item.name, item.description ?? "", item.text, "create");
      (result.isError ? skipped : added).push(item);
      continue;
    }

    if (await memoryHas(brain, item.name, item.text)) {
      skipped.push(item);
      continue;
    }
    const result = await saveMemory(brain, item.name, item.text);
    (result.isError ? skipped : added).push(item);
  }

  return { added, skipped };
}

/** Whether a project memory already carries this entry. */
async function memoryHas(brain: string, slug: string, text: string): Promise<boolean> {
  try {
    const existing = await readFile(path.join(brain, "memories", "projects", `${slug}.md`), "utf8");
    // A prefix rather than the whole entry: the writer reflows newlines, so an
    // exact match would miss a note it wrote a moment ago.
    const probe = text.trim().replace(/\s+/g, " ").slice(0, 80);
    return probe.length > 0 && existing.replace(/\s+/g, " ").includes(probe);
  } catch {
    return false;
  }
}

/**
 * The whole pass: extract, then file. One entry point for the agent and the UI,
 * so neither has to know the order.
 */
export async function learnFromSession(options: {
  messages: readonly ChatMessage[];
  provider: Provider;
  model: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<LearnResult> {
  const extracted = await extractLearnings(options);
  if (extracted.error !== undefined) return { added: [], skipped: [], error: extracted.error };
  return applyLearnings(options.cwd, extracted.learnings);
}
