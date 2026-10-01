# Route consent — "never pay by accident"

> Companion to [`kicode-vision-spec.md`](kicode-vision-spec.md) §4.1 and
> [`quota-route-health-design.md`](quota-route-health-design.md) §6. The
> interaction that decides whether KiCode spends money. Design only.

## 1. The rule it implements

**Free routes are used automatically. A paid route is entered only with a yes,
given once, for a named route, in a named session.** No flag, no default, and no
absence of a prompt may ever mean "yes".

That last clause is the whole feature. Every design below is a way of making
"No" the answer when nobody is there to say anything else.

## 2. When the prompt appears

Only at one moment: **the chain has run out of free, eligible, non-deferred
routes, and the next route in the order costs money.** Not at startup, not when
a paid route is merely configured, not as a warning.

```
  ┌──────────────────────────────────────────────────────────────┐
  │ no free route left                                    esc    │
  │                                                              │
  │  qwen3-coder:free   capped · resets in 3h 12m                │
  │  glm-5.3:free       rate-limited · retry in 40s              │
  │                                                              │
  │  next: groq/llama-3.3-70b   est. $0.0004 / 1K tokens         │
  │                                                              │
  │  spent this session  $0.00 of a $0.50 cap                    │
  │                                                              │
  │  use?  y once · a this session · n stop here                 │
  └──────────────────────────────────────────────────────────────┘
```

The body answers, in order: *why am I being asked*, *what is left*, *what would
I get*, *what would it cost*, *what happens if I say no*. A prompt that does not
answer the first is the one users learn to dismiss.

### Why this and not a dialog per request

Spending is a policy decision, not a per-request one. Asking every time trains
the user to press `y`, which is the failure mode this design exists to prevent.
So the answer is asked once, applied to that route for the session, and is
visible in `/budget` afterwards.

## 3. The interaction

| Key | Meaning | Recorded as |
| --- | --- | --- |
| `y` | use **this route, this once** | consent for one request only |
| `a` | use **this route for the session** | consent for the route, until the session ends |
| `n` | **stop here** — save, keep the partial work, report resets | refusal; not asked again this session |
| `esc` | same as `n` | refusal |

The keys are the approval modal's keys on purpose — `y` / `a` / `n` / `esc` is
already learned for writing files, and spending should not teach a second
alphabet. `Esc` meaning "no" is the existing rule and applies unchanged.

**A refusal is not a retry prompt.** After `n`/`esc`, KiCode does not cascade to
the next-cheapest paid route. It ends the turn with the exhaustion message
(`spec` §4.1) and a note that a paid route is available. Nagging across routes
is how "no" gets worn down.

## 4. What each answer actually does

- **`y` (once)** — the request goes out on that route; the next time the chain
  reaches it, the prompt returns. For a user who wants to spend on one hard
  question and no more.
- **`a` (session)** — the route joins the session's consented set. It is
  remembered in memory only, exactly like a tool's "always" answer, and is gone
  when the session is. **Never written to `kicode.json`** — a file is shared and
  committed, and a spending decision is not a project setting.
- **`n` / `esc`** — no spend. The turn ends as exhaustion: the session is saved,
  the partial reply is kept (already built), and the message names when each
  free route frees up.

## 5. Pre-authorisation, and why `--yes` must not imply it

`--yes` means "approve my *file changes* without asking" — it is about
permission, not money. Conflating them would make a scripted run spend silently,
which is the exact accident to avoid.

| Path | Effect |
| --- | --- |
| `--yes` | tools are approved; **paid routes are still refused** |
| `--allow-paid` (flag) | automatic use of paid routes is allowed for this run |
| `allowPaid: true` in `kicode.json` | same, per project, and visible in `/settings` |
| `KICODE_ALLOW_PAID=1` | same, per shell |
| `/budget allow-paid` | same, for the rest of this session |

Even with pre-authorisation, a **money cap** is required to actually spend (see
§6). "Allowed" is permission; the cap is the limit.

## 6. The money cap is the second lock

Permission without a cap is an open wallet. So a paid route is only entered when
**both** are true: consent exists, and a money cap is set and not yet reached.

- With no cap, the prompt does not offer `y`; it offers to set one:
  `no money cap set — set one with /budget 0.50, or use a free route`.
- With a cap, the prompt shows spend against it (`spent this session $0.00 of a
  $0.50 cap`).
