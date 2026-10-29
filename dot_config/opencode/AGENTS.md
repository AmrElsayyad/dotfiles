# Global Agent Guidelines & Project Architecture

## Core Design Philosophy

- **Flat Logic First**: Default to small, single-purpose functions. Use early returns/guard clauses. Never nest deeply.
- **SOLID & KISS**: Simple is better than complex. Explicit is better than implicit.
- **Security Default**: Apply Least Privilege. Never hardcode sensitive values, magic numbers, or env configs.
- **Untrusted Clients**: Treat Tauri clients, browser clients, installed app packages, JS bundles, assets, and network traffic as untrusted.
- **Authoritative Backend**: Axum is the only authority for authentication, authorization, entitlements, payments, quotas, pricing, subscriptions, and sensitive business rules.

## Tech Stack

> **⚠️ Default stack for greenfield projects.** Each project's actual stack is defined in its own `AGENTS.md`. Always read the project-level `AGENTS.md` first — do not assume this global stack applies to existing projects.

- **Mobile-first cross-platform**: Tauri v2 for iOS and Android. Add desktop/web targets later only when product requirements justify it.
- **Web/Admin**: SvelteKit. Use `@sveltejs/adapter-static` with `ssr = false` only for static SPA deployments; use a server adapter/BFF when server-side secrets, sessions, or proxying are required.
- **Backend API**: Rust with Axum & Tower ecosystem.
- **Database**: PostgreSQL with SQLx (compile-time checked macros like `query!`).
- **AI/Vector**: `pgvector` extension. Rust-based background agent workers.
- **Tooling**: `bun` (STRICTLY for JS/TS), `cargo` (for Rust), Tailwind CSS, `shadcn-svelte`.

## Mobile Architecture Decision

- For mobile-first products, prefer **Tauri v2 + Axum**.
- Use a shared SvelteKit/Svelte-based UI as the primary client shell for mobile, desktop, and web where practical.
- Keep SvelteKit for marketing sites, admin dashboards, and web companion apps; use Tauri for packaged mobile and desktop clients.
- Tauri owns mobile/desktop UI, local state, secure client storage, and native platform integrations.
- Axum owns all authorization, entitlement, payment, quota, pricing, and sensitive business decisions.
- Design mobile UX first: touch targets, offline behavior, constrained network conditions, platform navigation, and safe areas.
- Reuse API clients, domain types, validation, and UI components across Tauri mobile, desktop, and web targets where practical.

## Monorepo Layout

- `/apps/mobile`: Tauri v2 mobile client for iOS and Android.
- `/apps/desktop`: Optional Tauri v2 desktop client, only when desktop is required.
- `/apps/web`: SvelteKit web/admin app.
- `/packages/ui`: Shared Svelte components and mobile-first UI primitives.
- `/packages/api-client`: Shared typed API client and request/response contracts.
- `/services/api`: Rust Axum REST API.
- `/services/agent-worker`: Rust background worker for AI plans.
- `/db`: SQLx migrations.
- `/packages/shared-types`: Shared type definitions and API contracts.

## Coding Standards

- **SvelteKit**: Prefer server-only contexts for secrets and privileged logic: `$lib/server/`, `*.server.ts`, `+page.server.ts`, `+server.ts`, and `hooks.server.ts`.
- **SvelteKit SPA exception**: For strict static SPAs, do not use `+page.server.ts`; load data through the Rust API. Never place secrets in client-loaded code.
- **Tauri**: Keep Svelte components and client state separate from security decisions. Use repositories/services for API access.
- **Tauri commands**: Keep Rust commands thin. Validate every input, enforce capability boundaries, and delegate privileged decisions to Axum or a dedicated Rust service.
- **Rust**: `unsafe` is strictly forbidden. Axum handlers must be thin; push logic to services.
- **Interface Modularity (No Vendor Lock-in)**: ALWAYS isolate external dependencies, databases, and APIs behind generalized asynchronous Rust traits. This repository pattern ensures you can easily change design choices or swap vendors later without touching core business logic.
- **Repository Pattern for RAG**: Never hard-code `pgvector` queries directly inside agent orchestration logic. Define asynchronous traits (e.g., `VectorStore`) for vector operations. Implement the trait using SQLx and `pgvector`. This ensures the vector database can be swapped later without refactoring core agent logic.
- **Generation**: Output must be immediately runnable (include imports, update `Cargo.toml`/`package.json`). Fix linters automatically (`cargo clippy`, `bun run lint`). Prefer `edit` over raw code blocks.

