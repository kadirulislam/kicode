# Launch checklist

Status for `@kadirulislam/kicode@0.1.1`. Everything under "Verified" was run against the built
artifact, not just the source. The outstanding steps are all **owner-only** —
each needs an account, a secret or a repository setting this checkout does not
have.

## Verified in this checkout

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | **1118 tests / 52 suites** |
| `npm run build` | `dist/cli.js`, **308.7 kB** minified, shebang intact |
| `npm run check:secrets` | clean |
| `node dist/cli.js --version` | `0.1.1` |
| `npm pack --dry-run` | 5 files — `CHANGELOG.md`, `LICENSE`, `README.md`, `dist/cli.js`, `package.json`; 131.0 kB; no source, tests, `.env` or secrets |
| `npm publish --dry-run` | clean — no package-normalization warnings |
| Install tarball in a clean prefix, run it | `--version` → `0.1.1`; `--help` prints usage |
| First run with `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `TOKENHARBOR_API_KEY` set in the shell | exit 1, `No provider is configured yet.` + the `/connect` remedy — none of them is used (ADR-041) |
| The same environment with an explicit `--base-url`/`--api-key` | exit 0, the bundled mock answers |
| One-shot against the bundled mock | calls `read`, returns the file, answers |
| Approval gate | `write` refused without `--yes` (named reason), written with `--yes` |
| Persistence | `-p --continue` writes a session record with its own `model`/`baseUrl` |
| Key refusal | an inline `apiKey` on a provider → *"Ignoring the API key … Set the provider's apiKeyEnv in the environment instead."*, value never echoed, run still exits 0 |
| No-key paths | `-p` with no key → exit 1 + setup hint; `--tui-preview` with no key → exit 0, frame drawn |
| `--init` | writes `./kicode.json` with `gpt-4o-mini` |
| Package name | the bare `kicode` is **rejected at publish** by npm's similarity guard (`keycode`, `code`, `xcode`, `qrcode`); published scoped as **`@kadirulislam/kicode`**, installed command still `kicode` |

## Two defects found while preparing the publish

Both were found by exercising the publish path rather than assuming it, and both
are fixed. They are recorded because a later release could reintroduce either.

1. **A `./`-prefixed `bin` path is dropped by npm 11+.** `"bin": { "kicode":
   "./dist/cli.js" }` produced
   `npm warn publish "bin[kicode]" script name dist/cli.js was invalid and removed`
   — the published manifest would have carried **no `bin` entry at all**, so
   `npm install -g @kadirulislam/kicode` would have installed a package with no
   `kicode` command. `npm pkg fix` corrects exactly this one line (`"./dist/cli.js"` →
   `"dist/cli.js"`), which is now in `package.json`. `npm pack` does *not* show
   it — the tarball keeps the path as written. Only the publish path rewrites it.
2. **The packed bin file is mode 644, not 755** — npm's tar step does not add the
   executable bit when packing on Windows. npm's installer is expected to chmod
   bin targets on install, but that is an assumption about the installer, so the
   `verify` workflow job asserts `test -x` on Linux against the installed file
   instead of trusting it.

## Order of operations

The order matters: **going public exposes git history**, so the history must be
clean *before* the repository is visible — and provenance cannot be minted at all
for a private repository, so the CI publish has to come after it.

1. **Rotate the leaked keys and scrub the history.** Three real provider keys
   were committed in an earlier `.env.example` and remain in this repository's
   git history. Blanking the file does not remove them from the objects. Rotate
   each key at its provider, then rewrite history (`git filter-repo`, or the
   provider's secret-scanning remediation).
2. **Force-push `main`:**
   ```sh
   git push --force-with-lease=main:2cbdf7a38162ce68cc16f241cd68cf7ba331c6c2 origin main
   ```
   `git fetch` only after that push.
3. **Make the repository public.** Required before an attestation can be minted,
   and it is what makes `repository` / `homepage` / `bugs` resolve on the npm page.
4. **Add the `NPM_TOKEN` secret** (Settings → Secrets and variables → Actions) —
   an *Automation* token, not a Classic one.
5. **Publish** — see below.
6. **Test as a new user** — see below.

### Publishing while the repository is private

A private repository does **not** stop an npm publish — only the provenance
attestation needs a public one. So a local publish is the path for as long as the
repository stays private, and `publishConfig` deliberately does *not* request
provenance: setting it there makes every local `npm publish` fail with
*"Automatic provenance generation not supported for provider: null"*, which is
the error to expect if it is ever added back.

```sh
npm publish --access public        # from the project root
```

Attestation is not lost by this: `.github/workflows/publish.yml` passes
`--provenance` explicitly, so the moment the repository is public and releases go
through CI, every version published that way carries an attestation. `0.1.0`
will not — it is the trade for shipping first.

Precedence, verified: a command-line flag beats `publishConfig`
(`publishConfig.tag: "beta"` plus `--tag next` publishes under `next`). So
`npm publish --no-provenance` is equivalent, if the setting is ever restored and
a single unattested publish is wanted.

## Publishing from CI

`.github/workflows/publish.yml` publishes on `release: published`. It runs
`check:secrets`, `typecheck`, `test` and `build`, publishes with provenance, and
then a `verify` job installs the tarball the registry is actually serving — into
a prefix with none of this checkout in it — and runs it.

Provenance is minted from an OIDC token, not from the npm credential: the registry
has to see that the tarball was built on GitHub's runner from this commit. That is
why the workflow asks for `id-token: write`, and why the trade is worth it — an
attested *built on GitHub from commit X* is worth more to someone installing a
BYOK coding agent than a tarball that says nothing about where it came from.

Requirements: the repository public (above), an `NPM_TOKEN` secret (above), and a
GitHub-hosted runner — provenance cannot be generated from a self-hosted one. The
workflow pins Node 24.x and never caches dependencies, because a stale cache
changes the build and provenance exists precisely to rule that out.

### Cutting a release

```sh
# bump the version, update CHANGELOG.md, commit, push
npm version patch        # or minor / major — creates the tag
git push --follow-tags
```

Then publish the GitHub release for that tag. Confirm on the registry:

```sh
npm view @kadirulislam/kicode                          # version + the 5-file tarball
npm view @kadirulislam/kicode dist.attestations        # { url, provenance } once it lands
```

In a project that has installed `kicode`, `npm audit signatures` reports the
verified attestations.

The package is unscoped, so it publishes public by default; `--access public`
matters only for the very first publish. `"license": "UNLICENSED"` is on purpose —
publishing puts the code in the registry, not in the public domain.

## Testing as a new user

Not a re-run of the suite — the suite has already run. This is the path someone
who has never heard of KiCode takes, on a machine with none of this checkout's
state. Do it on Linux or macOS as well as Windows: defect 2 above only shows up
where an executable bit means something.

```sh
# A home with no ~/.kicode in it, so nothing is inherited from your own runs.
export KICODE_HOME="$(mktemp -d)"

