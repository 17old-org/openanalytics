import type { ServiceEnv } from '@openanalytics/domain'
import {
  createCredentialVault,
  CredentialKeyringError,
  EMAIL_OUTBOX_TOPIC,
  processEmailOutbox,
  resolveStoredSmtpBlock,
  selectEmailTransport,
  type CredentialVault,
  type EmailOutboxStore,
  type EmailTransport,
  type SmtpEnvBlock,
} from '@openanalytics/integrations'
import type { Logger } from '@openanalytics/observability'
import {
  claimDueOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  readDeploymentSetting,
  type Database,
} from '@openanalytics/postgres'

/**
 * Email delivery is a worker job (docs snapshot 02 §5): the API only writes the
 * send to the outbox, and this loop drains it through whichever transport is
 * configured — Sendflare, Resend, SMTP, or the log transport when none is.
 *
 * Since migration 0043 there are two places a transport can come from, and this
 * file is where they are reconciled. **A transport stored in the database wins
 * over the environment.** That direction is the one the operator expects: they
 * typed it into a screen a moment ago, they can see it, and they can change it
 * without a shell. An env file is set once and forgotten, and being unable to
 * override it from the product was the wall the self-host dry run kept hitting.
 * A deployment that wants the opposite sets `DEPLOYMENT_SETTINGS=disabled` and
 * this loop never reads the table at all.
 *
 * The stored transport is re-read each tick, so an operator who fixes a relay
 * sees the next queued message go out — no restart, which is the whole point.
 * The nodemailer client is still built once per *configuration*: the resolved
 * block is fingerprinted, and the transport is rebuilt only when the
 * fingerprint changes. Rebuilding per tick would re-run TLS negotiation every
 * five seconds for a setting that changes twice a year.
 */

const DEFAULT_INTERVAL_MS = 5_000

export function createEmailOutboxStore(db: Database): EmailOutboxStore {
  return {
    claimDue: (limit) => claimDueOutbox(db, { topic: EMAIL_OUTBOX_TOPIC, limit }),
    markDelivered: (id) => markOutboxDelivered(db, id),
    markFailed: (id, reason, options) => markOutboxFailed(db, id, reason, options),
  }
}

export interface EmailDrainDeps {
  readonly db: Database
  readonly env: ServiceEnv<'worker'>
  readonly logger: Logger
  readonly intervalMs?: number
}

export interface EmailDrain {
  stop(): Promise<void>
}

/**
 * A stable string identifying one resolved configuration.
 *
 * The password is included — a rotated credential on an unchanged host has to
 * rebuild the client, or the worker keeps authenticating with the old one — and
 * it is hashed rather than concatenated so this value can be compared without
 * ever being a place a secret could be logged by accident.
 */
function fingerprint(block: SmtpEnvBlock | undefined, source: string): string {
  if (block === undefined) return `${source}:none`
  const parts = [block.host, block.port, block.secure, block.user, block.from, block.pass]
  let hash = 0
  for (const value of parts.join('\0')) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(0)) | 0
  }
  return `${source}:${String(hash)}`
}

