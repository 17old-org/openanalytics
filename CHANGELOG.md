# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the numbers mean what [RELEASING.md](RELEASING.md) says they mean: while
the major is `0`, a minor is anything you might have to read this file before
taking.

Releases before 0.6.0 have their notes on the
[GitHub releases page](https://github.com/OpenLabs-so/openanalytics/releases).

## [0.6.0] - 2026-09-05

**Upgrade notes: none.** `./upgrade.sh` and nothing else. The two ClickHouse
migrations in this release only add columns, and the migrate container applies
them while the upgrade runs.

### Added

- **Filters.** Clicking a row in Sources, Locations or the device cards keeps
  only the sessions that match it, and the overview re-reads with that filter
  applied. Four dimensions — source, country, city, device — combined with
  `and` across dimensions and `or` within one. What you picked shows as marks
  on the tab bar, each clearing on its own. A filtered view is rebuilt from raw
  events rather than read off a rollup, so it covers at most 92 days; past that
  the cards offer to shorten the range or drop the filters. The same grammar
  serves the dashboard, `/v1/read` and MCP, so they cannot drift.
- **Entries and exits.** Top Pages carries entrances, exits and a bounce rate
  per path, and can be ranked by any of them. The ranking is a question put to
  the server rather than a re-sort of the rows on screen.
- **Click ids as sources.** `gclid`, `fbclid`, `msclkid` and their companions
  name the ad network a visit came from when the referrer does not.
- **`?ref=` names a source.** A link you control can carry `?ref=twitter` or
  `?ref=newsletter`, and visits that would have read as Direct get that name
  instead. Known names fold onto the site they mean; anything else is kept as
  written. A referrer the browser did send always wins.
- **Polar as a revenue provider.** A second provider a site can connect
  alongside Stripe, with Standard Webhooks signature verification.
- **Umami import.** An adapter for Umami exports, and one archive entry may now
  fill several reports.
- **Overview poster.** A share button turns the numbers on screen into an
  image — the site's mark, the period, the headline figures and the traffic
  curve — as a PNG or on the clipboard. It draws from what the board already
  has, so it cannot disagree with the screen it was made from.
- **Realtime names who is here.** The overview's realtime card lists the
  visitors present rather than the paths that are busy, and a live badge sits
  beside the Overview and Realtime titles.
- **MCP hints.** Every tool spells out its hints, native-app redirect URIs are
  accepted, and a root `.mcp.json` points at the hosted server.
- **Dokploy.** The blueprint ships with an import config and a copyable raw
  link beside it.
- Documentation for the dashboard: what each headline metric counts, what each
  breakdown is a cut of, how filters behave, and how to tag your own links.

### Changed

- **The tracker stands down for a site that is gone.** A `404` from the config
  read is a gone-marker, and `collection_paused` carries a body and an ETag;
  the tracker obeys both and stops asking.
- Squircle cards fall back to rounder corners on engines without
  `corner-shape`, and to a plain radius where even that is unsupported.

### Fixed

- **Email.** A rate limit is retryable and a bad address is not, so a `429` no
  longer burns an address; a stranger's typo no longer becomes a page. A
  terminal failure is recorded as `failed`.
- **Ingest.** The finalizer window is bounded, the outbox is leased and
  reclaimed rather than raced, the backlog carries an `available_at`, and the
  queue publishes its own metrics.
- **Realtime.** A refusal is believed only once a fresh token has been refused
  too, so an expired token no longer reads as a revoked one.
- **Shared reports.** Percentages are shares of the total rather than of the
  biggest row.

### Coming in 0.7.0

Fifteen-minute rollups, which serve every timezone including the half- and
quarter-hour ones (+05:30, +05:45), with a one-time backfill the upgrader runs
for you.
