import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHome } from "../paths";
import { messageText, withoutImages, type ChatMessage } from "../types";

/**
 * Session persistence.
 *
 * Conversations are written as JSON under `<KICODE_HOME or ~/.kicode>/sessions`.
 * Only the transcript is stored — never the API key — so these files are not
 * secrets, but they do contain file contents and paths, which is why they live
 * in the user's home directory rather than the project.
 */

export type SessionRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  baseUrl: string;
  /** Short label for the TUI's session tabs. Older records have none. */
  title?: string;
  /** The conversation after the system prompt. */
  messages: ChatMessage[];
};

const MAX_SESSIONS = 50;
const TITLE_MAX = 28;

export { resolveHome } from "../paths";

export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHome(env), "sessions");
}

/** Timestamp-prefixed, so the ids sort chronologically and stay filename-safe. */
export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * A one-line label, taken from the opening request — which is what the user
 * will recognise the session by a day later.
 */
export function deriveTitle(messages: readonly ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  // A pasted screenshot is a title's worth of nothing, so the words are used
  // and an image-only turn falls through to the next user message.
  const text = first && typeof first.content !== "undefined" ? messageText(first.content) : "";
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  const flat = (line ?? "").replace(/\s+/g, " ");
  if (!flat) return "new session";
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/** Falls back to deriving one, so records written before titles existed work. */
export function sessionTitle(record: SessionRecord): string {
  return record.title?.trim() || deriveTitle(record.messages);
}

/** What the session opened with, flattened and capped for searching. */
const PREVIEW_MAX = 100;

export function sessionPreview(record: SessionRecord): string {
  const first = record.messages.find((message) => message.role === "user");
  const text = first && typeof first.content !== "undefined" ? messageText(first.content) : "";
  const flat = text
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
  if (!flat) return "";
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

export async function saveSession(record: SessionRecord, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = sessionsDir(env);
  await mkdir(dir, { recursive: true });

  const target = path.join(dir, `${record.id}.json`);
  const temp = `${target}.tmp`;
  // A pasted screenshot is hundreds of kilobytes of base64 and this file is read
  // back on every listing, so images are noted and not kept. Doing it here means
  // no caller can write one by accident.
  const messages = record.messages.map((message) =>
    message.role === "user" ? { ...message, content: withoutImages(message.content) } : message,
  );
  const withTitle: SessionRecord = { ...record, messages, title: record.title?.trim() || deriveTitle(messages) };
  // Write then rename, so a crash mid-write cannot leave a half-parsed session.
  await writeFile(temp, JSON.stringify(withTitle, null, 2), "utf8");
  await rename(temp, target);
}

export async function loadSession(id: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionRecord | null> {
  return readRecord(path.join(sessionsDir(env), `${id}.json`));
}

/** Newest first. Corrupt or unreadable files are skipped, not fatal. */
export async function listSessions(env: NodeJS.ProcessEnv = process.env): Promise<SessionRecord[]> {
  const dir = sessionsDir(env);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const records: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readRecord(path.join(dir, name));
    if (record) records.push(record);
  }

  return records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export async function latestSessionFor(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionRecord | null> {
  const records = await listSessions(env);
  return records.find((record) => samePath(record.cwd, cwd)) ?? null;
}

/** Keeps the store from growing without bound. */
export async function pruneSessions(env: NodeJS.ProcessEnv = process.env, keep = MAX_SESSIONS): Promise<void> {
  const records = await listSessions(env);
  for (const record of records.slice(keep)) {
    await rm(path.join(sessionsDir(env), `${record.id}.json`), { force: true });
  }
}

/** Permanently deletes a single session file from the store. */
export async function deleteSession(id: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const file = path.join(sessionsDir(env), `${id}.json`);
  try {
    await rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function readRecord(file: string): Promise<SessionRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<SessionRecord>;
    if (typeof parsed.id !== "string" || !Array.isArray(parsed.messages)) return null;
    return {
      id: parsed.id,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
      messages: parsed.messages as ChatMessage[],
    };
  } catch {
    return null;
  }
}

export function samePath(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
