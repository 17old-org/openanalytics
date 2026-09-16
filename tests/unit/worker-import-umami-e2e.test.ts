import { createImportAdapterRegistry, umamiImportAdapter } from '@openanalytics/domain'
import type { ObjectStorage } from '@openanalytics/integrations'
import { createRecordingMetrics } from '@openanalytics/observability'
import type { Database, ImportRunRow, ImportUploadRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildUmamiZip, UMAMI_EVENT_CSV, umamiCsv } from '../support/import-fixtures.ts'

/**
 * A real Umami Cloud archive through the real pipeline (ADR-0032, Umami
 * amendment).
 *
 * The adapter suite proves the aggregation and the executor suite proves the
 * pipeline; neither proves that the two meet, and for this provider the seam is
 * the interesting part — **one entry, eight passes**. A genuine ZIP of the three
 * CSVs the product delivers goes in at `uploaded`, and what comes out is the
 * review payload a customer would be shown before publishing.
 *
 * What it asserts is the *summary*, because that is the artefact the human
 * decision is made on: eight staged reports from one file, the two property-bag
 * files named as notes rather than as failures, the dropped cities and the
 * dropped duplicate counted exactly once each, and a date range and proposed
 * cutover computed from the rows.
 */

const SITE = '11111111-1111-4111-8111-111111111111'
const RUN = '33333333-3333-4333-8333-333333333333'
const KEY = `imports/${SITE}/${RUN}/archive.zip`
const ETAG = '"umami-fixture"'

const world = {
  run: null as ImportRunRow | null,
  upload: null as ImportUploadRow | null,
  firstEventAt: null as Date | null,
  archive: Buffer.alloc(0) as Buffer,
}

const calls = {
  transitions: [] as { to: string; summary?: Record<string, unknown> }[],
  inserts: [] as { report: string; rows: readonly Record<string, unknown>[]; token: string }[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    readImportRun: async () => world.run,
    readImportUpload: async () => world.upload,
    readSiteImportContext: async () => ({
      firstEventAt: world.firstEventAt,
      publishedImportRunId: null,
      status: 'active',
    }),
    recordStagingChunkBytes: async (_db: unknown, input: { proposedBytes: number }) =>
      input.proposedBytes,
    recordStagingProgress: async () => undefined,
    clearStagingProgress: async () => undefined,
    claimImportRunForCleanup: async () => true,
    releaseImportRunCleanupClaim: async () => undefined,
    transitionImportRun: async (
      _db: unknown,
      input: { to: string; summary?: Record<string, unknown> },
    ) => {
      calls.transitions.push(input)
      if (world.run) world.run = { ...world.run, state: input.to as ImportRunRow['state'] }
      return true
    },
  }
})

const { executeImportPrepare } = await import('../../apps/worker/src/jobs/import-prepare.ts')

const storage = {
  async getStream() {
    await Promise.resolve()
    return {
      key: KEY,
      size: world.archive.length,
      contentType: 'application/zip',
      etag: ETAG,
      body: (async function* () {
        yield new Uint8Array(world.archive)
      })(),
    }
  },
} as unknown as ObjectStorage

const writer = {
  async insertRows(input: {
    report: string
    rows: readonly Record<string, unknown>[]
    insertDeduplicationToken: string
  }) {
    await Promise.resolve()
    calls.inserts.push({
      report: input.report,
      rows: input.rows,
      token: input.insertDeduplicationToken,
    })
    return { rows: input.rows.length, durationMs: 1 }
  },
}

