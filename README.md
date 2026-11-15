# Issue and PR triager

A reusable GitHub Action that adds new issues and pull requests to an organization project and classifies them using the organization's current GitHub metadata.

The Action discovers labels, enabled issue types, field options, and their descriptions on every run. Updating those catalogs does not require updating the Action. Existing labels and populated values are preserved. Backlog enrollment is manual.

## Use

Call the Action by its verified release commit SHA. No checkout, package installation, or Python setup is required in the consumer.

```yaml
- name: Triage enrolled items
  uses: donadiosolutions/issue-pr-triager@<VERIFIED_RELEASE_COMMIT_SHA>
  with:
    github-token: ${{ steps.app-token.outputs.token }}
    openai-api-token: ${{ secrets.TRIAGER_TOKEN }}
    project-number: ${{ vars.TRIAGE_PROJECT_NUMBER }}
    mode: process
```

`TRIAGER_TOKEN` contains the **OpenAI API token**. `github-token` is a separate, short-lived installation token for a dedicated GitHub App.

### GitHub App

Use the [App manifest](.github/triager-app-manifest.json) as the permission reference. Install the App only on repositories that opt in. It needs:

| Resource | Access |
|---|---|
| Repository contents and metadata | Read |
| Repository issues and pull requests | Read and write |
| Organization issue fields and issue types | Read |
| Organization projects | Read and write |

Store its private key in `TRIAGE_APP_PRIVATE_KEY` and client ID in `TRIAGE_APP_CLIENT_ID`. Organization secrets can be restricted to selected consumer repositories. The App does not need webhooks, user OAuth, workflow write access, or repository administration.

Create an installation token with pinned `actions/create-github-app-token`. Restrict `repositories` to the consumer. Let the token inherit this dedicated App's grant: version 3.3.0 of that token action does not expose the newer Issue Fields and Issue Types read permissions as inputs.

```yaml
- name: Create App token
  id: app-token
  uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
  with:
    client-id: ${{ vars.TRIAGE_APP_CLIENT_ID }}
    private-key: ${{ secrets.TRIAGE_APP_PRIVATE_KEY }}
    owner: ${{ github.repository_owner }}
    repositories: ${{ github.event.repository.name }}
```

### Consumer workflow

Use separate enrollment and processing jobs:

1. `issues: opened` and `pull_request_target: opened` call `mode: enroll`. This records durable queue state and project membership before classification. Keep enrollment outside the worker concurrency group.
2. A processing job calls `mode: process` after enrollment, on edits/reopening/PR synchronization, or every 10 minutes. Serialize jobs by consumer repository; do not cancel an active job. Each invocation processes up to four different items in parallel by default; set `concurrency` from 1 to 20 to change the worker count. The batch remains limited to 20 items.
3. `workflow_dispatch` may select an existing `item-number` or explicitly start `mode: backfill`. Default its backfill input to `false`. Use `dry-run: true` to inspect decisions first.
4. Call `mode: checkpoint` with the caller's `${{ github.token }}` and `actions: read` permission. Its `checkpoint-artifact-id` and `checkpoint-run-id` outputs identify the latest artifact from the same trusted workflow and default branch. Pass these to pinned `actions/download-artifact`, then upload updated progress after processing. Lookup inspects at most 100 artifacts within a 60-second deadline. A dry run must not publish backfill authorization. Checkpoints expire after 30 days.
5. Ignore follow-up events authored by the triager App. On `labeled`, run only for `triage`.

Keep automatic processing disabled during setup, for example with a repository variable `TRIAGE_ENABLED=false`. Permit manual dry runs, validate the consumer credentials and provider requests, then set `TRIAGE_ENABLED=true` before a new-item write canary. Enabling creation events does not authorize backlog enrollment.

The worker processes only items with state authored by the authenticated App and bound to the repository and project. An existing `triage` label alone does not enroll an old item. A schedule may continue a manually authorized backfill; a missing or expired checkpoint requires another manual execution.

For `pull_request_target`, execute only the pinned Action and trusted caller steps. Never check out or execute the pull request head.

## Inputs and outputs

