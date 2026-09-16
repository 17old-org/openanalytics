import {
  EMAIL_OUTBOX_TOPIC,
  buildMagicLinkEmailPayload,
  buildVerificationEmailPayload,
  createResendTransport,
  createSendflareTransport,
  createSmtpTransport,
  parseEmailOutboxPayload,
  processEmailOutbox,
  selectEmailTransport,
  type DueOutboxRow,
  type EmailMessage,
  type EmailOutboxStore,
  type SmtpMailer,
  type SmtpTransportConfig,
} from '@openanalytics/integrations'
import { describe, expect, it, vi } from 'vitest'

/** Captures the config a selection produced and never opens a socket. */
function recordingMailerFactory(): {
  factory: (config: SmtpTransportConfig) => SmtpMailer
  configs: SmtpTransportConfig[]
  sent: { from: string; to: string }[]
} {
  const configs: SmtpTransportConfig[] = []
  const sent: { from: string; to: string }[] = []
  return {
    configs,
    sent,
    factory: (config) => {
      configs.push(config)
      return {
        async sendMail(message) {
          sent.push({ from: message.from, to: message.to })
          return { messageId: '<abc@relay>' }
        },
      }
    },
  }
}

describe('email transport selection', () => {
  it('falls back to the log transport when nothing is configured', () => {
    const transport = selectEmailTransport({ defaultFrom: 'noreply@test' })
    expect(transport.id).toBe('log')
  })

  it('uses Resend when a key is present', () => {
    const transport = selectEmailTransport({ apiKey: 're_test', defaultFrom: 'noreply@test' })
    expect(transport.id).toBe('resend')
  })

  it('uses Sendflare when its key is present', () => {
    const transport = selectEmailTransport({
      sendflareApiKey: 'live_test',
      defaultFrom: 'noreply@test',
    })
    expect(transport.id).toBe('sendflare')
  })

  it('uses SMTP when a host is present and no Resend key is', () => {
    const transport = selectEmailTransport({
      smtp: { host: 'mail.test' },
      defaultFrom: 'noreply@test',
      smtpMailerFactory: recordingMailerFactory().factory,
    })
    expect(transport.id).toBe('smtp')
  })

  it('an SMTP block with no host is not a configured transport', () => {
    const transport = selectEmailTransport({
      smtp: { port: 587, user: 'someone' },
      defaultFrom: 'noreply@test',
    })
    expect(transport.id).toBe('log')
  })

  it('prefers Resend over SMTP and says so, rather than silently rerouting', () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const transport = selectEmailTransport({
      apiKey: 're_test',
      smtp: { host: 'mail.test' },
      defaultFrom: 'noreply@test',
      log: (event, fields) => events.push({ event, fields }),
    })
    expect(transport.id).toBe('resend')
    expect(events).toEqual([
      { event: 'email_transport_conflict', fields: { chose: 'resend', ignored: 'smtp' } },
    ])
  })

  it('prefers Sendflare over the other environment transports and says so', () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const transport = selectEmailTransport({
      sendflareApiKey: 'live_test',
      apiKey: 're_test',
      smtp: { host: 'mail.test' },
      defaultFrom: 'noreply@test',
      log: (event, fields) => events.push({ event, fields }),
    })
    expect(transport.id).toBe('sendflare')
    expect(events).toEqual([
      {
        event: 'email_transport_conflict',
        fields: { chose: 'sendflare', ignored: ['resend', 'smtp'] },
      },
    ])
  })

  it('defaults the port to submission and derives implicit TLS from it', async () => {
    const recorder = recordingMailerFactory()
    await selectEmailTransport({
      smtp: { host: 'mail.test' },
      defaultFrom: 'noreply@test',
      smtpMailerFactory: recorder.factory,
    }).send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

    expect(recorder.configs[0]).toMatchObject({ port: 587, secure: false })
  })

  it('turns implicit TLS on for port 465 without being told to', async () => {
    const recorder = recordingMailerFactory()
    await selectEmailTransport({
      smtp: { host: 'mail.test', port: 465 },
      defaultFrom: 'noreply@test',
      smtpMailerFactory: recorder.factory,
    }).send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

    expect(recorder.configs[0]).toMatchObject({ port: 465, secure: true })
  })

  it('lets an explicit SMTP_SECURE override the port-derived default', async () => {
    const recorder = recordingMailerFactory()
    await selectEmailTransport({
      smtp: { host: 'mail.test', port: 465, secure: false },
      defaultFrom: 'noreply@test',
      smtpMailerFactory: recorder.factory,
    }).send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

    expect(recorder.configs[0]).toMatchObject({ secure: false })
  })

  it('prefers SMTP_FROM over EMAIL_FROM, for relays that refuse a foreign sender', async () => {
    const recorder = recordingMailerFactory()
    await selectEmailTransport({
      smtp: { host: 'mail.test', from: 'relay-account@mail.test' },
      defaultFrom: 'Brand <hello@brand.test>',
      smtpMailerFactory: recorder.factory,
    }).send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

    expect(recorder.sent[0]?.from).toBe('relay-account@mail.test')
  })
})

