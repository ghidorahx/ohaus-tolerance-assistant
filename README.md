# OHAUS Support Assistants

A browser-first workspace with a source-linked Tolerance Assistant, a workbook-grounded Sales Assistant, and an interactive Compatibility Web.

## Workbook-grounded Sales Assistant

The Sales Assistant uses the OpenAI Responses API with GPT-5.6 Sol, medium reasoning, Standard mode, hybrid workbook retrieval, and strict structured answers. GPT-5.6 Terra is used only as a same-generation fallback when Sol is temporarily rate limited. Each request receives exact JSON records, deterministic requirement filtering, exact and nearest capacity alternatives, relevant field matches, relationship data, and a small set of generated Markdown product or family documents before the model answers. Model memory and prior chat answers are never treated as product-source evidence.

The current catalog contains 80 portable balances across 7 families and 91 resolved related items from `Alpha-PortableBalances.xlsx`. Exact material numbers are authoritative, duplicate model labels require clarification, unresolved relationships remain review items, and missing live business fields such as pricing, inventory, and lead time are reported instead of invented.

### Catalog source pipeline

The workbook remains the only human-edited master. Do not manually edit the generated JSON or Markdown files. A workbook import now produces all of the following in one repeatable operation:

- `data/portable-balances-api.json` — structured authority for identifiers, exact specifications, numeric filtering, relationships, and field-level evidence.
- `data/sales-rag/products/*.md` — one readable retrieval document per product.
- `data/sales-rag/families/*.md` — one readable retrieval document per family.
- `data/sales-retrieval-index.json` — compact local retrieval index used before each AI request.
- `data/sales-data-quality-report.json` — required-field checks plus visible source-review items.
- `data/sales-catalog-version.json` and `data/sales-rag/manifest.json` — source hashes, record counts, generated-file hashes, and version traceability.

The current generated layer contains 80 product documents and 7 family documents. Exact or numeric claims still come from the structured JSON; Markdown helps find and explain descriptive details. This keeps one OpenAI model call per user question and avoids an additional embedding or vector-store request during the pilot.

To import a refreshed workbook, install the maintenance-only Python dependencies and run:

```bash
python3 -m pip install -r requirements-sales-import.txt
npm run import:sales-workbook -- /absolute/path/to/Alpha-PortableBalances.xlsx
```

Set `SALES_IMPORT_PYTHON` when the required Python executable is not named `python3`.

For the expanded-context test, the Tier 1 profile uses a 450K total request budget: up to 322K tokens are reserved for instructions, current catalog evidence, and verified conversation context, while GPT-5.6's maximum 128K output allowance is available for the answer. This leaves 50K of headroom under the model's 500K Tier 1 TPM limit. Conversation memory retains up to 120 verified turns, and each question may retrieve up to 20 generated knowledge documents with expanded excerpts. Requests for all information about an identified model receive its complete populated structured record. These are safety ceilings, not targets: only compact conversation summaries and relevant catalog evidence are sent. Every new question revalidates product facts against the catalog. The OpenAI response is not stored by the app, and the API key and catalog remain server-side.

To reduce avoidable API throttling, generated answers are capped to the size expected by this interface, Sol enters a short circuit-breaker period after a rate limit, and the browser honors the API retry interval with a visible countdown. Repeatedly submitting during a limit window should be avoided because rejected requests also count toward OpenAI rate limits.

## Compatibility Web rule

The Compatibility Web is centered on OHAUS and branches through product families, categories, series, models, and parts. Hierarchy nodes may be added from the current product catalog, but compatibility, incompatibility, replacement, and lifecycle links must only be shown as verified facts. Unverified branches remain visibly marked as awaiting relationship data. Every verified relationship must be navigable in both directions, and switching between Tolerance, Sales, and the Compatibility Web must preserve each mode's working state.

## Local browser test

Requirements: Node.js 22 or newer.

```bash
npm install
npm run prepare:data
npm run prepare:sales-data
npm run dev
```

Open `http://localhost:3000` in a browser. The Tolerance Assistant remains local-only. Sales questions are processed through the server-side OpenAI connection and are grounded in the server-side catalog.

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

The static output is written to `pages-dist/` for publication from a GitHub Pages branch. The repository can remain private when the GitHub account plan supports private-repository Pages; the published website itself remains public.

## Validation

```bash
npm test
```

The test suite builds the deployable site, checks the workbook hash and generated retrieval layer, verifies catalog quality totals, exercises representative service questions, verifies exact model matching, and tests current-versus-legacy disambiguation.