- **A price of "unknown" cannot be capped.** A route the endpoint does not price
  is not offered automatically; choosing it requires a per-request `y` and is
  labelled `price unknown — cannot be capped`. One exception to §2's "asked
  once": an uncappable route is asked about every time, because each request is
  an unbounded commitment.
- Reaching the cap mid-session is the token-budget case (checked between
  requests, never mid-stream) with money instead of tokens.

## 7. When there is nobody to ask

No channel means no consent. That is a refusal, not an approval:

- a one-shot `-p` run, a pipe, or a session with no UI → the chain stops at the
  paid route and reports exhaustion, naming the flag that would allow it.
- a **route switch inside a sub-agent** never prompts (a child has no channel);
  a paid route there is refused, and the child is only ever offered free routes.

The wording is the existing KiCode pattern — name the reason and the way out:

```
[ every free route is exhausted — the next route costs money and this run has
  no way to ask. Re-run with --allow-paid and a money cap to allow it. ]
```

## 8. Where consent is visible afterwards

- `/status` — the active route and whether it is free, paid-and-consented, or
  paid-and-blocked.
- `/budget` — the cap, the spend, and the consented routes this session.
- `/models` — a paid row is marked, and a consented one says so, so the picker
  and the policy never disagree.
- `/routes` — a consented route can be revoked; revoking clears it from the
  session immediately.

## 9. Edge cases, decided

1. **Choosing a paid model explicitly in `/models`** *is* consent: the user
   named it. Recorded for the session, and it still counts against the cap.
2. **Consent for route A is not consent for route B.** Each is named and given
   separately; a user approving `groq/llama` has not approved `openai/gpt`.
3. **The consent prompt is not the approval modal.** They share the keys and the
   look, but they are different modals: a tool prompt says *what will run*, this
   says *what it will cost*. Keeping them distinct matters because a user
   answering `y` should know which question they answered.
4. **Plan mode does not block a paid route** — plan mode is about writing, and a
   read-only investigation can still cost money. It is capped, not blocked.
5. **A declined route is retried only if the user asks.** `/routes retry <name>`
   forces it back into the order.
6. **`--allow-paid` in a repository with no cap** still refuses, per §6.
7. **The cap is per session**, not per project, so a long-running project cannot
   accumulate spend across restarts of the tool.
8. **A resumed session starts with no consents and no spend on the clock.** A
   spend decision does not survive into a session the user did not re-authorise.

## 10. Acceptance tests

Interaction (fake-terminal harness, `src/tui/app.test.ts`):

1. With only free routes, no consent modal ever appears (assert zero prompts
   across a full turn).
2. Reaching a paid route shows the modal with the free routes, their reasons,
   their reset times, the proposed route, its price, and the cap line.
3. `y` sends one request and re-prompts on the next; `a` does not re-prompt for
   that route this session; `n` and `esc` both stop without spending.
4. After `n`, the turn ends as exhaustion — session saved, partial reply kept —
   and **the next paid route is not tried**.
5. `--yes` alone never produces a paid request; `--allow-paid` without a cap
   still refuses; `--allow-paid` with a cap proceeds.
6. A non-interactive run (`-p`) reaching a paid route reports the exhaustion
   message and the flag, and makes no request.
7. A route with no reported price is prompted every time, labelled
   `price unknown — cannot be capped`, and is not entered automatically.
8. Consents do not survive a resume: a fresh session asks again.
9. `/budget` lists the consented routes and the spend; `/routes retry <name>`
   puts a declined route back in the order.

Unit (`src/routes/consent.test.ts`):

10. Consent is in-memory only: assert nothing is written to `kicode.json` or
    the session file.
11. Consent is keyed by route (`baseUrl#model`), so approving one paid route
    leaves another refused.
12. With no cap, `canSpend(route)` is false regardless of consent; with a cap
    and consent it is true; past the cap it is false again.

## 11. Copy (final wording)

- Modal title: `no free route left`
- Options row: `use?  y once · a this session · n stop here`
- Cap line: `spent this session $0.00 of a $0.50 cap`
- No cap: `no money cap set — set one with /budget 0.50, or use a free route`
- Unknown price: `price unknown — cannot be capped`
- Exhaustion note: `every free route is exhausted — the next route costs money`
- Non-interactive: `Re-run with --allow-paid and a money cap to allow it.`
