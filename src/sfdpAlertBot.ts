#!/usr/bin/env node
/**
 * SFDP Required-Version Alert Bot for Telegram (TypeScript / Node).
 *
 * Monitors the Solana Foundation Delegation Program (SFDP) required-versions API
 * and alerts a Telegram chat when:
 *   1. The required agave / firedancer versions change for any cluster, and
 *   2. (optional) one of your validators is running a version that is
 *      non-compliant with the requirement for the current or an upcoming epoch.
 *
 * API reference: https://solana.org/delegation-api-docs
 *   GET https://api.solana.org/api/community/v1/sfdp_required_versions?cluster=<cluster>
 *
 * Run modes:
 *   sfdp-alert-bot --once        one poll, then exit (good for cron)
 *   sfdp-alert-bot               loop forever (good for systemd)
 *   sfdp-alert-bot --test        send a test Telegram message and exit
 *   sfdp-alert-bot --dry-run     print alerts to stdout, send nothing
 *
 * Requires Node >= 18.17 (uses the global fetch / AbortController and node:util parseArgs).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const API_BASE = "https://api.solana.org/api/community/v1/sfdp_required_versions";
const USER_AGENT = "sfdp-alert-bot/1.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReqEntry {
  cluster?: string;
  epoch: number;
  agave_min_version: string | null;
  agave_max_version: string | null;
  firedancer_min_version: string | null;
  firedancer_max_version: string | null;
  inherited_from_prev_epoch?: boolean;
}

type ReqTuple = [string | null, string | null, string | null, string | null];

interface ValidatorCfg {
  name?: string;
  cluster: string;
  client?: "agave" | "firedancer" | string;
  rpc_url: string;
}

interface Config {
  telegram: { bot_token: string; chat_ids: string[] };
  poll_interval_seconds: number;
  clusters: string[];
  state_file: string;
  validators: ValidatorCfg[];
  /** If > 0, send a current-requirements summary after this many hours of silence. */
  heartbeat_interval_hours: number;
}

