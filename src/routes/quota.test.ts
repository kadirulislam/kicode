import { describe, expect, it } from "vitest";
import { RETRY_AFTER_CAP_MS, parseDuration, parseReset, readQuota } from "./quota";

const NOW = 1_800_000_000_000;

/** Headers in the shape a gateway actually sends them. */
const headers = (values: Record<string, string>): Headers => new Headers(values);

describe("parseDuration", () => {
  it("reads every concatenated form the gateways use", () => {
    expect(parseDuration("1s")).toBe(1_000);
    expect(parseDuration("7.66s")).toBe(7_660);
    expect(parseDuration("6m0s")).toBe(360_000);
    expect(parseDuration("2m59.56s")).toBe(179_560);
    expect(parseDuration("14h12m")).toBe(51_120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("500ms")).toBe(500);
  });

  it("refuses something that is not a duration", () => {
    // A bare number is seconds, not milliseconds — the caller decides that.
    expect(parseDuration("60")).toBeNull();
    expect(parseDuration("banana")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
});

describe("parseReset", () => {
  it("takes a duration as a time from now", () => {
    expect(parseReset("2m59.56s", NOW)).toBe(NOW + 179_560);
    expect(parseReset("7.66s", NOW)).toBe(NOW + 7_660);
  });

  it("takes a bare number as seconds", () => {
    expect(parseReset("60", NOW)).toBe(NOW + 60_000);
  });

  it("takes ten digits as an epoch in seconds, not a duration", () => {
    // No plausible reset is a duration of 1.77 billion seconds.
    expect(parseReset("1775500000", NOW)).toBe(1_775_500_000_000);
  });

  it("takes an HTTP date", () => {
    expect(parseReset("Wed, 21 Oct 2026 07:28:00 GMT", NOW)).toBe(Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"));
  });

  it("ignores what it cannot read rather than defaulting to zero", () => {
    // Zero would read as "resets now" and cause a retry storm.
    expect(parseReset("banana", NOW)).toBeNull();
    expect(parseReset("", NOW)).toBeNull();
    expect(parseReset(null, NOW)).toBeNull();
  });
});

describe("readQuota", () => {
  it("reads Groq's documented headers, each into its own window", () => {
    // From Groq's docs: `-requests` is Requests Per Day, `-tokens` is Tokens
    // Per Minute. Collapsing them into one number would lose that.
    const reading = readQuota(
      headers({
        "x-ratelimit-limit-requests": "14400",
        "x-ratelimit-remaining-requests": "14370",
        "x-ratelimit-reset-requests": "2m59.56s",
        "x-ratelimit-limit-tokens": "18000",
        "x-ratelimit-remaining-tokens": "17997",
        "x-ratelimit-reset-tokens": "7.66s",
      }),
      { now: NOW, host: "api.groq.com" },
    );

    expect(reading?.requests).toEqual({
      scope: "requests",
      window: "day",
      limit: 14400,
      remaining: 14370,
      resetAt: NOW + 179_560,
      source: "headers",
    });
    expect(reading?.tokens).toEqual({
      scope: "tokens",
      window: "minute",
      limit: 18000,
      remaining: 17997,
      resetAt: NOW + 7_660,
      source: "headers",
    });
    expect(reading?.retryAfterMs).toBeNull();
  });

  it("leaves the request window unknown on a host whose window is unknown", () => {
    // OpenAI uses the same names for a different window, so only a host we
    // know may claim one.
    const reading = readQuota(headers({ "x-ratelimit-limit-requests": "500" }), { now: NOW, host: "api.openai.com" });

    expect(reading?.requests?.window).toBe("unknown");
    expect(reading?.requests?.limit).toBe(500);
  });

  it("reads the unsuffixed family OpenRouter sends with an error", () => {
    const reading = readQuota(
      headers({ "x-ratelimit-limit": "8", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1775500000" }),
      { now: NOW },
    );

    expect(reading?.requests).toEqual({
      scope: "requests",
      window: "unknown",
      limit: 8,
      remaining: 0,
      resetAt: 1_775_500_000_000,
      source: "headers",
    });
  });

  it("prefers the suffixed family to the unsuffixed one", () => {
    const reading = readQuota(
      headers({ "x-ratelimit-limit-requests": "14400", "x-ratelimit-limit": "8" }),
      { now: NOW, host: "api.groq.com" },
    );

    expect(reading?.requests?.limit).toBe(14400);
  });

  it("clamps Retry-After so a gateway cannot park the session", () => {
    expect(readQuota(headers({ "retry-after": "2" }), { now: NOW })?.retryAfterMs).toBe(2_000);
    expect(readQuota(headers({ "retry-after": "120" }), { now: NOW })?.retryAfterMs).toBe(RETRY_AFTER_CAP_MS);
    expect(readQuota(headers({ "retry-after-ms": "250" }), { now: NOW })?.retryAfterMs).toBe(250);
  });

  it("reads Retry-After as an HTTP date too", () => {
    const at = "Wed, 21 Oct 2026 07:28:00 GMT";
    expect(readQuota(headers({ "retry-after": at }), { now: Date.parse(at) - 3_000 })?.retryAfterMs).toBe(3_000);
  });

  it("returns null when the gateway said nothing at all", () => {
    // OpenRouter's normal success case.
    expect(readQuota(headers({ "content-type": "text/event-stream" }), { now: NOW })).toBeNull();
  });

  it("ignores a value that is not a number without losing the rest", () => {
    const reading = readQuota(
      headers({ "x-ratelimit-limit-requests": "nope", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "banana" }),
      { now: NOW },
    );

    expect(reading?.requests).toEqual({
      scope: "requests",
      window: "unknown",
      limit: null,
      remaining: 0,
      resetAt: null,
      source: "headers",
    });
  });

  it("keeps the gateway's request id so a failure can be traced", () => {
    expect(readQuota(headers({ "x-request-id": "req_123", "retry-after": "1" }), { now: NOW })?.requestId).toBe("req_123");
  });

  it("returns null when only an unrelated header is present", () => {
    expect(readQuota(headers({ "x-request-id": "req_123" }), { now: NOW })).toBeNull();
  });
});
