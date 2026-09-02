# OHAUS Support Assistants

A browser-first workspace with a source-linked Tolerance Assistant and a workbook-grounded Ask assistant.

## Workbook-grounded Ask assistant

Ask is grounded in `MMMDF_EN_US_20260605_AI_Organized 2.xlsx`, the master product workbook. The current generated version contains 6,407 materials across 46 named parent families and 45,167 bounded retrieval chunks. `Product_Catalog_AI` is imported as the source sheet; the duplicate `Raw_Data` sheet is intentionally not indexed a second time.

The assistant uses a hybrid retrieval pipeline instead of sending the workbook, or a 450K-token catalog dump, to OpenAI for every question:

1. Normalize the customer wording and resolve exact material numbers, trade names, model aliases, and alternate model spellings.
2. Parse deterministic numeric requirements and compare canonical units for fields such as capacity, readability, dimensions, mass, volume, time, and temperature.
3. Search D1 with exact indexed lookups and SQLite FTS5 for lexical matches.
4. Search the active catalog namespace in Cloudflare Vectorize for semantic matches generated with Workers AI (`@cf/baai/bge-small-en-v1.5`, 384 dimensions, in `ohaus-master-catalog-fast-v1`).
5. Merge and rank the candidates, then hydrate only the relevant source fields, relationships, document links, and material records from D1.
6. Send that compact, source-traceable grounding bundle to the OpenAI Responses API for the final answer.

Exact identifiers, numeric filtering, FTS, aliases, and semantic retrieval complement one another; Vectorize is not treated as the authority for specifications. Model memory and earlier chat answers are never accepted as product evidence. If semantic retrieval is unavailable, the deterministic master-catalog paths can still answer. If the master D1 catalog is unavailable or has no active version, Ask falls back to the older verified 80-product portable-balance catalog so the interface remains usable; that fallback has much narrower coverage.