## Application Security Rules (CRITICAL)

### Secrets

- Never place secrets, API keys, private keys, signing keys, database URLs, or privileged credentials in Tauri frontend code, JavaScript/TypeScript constants, assets, bundled `.env` files, browser bundles, or client-side configuration.
- Keep third-party API keys in Axum or SvelteKit server-only code.
- Proxy third-party APIs through Axum when the key must remain private.
- Store secrets in a secrets manager or protected deployment environment.
- Never commit `.env`, private keys, credentials, tokens, or generated secrets.
- Use separate credentials for development, staging, production, mobile, web, and third-party integrations.
- Support credential and signing-key rotation.

### Authentication and sessions

- Use short-lived access tokens, preferably 5–15 minutes.
- Use refresh tokens with server-side storage so sessions can be revoked.
- Store refresh tokens hashed in the database and bind them to a device or session where practical.
- Validate JWTs completely: signature, expiry, not-before, issuer, audience, token type, required scopes, tenant/organization claims, and custom claims.
- Do not treat JWT claims as authorization by themselves; recheck permissions in Axum.
- Support logout, remote logout, device-session revocation, password-change revocation, and compromise recovery.
- Use Argon2id for password hashing.
- Require reauthentication for high-risk actions: changing email/password, disabling MFA, exporting data, making payments, or approving agent actions.
- Offer MFA to users; require it for privileged accounts.

### Authorization

- Implement three checks for protected operations:
  1. Authentication: is the caller valid?
  2. Coarse authorization: does the caller have the required role, scope, plan, tenant, or entitlement?
  3. Object-level authorization: does the caller own or have explicit access to the specific resource?
- A valid JWT never authorizes access to another user's resource.
- Check ownership, tenant membership, role, scope, subscription state, and resource state in Axum on every request.
- Never authorize based only on client-supplied IDs, flags, prices, or UI state.

### Axum API hardening

- Require TLS for all traffic.
- Use restrictive CORS; never use wildcard CORS for authenticated APIs.
- Apply rate limits by IP, user, route, and action.
- Apply stricter limits to login, registration, password reset, OTP, email verification, and expensive endpoints.
- Validate all external input with typed extractors and explicit validation.
- Reject unexpected fields where appropriate.
- Use request-size limits, timeouts, and body-size limits.
- Return generic authentication and authorization errors; do not reveal whether an account exists or which validation rule failed.
- Keep admin, debug, metrics, staging, and internal endpoints out of production.
- Log failed logins, permission denials, token reuse, suspicious traffic, and security events.
- Never log passwords, tokens, refresh tokens, full card data, or unnecessary personal data.
- Use least-privilege database roles; the Axum runtime account must not be a superuser.

## Tauri Security Rules

- Use HTTPS for every API request.
- Use certificate pinning only with a documented key-rotation and recovery strategy. Include backup pins and an app-update path.
- Store refresh tokens and sensitive values only in the OS secure credential store: iOS Keychain on iOS, Android Keystore-backed encrypted storage on Android, and the platform-appropriate secure storage mechanism on desktop.
- Never store access tokens, passwords, private keys, PII, or session data in localStorage, sessionStorage, unencrypted SQLite, logs, screenshots, or downloadable files.
- Keep access tokens in memory where possible.
- Clear tokens and sensitive cached data on logout, account deletion, and suspected compromise.
- Encrypt local databases and files containing sensitive user content.
- Minimize locally retained personal data.
- Apply Tauri capability permissions with least privilege. Enable only the plugins, commands, permissions, and native APIs the app actually needs.
- Never expose broad filesystem, shell, HTTP, or process-execution capabilities to the webview.
- Treat every Tauri command as a trust boundary: validate arguments, authorize the caller/session, and avoid returning privileged data unnecessarily.
- Prefer explicit, narrowly scoped Tauri commands over generic command dispatchers.
- Keep Tauri Rust backend code separate from UI state and never place authorization decisions in Svelte/JavaScript.
- Configure a strict Content Security Policy for webview content.
- Disable or restrict navigation to untrusted remote origins.
- Validate and sanitize all content rendered in the webview; avoid `@html` with untrusted data.
- Keep Tauri, plugin, frontend, and Rust dependencies updated; review plugin permissions and updater configuration in code review.