interface State {
  requirements: Record<string, Record<string, ReqEntry>>;
  compliance: Record<string, string>;
  /** Unix ms of the last message sent (alert or heartbeat). Used to schedule heartbeats. */
  last_message_at?: number;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG = {
  level: "info" as "info" | "debug",
  ts: () => new Date().toISOString(),
  info: (...a: unknown[]) => console.log(LOG.ts(), "INFO", ...a),
  warn: (...a: unknown[]) => console.warn(LOG.ts(), "WARN", ...a),
  error: (...a: unknown[]) => console.error(LOG.ts(), "ERROR", ...a),
  debug: (...a: unknown[]) => {
    if (LOG.level === "debug") console.log(LOG.ts(), "DEBUG", ...a);
  },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  poll_interval_seconds: 300,
  clusters: ["mainnet-beta", "testnet"],
  state_file: "sfdp_state.json",
  validators: [] as ValidatorCfg[],
  heartbeat_interval_hours: 0, // 0 disables heartbeat
};

function loadConfig(configPath: string): Config {
  if (!fs.existsSync(configPath)) {
    LOG.error(`Config file not found: ${configPath}`);
    LOG.error(`Copy config.example.json to ${configPath} and fill it in.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const cfg: Config = { ...DEFAULTS, ...raw, telegram: raw.telegram ?? {} };

  // Resolve state_file relative to the config file's directory so cron/systemd
  // runs don't silently start a fresh state when CWD differs from the project.
  const configDir = path.dirname(path.resolve(configPath));
  if (!path.isAbsolute(cfg.state_file)) {
    cfg.state_file = path.join(configDir, cfg.state_file);
  }

  // Environment overrides for secrets (handy for systemd / Docker).
  if (process.env.TELEGRAM_BOT_TOKEN) cfg.telegram.bot_token = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_IDS) {
    cfg.telegram.chat_ids = process.env.TELEGRAM_CHAT_IDS.split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }

  if (!cfg.telegram?.bot_token || !cfg.telegram?.chat_ids?.length) {
    LOG.error(
      "telegram.bot_token and telegram.chat_ids must be set " +
        "(in config or via TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS).",
    );
    process.exit(1);
  }
  cfg.telegram.chat_ids = cfg.telegram.chat_ids.map((c) => String(c));
  return cfg;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface HttpOpts {
  retries?: number;
  timeoutMs?: number;
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}

async function httpJson(method: string, url: string, opts: HttpOpts = {}): Promise<any> {
  const { retries = 3, timeoutMs = 30_000, body, params } = opts;
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, ...(opts.headers ?? {}) };
  let target = url;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    target += (target.includes("?") ? "&" : "?") + qs;
  }
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(target, { method, headers, body: payload, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      LOG.warn(`Request to ${target} failed (attempt ${attempt}/${retries}): ${String(e)}`);
      if (attempt < retries) await sleep(2 ** attempt * 1000);
    }
  }
  throw lastErr;
}

async function fetchRequiredVersions(cluster: string): Promise<ReqEntry[]> {
  const data = await httpJson("GET", API_BASE, { params: { cluster } });
  const entries: ReqEntry[] = data?.data ?? [];
  return entries.slice().sort((a, b) => a.epoch - b.epoch);
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[] = []): Promise<any> {
  const data = await httpJson("POST", rpcUrl, { body: { jsonrpc: "2.0", id: 1, method, params } });
  if (data?.error) throw new Error(`RPC ${method} error: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function fetchNodeVersion(rpcUrl: string): Promise<string> {
  const result = await rpcCall(rpcUrl, "getVersion");
  return result["solana-core"] ?? result.version;
}

async function fetchCurrentEpoch(rpcUrl: string): Promise<number> {
  const result = await rpcCall(rpcUrl, "getEpochInfo");
  return Number(result.epoch);
}

// Public RPC endpoints return whatever version Solana Foundation runs, not your
// validator's. Warn once per process if we spot one in a validator config.
const PUBLIC_RPC_HOSTS = new Set([
  "api.mainnet-beta.solana.com",
  "api.testnet.solana.com",
  "api.devnet.solana.com",
  "solana-api.projectserum.com",
]);
const warnedPublicRpc = new Set<string>();
function warnIfPublicRpc(rpcUrl: string, validatorName: string): void {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    return;
  }
  if (!PUBLIC_RPC_HOSTS.has(host) || warnedPublicRpc.has(host)) return;
  warnedPublicRpc.add(host);
  LOG.warn(
    `Validator "${validatorName}" rpc_url is a public endpoint (${host}). ` +
      `Compliance checks will report the public RPC's version, NOT your validator. ` +
      `Point rpc_url at your validator's own RPC (e.g. http://127.0.0.1:8899).`,
  );
}

// ---------------------------------------------------------------------------
// Semantic-version comparison (handles pre-releases like 4.0.0-beta7, 4.0.0-rc1)
// ---------------------------------------------------------------------------

const VER_RE = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-(.+))?$/;

function parseVersion(v: string | null | undefined): { core: number[]; pre: string | null } | null {
  if (!v) return null;
  const s = String(v).trim().replace(/^[vV]/, "").split("+")[0];
  const m = VER_RE.exec(s);
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), m[3] != null ? Number(m[3]) : 0],
    pre: m[4] ?? null,
  };
}

