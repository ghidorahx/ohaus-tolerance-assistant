# OHAUS Support Assistants

A browser-first workspace with Tolerance and Sales Assistant modes, plus an optional Electron desktop shell. The same structured OHAUS knowledge base powers both versions.

## Sales Assistant scope rule

The Sales Assistant is portfolio-wide. It must support all OHAUS product series and equipment categories as verified data becomes available; it must never be designed, named, routed, or prompted as a Scout-only assistant. Scout is the first verified sales dataset, not the boundary of the product.

The interface must clearly distinguish between the assistant's portfolio-wide purpose and the product lines currently loaded with verified data. Every new series should extend the same sales workflow and compatibility model rather than create a separate series-specific assistant.

## Local browser test

Requirements: Node.js 22 or newer.

```bash
npm install
npm run prepare:data
npm run dev
```

Open `http://localhost:3000` in a browser. The questions and reference data stay inside the browser; the test version does not call an external AI service.

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

The test suite builds the deployable site, checks the packaged record count, exercises representative service questions, verifies exact model matching, and tests current-versus-legacy disambiguation.