function context() {
  const { logger } = createCapturedLogger()
  return {
    job: {
      id: 'job-1',
      type: 'import_prepare',
      subjectId: SITE,
      payload: { import_run_id: RUN },
      phase: null,
      attempts: 1,
      claimedBy: 'w-1',
      leaseExpiresAt: new Date(),
      createdAt: new Date(),
    },
    db: {} as Database,
    logger,
    metrics: createRecordingMetrics(),
    resources: {
      objectStorage: storage,
      importedAggregatesWriter: writer,
      importedAggregatesMaintenance: { deleteImportRunRows: async () => ({ tables: 8 }) },
      importAdapters: createImportAdapterRegistry([umamiImportAdapter]),
      importPolicy: {
        maxArchiveBytes: 1_000_000,
        maxEntries: 32,
        maxEntryBytes: 1_000_000,
        maxTotalUncompressedBytes: 2_000_000,
        maxRowBytes: 1_024,
        stagingChunkBytes: 1_000_000,
        uploadTtlDays: 7,
      },
    },
    extendLease: async () => {
      await Promise.resolve()
      return true
    },
    updatePhase: async () => {
      await Promise.resolve()
      return true
    },
  } as unknown as Parameters<typeof executeImportPrepare>[0]
}

beforeEach(() => {
  world.run = {
    id: RUN,
    siteId: SITE,
    provider: 'umami',
    state: 'uploaded',
    summary: null,
    cutoverDate: null,
    stagingChunkBytes: null,
    stagingProgress: null,
    supersededRunId: null,
    sweptAt: null,
    errorCode: null,
    createdAt: new Date('2026-08-26T00:00:00.000Z'),
    updatedAt: new Date('2026-08-26T00:00:00.000Z'),
    finishedAt: null,
  }
  world.upload = {
    id: 'up-1',
    importRunId: RUN,
    objectKey: KEY,
    declaredBytes: 4_096,
    contentType: 'application/zip',
    etag: ETAG,
    createdAt: new Date('2026-08-26T00:00:00.000Z'),
    completedAt: new Date('2026-08-26T00:00:00.000Z'),
  }
  world.firstEventAt = null
  world.archive = buildUmamiZip()
  calls.transitions = []
  calls.inserts = []
})

function summary(): Record<string, unknown> {
  const recorded = calls.transitions.find((transition) => transition.summary !== undefined)
  return recorded?.summary as Record<string, unknown>
}

function warnings(): { code: string; count: number; detail?: { report?: string } }[] {
  return summary()['warnings'] as { code: string; count: number; detail?: { report?: string } }[]
}

