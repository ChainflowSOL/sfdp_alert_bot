import assert from "node:assert";
import {
  compareVersions,
  diffRequirements,
  checkCompliance,
  effectiveRequirement,
} from "../src/sfdpAlertBot";

function strip(s: string) {
  return s.replace(/<[^>]+>/g, "");
}

async function run() {
  // --- version comparison, incl. the chat's real case ---
  assert.ok(compareVersions("4.0.0-beta7", "4.0.0-rc1") < 0, "beta7 should be < rc1");
  assert.ok(compareVersions("2.1.13", "2.1.0") > 0);
  assert.strictEqual(compareVersions("2.2.0", "2.2.0"), 0);
  assert.ok(compareVersions("2.0.0", "2.1.0") < 0);
  assert.ok(compareVersions("4.0.0", "4.0.0-rc1") > 0); // release > prerelease
  console.log("OK  version comparison (beta7 < rc1, release > prerelease, etc.)");

  // --- diff: existing epoch requirement edited ---
  {
    const oldMap = {
      "860": {
        epoch: 860,
        agave_min_version: "2.1.0",
        agave_max_version: "2.2.0",
        firedancer_min_version: "0.2.0",
        firedancer_max_version: "0.3.0",
        inherited_from_prev_epoch: false,
      },
    };
    const next = [
      {
        epoch: 860,
        agave_min_version: "2.2.14",
        agave_max_version: "2.3.0",
        firedancer_min_version: "0.3.0",
        firedancer_max_version: null,
        inherited_from_prev_epoch: false,
      },
    ];
    const alerts = diffRequirements("testnet", oldMap as any, next as any);
    assert.strictEqual(alerts.length, 1);
    assert.ok(alerts[0].includes("CHANGED"));
    console.log("OK  detects edited requirement ->", strip(alerts[0].split("\n")[0]));
  }

  // --- diff: new explicit future requirement appears (window slides) ---
  {
    const oldMap = {
      "857": {
        epoch: 857,
        agave_min_version: "2.0.0",
        agave_max_version: null,
        firedancer_min_version: "0.1.0",
        firedancer_max_version: null,
        inherited_from_prev_epoch: true,
      },
    };
    const next = [
      { epoch: 857, agave_min_version: "2.0.0", agave_max_version: null, firedancer_min_version: "0.1.0", firedancer_max_version: null, inherited_from_prev_epoch: true },
      { epoch: 858, agave_min_version: "2.0.0", agave_max_version: null, firedancer_min_version: "0.1.0", firedancer_max_version: null, inherited_from_prev_epoch: true },
      { epoch: 860, agave_min_version: "2.1.0", agave_max_version: "2.2.0", firedancer_min_version: "0.2.0", firedancer_max_version: "0.3.0", inherited_from_prev_epoch: false },
    ];
    const alerts = diffRequirements("mainnet-beta", oldMap as any, next as any);
    assert.strictEqual(alerts.length, 1);
    assert.ok(alerts[0].includes("New SFDP"));
    console.log("OK  detects new published requirement ->", strip(alerts[0].split("\n")[0]));
  }

  // --- diff: an API-side new *_version field is picked up generically ---
  {
    const oldMap = {
      "860": {
        epoch: 860,
        agave_min_version: "2.1.0",
        agave_max_version: "2.2.0",
        firedancer_min_version: "0.2.0",
        firedancer_max_version: "0.3.0",
        // Pretend an earlier poll captured a quic_min_version too.
        quic_min_version: "1.0.0",
        inherited_from_prev_epoch: false,
      },
    };
    const next = [
      {
        epoch: 860,
        agave_min_version: "2.1.0",
        agave_max_version: "2.2.0",
        firedancer_min_version: "0.2.0",
        firedancer_max_version: "0.3.0",
        quic_min_version: "1.1.0", // only this changed
        inherited_from_prev_epoch: false,
      },
    ];
    const alerts = diffRequirements("testnet", oldMap as any, next as any);
    assert.strictEqual(alerts.length, 1, "should alert on a new *_version field changing");
    console.log("OK  detects change in a previously-unknown *_version field");
  }

  // --- diff: pure inherited window advance => NO alert (no noise) ---
  {
    const oldMap = {
      "857": { epoch: 857, agave_min_version: "2.0.0", agave_max_version: null, firedancer_min_version: "0.1.0", firedancer_max_version: null, inherited_from_prev_epoch: true },
    };
    const next = [
      { epoch: 858, agave_min_version: "2.0.0", agave_max_version: null, firedancer_min_version: "0.1.0", firedancer_max_version: null, inherited_from_prev_epoch: true },
      { epoch: 859, agave_min_version: "2.0.0", agave_max_version: null, firedancer_min_version: "0.1.0", firedancer_max_version: null, inherited_from_prev_epoch: true },
    ];
    assert.strictEqual(diffRequirements("mainnet-beta", oldMap as any, next as any).length, 0);
    console.log("OK  inherited window advance produces no false alert");
  }

  // --- compliance: the chat scenario, node on beta7 when rc1 required ---
  const entries = [
    { epoch: 1020, agave_min_version: "4.0.0-rc1", agave_max_version: null, firedancer_min_version: null, firedancer_max_version: null, inherited_from_prev_epoch: false },
  ];
  assert.strictEqual(effectiveRequirement(entries as any, 1020)!.epoch, 1020);

  const validator = { name: "testnet-val", cluster: "testnet", client: "agave", rpc_url: "x" };

  // Monkeypatch the RPC layer by intercepting global fetch.
  const realFetch = globalThis.fetch;
  function mockFetch(version: string) {
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const result =
        body.method === "getVersion"
          ? { "solana-core": version, "feature-set": 1 }
          : { epoch: 1020 };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  mockFetch("4.0.0-beta7");
  const [msg] = await checkCompliance(validator as any, entries as any);
  assert.ok(msg && msg.includes("NON-COMPLIANT"));
  console.log("OK  compliance flags beta7 vs rc1:");
  console.log("    " + strip(msg!).split("\n").join("\n    "));

  mockFetch("4.0.0-rc1");
  const [msg2] = await checkCompliance(validator as any, entries as any);
  assert.strictEqual(msg2, null);
  console.log("OK  compliant node produces no alert");

  globalThis.fetch = realFetch;
  console.log("\nALL TESTS PASSED");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});