describe('SMTP transport', () => {
  const config: SmtpTransportConfig = {
    host: 'mail.test',
    port: 587,
    secure: false,
    defaultFrom: 'noreply@test',
  }
  const message: EmailMessage = { to: 'a@b.com', subject: 's', html: '<p>h</p>' }

  it("returns the relay's message id on success", async () => {
    const transport = createSmtpTransport(config, () => ({
      sendMail: async () => ({ messageId: '<id@relay>' }),
    }))
    expect(await transport.send(message)).toEqual({ ok: true, id: '<id@relay>' })
  })

  it('builds the client once across sends rather than per message', async () => {
    const recorder = recordingMailerFactory()
    const transport = createSmtpTransport(config, recorder.factory)
    await transport.send(message)
    await transport.send(message)
    expect(recorder.configs).toHaveLength(1)
    expect(recorder.sent).toHaveLength(2)
  })

  it('authenticates only with a complete credential', async () => {
    const recorder = recordingMailerFactory()
    await createSmtpTransport({ ...config, user: 'someone' }, recorder.factory).send(message)
    expect(recorder.configs[0]?.pass).toBeUndefined()
  })

  it('maps auth, permanent and transient failures to the same reasons Resend uses', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ code: 'EAUTH', responseCode: 535 }, 'unauthorized'],
      [{ responseCode: 530 }, 'unauthorized'],
      [{ responseCode: 550 }, 'invalid'],
      [{ responseCode: 421 }, 'unavailable'],
      [{ code: 'ECONNECTION' }, 'unavailable'],
      [{ code: 'ETIMEDOUT' }, 'unavailable'],
      [{}, 'unavailable'],
    ]
    for (const [thrown, reason] of cases) {
      const transport = createSmtpTransport(config, () => ({
        sendMail: async () => {
          throw Object.assign(new Error('boom'), thrown)
        },
      }))
      const outcome = await transport.send(message)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason, JSON.stringify(thrown)).toBe(reason)
    }
  })

  it('never lets the relay reply text out — a reply to AUTH can echo the credential', async () => {
    const transport = createSmtpTransport(config, () => ({
      sendMail: async () => {
        throw Object.assign(new Error('535 5.7.8 Username and Password not accepted'), {
          code: 'EAUTH',
          responseCode: 535,
          response: '535 5.7.8 rejected credential hunter2',
        })
      },
    }))
    const outcome = await transport.send(message)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.detail).not.toContain('hunter2')
      expect(outcome.detail).not.toContain('Username')
      expect(outcome.detail).toContain('535')
    }
  })
})

describe('log transport', () => {
  it('captures messages and never logs the raw recipient', async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const transport = selectEmailTransport({
      defaultFrom: 'noreply@test',
      log: (event, fields) => events.push({ event, fields }),
    })

    const outcome = await transport.send({
      to: 'person@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
    })

    expect(outcome.ok).toBe(true)
    const logged = events[0]
    expect(logged?.fields).toMatchObject({ recipientDomain: 'example.com' })
    // The hard rule: no raw address anywhere in the log line.
    expect(JSON.stringify(events)).not.toContain('person@example.com')
  })
})