# Exactly what the README tells a stranger to type.
npm install -g @kadirulislam/kicode
kicode --version          # 0.1.0
kicode --help

# No key yet: the setup hint and exit 1, not a stack trace.
kicode -p "hello"

# The UI must open with no key, so /connect and /key are reachable.
kicode --tui-preview

# With a key: one real one-shot turn against your own endpoint.
export OPENAI_API_KEY=sk-...
kicode -p "read package.json and tell me the version"

# The interactive path, which is the actual product.
kicode
```

Then confirm the things a first run is judged on: the UI opens on the home
screen, `Shift+Enter` inserts a newline, `/connect` accepts a key, a first
`remember` **creates** the brain at `~/.kicode/brain` rather than failing, and
switching tabs while a turn is running parks that turn instead of cancelling it
(`◐` on the tab, the answer saved under its own id).

## Deliberately not done

- **`repository` / `homepage` / `bugs` point at a private repo.** They are set to
  `github.com/kadirulislam/kicode`, which npm cannot resolve into a browsable
  page until the repository is made public. Remove them if it never is.
- **Git installs are a poor path.** npm 12 blocks `prepare` scripts by default,
  so `npm install github:…` skips the build and installs no `dist/`. The registry
  tarball is the supported channel.
- **No standalone binary.** The minified bundle raises the bar; it is not a
  secret, and the licence — not the minifier — is what forbids copying. A
  single-file binary is the next step only if that bar needs to be higher.
