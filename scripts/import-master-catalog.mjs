import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.resolve(
  process.argv[2] ?? path.join(appRoot, "MMMDF_EN_US_20260605_AI_Organized 2.xlsx"),
);
const outputRoot = path.resolve(process.argv[3] ?? path.join(appRoot, "work/master-catalog"));
const manifestPath = path.resolve(process.argv[4] ?? path.join(appRoot, "data/master-catalog-manifest.json"));
const python = process.env.MASTER_CATALOG_PYTHON ?? process.env.SALES_IMPORT_PYTHON ?? "python3";
const importer = path.join(appRoot, "scripts/import-master-catalog.py");

const result = spawnSync(python, [
  importer,
  "--source", sourcePath,
  "--output-dir", outputRoot,
  "--manifest", manifestPath,
], {
  cwd: appRoot,
  encoding: "utf8",
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