describe('Resend transport', () => {
  const config = { apiKey: 're_test', defaultFrom: 'noreply@test' }
  const message: EmailMessage = { to: 'a@b.com', subject: 's', html: '<p>h</p>' }

  it('returns the provider id on success', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: 're_123' }), { status: 200 }),
    )
    const outcome = await createResendTransport(config, fetchImpl as unknown as typeof fetch).send(
      message,
    )
    expect(outcome).toEqual({ ok: true, id: 're_123' })
  })

  /**
   * The header that makes the outbox's crash recovery safe to run.
   *
   * `reclaimStalledOutbox` returns a row abandoned in `processing` to the
   * queue, and it cannot know whether the dead worker sent the mail before it
   * died. Without this key, the fix for five stranded emails would have been a
   * mechanism that sends some emails twice.
   */
  it('sends the outbox row id as Resend Idempotency-Key', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ id: 're_123' }), { status: 200 }),
    )
    const transport = createResendTransport(config, fetchImpl as unknown as typeof fetch)

    await transport.send(message, { idempotencyKey: '01a0299e-5cda-77a2-bec6-4dedbddee140' })

    const init = fetchImpl.mock.calls[0]![1]
    const headers = init.headers as Record<string, string>
    expect(headers['idempotency-key']).toBe('01a0299e-5cda-77a2-bec6-4dedbddee140')
    // A REQUEST header, not a mail header: `message.headers` is serialized into
    // the JSON body and becomes a header of the delivered email, which is a
    // different thing entirely and would not deduplicate anything.
    expect(JSON.parse(String(init.body))).not.toHaveProperty('headers')
  })

  it('omits the header entirely when no key is given', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ id: 're_123' }), { status: 200 }),
    )
    const transport = createResendTransport(config, fetchImpl as unknown as typeof fetch)

    await transport.send(message)

    const init = fetchImpl.mock.calls[0]![1]
    // Absent, not empty-string: Resend treats a blank key as a key.
    expect(init.headers as Record<string, string>).not.toHaveProperty('idempotency-key')
  })

  it('maps auth, server and client errors to typed reasons', async () => {
    const cases: [number, string][] = [
      [401, 'unauthorized'],
      [503, 'unavailable'],
      [422, 'invalid'],
      // The two 4xx codes that mean "later", not "never". They sit in the same
      // table as the rest because the point is that they are *not* `invalid`:
      // `invalid` is terminal, so classifying a throttle as one discards the
      // mail instead of waiting a minute for it.
      [429, 'unavailable'],
      [408, 'unavailable'],
    ]
    for (const [status, reason] of cases) {
      const fetchImpl = vi.fn(async () => new Response('nope', { status }))
      const outcome = await createResendTransport(
        config,
        fetchImpl as unknown as typeof fetch,
      ).send(message)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe(reason)
    }
  })

  it('treats a transport error as retryable-unavailable, not a throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const outcome = await createResendTransport(config, fetchImpl as unknown as typeof fetch).send(
      message,
    )
    expect(outcome).toEqual({ ok: false, reason: 'unavailable', detail: 'resend request failed' })
  })
})