## Anti-Reverse-Engineering Rules

- Assume APK/IPA files, desktop installers, JavaScript bundles, Rust binaries, assets, and network traffic can be inspected.
- Reverse engineering cannot be fully prevented. Goal: raise attacker cost while ensuring backend security does not depend on client secrecy.
- Minify production JavaScript/TypeScript and avoid shipping source maps publicly.
- Strip debug symbols, debug logging, test accounts, staging URLs, mock data, and development-only plugins from release builds.
- Obfuscate identifiers and sensitive strings where useful, but never store real secrets in frontend code, Tauri configuration, or assets.
- Move proprietary algorithms, license logic, pricing logic, and high-value business rules to Axum.
- Use root/jailbreak detection, emulator detection, debugger detection, tampering detection, integrity checks, and screenshot protection only as defense-in-depth.
- Report client security detections to Axum; do not make authorization or entitlement decisions solely from a client signal.
- Respond to detections gradually: log, require reauthentication, restrict high-risk features, or block clearly abusive sessions. Avoid crashing legitimate users on possible false positives.

### Tauri release build commands

Android:

```bash
bun --bun run tauri android build
```

iOS:

```bash
bun --bun run tauri ios build
```

Desktop:

```bash
bun --bun run tauri build
```

Sign Android, iOS, and desktop release artifacts using the platform-appropriate signing configuration. Never commit signing keys or credentials.

## SvelteKit Security Rules

- Put secrets and privileged logic only in server-only contexts: `$lib/server/`, `*.server.ts`, `+page.server.ts`, `+server.ts`, or `hooks.server.ts`.
- Use `$env/static/private` or `$env/dynamic/private` for private environment values.
- Never import private environment modules into client-executed code.
- Review imports carefully: importing a server-only module into a client component can leak its contents into the browser bundle.
- Store web session identifiers or refresh tokens in HttpOnly, Secure, SameSite cookies.
- Do not store long-lived credentials in localStorage.
- Validate sessions in `hooks.server.ts` before protected pages or API routes.
- Keep SvelteKit CSRF protections enabled for form actions.
- Escape user-generated content; avoid `@html` with untrusted data.
- Sanitize rich text or HTML with an allowlist-based sanitizer.
- Use a strict Content Security Policy and avoid `unsafe-inline` where practical.
- Add security headers: HSTS, `X-Content-Type-Options`, `Referrer-Policy`, and restrictive `Permissions-Policy`.
- Minify production JavaScript and never deploy source maps publicly.

## SvelteKit as BFF

- For web apps requiring sessions or third-party credentials, use SvelteKit server routes, form actions, or server hooks as a backend-for-frontend.
- Browser → SvelteKit server → Axum API.
- Keep third-party keys and privileged operations on the server.
- Send only the minimum data required by each page to the browser.
- Axum remains the authorization authority; SvelteKit must not independently make privileged decisions.

## Bun Supply-Chain Security

- Use Bun for JavaScript/TypeScript dependency management, scripts, testing, and runtime.
- Use `bun install`, `bun add`, `bun remove`, `bun run`, `bunx`, and `bun test`.
- Treat `bun.lock` as the source of truth for dependency versions.
- Review `bun.lock` changes in pull requests.
- Bun does not run arbitrary dependency lifecycle scripts by default.
- Treat `trustedDependencies` as a privileged allowlist.
- Before adding a package to `trustedDependencies`, verify why it needs a lifecycle script and review exactly what the script executes.
- Keep `trustedDependencies` as small as possible.
- Never enable lifecycle scripts for unreviewed or untrusted packages.
- Run dependency audits and vulnerability scans in CI.
- For production SvelteKit installs, use:

```bash
bun install --production --frozen-lockfile
```

### SvelteKit commands

- Install: `bun install`
- Add dependency: `bun add <package>`
- Add dev dependency: `bun add -d <package>`
- Develop: `bun --bun run dev`
- Type-check: `bun run check`
- Build: `bun --bun run build`
- Preview: `bun run preview`
- Test: `bun test`

### Tauri commands

- Install frontend dependencies: `bun install`
- Develop desktop app: `bun --bun run tauri dev`
- Develop Android app: `bun --bun run tauri android dev`
- Develop iOS app: `bun --bun run tauri ios dev`
- Build desktop app: `bun --bun run tauri build`
- Build Android app: `bun --bun run tauri android build`
- Build iOS app: `bun --bun run tauri ios build`