The generation model is `gpt-5.6-sol` with fixed `high` reasoning in Standard mode and request-level OpenAI Fast mode (`service_tier: "fast"`). `gpt-5.6-terra` is used only as the same-generation fallback for a transient Sol rate limit and keeps the same Fast service tier. Official [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model) documents high reasoning, while the [Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode) documents the latency and pricing tradeoff. The reusable instruction prefix stays stable for [prompt caching](https://developers.openai.com/api/reference/resources/responses/methods/create), while the changing question and compact retrieved evidence are appended per request.

Each request retains at most 12 verified conversation turns and has a 60K-token safety ceiling: up to 54K input tokens and up to 6K output tokens. Normal answers are capped lower. These are ceilings rather than targets; routine questions should retrieve a small set of relevant chunks and fields. Every new question revalidates product claims against the active catalog, the OpenAI response is not stored by the app, and the API key and catalog remain server-side.

### Catalog source pipeline

The workbook remains the human-edited source. Do not manually edit generated catalog artifacts. The importer preserves every populated source cell, gives duplicate headers deterministic field keys, builds normalized aliases, extracts numeric values and canonical units, parses relationship columns, deduplicates document URLs, and creates deterministic chunks no longer than 1,450 characters. The currently staged `mcv_f3213eb213a5f28d58e5f3ab` artifact is retained as a generator `1.1.0` historical import. Importer `1.2.0` includes its generator version in every future content-derived ID, so rerunning the same workbook intentionally produces a new, unambiguous version rather than pretending to reproduce that historical artifact.

The current import also contains 323,389 source attributes, 94,754 numeric attributes, 74,400 canonicalized values, 203,589 relationship rows, and 5,775 material/document URL rows. Unresolved relationship targets remain source-visible review data; they are not silently converted into verified compatibility claims.

The repeatable import produces:

- `data/master-catalog-manifest.json` — source hash, immutable version ID, counts, QA summary, chunk settings, and generated-file hashes.
- `work/master-catalog/master-catalog-stage-*.sql` — size-bounded, retry-safe D1 staging shards.
- `work/master-catalog/master-catalog-qa.json` and the field dictionary — import review artifacts.
- `work/master-catalog/*.ndjson` — complete records, chunks, and Vectorize seed data for auditing or recovery.
- `data/master-retrieval-eval.json` — 107 deterministic retrieval cases spanning every named parent family, aliases, technical wording, relationships, document links, and unsupported live-data questions.
- `data/master-retrieval-eval-profile.json` — the deployed fixture/source identity plus a deterministic fingerprint of the retrieval, evaluator, embedding, and Vectorize configuration. The administration API accepts evaluation results only for this exact profile.

Generated files under `work/` are deliberately gitignored and can be rebuilt from the workbook plus the tracked importer. Preserve them in an update backup until the new version is active and verified.

### Safe catalog update procedure

Do not replace the active catalog in place. Each import receives a content-derived version ID and is loaded as `staged`; the public Ask route continues using the previous active version until seeding, evaluation, and activation all succeed.

Before changing or re-importing the workbook:

- Record `git status` and make a recoverable archive that includes the repository history, workbook, tracked manifest, and generated `work/master-catalog` artifacts.
- Export the authoritative base tables from the current remote D1 database. A full export is not supported because the database contains an FTS5 virtual table; the FTS index and vector-seed queue are reproducible from `master_chunks`.
- Keep the workbook filename and SHA-256 with the backup so a generated version can always be traced to its source.

Example base-table export (run outside peak traffic because a large export can temporarily block queries):

```bash
backup_path="../backups/ohaus-master-catalog-base-$(date +%Y%m%d-%H%M%S).sql"

npx wrangler d1 export ohaus-master-catalog-v1 \
  --remote \
  --no-schema \
  --table master_catalog_versions \
  --table master_materials \
  --table master_aliases \
  --table master_attributes \
  --table master_relationships \
  --table master_documents \
  --table master_chunks \
  --output="$backup_path" \
  --config wrangler.deploy.jsonc \
  --skip-confirmation
```

Recovery uses a fresh D1 database: apply the tracked migrations, import this data-only dump with `wrangler d1 execute --remote --file=<backup.sql>`, and normalize the restored target version back to `staged` with `activated_at = NULL`. Point `master_catalog_state.staged_version_id` at that exact version while leaving `active_version_id` null. Verify that `master_chunks` and the rebuilt `master_chunks_fts` have equal counts, then reseed, evaluate, and activate through the authenticated API. Keep `master_catalog_state` and old evaluations out of the dump so a restored version cannot become active or satisfy the evaluation gate before those checks.

Install the repository and maintenance-only workbook dependencies once:

```bash
npm install
python3 -m pip install -r requirements-sales-import.txt
```

No additional plugin is required. The workbook importer uses `pandas` and `openpyxl`; set `MASTER_CATALOG_PYTHON` if the correct Python executable is not named `python3`.

Generate the staged import and rebuild the deterministic evaluation fixture:

```bash
npm run import:master-catalog -- "/absolute/path/to/MMMDF_EN_US_20260605_AI_Organized 2.xlsx"
python3 scripts/build-master-retrieval-eval.py \
  --source "/absolute/path/to/MMMDF_EN_US_20260605_AI_Organized 2.xlsx"
```

Review `data/master-catalog-manifest.json`, `data/master-retrieval-eval-profile.json`, and `work/master-catalog/master-catalog-qa.json` before uploading anything. Stop if the source hash, material totals, fixture or retrieval-profile hash, error count, or review warnings are unexpected. `npm run verify:master-retrieval-profile` fails if retrieval/evaluator code or configuration changed without regenerating the profile, and runs automatically before every Worker build. Apply tracked migrations through Wrangler before loading a newly generated catalog. Wrangler records completed files, which prevents the non-idempotent column migrations from being replayed:

```bash
set -euo pipefail

npx wrangler d1 migrations apply ohaus-master-catalog-v1 \
  --remote \
  --config wrangler.deploy.jsonc

for shard in work/master-catalog/master-catalog-stage-*.sql; do
  npx wrangler d1 execute ohaus-master-catalog-v1 \
    --remote \
    --file="$shard" \
    --config wrangler.deploy.jsonc
done
```

Catalog maintenance uses `CATALOG_ADMIN_TOKEN`, a separate server secret from the employee-facing `SALES_PILOT_ACCESS_CODE`. Set the same high-entropy token in the deployed Worker and the maintenance shell, but never commit it:

```bash
export CATALOG_ADMIN_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$CATALOG_ADMIN_TOKEN" | \
  npx wrangler secret put CATALOG_ADMIN_TOKEN --config wrangler.deploy.jsonc
npm run deploy:worker
```

Seed without activation, evaluate the staged version, and only then activate it:

```bash
npm run seed:master-catalog -- --no-activate
npm run eval:master-catalog
npm run seed:master-catalog
npm run seed:master-catalog -- --status-only
unset CATALOG_ADMIN_TOKEN
```

`seed:master-catalog` is resumable and records per-chunk progress. A failed chunk is tried at most three times; inspect and repair persistent failures before running `npm run seed:master-catalog -- --reset-failed --no-activate` or rebuilding the staged version. Activation validates every declared table count, the FTS index, the complete vector queue, a distributed Vectorize visibility sample, and the latest full passing retrieval evaluation for the exact deployed retrieval-profile fingerprint before it atomically switches versions. Migration `0004` intentionally marks older saved evaluations with a non-matching legacy fingerprint, so code, evaluator, embedding, or index changes require a fresh full run. The required suite checks exact technical values, semantic-channel discovery, complete category results, exact and inclusive-range numeric filters, and a proven empty filtered result. Live-price/inventory cases remain documented answer-layer requirements and are not falsely counted as retrieval passes. The final invocation waits for asynchronous Vectorize propagation when needed and retries that visibility check. Do not execute `work/master-catalog/master-catalog-activate.sql` directly: generated activation SQL is intentionally non-mutating, and only the authenticated API enforces the rollout gates. If evaluation fails, leave the version staged, inspect the misses, and keep the existing active catalog.

Use `npm run master-vectorize:status` for index configuration status. `npm run eval:master-catalog -- --limit 10` is useful for a short deployed smoke test; it is saved as incomplete and cannot activate a catalog. The full command evaluates every required fixture case.

### Source and capacity limitations

The workbook contains product fields and document URLs, but the referenced PDF bodies are not ingested. Ask can return a relevant data-sheet, user-guide, or manual link; it cannot claim facts found only inside that PDF until a separate document-content ingestion pipeline is added. The workbook also does not provide live price, inventory, availability, or lead-time data. Questions requiring those fields must receive a clear unavailable-data answer rather than an estimate.

At the time of this import, the remote D1 database is 424,308,736 bytes (about 424 MB). Cloudflare's current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) allow 500 MB per database on Workers Free and 10 GB on Workers Paid. Consequently, a second full catalog version should not be staged in the same database on the Free plan. The 45,167-vector seed is resumable, but its progress updates can approach the Free plan's daily row-write allowance, and the 22,426,666-character embedding corpus may slightly exceed one day's [Workers AI free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/) depending on actual tokenization. Cloudflare's [Free D1 limits reset at 00:00 UTC](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/); a quota-stopped run should be resumed after reset, not restarted. Before the next master update, confirm the account plan and current database size. Workers Paid provides more headroom. A fresh-D1 rollout additionally requires a temporary non-production Worker/config bound to that database for seeding and evaluation before the production binding is switched. Do not point the production admin URL at an unvalidated replacement, and do not delete the active version merely to create space without a verified backup and rollback path.

To reduce avoidable API throttling, generated answers are capped to the size expected by this interface, Sol enters a short circuit-breaker period after a rate limit, and the browser honors the API retry interval with a visible countdown. Repeatedly submitting during a limit window should be avoided because rejected requests also count toward OpenAI rate limits.

## Local browser test

Requirements: Node.js 22 or newer.

```bash
npm install
npm run prepare:data
npm run prepare:sales-data
npm run dev
```

Open `http://localhost:3000` in a browser. The Tolerance Assistant remains local-only. Ask questions are processed through the server-side OpenAI connection and are grounded in the server-side catalog.

The current local configuration intentionally uses the remote Cloudflare D1 and Vectorize bindings. Local Ask tests can therefore read production catalog resources and consume OpenAI/Workers AI usage; use a valid local `OPENAI_API_KEY` and do not run catalog administration commands casually.

## Electron test on this laptop

```bash
npm run electron:dev
```

This starts the local web app and opens it in a restricted Electron window. The Electron shell has Node integration disabled, context isolation enabled, and sandboxing enabled.

## Company-laptop pilot

Use the hosted browser URL when software installation is restricted. No Electron or Node installation is needed for that route. If the company later approves a desktop package, the Electron shell can load the same hosted URL by setting `OHAUS_APP_URL`.

Before production use, add company authentication, access logging requirements, an owner/version policy for the master workbook, and a formal review workflow for records marked `Source review`.

## GitHub Pages build

```bash
npm run build:pages
```

The static output is written to `pages-dist/`. It is useful for a front-end preview, but it does not include the server-side `/api/sales` route and is not a standalone Ask deployment. The production Worker build uploads its matching `dist/client` assets directly to Cloudflare, so Worker code and hashed front-end assets are published together.

## Validation

```bash
npm test
npm run lint
```

The test suite builds both deployable targets, checks the workbook-derived manifests and generated retrieval layer, exercises master-catalog import invariants, validates exact, alias, numeric, FTS, semantic, relationship, and document-link retrieval, and verifies the deterministic evaluation fixture. Legacy portable-catalog and Tolerance Assistant coverage remain in place for fallback and regression protection.
