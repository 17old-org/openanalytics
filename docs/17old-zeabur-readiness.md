# 17old Zeabur readiness

This repository is the 17old-org fork of
[OpenLabs-so/openanalytics](https://github.com/OpenLabs-so/openanalytics),
tracked from upstream. The deployment baseline is the upstream release tag
`v0.6.0` (upgraded from `v0.4.2` on 2026-09-16); do not deploy a floating
`main` commit as though it were a release.

## Live deployment (2026-09-16)

Zeabur project `l7old-openanalytics` (`6a801ecebdeaa87e2c52507b`), environment
`production`, server `Tencent 8GB for 17old`. Ten services run
`ghcr.io/openlabs-so/openanalytics/<svc>:v0.6.0`; PostgreSQL runs the upstream
`postgres:17-alpine`. Four hostnames are live: `app.`, `c.`, `rt.` and `api.`
under `analytics.17-old.org`.

### Sendflare is NOT in production

The worker carries an `EMAIL_FROM` and a `SENDFLARE_API_KEY` variable, but it
runs the **upstream** worker image, which never reads `SENDFLARE_API_KEY` —
that transport exists only in this fork. Magic-link mail therefore falls
through to Resend, SMTP or the log transport, whichever is configured.

Putting Sendflare live needs the fork image
`ghcr.io/17old-org/openanalytics/worker:sendflare`, which is built by the
manual `ci.yml` dispatch on `agent/zeabur-selfhost-setup`. That image sits in a
**private** GHCR package while `17old-org/openanalytics` itself is public, so
Zeabur cannot pull it. Two ways out, both needing a human decision:

1. Make the `openanalytics/worker` package public — the source is already
   public and AGPLv3, so this exposes nothing new.
2. Give Zeabur GHCR pull credentials in the service's Source dialog.

A third route exists and needs no registry at all: point the worker service at
the public GitHub repository instead of an image. `infra/docker/node-app.Dockerfile`
already defaults to `ARG APP=worker` precisely so a platform that builds the
file directly picks the worker.

## Decision recorded before a server is purchased

OpenAnalytics is a multi-service application, not a single Node process. Its
supported self-hosted layout contains Postgres, ClickHouse, two Valkey
instances, migrations, tracker build, API, collector, worker, query gateway,
realtime, web, and a proxy. The stock deployment is Docker Compose and needs
four public hostnames:

- `app.<base-domain>` -- dashboard
- `api.<base-domain>` -- API and OAuth callbacks
- `c.<base-domain>` -- collector and `oa.js`
- `rt.<base-domain>` -- realtime SSE

Zeabur does **not** directly deploy Docker Compose YAML. Therefore do not
create one generic "Node.js" service from this repository. At deployment time
we will choose one of these explicit paths:

1. Convert the supported topology to a Zeabur Template and deploy it as
   separate services with persistent volumes. This keeps Zeabur's managed
   server, networking, logs, and service controls.
2. Run the upstream Docker Compose stack on a standalone Docker host. This is
   the upstream-supported route, but it is not a Zeabur-managed service
   deployment.

The first path is the intended one for a newly purchased Zeabur Server. No
secrets, domains, or service definitions have been generated yet, because they
must be bound to the final domain and deployment topology.

## Minimum server to buy

Buy an **amd64/x86_64** server with **2 vCPU, 8 GB RAM, 80 GB SSD/NVMe, and one
public IPv4 address**. This is the smallest configuration I recommend for the
Zeabur-managed path:

- Upstream documents about 4 GB RAM for the OpenAnalytics runtime itself.
- A Zeabur Server also runs K3s and needs headroom; 4 GB total would leave no
  dependable operating margin for the database containers and the platform.
- Official release images are amd64-only. Choosing ARM would force a local
  build of all images and materially raises the memory requirement.
- 80 GB is a starting disk allocation, not an analytics-data limit. ClickHouse
  data and backups grow with traffic, so plan to expand storage or retain fewer
  snapshots when disk usage reaches 70%.

For a throwaway, directly managed Docker evaluation (not the Zeabur-managed
path), 2 vCPU / 4 GB RAM / 50 GB SSD can run the prebuilt release images. Do
not use that smaller profile for the long-lived Zeabur deployment.

## Purchase and DNS checklist

Before deployment, provide these non-secret inputs:

1. The chosen base domain, for example `analytics.17old.org`.
2. Control of DNS so the four names above can point at the new server.
3. A Zeabur workspace/project where the server can be selected.
4. Confirmation that the server has the required public networking and that
   Zeabur can reserve resources for stateful services.

Do not put generated `infra/selfhost/.env`, `infra/selfhost/env/*.env`, or
`infra/selfhost/docker-compose.override.yml` in Git. They contain database
passwords and signing keys. The upstream generator is intentionally run only
once against the final domain and refuses to overwrite an existing install.

## Source and license obligations

The code is AGPL-3.0-only. If this fork is modified and offered as a network
service, users must be offered the corresponding source. Keep this repository
public or provide an equivalent source offer in the running dashboard. Also
use a 17old-owned domain and visual identity: the upstream OpenAnalytics name
and hosted-service branding are not granted by the code licence.