## AI Security Rules (CRITICAL)

Because this app utilizes LLMs and RAG, **OWASP LLM Top 10** mitigation is mandatory.

- **No Direct DB Access for LLMs**: Agents NEVER write raw SQL or have direct database access. They must propose actions to a deterministic "Tool Gateway".
- **Tool Gateway Pattern**: Every tool/action available to the LLM must be a discrete Rust function with strict typed inputs. The Rust backend MUST validate all arguments.
- **Human-in-the-Loop (HITL)**: Any agent action that modifies state (sending emails, deleting records, moving money) MUST output a `pending_approval` status, requiring the user to explicitly confirm via the Svelte UI before execution.
- **Untrusted RAG Context**: Treat all vector database data as untrusted. RAG data must be clearly delineated in the prompt to prevent indirect Prompt Injection (applicable regardless of the underlying vector DB technology in use).
- **Agent Authorization**: Agent tools inherit the authenticated user's permissions. Never grant an agent broader access than the user.
- **Agent Auditability**: Log tool invocations, arguments, approvals, denials, and resulting state changes without logging secrets or unnecessary personal data.

## CI/CD and Release Requirements

- Scan code and Git history for secrets.
- Scan Tauri/JavaScript/SvelteKit and Rust dependencies for vulnerabilities.
- Run `bun run check`, `bun test`, `cargo test`, `cargo clippy -- -D warnings`, and `cargo audit` where applicable.
- Run Tauri frontend and Rust checks for every supported mobile/desktop target.
- Require reviewed pull requests and protected branches for production deployments.
- Build release artifacts from clean CI environments.
- Sign release artifacts and verify updater signatures.
- Verify that release builds contain no debug endpoints, source maps, test accounts, staging configuration, or private environment files.
- Separate build, staging, and production credentials.
- Maintain rollback and forced-update processes for mobile and desktop clients.

## Monitoring and Incident Response

- Centralize security logs from Tauri, SvelteKit, and Axum.
- Alert on repeated authorization failures, token replay, abnormal API usage, spikes in 401/403 responses, unusual devices, and suspicious client versions.
- Maintain the ability to revoke refresh tokens, rotate signing keys, disable API keys, and force password resets.
- Perform periodic penetration tests and reverse-engineering assessments against release builds, not only development builds.
- Use OWASP MASVS and MASTG as the baseline for mobile security review.

## Security Review Workflow

Before implementing a feature, identify:

1. What data crosses a trust boundary.
2. What must be authorized in Axum.
3. What secrets or privileged operations must remain server-side.
4. What client-side checks are only UX or defense-in-depth.
5. What abuse, replay, rate-limit, and logging controls are needed.

When changing authentication, payments, file access, permissions, native capabilities, Tauri commands, or API contracts:

- State the security impact.
- State the required backend authorization checks.
- Add or update tests for authorization, validation, token handling, and abuse resistance.
- Do not bypass, weaken, or remove security controls to make implementation easier.

## Git Workflow

- **Conventional Commits**: `<type>(<scope>): <description>` (e.g., `feat`,
  `fix`, `chore`). Imperative mood, < 50 chars. Explain _what_ and _why_ in the
  body, wrapped at 72 chars. Use `BREAKING CHANGE:` footer if applicable. The
  commit command must use the `-s` flag to add a Signed-off-by trailer.

<!-- CODEGRAPH_START -->

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it is listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.

<!-- CODEGRAPH_END -->

<!-- codebase-memory-mcp:start -->

## Codebase Knowledge Graph (codebase-memory-mcp)

This project uses codebase-memory-mcp to maintain a knowledge graph of the codebase.
ALWAYS prefer MCP graph tools over grep/glob/file-search for code discovery.

### Priority Order

1. `search_graph` — find functions, classes, routes, variables by pattern
2. `trace_path` — trace who calls a function or what it calls
3. `get_code_snippet` — read specific function/class source code
4. `query_graph` — run Cypher queries for complex patterns
5. `get_architecture` — high-level project summary

### When to fall back to grep/glob

- Searching for string literals, error messages, config values
- Searching non-code files (Dockerfiles, shell scripts, configs)
- When MCP tools return insufficient results

### Examples

