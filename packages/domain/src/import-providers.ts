/**
 * The import provider catalog (ADR-0032, D11).
 *
 * One list, published over HTTP, so the frontend renders what this build can
 * actually do. The mock the dashboard shipped with named six providers that were
 * never the six the plan lists, and the two only converged by redeploying the
 * frontend; a catalog endpoint is how they converge without one.
 *
 * `available: false` is deliberately a *listed* provider rather than an absent
 * one. "Matomo is coming" and "Matomo is not a thing we do" are different
 * answers, and a screen that can only show what works cannot give the first.
 *
 * `capability` is the honest half of the descriptor, and it describes the
 * **provider's export**, not what this system does with it. Plausible's is
 * aggregate-only — ten daily-grain CSVs, no visitor identifiers — which is what
 * makes the whole D2/D4/D5 read design necessary. Umami's is `event_level`: its
 * export is the raw event table, and the adapter aggregates it to the same daily
 * grain, because the staged tables and the read design are the same on both
 * sides of that difference. So `event_level` is not a promise of finer-grained
 * reporting; it is a fact about what the customer's file contains, and stating
 * it per provider keeps it a property of the export rather than an assumption in
 * the pipeline.
 */

export const IMPORT_PROVIDER_CAPABILITIES = ['aggregate_only', 'event_level'] as const
export type ImportProviderCapability = (typeof IMPORT_PROVIDER_CAPABILITIES)[number]

export interface ImportProviderDescriptor {
  readonly id: string
  readonly displayName: string
  readonly capability: ImportProviderCapability
  /** Whether this build has a working adapter. Never inferred from the list. */
  readonly available: boolean
}

/**
 * The catalog, in the order the picker should show it: what works first.
 *
 * The four unavailable entries are the follow-up sub-parts behind the same
 * descriptor/parser framework (D11, F-302). Their capability is recorded now
 * because it is a property of the *provider's export*, not of our adapter — GA
 * and OpenPanel can ship event-level rows whether or not we read them yet, and
 * a descriptor that lied about that would mislead the staging design later.
 *
 * **The order does not change when a provider becomes available.** It is a
 * stable list the frontend renders and a test transcribes; re-sorting it so that
 * the working ones float to the top would move a card under the customer's
 * cursor every time an adapter ships.
 */
export const IMPORT_PROVIDERS: readonly ImportProviderDescriptor[] = [
  { id: 'plausible', displayName: 'Plausible', capability: 'aggregate_only', available: true },
  { id: 'umami', displayName: 'Umami', capability: 'event_level', available: true },
  { id: 'matomo', displayName: 'Matomo', capability: 'event_level', available: false },
  { id: 'fathom', displayName: 'Fathom', capability: 'aggregate_only', available: false },
  {
    id: 'google_analytics',
    displayName: 'Google Analytics',
    capability: 'aggregate_only',
    available: false,
  },
  { id: 'openpanel', displayName: 'OpenPanel', capability: 'event_level', available: false },
]

export function findImportProvider(id: unknown): ImportProviderDescriptor | null {
  if (typeof id !== 'string') return null
  return IMPORT_PROVIDERS.find((provider) => provider.id === id) ?? null
}
