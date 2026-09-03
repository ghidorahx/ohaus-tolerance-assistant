import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const salesRoute = await readFile(new URL("../app/api/sales/route.ts", import.meta.url), "utf8");

async function builtWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("security-test", `${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
  return (await import(workerUrl.href)).default;
}

async function request(path, init = {}) {
  const worker = await builtWorker();
  return await worker.fetch(
    new Request(path, init),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function withEnvironment(values, operation) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("team access fails closed off localhost when its secret is missing", { concurrency: false }, async () => {
  await withEnvironment({ SALES_PILOT_ACCESS_CODE: undefined }, async () => {
    const healthResponse = await request("https://support.example/api/sales");
    const health = await healthResponse.json();
    assert.equal(health.status, "configuration_required");
    assert.equal(health.access_code_required, true);
    assert.equal(health.access_code_configured, false);

    const response = await request("https://support.example/api/sales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Tell me about CR221" }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "access_code_not_configured");
  });
});

test("localhost development remains available without a team-code secret", { concurrency: false }, async () => {
  await withEnvironment({ SALES_PILOT_ACCESS_CODE: undefined }, async () => {
    const response = await request("http://localhost/api/sales");
    const health = await response.json();
    assert.equal(response.status, 200);
    assert.equal(health.status, "ready");
    assert.equal(health.access_code_required, false);
    assert.equal(health.access_code_configured, false);
  });
});

test("only authenticated administration opts into seed-progress status", () => {
  const publicGet = salesRoute.slice(
    salesRoute.indexOf("export async function GET"),
    salesRoute.indexOf("export async function POST"),
  );
  const adminPut = salesRoute.slice(salesRoute.indexOf("export async function PUT"));

  assert.match(publicGet, /getMasterCatalogStatus\(\{[\s\S]*?includeSeedProgress:\s*false,[\s\S]*?\}\)/);
  assert.doesNotMatch(publicGet, /includeSeedProgress:\s*true/);
  assert.match(adminPut, /if \(action === "status"\)[\s\S]*?getMasterCatalogStatus\(\{[\s\S]*?includeSeedProgress:\s*true,[\s\S]*?\}\)/);
});

test("authenticated retrieval diagnostics derive semantic materials from selected semantic chunks", () => {
  const adminPut = salesRoute.slice(salesRoute.indexOf("export async function PUT"));
  assert.match(adminPut, /catalog_retrieval_unavailable[\s\S]*?d1_health:[\s\S]*?warnings:/);
  assert.match(adminPut, /evaluation_diagnostics:\s*\{/);
  assert.match(adminPut, /semantic_material_numbers:[\s\S]*?result\.chunks[\s\S]*?retrieval\?\.sources\?\.includes\("semantic"\)/);
  assert.match(adminPut, /retrievalProfileSha256:\s*body\.retrieval_profile_sha256/);
});

test("public retrieval preserves the raw customer question on both retrieval passes", () => {
  const publicPost = salesRoute.slice(
    salesRoute.indexOf("export async function POST"),
    salesRoute.indexOf("export async function PUT"),
  );
  assert.equal(publicPost.match(/rawQuestion:\s*question/g)?.length, 2);
});

test("catalog administration rejects cross-origin requests before authorization", { concurrency: false }, async () => {
  await withEnvironment({ CATALOG_ADMIN_TOKEN: "valid-admin-token" }, async () => {
    const response = await request("https://support.example/api/sales", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
        "x-catalog-admin-token": "valid-admin-token",
      },
      body: JSON.stringify({ action: "status", version_id: "catalog-v1" }),
    });
    assert.equal(response.status, 403);
  });
});

test("catalog administration fails closed for missing and invalid secrets", { concurrency: false }, async () => {
  await withEnvironment({ CATALOG_ADMIN_TOKEN: undefined }, async () => {
    const response = await request("https://support.example/api/sales", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", version_id: "catalog-v1" }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "catalog_admin_not_configured");
  });

  await withEnvironment({ CATALOG_ADMIN_TOKEN: "valid-admin-token" }, async () => {
    const response = await request("https://support.example/api/sales", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-catalog-admin-token": "wrong-admin-token",
      },
      body: JSON.stringify({ action: "status", version_id: "catalog-v1" }),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "catalog_admin_required");
  });
});

test("catalog administration rejects oversized bodies after valid authorization", { concurrency: false }, async () => {
  await withEnvironment({ CATALOG_ADMIN_TOKEN: "valid-admin-token" }, async () => {
    const response = await request("https://support.example/api/sales", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-catalog-admin-token": "valid-admin-token",
      },
      body: JSON.stringify({
        action: "status",
        version_id: "catalog-v1",
        padding: "x".repeat(20 * 1_024),
      }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, "request_too_large");
  });
});

test("unauthorized callers cannot mutate catalog rollout state", { concurrency: false }, async () => {
  await withEnvironment({ CATALOG_ADMIN_TOKEN: "valid-admin-token" }, async () => {
    for (const action of ["seed", "activate", "reset_failed_seed", "record_evaluation"]) {
      const response = await request("https://support.example/api/sales", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-catalog-admin-token": "wrong-admin-token",
        },
        body: JSON.stringify({ action, version_id: "catalog-v1" }),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, "catalog_admin_required");
    }
  });
});