export function startEmailDrain(deps: EmailDrainDeps): EmailDrain {
  const store = createEmailOutboxStore(deps.db)
  // One sink, two levels, chosen by the one field that changes what an operator
  // should do. A retryable failure is traffic — the next tick handles it — and
  // belongs at `info`. A terminal one is a message that will never be sent, and
  // since it now ends at `failed` rather than `dead` it raises no alert of its
  // own (`markOutboxFailed`, and `worker_outbox_backlog` gauges only pending,
  // processing and dead). `warn` is what keeps it findable in the log instead of
  // disappearing quietly, which is the failure mode this whole change is
  // supposed to avoid rather than move.
  const log = (event: string, fields: Record<string, unknown>) =>
    fields['terminal'] === true ? deps.logger.warn(event, fields) : deps.logger.info(event, fields)

  /**
   * The vault, for the stored transport's password.
   *
   * Fail-closed and non-fatal, the billing precedent: a malformed ring means the
   * stored transport is not readable, so the loop falls back to the environment
   * and says so once. It does not stop the drain — mail that Resend or `SMTP_*`
   * can still deliver has nothing to do with the ring.
   */
  const vault: CredentialVault | undefined = (() => {
    if (deps.env.DEPLOYMENT_SETTINGS !== 'enabled') return undefined
    if (!deps.env.OA_CREDENTIAL_KEYRING) return undefined
    try {
      return createCredentialVault(deps.env.OA_CREDENTIAL_KEYRING)
    } catch (error) {
      deps.logger.warn('deployment_settings_not_readable', {
        reason: error instanceof CredentialKeyringError ? error.reason : 'keyring_unusable',
        detail: 'stored mail settings cannot be decrypted; the environment is used instead',
      })
      return undefined
    }
  })()

  const environmentBlock: SmtpEnvBlock = {
    host: deps.env.SMTP_HOST,
    port: deps.env.SMTP_PORT,
    secure: deps.env.SMTP_SECURE,
    user: deps.env.SMTP_USER,
    pass: deps.env.SMTP_PASS,
    from: deps.env.SMTP_FROM,
  }

  let transport: EmailTransport | undefined
  let currentFingerprint: string | undefined

  /**
   * The transport this tick should use.
   *
   * The database read is wrapped: an unreachable Postgres is already going to
   * fail the claim two lines later, and turning it into a thrown resolution
   * would replace "the drain retried" with "the drain crashed".
   */
  const resolveTransport = async (): Promise<EmailTransport> => {
    let stored: SmtpEnvBlock | undefined
    if (vault) {
      try {
        const row = await readDeploymentSetting(deps.db, 'email')
        if (row) stored = resolveStoredSmtpBlock({ row, scope: 'email', vault, log }) ?? undefined
      } catch (err) {
        deps.logger.warn('deployment_settings_read_failed', { err, retryable: true })
      }
    }

    const source = stored ? 'database' : 'environment'
    const block = stored ?? environmentBlock
    const next = fingerprint(stored ?? (block.host ? block : undefined), source)
    if (transport !== undefined && next === currentFingerprint) return transport

    transport = selectEmailTransport({
      // A stored relay wins over provider keys as well as over `SMTP_*`. Among
      // environment transports Sendflare wins, then Resend, then SMTP; every
      // conflict is logged by `selectEmailTransport`.
      ...(stored
        ? {}
        : {
            sendflareApiKey: deps.env.SENDFLARE_API_KEY,
            apiKey: deps.env.RESEND_API_KEY,
          }),
      smtp: block,
      defaultFrom: deps.env.EMAIL_FROM ?? 'noreply@localhost',
      log,
    })
    currentFingerprint = next

    // Stated on every change rather than only at startup, because the change is
    // now something an operator can cause from a screen and needs to see the
    // effect of. At `warn` when nothing is configured, for the reason it always
    // was: with the log transport the message is never delivered *and* never
    // written down, so a self-hoster who submits their address and goes looking
    // in the log finds nothing.
    if (transport.id === 'log') {
      const missing = [
        ...(deps.env.SENDFLARE_API_KEY ? [] : ['SENDFLARE_API_KEY']),
        ...(deps.env.RESEND_API_KEY ? [] : ['RESEND_API_KEY']),
        ...(deps.env.SMTP_HOST ? [] : ['SMTP_HOST']),
      ]
      deps.logger.warn('email_transport_selected', {
        transport: transport.id,
        source,
        missing,
        detail:
          'no mail transport is configured: store one from the deployment settings screen, or set ' +
          `${missing.join(' or ')} on the worker. Until then nothing is delivered, and the message ` +
          'body and sign-in link are written nowhere.',
      })
    } else {
      deps.logger.info('email_transport_selected', { transport: transport.id, source })
    }
    return transport
  }

  let running = false
  let stopped = false

  // No `reclaimStalledOutbox` call here, and the omission is deliberate rather
  // than an oversight — this loop needs the sweep as much as any, it just
  // already has it. The sweep is table-wide, not per-topic, and the outbox
  // dispatcher runs it at the top of every one of its own 5-second ticks; both
  // loops are started inside the same `if (env.DATABASE_URL)` block in main.ts,
  // so there is no deployment in which this one runs and that one does not. A
  // second identical statement here would be a duplicate write against the same
  // rows twice a tick, buying nothing. If the two loops are ever separated, this
  // is the comment that has to become a call.
  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const selected = await resolveTransport()
      const result = await processEmailOutbox({ store, transport: selected, log })
      if (result.claimed > 0) {
        deps.logger.info('email_outbox_drained', { ...result, transport: selected.id })
      }
    } catch (err) {
      deps.logger.error('email_outbox_drain_failed', { err, retryable: true })
    } finally {
      running = false
    }
  }

  // Kicked immediately rather than one interval from now, because
  // `email_transport_selected` is a *boot* line: "mail is silently going
  // nowhere" and "no mail has been queued yet" look identical until it is
  // written, and waiting five seconds to say so puts it after the first thing an
  // operator reads. It is a tick like any other — it drains too — and `stop()`
  // waits for it, so a process that starts and stops immediately still finishes
  // the work it claimed.
  void tick()
  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  // The drain must not by itself keep the process alive.
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}