| Input | Default | Meaning |
|---|---|---|
| `github-token` | Required | Scoped installation token; caller token with Actions read permission for checkpoint lookup |
| `openai-api-token` | Required for processing | OpenAI token from `secrets.TRIAGER_TOKEN`; not needed for enrollment or checkpoint lookup |
| `project-number` | Required | Organization project number |
| `mode` | `process` | `enroll`, `process`, manually authorized `backfill`, or read-only `checkpoint` |
| `item-number` | Empty | Optional item to enroll through manual execution |
| `dry-run` | `false` | Report intended work without GitHub changes |
| `reclassify` | `false` | Refresh bot-owned values that still match their ownership record |
| `concurrency` | `4` | Maximum items processed in parallel; integer from 1 to 20 |
| `checkpoint-path` | Runner temporary directory | Local JSON checkpoint for the caller to persist |
| `priority-field-name` | `Priority` | Organization priority field name |
| `effort-field-name` | `Effort` | Organization effort field name |

Boolean inputs accept exactly `true` or `false`. Item and project numbers must be positive integers. Repository and event identity come from the runner environment.

Outputs: `processed`, `deferred`, `failed`, `human-review`, `backfill-remaining`, and `checkpoint-path`. Checkpoint lookup also exposes `checkpoint-artifact-id` and `checkpoint-run-id` when a trusted artifact exists. The Actions summary reports processing counts and model usage. Checkpoint files contain discovery progress, never credentials or issue bodies.

## Classification and review

Issues receive native labels, issue type, Priority, and Effort. GitHub does not support native issue types or organization issue fields on PRs, so the Action creates `PR Type`, `PR Priority`, and `PR Effort` single-select project fields. Their options follow the organization catalogs; historical selections are retained. Each semantic pass requests only fields that still need values, plus matching bot-owned fields when `reclassify` is enabled. A second pass fills remaining gaps without requesting fields completed by the first pass.

The first semantic pass uses `gpt-6-luna` through Decisions. Unresolved work gets one second pass through Responses with `gpt-6.1-terra`. Model output must match the live catalogs; confidence below 0.85 defers the decision. Effort is relative story effort, not hours. Existing values remain intact; explicit reclassification replaces only values still owned by the bot.

The Action sends bounded issue/PR text, relevant discussion, candidate issues, and PR patch excerpts to OpenAI. Evidence is treated as data. Models receive no execution tools. Responses requests use `store: false`. Credentials and raw provider payloads are not written to logs or checkpoints.

A PR link requires a unique same-repository candidate, confidence of at least 0.95, a margin of at least 0.15, and evidence that the PR fully resolves the issue. Existing associations are preserved. For a qualifying PR targeting the default branch, the Action appends one marked `Closes #N` block. This closes the issue when merged. Partial, ambiguous, and non-default-branch matches remain for review; no-parent is a valid outcome.

`triage` remains while work is pending and is removed after completion. Populated fields being preserved do not require another model choice. Existing review states whose only blockers are preserved fields complete without another paid request. One bot-owned progress comment records enrollment, fingerprints, ownership, and unresolved reasons. After two unchanged semantic passes, the Action stops making paid calls and retains the label for human review. Transport retries are bounded; saved valid decisions can resume partially completed writes.

## Development and coverage

Use Node.js **24.22.3**. Runtime dependencies are native; coverage dependencies are development-only and pinned with lockfile integrity hashes. Review changed dependencies through Socket before installing them.

```sh
npm ci --ignore-scripts --omit=optional
npm test
npm run coverage
```

Tests use synthetic fixtures, mocked HTTP, bounded child processes, a 10-second test timeout, and concurrency of one. No production credentials or live provider calls are needed.

CI requires **100% lines, branches, statements, and functions for every implementation file and globally**. `c8 --all` includes unimported source; the inventory gate checks every `src/**/*.js` file and rejects skipped or partially covered counters. Coverage ignore directives and production-file exclusions are not used. Reports include text, HTML, LCOV, JSON summary, and raw coverage data.

Immutable signed releases use `vMAJOR.MINOR.PATCH`. Consumers should pin the release's full commit SHA. This repository inherits the organization's [security reporting policy](https://github.com/donadiosolutions/.github/blob/main/SECURITY.md).

## License

[MIT](LICENSE), copyright Donadio Solutions.