function cmp(a: number | string, b: number | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Returns -1, 0, 1. Falls back to string compare if either is unparseable. */
function compareVersions(v1: string | null, v2: string | null): number {
  const p1 = parseVersion(v1);
  const p2 = parseVersion(v2);
  if (!p1 || !p2) return cmp(String(v1), String(v2));

  for (let i = 0; i < 3; i++) {
    const c = cmp(p1.core[i], p2.core[i]);
    if (c) return c;
  }
  const { pre: pre1 } = p1;
  const { pre: pre2 } = p2;
  if (pre1 === null && pre2 === null) return 0;
  if (pre1 === null) return 1; // a release outranks any pre-release of the same core
  if (pre2 === null) return -1;

  const ids1 = pre1.split(".");
  const ids2 = pre2.split(".");
  const n = Math.min(ids1.length, ids2.length);
  for (let i = 0; i < n; i++) {
    const a = ids1[i];
    const b = ids2[i];
    const an = /^\d+$/.test(a);
    const bn = /^\d+$/.test(b);
    let c: number;
    if (an && bn) c = cmp(Number(a), Number(b));
    else if (an) c = -1; // numeric identifiers rank below alphanumeric ones
    else if (bn) c = 1;
    else c = cmp(a, b);
    if (c) return c;
  }
  return cmp(ids1.length, ids2.length);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtRange(mn: string | null, mx: string | null): string {
  if (mn && mx) return `${esc(mn)} – ${esc(mx)}`;
  if (mn) return `≥ ${esc(mn)}`;
  if (mx) return `≤ ${esc(mx)}`;
  return "any";
}

function reqTuple(entry: ReqEntry): ReqTuple {
  return [
    entry.agave_min_version,
    entry.agave_max_version,
    entry.firedancer_min_version,
    entry.firedancer_max_version,
  ];
}

/**
 * Canonical signature of every version-bearing field on a requirement entry.
 * Field-agnostic so that if the API adds e.g. `quic_min_version` we'll diff it
 * instead of silently ignoring the new field.
 */
function reqSignature(entry: ReqEntry): string {
  const fields: Record<string, string | null> = {};
  for (const k of Object.keys(entry).sort()) {
    if (k.endsWith("_min_version") || k.endsWith("_max_version")) {
      const v = (entry as unknown as Record<string, unknown>)[k];
      fields[k] = v == null ? null : String(v);
    }
  }
  return JSON.stringify(fields);
}

function entriesEqual(a: ReqEntry, b: ReqEntry): boolean {
  return reqSignature(a) === reqSignature(b);
}

function fmtRequirementBlock(t: ReqTuple): string {
  const [amn, amx, fmn, fmx] = t;
  return `  • Agave: ${fmtRange(amn, amx)}\n  • Firedancer: ${fmtRange(fmn, fmx)}`;
}

function fmtChange(cluster: string, epoch: number, oldT: ReqTuple, newT: ReqTuple): string {
  const [oAmn, oAmx, oFmn, oFmx] = oldT;
  const [nAmn, nAmx, nFmn, nFmx] = newT;
  return (
    `⚠️ <b>SFDP required version CHANGED</b>\n` +
    `Cluster: <b>${esc(cluster)}</b>\n` +
    `Epoch: <b>${epoch}</b>\n` +
    `Agave: ${fmtRange(oAmn, oAmx)} → <b>${fmtRange(nAmn, nAmx)}</b>\n` +
    `Firedancer: ${fmtRange(oFmn, oFmx)} → <b>${fmtRange(nFmn, nFmx)}</b>`
  );
}

function fmtNew(cluster: string, epoch: number, t: ReqTuple): string {
  return (
    `🆕 <b>New SFDP required version published</b>\n` +
    `Cluster: <b>${esc(cluster)}</b>\n` +
    `Effective from epoch: <b>${epoch}</b>\n` +
    `${fmtRequirementBlock(t)}`
  );
}

// ---------------------------------------------------------------------------
// Core logic: diffing required versions
// ---------------------------------------------------------------------------

function diffRequirements(
  cluster: string,
  oldMap: Record<string, ReqEntry>,
  newEntries: ReqEntry[],
): string[] {
  const alerts: string[] = [];
  const oldByEpoch = new Map<number, ReqEntry>();
  for (const [ep, v] of Object.entries(oldMap)) oldByEpoch.set(Number(ep), v);

  let prevLatest: ReqEntry | null = null;
  if (oldByEpoch.size) prevLatest = oldByEpoch.get(Math.max(...oldByEpoch.keys()))!;

  for (const entry of newEntries) {
    const ep = entry.epoch;
    if (oldByEpoch.has(ep)) {
      // We've seen this epoch before — alert if the requirement was edited.
      const old = oldByEpoch.get(ep)!;
      if (!entriesEqual(old, entry)) alerts.push(fmtChange(cluster, ep, reqTuple(old), reqTuple(entry)));
    } else {
      // A future epoch we hadn't recorded yet. Only alert if it is an *explicit*
      // new requirement (not inherited) and actually differs from the last
      // requirement we knew about — avoids noise from the rolling window advancing.
      const isExplicit = !entry.inherited_from_prev_epoch;
      if (prevLatest && isExplicit && !entriesEqual(prevLatest, entry)) {
        alerts.push(fmtNew(cluster, ep, reqTuple(entry)));
      }
    }
  }
  return alerts;
}

function effectiveRequirement(entries: ReqEntry[], epoch: number): ReqEntry | null {
  let eff: ReqEntry | null = null;
  for (const e of entries) {
    if (e.epoch <= epoch) eff = e;
    else break;
  }
  return eff ?? (entries.length ? entries[0] : null);
}

// Stable signature for an unreachable validator. Kept independent of the error
// text so a flapping error message doesn't re-fire the "unreachable" alert.
const UNREACHABLE_SIG = "unreachable";

async function checkCompliance(
  validator: ValidatorCfg,
  entries: ReqEntry[],
  prevSig?: string,
): Promise<[string | null, string]> {
  const name = validator.name ?? "validator";
  const cluster = validator.cluster;
  const rpcUrl = validator.rpc_url;
  const client = (validator.client ?? "agave").toLowerCase();
  warnIfPublicRpc(rpcUrl, name);

  let nodeVer: string;
  let currentEpoch: number;
  try {
    nodeVer = await fetchNodeVersion(rpcUrl);
    currentEpoch = await fetchCurrentEpoch(rpcUrl);
  } catch (e) {
    LOG.warn(`Could not query validator ${name} (${rpcUrl}): ${String(e)}`);
    // Alert on the transition into "unreachable" so operators learn their
    // validator's RPC went dark. The stable signature means runOnce fires this
    // only once until the node recovers.
    const msg =
      `📵 <b>Validator UNREACHABLE</b>\n` +
      `Validator: <b>${esc(name)}</b> (${esc(cluster)}, ${esc(client)})\n` +
      `Could not query its RPC (${esc(rpcUrl)}).\n` +
      `Error: ${esc(String(e))}`;
    return [msg, UNREACHABLE_SIG];
  }

  const wasUnreachable = prevSig === UNREACHABLE_SIG;

  if (!entries.length) return [null, "no-requirements"];

  const minKey = client === "firedancer" ? "firedancer_min_version" : "agave_min_version";
  const maxKey = client === "firedancer" ? "firedancer_max_version" : "agave_max_version";

  const nowReq = effectiveRequirement(entries, currentEpoch)!;
  const mn = nowReq[minKey as keyof ReqEntry] as string | null;
  const mx = nowReq[maxKey as keyof ReqEntry] as string | null;

  const problems: string[] = [];
  if (mn && compareVersions(nodeVer, mn) < 0) {
    problems.push(`running ${esc(nodeVer)} is below the required minimum ${esc(mn)}`);
  }
  if (mx && compareVersions(nodeVer, mx) > 0) {
    problems.push(`running ${esc(nodeVer)} is above the allowed maximum ${esc(mx)}`);
  }

  // Upcoming epochs that will require an upgrade the node hasn't done yet.
  const upcoming: Array<[number, string]> = [];
  for (const e of entries) {
    if (e.epoch <= currentEpoch) continue;
    const fmn = e[minKey as keyof ReqEntry] as string | null;
    if (fmn && compareVersions(nodeVer, fmn) < 0) upcoming.push([e.epoch, fmn]);
  }

  // Include the in-force requirement range in the signature so that a node which
  // stays non-compliant while the requirement itself tightens (e.g. the required
  // minimum moves up again) is re-alerted instead of silently deduped.
  const req = `${mn ?? "*"}..${mx ?? "*"}`;
  const signature = `${client}|${nodeVer}|req=${req}|now_ok=${problems.length === 0}|up=${JSON.stringify(upcoming)}`;

  if (!problems.length && !upcoming.length) {
    // Healthy. If we were previously unreachable, announce the recovery.
    if (wasUnreachable) {
      const msg =
        `✅ <b>Validator back online &amp; compliant</b>\n` +
        `Validator: <b>${esc(name)}</b> (${esc(cluster)}, ${esc(client)})\n` +
        `Running: <b>${esc(nodeVer)}</b>\n` +
        `Required now (epoch ${currentEpoch}): ${fmtRange(mn, mx)}`;
      return [msg, signature];
    }
    return [null, signature];
  }

  const lines: string[] = [];
  lines.push(problems.length ? `🚨 <b>Validator NON-COMPLIANT</b>` : `🔔 <b>Validator upgrade needed soon</b>`);
  lines.push(`Validator: <b>${esc(name)}</b> (${esc(cluster)}, ${esc(client)})`);
  lines.push(`Running: <b>${esc(nodeVer)}</b>`);
  lines.push(`Required now (epoch ${currentEpoch}): ${fmtRange(mn, mx)}`);
  for (const p of problems) lines.push(`  ❌ ${p}`);
  if (upcoming.length) {
    const next = upcoming.reduce((a, b) => (b[0] < a[0] ? b : a));
    lines.push(`  ⏭ By epoch <b>${next[0]}</b> you must run ≥ <b>${esc(next[1])}</b>`);
  }
  return [lines.join("\n"), signature];
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegram(cfg: Config, text: string, dryRun = false): Promise<void> {
  if (dryRun) {
    console.log("\n--- TELEGRAM (dry-run) ---");
    console.log(text.replace(/<[^>]+>/g, "")); // strip tags for console readability
    console.log("--------------------------\n");
    return;
  }
  const token = cfg.telegram.bot_token;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  for (const chatId of cfg.telegram.chat_ids) {
    try {
      await httpJson("POST", url, {
        retries: 2,
        body: {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        },
      });
    } catch (e) {
      LOG.error(`Telegram send to ${chatId} failed: ${String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function loadState(statePath: string): State {
  if (fs.existsSync(statePath)) {
    try {
      const s = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Partial<State>;
      return {
        requirements: s.requirements ?? {},
        compliance: s.compliance ?? {},
        last_message_at: s.last_message_at,
      };
    } catch (e) {
      LOG.warn(`Could not read state file ${statePath} (${String(e)}); starting fresh.`);
    }
  }
  return { requirements: {}, compliance: {} };
}

function saveState(statePath: string, state: State): void {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

function buildSummary(cfg: Config, state: State, header: string): string | null {
  const lines: string[] = [header, ""];
  let hasContent = false;
  for (const cluster of cfg.clusters) {
    const window = state.requirements[cluster] ?? {};
    const entries = Object.values(window);
    if (!entries.length) continue;
    const latest = entries.reduce((a, b) => (b.epoch > a.epoch ? b : a));
    lines.push(`<b>${esc(cluster)}</b> (epoch ${latest.epoch}):`);
    lines.push(fmtRequirementBlock(reqTuple(latest)));
    hasContent = true;
  }
  return hasContent ? lines.join("\n") : null;
}

// ---------------------------------------------------------------------------
// One polling cycle
// ---------------------------------------------------------------------------

async function runOnce(cfg: Config, dryRun = false): Promise<void> {
  const state = loadState(cfg.state_file);
  const firstRun = Object.keys(state.requirements).length === 0;
  let sentAnyMessage = false;

  const notify = async (msg: string) => {
    await sendTelegram(cfg, msg, dryRun);
    if (!dryRun) {
      state.last_message_at = Date.now();
      sentAnyMessage = true;
    }
  };

  // 1) Required-version tracking per cluster. Persist after each cluster so a
  //    crash mid-loop doesn't re-fire alerts for clusters we already processed.
  for (const cluster of cfg.clusters) {
    let entries: ReqEntry[];
    try {
      entries = await fetchRequiredVersions(cluster);
    } catch (e) {
      LOG.error(`Failed to fetch required versions for ${cluster}: ${String(e)}`);
      continue;
    }

    const oldMap = state.requirements[cluster] ?? {};
    for (const a of diffRequirements(cluster, oldMap, entries)) {
      await notify(a);
    }

    const window: Record<string, ReqEntry> = {};
    for (const e of entries) window[String(e.epoch)] = e;
    state.requirements[cluster] = window;
    saveState(cfg.state_file, state);
  }

  if (firstRun && !dryRun) {
    // One-time baseline summary so operators know it's live.
    const baseline = buildSummary(cfg, state, "✅ <b>SFDP version monitor started</b>");
    if (baseline) await notify(baseline);
  }

  // 2) Optional per-validator compliance checks.
  for (const validator of cfg.validators ?? []) {
    const window = state.requirements[validator.cluster] ?? {};
    const entries = Object.values(window).sort((a, b) => a.epoch - b.epoch);
    const key = validator.name ?? validator.rpc_url ?? "validator";
    const [msg, sig] = await checkCompliance(validator, entries, state.compliance[key]);
    if (msg && state.compliance[key] !== sig) await notify(msg);
    state.compliance[key] = sig; // record latest signature; only alert on transitions
  }

  // 3) Heartbeat: if configured and we've been silent past the interval, emit
  //    a "still here, current requirements look like this" summary so operators
  //    can distinguish "no SFDP changes" from "bot is dead".
  if (!dryRun && cfg.heartbeat_interval_hours > 0 && !sentAnyMessage) {
    const intervalMs = cfg.heartbeat_interval_hours * 3600_000;
    const last = state.last_message_at ?? 0;
    if (Date.now() - last >= intervalMs) {
      const hb = buildSummary(cfg, state, "💓 <b>SFDP monitor heartbeat</b>");
      if (hb) await notify(hb);
    }
  }

  saveState(cfg.state_file, state);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: process.env.CONFIG_FILE ?? "config.json" },
      once: { type: "boolean", default: false },
      test: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
    },
  });

  if (values.verbose) LOG.level = "debug";
  const cfg = loadConfig(values.config as string);
  const dryRun = values["dry-run"] as boolean;

  if (values.test) {
    await sendTelegram(
      cfg,
      "✅ <b>SFDP alert bot</b>: test message. If you see this, Telegram is wired up correctly.",
      dryRun,
    );
    return;
  }

  if (values.once) {
    await runOnce(cfg, dryRun);
    return;
  }

  const interval = Number(cfg.poll_interval_seconds);
  LOG.info(`Starting loop. Polling every ${interval}s. Clusters: ${cfg.clusters.join(", ")}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runOnce(cfg, dryRun);
    } catch (e) {
      LOG.error(`Unexpected error during poll: ${String(e)}`);
    }
    await sleep(interval * 1000);
  }
}

// Exported for unit tests.
export {
  parseVersion,
  compareVersions,
  reqTuple,
  diffRequirements,
  effectiveRequirement,
  checkCompliance,
  fmtRange,
};

// Run only when executed directly, not when imported by tests.
if (require.main === module) {
  main().catch((e) => {
    LOG.error("Fatal:", e);
    process.exit(1);
  });
}