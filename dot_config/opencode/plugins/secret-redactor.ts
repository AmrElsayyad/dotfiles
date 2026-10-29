import { Plugin } from "@opencode/plugin"

// In-memory secret redactor for OpenCode v2.
// Secrets never leave the process: detected values are swapped for stable
// `🔒label🔓` tokens before prompts/context/tool output reach the model, and
// restored only when a tool is about to execute locally.

const REDACT_OUTPUT_TOOLS = ["bash", "shell", "read", "grep", "webfetch", "write", "edit"]
const UNREDACT_ARGS_TOOLS = ["bash", "shell", "read", "grep", "webfetch", "write", "edit"]
const MIN_SECRET_LENGTH = 8
const REDACTED_PREFIX = "🔒"
const REDACTED_SUFFIX = "🔓"

interface SecretPattern {
  label: string
  pattern: RegExp
  validate?: (value: string) => boolean
}

const NON_SECRET_IDENTIFIERS = /^(?:string|number|boolean|unknown|any|object|void|never|null|undefined|true|false)\b/i

const PATTERNS: SecretPattern[] = [
  // -- GitLab token family --
  { label: "gitlab_pat", pattern: /glpat-[A-Za-z0-9\-_]{20,}/g },
  { label: "gitlab_pipeline_trigger", pattern: /glptt-[A-Za-z0-9\-_]{20,}/g },
  { label: "gitlab_deploy_token", pattern: /gldt-[A-Za-z0-9\-_]{20,}/g },
  { label: "gitlab_ci_job_token", pattern: /glcbt-[A-Za-z0-9\-_]{20,}/g },
  { label: "gitlab_runner_token", pattern: /glrt-[A-Za-z0-9\-_]{20,}/g },
  { label: "gitlab_service_account", pattern: /glsoat-[A-Za-z0-9\-_]{20,}/g },
  { label: "gitlab_feed_token", pattern: /glft-[A-Za-z0-9\-_]{20,}/g },
  { label: "gitlab_incoming_mail", pattern: /glimt-[A-Za-z0-9\-_]{20,}/g },
  { label: "gitlab_oauth_secret", pattern: /gloas-[A-Za-z0-9\-_]{20,}/g },
  { label: "gitlab_agent_token", pattern: /glagent-[A-Za-z0-9\-_]{20,}/g },
  // -- GitHub token family --
  { label: "github_pat", pattern: /ghp_[A-Za-z0-9]{36,}/g },
  { label: "github_oauth", pattern: /gho_[A-Za-z0-9]{36,}/g },
  { label: "github_app_token", pattern: /ghu_[A-Za-z0-9]{36,}/g },
  { label: "github_app_install", pattern: /ghs_[A-Za-z0-9]{36,}/g },
  { label: "github_fine_grained", pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
  // -- AWS --
  { label: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g },
  {
    label: "aws_secret_key",
    pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|SecretAccessKey)[=:\s"']+([A-Za-z0-9/+=]{40})/g,
  },
  // -- AI providers (anthropic before openai to avoid prefix collision) --
  { label: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { label: "openai_project_key", pattern: /sk-proj-[A-Za-z0-9\-_]{20,}/g },
  { label: "openai_key", pattern: /sk-(?!ant-)(?!proj-)[A-Za-z0-9]{20,}/g },
  { label: "cohere_key", pattern: /co-[A-Za-z0-9]{30,}/g },
  { label: "huggingface_token", pattern: /hf_[A-Za-z0-9]{30,}/g },
  // -- Google Cloud --
  { label: "google_api_key", pattern: /AIza[0-9A-Za-z\-_]{35}/g },
  { label: "google_oauth_secret", pattern: /GOCSPX-[A-Za-z0-9\-_]{28}/g },
  { label: "gcloud_access_token", pattern: /ya29\.[A-Za-z0-9\-_]{50,}/g },
  { label: "google_refresh_token", pattern: /1\/\/[A-Za-z0-9\-_]{40,}/g },
  // -- Cloud infrastructure --
  { label: "digitalocean_pat", pattern: /dop_v1_[a-f0-9]{64}/g },
  { label: "digitalocean_oauth", pattern: /doo_v1_[a-f0-9]{64}/g },
  { label: "hashicorp_vault", pattern: /hvs\.[A-Za-z0-9]{24,}/g },
  {
    label: "heroku_api_key",
    pattern: /(?:HEROKU_API_KEY|heroku_api_key)[=:\s"']+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g,
  },
  { label: "vercel_token", pattern: /vercel_[A-Za-z0-9]{24,}/g },
  // -- SaaS --
  { label: "slack_token", pattern: /xox[bpors]-[A-Za-z0-9-]{10,}/g },
  {
    label: "slack_webhook",
    pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
  },
  { label: "twilio_api_key", pattern: /SK[a-f0-9]{32}/g },
  { label: "sendgrid_key", pattern: /SG\.[A-Za-z0-9\-_]{22,}\.[A-Za-z0-9\-_]{22,}/g },
  { label: "postman_key", pattern: /PMAK-[A-Za-z0-9-]{50,}/g },
  { label: "datadog_api_key", pattern: /dd[a-z]{1,2}_[A-Za-z0-9]{32,40}/g },
  // -- Payments --
  { label: "stripe_secret", pattern: /sk_(?:test|live)_[A-Za-z0-9]{10,}/g },
  { label: "stripe_restricted", pattern: /rk_(?:test|live)_[A-Za-z0-9]{10,}/g },
  { label: "stripe_webhook", pattern: /whsec_[A-Za-z0-9]{32,}/g },
  { label: "square_access_token", pattern: /sq0atp-[A-Za-z0-9\-_]{22,}/g },
  { label: "square_oauth", pattern: /sq0csp-[A-Za-z0-9\-_]{43}/g },
  // -- Package registries --
  { label: "npm_token", pattern: /npm_[A-Za-z0-9]{36,}/g },
  { label: "pypi_token", pattern: /pypi-[A-Za-z0-9\-_]{50,}/g },
  { label: "rubygems_key", pattern: /rubygems_[A-Za-z0-9]{48}/g },
  // -- Auth tokens --
  { label: "jwt", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { label: "bearer_token", pattern: /Bearer\s+[A-Za-z0-9\-._~+/]{8,}=*/g },
  { label: "basic_auth", pattern: /Basic\s+[A-Za-z0-9+/]{10,}={0,2}/g },
  {
    label: "private_key",
    pattern: /-----BEGIN\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY-----/g,
  },
  // -- Database URLs --
  {
    label: "database_url",
    pattern: /(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/g,
  },
  // -- Observability --
  { label: "sentry_dsn", pattern: /https:\/\/[a-f0-9]{32}@[^\s/]+\.ingest\.sentry\.io\/[0-9]+/g },
  { label: "grafana_api_key", pattern: /glc_[A-Za-z0-9\-_]{32,}/g },
  { label: "doppler_token", pattern: /dp\.st\.[A-Za-z0-9_-]{40,}/g },
  // -- Azure / Microsoft --
  {
    label: "azure_connection_string",
    pattern: /DefaultEndpointsProtocol=https?;AccountName=[^;\s]+;AccountKey=[A-Za-z0-9+/]{86}==[^\s"']*/g,
  },
  { label: "azure_storage_key", pattern: /AccountKey=([A-Za-z0-9+/]{86}==)/g },
  { label: "azure_sas_token", pattern: /[?&]sig=([A-Za-z0-9%+/=]{40,})/g },
  // -- Shopify --
  { label: "shopify_access_token", pattern: /shpat_[a-fA-F0-9]{20,}/g },
  { label: "shopify_custom_app", pattern: /shpca_[a-fA-F0-9]{20,}/g },
  { label: "shopify_private_app", pattern: /shppa_[a-fA-F0-9]{20,}/g },
  { label: "shopify_shared_secret", pattern: /shpss_[a-fA-F0-9]{20,}/g },
  // -- Additional SaaS --
  { label: "mailgun_api_key", pattern: /key-[a-z0-9]{30,}/g },
  { label: "mailchimp_api_key", pattern: /[a-f0-9]{32}-us\d{1,2}/g },
  { label: "linear_api_key", pattern: /lin_api_[A-Za-z0-9]{40,}/g },
  {
    label: "terraform_cloud_token",
    pattern: /[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9\-_]{60,}/g,
  },
  { label: "pulumi_token", pattern: /pul-[a-f0-9]{40}/g },
  { label: "docker_pat", pattern: /dckr_pat_[A-Za-z0-9\-_]{24,}/g },
  { label: "age_secret_key", pattern: /AGE-SECRET-KEY-1[A-Za-z0-9]{58}/g },
  // -- SSH public keys --
  { label: "ssh_public_key", pattern: /ssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/]{60,}={0,2}/g },
  {
    label: "ssh_ecdsa_key",
    pattern: /ecdsa-sha2-nistp(?:256|384|521)\s+[A-Za-z0-9+/]{60,}={0,2}/g,
  },
  // -- PII --
  { label: "email", pattern: /(?<![\w.%+-])[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  {
    label: "credit_card",
    pattern: /\b(?:4[0-9]{3}|5[1-5][0-9]{2}|3[47][0-9]{2}|6(?:011|5[0-9]{2}))[-\s]?[0-9]{4}[-\s]?[0-9]{4}[-\s]?[0-9]{3,4}\b/g,
  },
  { label: "us_ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: "phone_us", pattern: /\+1[-.\s]?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}/g },
  { label: "uuid", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi },
  {
    label: "ipv4",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
  },
  { label: "mac", pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g },
  { label: "china_phone", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  {
    label: "china_id",
    pattern: /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
  },
  // -- Generic env var secrets (last -- most generic) --
  {
    label: "env_secret",
    pattern: /(?:password|passwd|secret|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?token|encryption[_-]?key|signing[_-]?key|db[_-]?password|database[_-]?password)\s*[=:]\s*(?:"([^"]{8,})"|'([^']{8,})'|([^\s"',;)\]}]{8,}))/gi,
    validate: (value) =>
      !NON_SECRET_IDENTIFIERS.test(value) &&
      (value.length >= 20 || /[0-9]/.test(value) || /[^A-Za-z]/.test(value)),
  },
]

interface DetectedSecret {
  label: string
  value: string
}

function detectSecrets(text: string): DetectedSecret[] {
  const found: DetectedSecret[] = []
  const seen = new Set<string>()

  for (const { label, pattern, validate } of PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags)
    let match = regex.exec(text)
    while (match !== null) {
      const captured = match.slice(1).find((group) => group !== undefined)
      const value = captured ?? match[0]
      // A token from an earlier pass is never a secret; storing it would
      // rewrite token-to-token and corrupt restore.
      const isToken = value.includes(REDACTED_PREFIX) || value.includes(REDACTED_SUFFIX)
      if (
        !isToken &&
        !seen.has(value) &&
        value.length >= MIN_SECRET_LENGTH &&
        (validate === undefined || validate(value))
      ) {
        seen.add(value)
        found.push({ label, value })
      }
      match = regex.exec(text)
    }
  }

  return found
}

interface Vault {
  store(label: string, value: string): string
  scrubText(text: string): string
  unscrubText(text: string): string
  readonly size: number
}

function createVault(): Vault {
  const tokenByValue = new Map<string, string>()
  const valueByToken = new Map<string, string>()

  function store(label: string, value: string): string {
    const existing = tokenByValue.get(value)
    if (existing) return existing

    // Tokens must be unique per value: labels repeat across calls.
    const base = `${REDACTED_PREFIX}${label}${REDACTED_SUFFIX}`
    let token = base
    let suffix = 2
    while (valueByToken.has(token)) {
      token = `${REDACTED_PREFIX}${label}_${suffix}${REDACTED_SUFFIX}`
      suffix++
    }
    tokenByValue.set(value, token)
    valueByToken.set(token, value)
    return token
  }

  function scrubText(text: string): string {
    let result = text
    for (const [value, token] of tokenByValue) {
      result = result.split(value).join(token)
    }
    return result
  }

  function unscrubText(text: string): string {
    let result = text
    for (const [token, value] of valueByToken) {
      result = result.split(token).join(value)
    }
    return result
  }

  return {
    store,
    scrubText,
    unscrubText,
    get size() {
      return tokenByValue.size
    },
  }
}

interface Redaction {
  value: unknown
  labels: string[]
}

function redactString(text: string, vault: Vault): { text: string; labels: string[] } {
  // Detect against the original text: scrubbed tokens are not secrets.
  const labels: string[] = []

  for (const secret of detectSecrets(text)) {
    vault.store(secret.label, secret.value)
    labels.push(secret.label)
  }

  return { text: vault.scrubText(text), labels }
}

// Prompt text must not scrub values from earlier prompts: a false positive
// stored once would otherwise rewrite every later prompt.
function redactCurrentText(text: string, vault: Vault): string {
  let result = text
  for (const secret of detectSecrets(text)) {
    const token = vault.store(secret.label, secret.value)
    result = result.split(secret.value).join(token)
  }
  return result
}

function redactDeep(value: unknown, vault: Vault): Redaction {
  const labels: string[] = []
  return { value: redactValue(value, vault, labels), labels }
}

function unredactDeep(value: unknown, vault: Vault): unknown {
  if (typeof value === "string") return vault.unscrubText(value)
  if (Array.isArray(value)) return value.map((item) => unredactDeep(item, vault))
  if (value instanceof Map) {
    const next = new Map<unknown, unknown>()
    for (const [key, item] of value) {
      next.set(unredactDeep(key, vault), unredactDeep(item, vault))
    }
    return next
  }
  if (value instanceof Set) {
    const next = new Set<unknown>()
    for (const item of value) next.add(unredactDeep(item, vault))
    return next
  }
  if (isTraversable(value)) {
    const target = Object.isFrozen(value) ? cloneObject(value) : value
    for (const key of Object.keys(target)) {
      target[key] = unredactDeep(target[key], vault)
    }
    return target
  }
  return value
}

function redactValue(value: unknown, vault: Vault, labels: string[]): unknown {
  if (typeof value === "string") {
    const result = redactString(value, vault)
    labels.push(...result.labels)
    return result.text
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, vault, labels))
  }
  if (value instanceof Map) {
    const next = new Map<unknown, unknown>()
    for (const [key, item] of value) {
      next.set(redactValue(key, vault, labels), redactValue(item, vault, labels))
    }
    return next
  }
  if (value instanceof Set) {
    const next = new Set<unknown>()
    for (const item of value) next.add(redactValue(item, vault, labels))
    return next
  }
  if (isTraversable(value)) {
    const target = Object.isFrozen(value) ? cloneObject(value) : value
    for (const key of Object.keys(target)) {
      target[key] = redactValue(target[key], vault, labels)
    }
    return target
  }
  return value
}

// Copy descriptors so a frozen object can be redacted without losing its prototype.
function cloneObject<T extends object>(value: T): T {
  const clone = Object.create(Object.getPrototypeOf(value)) as T
  const source = value as Record<string, unknown>
  const target = clone as Record<string, unknown>
  for (const key of Object.keys(source)) {
    try {
      target[key] = source[key]
    } catch {
      // Readonly accessors cannot be copied; leave them on the prototype.
    }
  }
  return clone
}

// Class instances (Effect Schema parts/messages) must be traversed too;
// restricting to plain objects silently skipped them.
function isTraversable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface SessionRequestLike {
  system?: unknown
  messages?: unknown
  metadata?: unknown
  result?: unknown
}

function redactSessionRequest(event: SessionRequestLike, vault: Vault): void {
  if (Array.isArray(event.system)) {
    for (let index = 0; index < event.system.length; index += 1) {
      const part = event.system[index]
      if (typeof part !== "object" || part === null) continue
      const record = part as Record<string, unknown>
      if (typeof record.text === "string") {
        record.text = redactString(record.text, vault).text
      }
      if (record.metadata !== undefined && record.metadata !== null) {
        record.metadata = redactDeep(record.metadata, vault).value
      }
    }
  }

  if (Array.isArray(event.messages)) {
    for (const message of event.messages) {
      if (typeof message !== "object" || message === null) continue
      const content = (message as Record<string, unknown>).content
      if (!Array.isArray(content)) continue
      for (let index = 0; index < content.length; index += 1) {
        content[index] = redactDeep(content[index], vault).value
      }
    }
  }

  if (event.metadata !== undefined && event.metadata !== null) {
    event.metadata = redactDeep(event.metadata, vault).value
  }

  if (typeof event.result === "string") {
    event.result = redactString(event.result, vault).text
  } else if (typeof event.result === "object" && event.result !== null) {
    const result = cloneObject(event.result as Record<string, unknown>)
    if (typeof result.summary === "string") {
      result.summary = redactString(result.summary, vault).text
    }
    if (result.metadata !== undefined && result.metadata !== null) {
      result.metadata = redactDeep(result.metadata, vault).value
    }
    event.result = result
  }
}

interface PromptLike {
  text?: unknown
  files?: unknown
  metadata?: unknown
}

function redactPrompt(event: { prompt?: unknown; metadata?: unknown }, vault: Vault): void {
  if (typeof event.prompt !== "object" || event.prompt === null) return
  const prompt = cloneObject(event.prompt as Record<string, unknown>)

  if (typeof prompt.text === "string") {
    prompt.text = redactCurrentText(prompt.text, vault)
  }

  if (Array.isArray(prompt.files)) {
    prompt.files = prompt.files.map((file) => {
      if (typeof file !== "object" || file === null) return file
      const record = cloneObject(file as Record<string, unknown>)
      for (const key of ["uri", "name", "description"]) {
        if (typeof record[key] === "string") {
          record[key] = redactCurrentText(record[key] as string, vault)
        }
      }
      if (record.mention !== undefined && record.mention !== null && typeof record.mention === "object") {
        const mention = cloneObject(record.mention as Record<string, unknown>)
        if (typeof mention.text === "string") {
          mention.text = redactCurrentText(mention.text, vault)
        }
        record.mention = mention
      }
      return record
    })
  }

  if (prompt.metadata !== undefined && prompt.metadata !== null) {
    prompt.metadata = redactDeep(prompt.metadata, vault).value
  }
  event.prompt = prompt

  if (event.metadata !== undefined && event.metadata !== null) {
    event.metadata = redactDeep(event.metadata, vault).value
  }
}

export default Plugin.define({
  id: "opencode-secret-redactor",
  async setup(ctx) {
    const vault = createVault()

    await ctx.session.hook("prompt", (event) => {
      try {
        redactPrompt(event, vault)
      } catch {
        // Never break a session because redaction failed.
      }
    })

    const sessionHook = (event: SessionRequestLike) => {
      try {
        redactSessionRequest(event, vault)
      } catch {
        // Never break a session because redaction failed.
      }
    }

    await ctx.session.hook("context", sessionHook)
    await ctx.session.hook("compaction", sessionHook)
    await ctx.session.hook("generate", sessionHook)
    await ctx.session.hook("title", sessionHook)

    await ctx.tool.hook("execute.after", (event) => {
      try {
        if (event.status !== "completed") return
        if (!REDACT_OUTPUT_TOOLS.includes(event.tool)) return

        const result = event.result
        const content = result.content !== undefined && result.content !== null
          ? redactDeep(result.content, vault).value
          : result.content
        const output = result.output !== undefined && result.output !== null
          ? redactDeep(result.output, vault).value
          : result.output
          try {
            if (content !== result.content) {
              ;(result as { content: unknown }).content = content
            }
            if (output !== result.output) {
              ;(result as { output: unknown }).output = output
            }
          } catch {
          try {
            ;(event as { result: unknown }).result = { ...result, content, output }
          } catch {
            // Frozen event: mutation is the only hook mechanism available.
          }
        }
      } catch {
        // Never break a session because redaction failed.
      }
    })

    await ctx.tool.hook("execute.before", (event) => {
      try {
        if (!UNREDACT_ARGS_TOOLS.includes(event.tool)) return
        event.input = unredactDeep(event.input, vault)
      } catch {
        // Never break a session because unredaction failed.
      }
    })
  },
})