- Find a handler: `search_graph(name_pattern=".*OrderHandler.*")`
- Who calls it: `trace_path(function_name="OrderHandler", direction="inbound")`
- Read source: `get_code_snippet(qualified_name="pkg/orders.OrderHandler")`
<!-- codebase-memory-mcp:end -->

<!-- context7 -->

## Context7 (ctx7) Documentation

Use the `ctx7` CLI to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

### Steps

1. Resolve library: `npx ctx7@latest library <name> "<user's question>"` — use the official library name with proper punctuation (e.g., "Next.js" not "nextjs", "Customer.io" not "customer.io", "Three.js" not "nextjs")
2. Pick the best match (ID format: `/org/project`) by: exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question)
3. Fetch docs: `npx ctx7@latest docs <libraryId> "<user's question>"`
4. Answer using the fetched documentation

You MUST call `library` first to get a valid ID unless the user provides one directly in `/org/project` format. Use the user's full question as the query -- specific and detailed queries return better results than vague single words. Do not run more than 3 commands per question. Do not include sensitive information (API keys, passwords, credentials) in queries.

For version-specific docs, use `/org/project/version` from the `library` output (e.g., `/vercel/next.js/v14.3.0`).

If a command fails with a quota error, inform the user and suggest `npx ctx7@latest login` or setting `CONTEXT7_API_KEY` env var for higher limits. Do not silently fall back to training data.

<!-- /context7 -->

## TUI Development (ratatui)

Use `ratatui` (0.30+) with `crossterm` (0.28+) for all TUI applications.

### Project Layout

- `src/main.rs` — entry point, event loop setup
- `src/ui.rs` — **pure render only** (state in, widgets out, never mutate)
- `src/app.rs` — state and handlers
- Larger apps: add `src/event.rs`, `src/handler.rs`, `src/action.rs`

### Event Handling

- Always `event::poll(timeout)` + `event::read()`, never block on `read()` alone
- Filter `KeyEventKind::Press` to avoid double-handling
- Use `ratatui::run(|mut terminal| {...})` for automatic init/restore

### Components

- Custom `Component` trait: `handle_key(&mut self, key) -> Option<AppAction>` + `render(&self, frame, area)`
- `App` owns state, renders children in `Widget` impl
- Layout: `Layout::vertical/constraints` → `.areas(area)` destructuring
- `Constraint::Fill(1)` for equal splits, `Length(n)` fixed, `Min(n)` minimum

### Styling

- Use `Stylize` trait: `"text".red().on_blue().bold()`
- Define a `Theme` struct, never hardcode colors

### Error Handling

- Set panic hook calling `ratatui::restore()` to prevent bricked terminal
- `thiserror` for larger apps, `Box<dyn Error>` for small ones

### Anti-Patterns

1. Blocking on `event::read()` without `event::poll()`
2. Mutating state during render
3. Overengineering state management (no RefCell/Arc<Mutex> too early)
4. Passing state through 5+ layers
5. Not restoring terminal on panic
6. Hardcoding colors/styles (use theme struct)
7. Mixing business logic with rendering

## Python Prototyping Stack

Default stack for quick prototyping with Python. Use the latest Python version and its built-in features wherever possible.

### Tools (astral-sh)