describe('Sendflare transport', () => {
  const config = { apiKey: 'live_test', defaultFrom: 'Open Analytics <hello@example.com>' }
  const message: EmailMessage = { to: 'a@b.com', subject: 's', html: '<p>h</p>' }

  it('sends the documented payload and returns the provider email id', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            requestId: 'request-1',
            code: 0,
            success: true,
            data: { emailId: 'email-1' },
          }),
          { status: 200 },
        ),
    )
    const outcome = await createSendflareTransport(
      config,
      fetchImpl as unknown as typeof fetch,
    ).send(message)

    expect(outcome).toEqual({ ok: true, id: 'email-1' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.sendflare.com/v1/send',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer live_test',
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          from: 'Open Analytics <hello@example.com>',
          to: 'a@b.com',
          subject: 's',
          body: '<p>h</p>',
        }),
      }),
    )
  })

  it('requires the provider business success fields, even on HTTP 200', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 100030, success: false, message: 'domain' }), {
          status: 200,
        }),
    )
    const outcome = await createSendflareTransport(
      config,
      fetchImpl as unknown as typeof fetch,
    ).send(message)
    expect(outcome).toEqual({ ok: false, reason: 'invalid', detail: 'sendflare responded 100030' })
  })

  it('maps auth, rate-limit, server and malformed responses to typed reasons', async () => {
    const cases: Array<[Response, string]> = [
      [new Response('', { status: 401 }), 'unauthorized'],
      [new Response('', { status: 429 }), 'unavailable'],
      [new Response('', { status: 503 }), 'unavailable'],
      [
        new Response(JSON.stringify({ code: 100029, success: false }), { status: 200 }),
        'unauthorized',
      ],
      [
        new Response(JSON.stringify({ code: 100025, success: false }), { status: 200 }),
        'unavailable',
      ],
      [new Response('not-json', { status: 200 }), 'invalid'],
    ]
    for (const [response, reason] of cases) {
      const fetchImpl = vi.fn(async () => response)
      const outcome = await createSendflareTransport(
        config,
        fetchImpl as unknown as typeof fetch,
      ).send(message)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe(reason)
    }
  })

  it('treats a transport error as retryable-unavailable without leaking it', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('secret-bearing network error')
    })
    const outcome = await createSendflareTransport(
      config,
      fetchImpl as unknown as typeof fetch,
    ).send(message)
    expect(outcome).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'sendflare request failed',
    })
  })
})

describe('email outbox payload', () => {
  it('builds a verification payload from typed config, not a hard-coded brand', () => {
    const payload = buildVerificationEmailPayload({
      to: 'u@x.com',
      url: 'https://api.test/verify?token=abc',
      productName: 'Acme Metrics',
    })
    expect(payload.kind).toBe('verification')
    expect(payload.subject).toContain('Acme Metrics')
    expect(payload.html).toContain('https://api.test/verify?token=abc')
  })

  it('builds a magic-link payload that promises sign-in, never sign-up', () => {
    const payload = buildMagicLinkEmailPayload({
      to: 'u@x.com',
      url: 'https://api.test/magic-link/verify?token=abc',
      productName: 'Acme Metrics',
    })
    expect(payload.kind).toBe('magic_link')
    expect(payload.subject).toContain('Acme Metrics')
    expect(payload.html).toContain('https://api.test/magic-link/verify?token=abc')
    // One email serves both faces of the door; the copy must not promise
    // account creation to someone who already has one.
    expect(payload.html.toLowerCase()).not.toContain('sign up')
    expect(parseEmailOutboxPayload(payload)).toEqual(payload)
  })

  it('rejects a malformed payload', () => {
    expect(() => parseEmailOutboxPayload({ kind: 'verification', to: 'x' })).toThrow()
    expect(() => parseEmailOutboxPayload(null)).toThrow()
  })
})

