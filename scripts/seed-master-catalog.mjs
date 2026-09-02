import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

async function request(url, token, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-catalog-admin-token": token,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `Catalog administration request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.code ?? null;
    throw error;
  }
  return payload;
}

const token = process.env.CATALOG_ADMIN_TOKEN?.trim();
if (!token) throw new Error("CATALOG_ADMIN_TOKEN is required.");

const manifestPath = path.resolve(option(
  "--manifest",
  path.join(appRoot, "data/master-catalog-manifest.json"),
));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const versionId = option("--version", manifest.version_id);
const url = option("--url", process.env.CATALOG_ADMIN_URL ?? "https://support.ghidorahx.workers.dev/api/sales");
const batchSize = Math.max(1, Math.min(96, Number(option("--batch-size", "64")) || 64));
const statusOnly = flag("--status-only");
const skipActivation = flag("--no-activate");
const resetFailed = flag("--reset-failed");

if (!versionId) throw new Error("The catalog manifest does not contain version_id.");
if (statusOnly && resetFailed) throw new Error("Use either --status-only or --reset-failed, not both.");

if (statusOnly) {
  const status = await request(url, token, { action: "status", version_id: versionId });
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

if (resetFailed) {
  const reset = await request(url, token, { action: "reset_failed_seed", version_id: versionId });
  console.log(`Reset ${Number(reset.reset_count ?? 0)} failed vector row(s) for staged catalog ${versionId}.`);
}

let batchNumber = 0;
let result;
do {
  batchNumber += 1;
  result = await request(url, token, {
    action: "seed",
    version_id: versionId,
    batch_size: batchSize,
  });
  const seeded = Number(result.seeded ?? result.processed ?? 0);
  const remaining = Number(result.remaining ?? 0);
  const total = Number(result.total ?? manifest.counts?.chunks ?? 0);
  if (batchNumber === 1 || batchNumber % 20 === 0 || result.complete) {
    console.log(`Batch ${batchNumber}: ${seeded} indexed, ${remaining} remaining${total ? ` of ${total}` : ""}.`);
  }
  if (!result.complete && seeded === 0) {
    throw new Error("Catalog seeding made no progress. Inspect status and use --reset-failed only after correcting the recorded failure.");
  }
  if (batchNumber > 10_000) throw new Error("Catalog seeding exceeded the safety batch limit.");
} while (!result.complete);

if (!skipActivation) {
  // Vectorize mutations are asynchronous. The server verifies a deterministic
  // sample across the full seed before activation; retry while it propagates.
  let activation;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      activation = await request(url, token, { action: "activate", version_id: versionId });
      break;
    } catch (error) {
      if (error.code !== "catalog_vectors_propagating" || attempt === 5) throw error;
      const delay = Math.min(30_000, 2_000 * (2 ** attempt));
      console.log(`Final vectors are propagating; retrying activation in ${Math.round(delay / 1_000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  console.log(`Catalog ${activation?.version_id ?? versionId} is ${activation?.status ?? "active"}.`);
}
