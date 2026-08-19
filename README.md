# OHAUS Tolerance Assistant

A browser-first service reference with an optional Electron desktop shell. The same structured OHAUS knowledge base powers both versions.

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

## Validation

```bash
npm test
```

The test suite builds the deployable site, checks the packaged record count, exercises representative service questions, verifies exact model matching, and tests current-versus-legacy disambiguation.