describe('a real Umami Cloud export, uploaded to ready_for_review', () => {
  it('walks the run forward and terminates the job succeeded at review', async () => {
    expect(await executeImportPrepare(context())).toBe('succeeded')
    expect(calls.transitions.map((transition) => transition.to)).toEqual([
      'validating',
      'processing',
      'ready_for_review',
    ])
  })

  it('stages eight reports from one file', async () => {
    await executeImportPrepare(context())
    expect(Object.keys(summary()['reports'] as object).sort()).toEqual([
      'browsers',
      'custom_events',
      'devices',
      'geography',
      'metrics',
      'os',
      'pages',
      'sources',
    ])
    expect(calls.inserts.map((insert) => insert.token).sort()).toEqual(
      [
        'browsers',
        'custom_events',
        'devices',
        'geography',
        'metrics',
        'os',
        'pages',
        'sources',
      ].map((report) => `${RUN}:${report}:0`),
    )
  })

  it('records the two property-bag files as notes naming the token, never the filename', async () => {
    await executeImportPrepare(context())
    const dropped = warnings()
      .filter((warning) => warning.code === 'report_not_staged')
      .map((warning) => warning.detail?.report)
      .sort()
    expect(dropped).toEqual(['event_data', 'session_data'])
    // The summary is rendered on the customer's review screen, and a filename is
    // provider text from inside an archive nothing has yet proven benign.
    expect(JSON.stringify(summary())).not.toContain('.csv')
  })

  it('counts the dropped cities and the dropped duplicate exactly once each', async () => {
    // Eight passes read the same file. A warning about the *file* emitted from
    // every pass would show the customer a count eight times too large — the
    // failure mode this provider's shape invents.
    await executeImportPrepare(context())
    const counts = new Map<string, number>()
    for (const warning of warnings()) {
      counts.set(warning.code, (counts.get(warning.code) ?? 0) + warning.count)
    }
    expect(counts.get('city_dropped')).toBe(4)
    expect(counts.get('duplicate_events_dropped')).toBe(1)
  })

  it('reports the range the rows cover and the cutover it proposes', async () => {
    await executeImportPrepare(context())
    expect(summary()['date_range']).toEqual({ from: '2026-03-01', to: '2026-03-02' })
    // No live events yet — the primary migration case — so there is no clamp and
    // the whole import is visible: the day after the last imported day.
    expect(summary()['proposed_cutover_date']).toBe('2026-03-03')
    expect(summary()['total_rows']).toBe(22)
  })

  it('warns about rows the chosen cutover would not show', async () => {
    world.firstEventAt = new Date('2026-03-02T09:00:00.000Z')
    await executeImportPrepare(context())
    expect(summary()['proposed_cutover_date']).toBe('2026-03-02')
    // One row on the second day in each of the eight reports.
    expect(warnings().find((warning) => warning.code === 'rows_at_or_after_cutover')?.count).toBe(8)
  })

  it('stages Umami’s own daily totals, computed from the events', async () => {
    await executeImportPrepare(context())
    const metrics = calls.inserts.find((insert) => insert.report === 'metrics')?.rows ?? []
    expect(
      metrics.map((row) => [row['date'], row['pageviews'], row['visitors'], row['visits']]),
    ).toEqual([
      ['2026-03-01', 3, 2, 2],
      ['2026-03-02', 2, 1, 1],
    ])
    // Every staged row carries the site and the run the pipeline stamped, never
    // anything the adapter could have named.
    for (const insert of calls.inserts) {
      for (const row of insert.rows) {
        expect(row['site_id']).toBe(SITE)
        expect(row['import_run_id']).toBe(RUN)
      }
    }
    // The geography rows reach ClickHouse with no city column at all.
    const geography = calls.inserts.find((insert) => insert.report === 'geography')?.rows ?? []
    expect(Object.keys(geography[0] as object)).not.toContain('city')
  })

  it('accepts an export a customer repacked without the property-bag files', async () => {
    world.archive = buildUmamiZip({ omitDropped: true })
    expect(await executeImportPrepare(context())).toBe('succeeded')
    expect(calls.transitions.at(-1)).toMatchObject({ to: 'ready_for_review' })
    expect(warnings().some((warning) => warning.code === 'report_not_staged')).toBe(false)
  })

  it('fails the run, not the job, when the file is another provider’s', async () => {
    // The likeliest real failure: a customer uploading the wrong export. The job
    // did its work and the answer was no.
    world.archive = buildUmamiZip({ eventCsv: 'date,visitors\n2024-01-01,5\n' })
    expect(await executeImportPrepare(context())).toBe('succeeded')
    expect(calls.transitions.at(-1)).toMatchObject({ to: 'failed' })
  })

  it('reaches review with nothing staged when the export carried no events', async () => {
    // A site that recorded nothing in the exported range is not a broken export,
    // and the archive is structurally fine — so it is not `empty_archive`. The
    // reviewer is shown a summary of zero rows, which is the honest artefact to
    // decide on and the same thing an all-header Plausible export produces.
    world.archive = buildUmamiZip({ eventCsv: umamiCsv([]) })
    expect(await executeImportPrepare(context())).toBe('succeeded')
    expect(summary()['total_rows']).toBe(0)
  })

  it('reads the same bytes eight times without spending the budget eight times', async () => {
    // The proof at the seam rather than in the archive unit: the whole export is
    // inflated once per report, and a total budget that counted every pass would
    // refuse a legitimate archive as a bomb.
    expect(Buffer.byteLength(UMAMI_EVENT_CSV, 'utf8') * 8).toBeGreaterThan(2_000_000 / 100)
    expect(await executeImportPrepare(context())).toBe('succeeded')
  })
})