describe('processEmailOutbox', () => {
  function fakeStore(rows: DueOutboxRow[]): EmailOutboxStore & {
    delivered: string[]
    failed: { id: string; reason: string; terminal: boolean }[]
  } {
    const delivered: string[] = []
    const failed: { id: string; reason: string; terminal: boolean }[] = []
    return {
      delivered,
      failed,
      claimDue: async () => rows,
      markDelivered: async (id) => {
        delivered.push(id)
      },
      markFailed: async (id, reason, options) => {
        failed.push({ id, reason, terminal: options?.terminal === true })
      },
    }
  }

  it('delivers valid rows through the transport and fails malformed ones', async () => {
    const store = fakeStore([
      {
        id: 'ok-1',
        payload: { kind: 'verification', to: 'a@b.com', subject: 's', html: '<p>h</p>' },
      },
      { id: 'bad-1', payload: { kind: 'nonsense' } },
    ])
    const transport = selectEmailTransport({ defaultFrom: 'noreply@test' })

    const result = await processEmailOutbox({ store, transport })

    expect(result).toEqual({ claimed: 2, delivered: 1, failed: 1 })
    expect(store.delivered).toEqual(['ok-1'])
    expect(store.failed).toEqual([{ id: 'bad-1', reason: 'invalid_payload', terminal: true }])
  })

  it('hands the transport the row id as the idempotency key', async () => {
    const store = fakeStore([
      {
        id: 'ok-1',
        payload: { kind: 'verification', to: 'a@b.com', subject: 's', html: '<p>h</p>' },
      },
    ])
    const seen: (string | undefined)[] = []
    const transport = {
      id: 'stub',
      send: async (_message: EmailMessage, options?: { idempotencyKey?: string }) => {
        seen.push(options?.idempotencyKey)
        return { ok: true as const, id: 'provider-1' }
      },
    }

    await processEmailOutbox({ store, transport })

    // The row id and nothing else: it is unique per queued message and stable
    // across a reclaim, which is the exact pair of properties dedup needs.
    expect(seen).toEqual(['ok-1'])
  })

  it('marks a row failed on a provider failure without throwing', async () => {
    const store = fakeStore([
      {
        id: 'ok-1',
        payload: { kind: 'verification', to: 'a@b.com', subject: 's', html: '<p>h</p>' },
      },
    ])
    const transport = {
      id: 'stub',
      send: async () => ({ ok: false as const, reason: 'unavailable' as const, detail: 'down' }),
    }

    const result = await processEmailOutbox({ store, transport })

    expect(result.delivered).toBe(0)
    expect(store.failed).toEqual([{ id: 'ok-1', reason: 'unavailable', terminal: false }])
  })

  it('ends an invalid message rather than retrying it, and keeps the other two retrying', async () => {
    // The whole point of the split. `invalid` is the message being unsendable —
    // most often an address the provider refuses — and no schedule fixes that,
    // so it is terminal and never reaches `dead`, which is the status that
    // pages. `unauthorized` is a refused credential: a real outage, so it keeps
    // spending attempts and *does* reach `dead`.
    const reasons = [
      ['invalid', true],
      ['unavailable', false],
      ['unauthorized', false],
    ] as const

    for (const [reason, terminal] of reasons) {
      const store = fakeStore([
        {
          id: 'row-1',
          payload: { kind: 'verification', to: 'a@b.com', subject: 's', html: '<p>h</p>' },
        },
      ])
      const transport = {
        id: 'stub',
        send: async () => ({ ok: false as const, reason, detail: 'nope' }),
      }

      await processEmailOutbox({ store, transport })

      expect(store.failed).toEqual([{ id: 'row-1', reason, terminal }])
    }
  })

  it('tells the log which failures are terminal, since those raise no alert', async () => {
    // `failed` is outside `worker_outbox_backlog`, so a terminal row is not
    // gauged and not alerted; the log line is the only place it surfaces. The
    // drain reads this field to pick its level.
    const store = fakeStore([
      {
        id: 'row-1',
        payload: { kind: 'verification', to: 'a@b.com', subject: 's', html: '<p>h</p>' },
      },
    ])
    const transport = {
      id: 'stub',
      send: async () => ({ ok: false as const, reason: 'invalid' as const, detail: 'nope' }),
    }
    const seen: { event: string; fields: Record<string, unknown> }[] = []

    await processEmailOutbox({
      store,
      transport,
      log: (event, fields) => seen.push({ event, fields }),
    })

    expect(seen).toEqual([
      {
        event: 'email_delivery_failed',
        fields: { reason: 'invalid', outboxId: 'row-1', terminal: true },
      },
    ])
  })
})

describe('outbox topic', () => {
  it('is a stable constant', () => {
    expect(EMAIL_OUTBOX_TOPIC).toBe('email.send')
  })
})
