import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.resolve(process.argv[2] ?? "/Users/rorona/Downloads/Alpha-PortableBalances.xlsx");
const outputPath = path.join(appRoot, "data/portable-balances-api.json");
const python = process.env.SALES_IMPORT_PYTHON ?? "python3";
const importer = path.join(appRoot, "scripts/import-sales-workbook.py");

const result = spawnSync(python, [importer, sourcePath, outputPath], {
  cwd: appRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const retrievalBuilder = spawnSync(process.execPath, [path.join(appRoot, "scripts/build-sales-retrieval.mjs")], {
  cwd: appRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (retrievalBuilder.error) throw retrievalBuilder.error;
if (retrievalBuilder.status !== 0) process.exit(retrievalBuilder.status ?? 1);