- [**uv**](https://pypi.org/project/uv/) — Extremely fast package installer, drop-in replacement for pip. Use for all dependency management: `uv add`, `uv sync`, `uv run`.
- [**ty**](https://docs.astral.sh/ty/) — Extremely fast Python type checker and language server, written in Rust. Use for type checking.
- [**ruff**](https://docs.astral.sh/ruff/) — Extremely fast Python linter and code formatter, written in Rust. Use for linting and formatting (replaces flake8, isort, black).

### Validation

- [**Pydantic**](https://docs.pydantic.dev/latest/) — The most widely used data validation library for Python. Use Pydantic V2 for schema validation, settings management, and data models.

### Principles

- Always follow [The Zen of Python](https://peps.python.org/pep-020/) (PEP 20)
- Security, performance, and best practices are non-negotiable
- Prefer stdlib first, then the tools above
- Use `uv` for all package management — never call `pip` directly
- Type-check with `ty`, lint and format with `ruff`
- Validate all data at trust boundaries with Pydantic
- Use the latest Python version features (type hints, match statements, structural pattern matching, etc.)

## Caveman Mode (Persistence)

ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure. Off only: "stop caveman" / "normal mode".

Default: **full**. Switch: `/caveman lite|full|ultra`.

### Rules

Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). No tool-call narration, no decorative tables/emoji, no dumping long raw error logs unless asked — quote shortest decisive line. Standard well-known tech acronyms OK (DB/API/HTTP); never invent new abbreviations reader can't decode. Technical terms exact. Code blocks unchanged. Errors quoted exact.

Preserve user's dominant language. User write Portuguese → reply Portuguese caveman. User write Spanish → reply Spanish caveman. Compress the style, not the language. No forced English openings or status phrases. ALWAYS keep technical terms, code, API names, CLI commands, commit-type keywords (feat/fix/...), and exact error strings verbatim — unless user explicitly ask for translation.

No self-reference. Never name or announce the style. No "caveman mode on", "me caveman think", no third-person caveman tags. Output caveman-only — never normal answer plus "Caveman:" recap. Exception: user explicitly ask what the mode is.

Pattern: `[thing] [action] [reason]. [next step].`

Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"

### Intensity

| Level     | What change                                                                                                                                                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **lite**  | No filler/hedging. Keep articles + full sentences. Professional but tight                                                                                                                                                                                                     |
| **full**  | Drop articles, fragments OK, short synonyms. Classic caveman. No tool-call narration, no decorative tables/emoji, no long raw error-log dumps unless asked. Standard acronyms OK; no invented abbreviations                                                                   |
| **ultra** | Abbreviate prose words (DB/auth/config/req/res/fn/impl) — prose words only, never real code symbols/function names. Strip conjunctions, arrows for causality (X → Y), one word when one word enough. Code symbols, function names, API names, error strings: never abbreviate |

### Auto-Clarity

Drop caveman when:

- Security warnings
- Irreversible action confirmations
- Multi-step sequences where fragment order or omitted conjunctions risk misread
- Compression itself creates technical ambiguity
- User asks to clarify or repeats question

Resume caveman after clear part done.

### Boundaries

Code/commits/PRs: write normal. "stop caveman" or "normal mode": revert. Level persist until changed or session end.

## Agent Operating Procedures

- **Fast Search**: ALWAYS use `rg` instead of `grep`, and `fd` (or `fdfind`) instead of `find`.
- **MCP First**: Prioritize MCP tools over generic CLI commands.
- **Act, Don't Ask**: Execute valid plans immediately. Only ask for missing context or major architectural tie-breakers.
- **Cleanup**: Delete all temporary files/scripts before concluding.
- **Package Managers**: ONLY use `bun` (`bun add`, `bun run`) for JS/TS. NEVER use npm/yarn/pnpm. Do NOT suggest global installs.
- **Security First**: Never weaken auth, authorization, validation, rate limiting, secret handling, or anti-tampering controls to simplify implementation.

<!-- headroom:rtk-instructions -->

# RTK (Rust Token Killer) - Token-Optimized Commands

When running shell commands, **always prefix with `rtk`**. This reduces context
usage by 60-90% with zero behavior change. If rtk has no filter for a command,
it passes through unchanged — so it is always safe to use.

## Key Commands

```bash
# Git (59-80% savings)
rtk git status          rtk git diff            rtk git log

# Files & Search (60-75% savings)
rtk ls <path>           rtk read <file>         rtk grep <pattern>
rtk find <pattern>      rtk diff <file>

# Test (90-99% savings) — shows failures only
rtk pytest tests/       rtk cargo test          rtk test <cmd>

# Build & Lint (80-90% savings) — shows errors only
rtk tsc                 rtk lint                rtk cargo build
rtk prettier --check    rtk mypy                rtk ruff check

# Analysis (70-90% savings)
rtk err <cmd>           rtk log <file>          rtk json <file>
rtk summary <cmd>       rtk deps                rtk env

# GitHub (26-87% savings)
rtk gh pr view <n>      rtk gh run list         rtk gh issue list

# Infrastructure (85% savings)
rtk docker ps           rtk kubectl get         rtk docker logs <c>

# Package managers (70-90% savings)
rtk pip list            rtk pnpm install        rtk npm run <script>
```

## Rules

- In command chains, prefix each segment: `rtk git add . && rtk git commit -m "msg"`
- For debugging, use raw command without rtk prefix
- `rtk proxy <cmd>` runs command without filtering but tracks usage
<!-- /headroom:rtk-instructions -->
