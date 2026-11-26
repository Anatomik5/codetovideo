import OpenAI from "openai";
import dotenv from "dotenv";
import { exec as rawExec, execFile as rawExecFile, execFileSync as rawExecFileSync, execSync as rawExecSync, spawn as rawSpawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";
import { chromium, type Browser, type Page } from "playwright";
import { writeSubtitles } from "./export-srt";
import { codeToHtml } from "shiki";

/** Capture process.env BEFORE dotenv loads .env, so we can avoid leaking CodeToVideo-specific vars into spawned apps. */
const ORIGINAL_ENV = { ...process.env };

dotenv.config();

/* ------------------------------------------------------------------ */
/* Silent process helpers                                              */
/* ------------------------------------------------------------------ */
/*
 * EVERY child process of this project goes through the helpers below. They always pass `windowsHide: true`, so on
 * Windows no console window is ever created (a process without a console otherwise gets a visible conhost per child).
 * Prefer the *File* variants (binary + argument array, no shell) wherever the command is a plain program call.
 */

/** Run a shell command line synchronously and silently. */
function runSilentSync(cmd: string, opts: any = {}): any {
  return rawExecSync(cmd, { windowsHide: true, ...opts });
}

/** Run a binary directly (no shell) synchronously and silently. */
function execFileSilentSync(file: string, args: string[], opts: any = {}): any {
  return rawExecFileSync(file, args, { windowsHide: true, ...opts });
}

/** Spawn a process silently. Same signature as child_process.spawn. */
function spawnSilent(cmd: string, argsOrOpts?: string[] | Record<string, any>, maybeOpts?: Record<string, any>): ChildProcess {
  const hasArgs = Array.isArray(argsOrOpts);
  const args = hasArgs ? (argsOrOpts as string[]) : [];
  const opts = (hasArgs ? maybeOpts : (argsOrOpts as Record<string, any> | undefined)) ?? {};
  const merged: Record<string, any> = { windowsHide: true, ...opts };
  // On Windows `detached: true` makes libuv create the child with its own console (conhost window), which overrides
  // windowsHide. Never detach there; callers that must outlive the parent use `child.unref()` instead.
  if (process.platform === "win32") merged.detached = false;
  return rawSpawn(cmd, args, merged);
}

/** Run a shell command line asynchronously and silently. */
const execSilentAsync = (cmd: string, opts: any = {}) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    rawExec(cmd, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Run a binary directly (no shell) asynchronously and silently. */
const execFileSilentAsync = (file: string, args: string[], opts: any = {}) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    rawExecFile(file, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Kill a whole process tree by pid (Windows: taskkill without a shell). */
function killTreeSilent(pid: number) {
  if (process.platform === "win32") execFileSilentSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(pid, "SIGKILL");
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const DEFAULT_PROMPT = "Show a clean, dynamic product promo of the main workflow";
const CAPTURE_FPS = 30;
/** Unique per process: intermediate files carry it so two runs can never overwrite each other's data. */
const RUN_ID = `${Date.now().toString(36)}${process.pid}`;

/** Hard per-call LLM budgets (ms). A hung provider can never block the process. */
const NAV_LLM_TIMEOUT_MS = 14_000;
const PLAN_LLM_TIMEOUT_MS = 90_000;
const SVG_LLM_TIMEOUT_MS = 110_000;

export interface PipelineOptions {
  prompt?: string;
  /** Project folder or launch file. */
  filePath?: string | null;
  /** Already running web app. */
  url?: string | null;
  port?: number | null;
  theme?: string;
  /** One or many files for multi-step upload forms. */
  uploadFiles?: string[];
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  publicDir?: string;
  outPath?: string;
  /** Saved session folder (manifest.json, clips/, props.json) for edit / re-render modes. */
  projectDir?: string | null;
  session?: string | null;
  /** Scene index (1-based) or id to modify. */
  editScene?: string | number | null;
  editPrompt?: string | null;
  /** Rebuild the final video from saved clips + manifest without launching a browser. */
  reRenderOnly?: boolean;
  /** Output height in pixels, 480 or higher (default 720). */
  quality?: number | string;
  /** Background generation: auto | generate (model draws) | motif (model picks). */
  backdropMode?: string;
  /** Explicit command that starts the app (trusted: typed by the user). Overrides the model's proposal. */
  launchCommand?: string;
  /** Video format: demo | promo. */
  format?: string;
  /** Developer aid: stop the browser agent after this many steps (quick smoke tests). */
  maxSteps?: number;
  /** Developer aid: record and save the session, skip the Remotion render. */
  noRender?: boolean;
}

export interface PipelineResult {
  status: "ok" | "stopped";
  mp4Path: string;
  durationSec: number;
  steps: string[];
  stopReason: string | null;
  comment: string | null;
  displayUrl: string;
  videoTitle: string;
  productName: string;
  uploadNames: string[];
  elapsedSec: number;
  startedAt: string;
  finishedAt: string;
}

interface CliConfig {
  filePath: string | null;
  url: string | null;
  port: number | null;
  theme: string;
  uploadFiles: string[];
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  prompt: string | null;
  outPath: string | null;
  projectDir: string | null;
  session: string | null;
  editScene: string | null;
  editPrompt: string | null;
  reRenderOnly: boolean;
  maxSteps: number | null;
  noRender: boolean;
  quality: string | null;
  backdropMode: string | null;
  format: string | null;
  launchCommand: string | null;
}

function parseCli(argv: string[]): CliConfig {
  const config: CliConfig = {
    filePath: null,
    url: null,
    port: null,
    theme: "auto",
    uploadFiles: [],
    model: null,
    baseUrl: null,
    apiKey: null,
    prompt: null,
    outPath: null,
    projectDir: null,
    session: null,
    editScene: null,
    editPrompt: null,
    reRenderOnly: false,
    maxSteps: null,
    noRender: false,
    quality: null,
    backdropMode: null,
    format: null,
    launchCommand: null,
  };

  const addUploads = (raw: string) => {
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (trimmed) config.uploadFiles.push(trimmed);
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--file" || arg === "--repo" || arg === "--repo-path") config.filePath = next() ?? null;
    else if (arg === "--prompt") config.prompt = next() ?? null;
    else if (arg === "--url") config.url = next() ?? null;
    else if (arg === "--port") config.port = Number(next()) || null;
    else if (arg === "--theme") config.theme = next() ?? "auto";
    else if (arg === "--upload" || arg === "--upload-file") {
      const value = next();
      if (value) addUploads(value);
    } else if (arg === "--model") config.model = next() ?? null;
    else if (arg === "--base-url") config.baseUrl = next() ?? null;
    else if (arg === "--api-key") config.apiKey = next() ?? null;
    else if (arg === "--out") config.outPath = next() ?? null;
    else if (arg === "--project-dir") config.projectDir = next() ?? null;
    else if (arg === "--session") config.session = next() ?? null;
    else if (arg === "--edit-scene") config.editScene = next() ?? null;
    else if (arg === "--edit-prompt") config.editPrompt = next() ?? null;
    else if (arg === "--re-render-only") config.reRenderOnly = true;
    else if (arg === "--max-steps") config.maxSteps = Number(next()) || null;
    else if (arg === "--no-render") config.noRender = true;
    else if (arg === "--quality") config.quality = next() ?? null;
    else if (arg === "--backdrop") config.backdropMode = next() ?? null;
    else if (arg === "--format") config.format = next() ?? null;
    else if (arg === "--launch") config.launchCommand = next() ?? null;
  }

  return config;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface UiEvent {
  atSec: number;
  kind: string;
  label: string;
  title?: string;
  x?: number;
  y?: number;
}

interface InteractiveElement {
  index: number;
  selector: string;
  tag: string;
  text: string;
  type: string;
  zone: string;
  isEnabled: boolean;
  isVisible: boolean;
  isDisabled: boolean;
  required: boolean;
  hasFiles: boolean;
  isFieldEmpty: boolean;
  inDialog: boolean;
  inForm: boolean;
  isSubmit: boolean;
  isBackCancel: boolean;
  isFilterOrTab: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

interface LlmNavigationDecision {
  action: "click" | "fill" | "upload" | "scroll" | "done";
  elementIndex?: number;
  value?: string;
  label: string;
  kind: string;
  scrollDelta?: number;
  stopReason?: string;
  completedNaturally?: boolean;
  /** Which layer made the decision: deterministic DOM rules or the LLM navigator. */
  source?: "rules" | "llm";
}

export interface StoryBeatPlan {
  id: string;
  title: string;
  caption: string;
  targetGoal: string;
}

export interface ArtDirection {
  accentColor: string;
  secondaryColor: string;
  bgStart: string;
  bgEnd: string;
  isDark: boolean;
  backdropSvg: string;
  backdropImage?: string;
}

export interface PacingConfig {
  scrollDurationMs: number;
  scrollStepPx: number;
  dwellAfterActionMs: number;
  preTrimPadSec: number;
  postTrimPadSec: number;
}

interface ProjectLaunchPlan {
  productName: string;
  launchCommand: string;
  expectedPorts: number[];
  summary: string;
}

interface DirectorScenario {
  videoTitle: string;
  introLine: string;
  outroLine: string;
  beats: StoryBeatPlan[];
  artDirection: ArtDirection;
  pacing: PacingConfig;
}

interface RepoStudy {
  root: string;
  name: string;
  readme: string;
  tree: string;
  keyFiles: { path: string; content: string }[];
  filesScanned: number;
}

interface RecordedAction {
  kind: "click" | "fill" | "upload" | "scroll";
  /** Seconds in the raw capture when the action began / finished (relative to the raw recording). */
  startSec: number;
  endSec: number;
  /** Moment the click/upload actually took effect (screen starts changing); drives chapter changes. */
  effectSec?: number;
  url: string;
  label: string;
  selector?: string;
  value?: string;
  fillMode?: "select" | "check" | "fill";
  uploadIndex?: number;
  scrollDelta?: number;
  /** Where on screen the action happened, normalised to the browser viewport (0..1). Drives promo zoom / call-outs. */
  rect?: { x: number; y: number; w: number; h: number };
}

interface RecordResult {
  recorded: boolean;
  /** Continuous encoded capture of this run (unique file name). */
  capturePath: string;
  actions: RecordedAction[];
  states: { atSec: number; url: string; snippet: string }[];
  replayOffsetSec: number;
  durationSec: number;
  uiEvents: UiEvent[];
  siteBg: string;
  detectedTheme: string;
  effectiveTheme: string;
  displayUrl: string;
  uploadName: string;
  stopReason: string | null;
  steps: string[];
}

interface PageDwellProfile {
  maxScroll: number;
  remainingScroll: number;
  isBusy: boolean;
  /** A filled primary button is visible but disabled: the app is still waiting (analysis running, input missing). */
  pendingPrimary: boolean;
}

interface LlmClient {
  openai: OpenAI;
  model: string;
  baseURL: string;
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const elapsedSec = (start: number) => (Date.now() - start) / 1000;
const cleanAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

function log(scope: string, message: string) {
  console.log(`[${scope}] ${message}`);
}

const isLocalEndpoint = (url: string) => /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(url);

let llmOverrides: { model?: string | null; baseUrl?: string | null; apiKey?: string | null } = {};

function getLlmClient(overrides?: { model?: string | null; baseUrl?: string | null; apiKey?: string | null }): LlmClient | null {
  const apiKey =
    overrides?.apiKey ||
    llmOverrides.apiKey ||
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GEMINI_APIKEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.GROQ_API_KEY ||
    "";

  let inferredBaseUrl = "";
  if (apiKey.startsWith("AIza")) {
    inferredBaseUrl = "https://generativelanguage.googleapis.com/v1beta/openai/";
  } else if (apiKey.startsWith("gsk_")) {
    inferredBaseUrl = "https://api.groq.com/openai/v1";
  } else if (apiKey.startsWith("sk-or-")) {
    inferredBaseUrl = "https://openrouter.ai/api/v1";
  }

  const baseURL =
    overrides?.baseUrl ||
    llmOverrides.baseUrl ||
    process.env.LLM_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    inferredBaseUrl ||
    "https://api.openai.com/v1";

  const effectiveKey = apiKey || (isLocalEndpoint(baseURL) ? "local" : "");
  if (!effectiveKey || effectiveKey === "no-key") return null;

  const model =
    overrides?.model ||
    llmOverrides.model ||
    process.env.LLM_MODEL ||
    process.env.OPENAI_MODEL ||
    (baseURL.includes("generativelanguage.googleapis.com")
      ? "gemini-3.8-flash"
      : baseURL.includes("api.groq.com")
        ? "llama-3.3-70b-versatile"
        : baseURL.includes("openrouter.ai")
          ? "openrouter/free"
          : baseURL.includes("deepseek")
            ? "deepseek-chat"
            : "gpt-4o-mini");

  return { openai: new OpenAI({ apiKey: effectiveKey, baseURL }), model, baseURL };
}

function readText(file: string, maxChars: number): string {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n… [truncated]` : raw;
  } catch {
    return "";
  }
}

function isProbablyBinary(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".woff", ".woff2", ".ttf", ".mp4", ".webm", ".dll", ".exe", ".so", ".dylib", ".pyc", ".duckdb", ".xlsx", ".xls", ".db"].includes(ext);
}

export function parseJsonLoose(content: string): any {
  const withoutThink = content.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim();
  const cleaned = withoutThink
    .replace(/^```(?:json|javascript|js|text)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch { /* fall through to repair */ }
    }
    if (first >= 0) {
      try {
        return JSON.parse(repairJson(cleaned.slice(first)));
      } catch { /* not repairable */ }
    }
    throw new Error("LLM response is not valid JSON.");
  }
}

/** Shortens text to at most `max` characters at a word boundary, adding an ellipsis; never cuts inside a word. */
export function clipText(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  const head = chars.slice(0, max - 1).join("");
  const cut = head.lastIndexOf(" ");
  // Text without spaces (e.g. CJK) or a single long word: fall back to a character cut.
  return `${(cut > max * 0.5 ? head.slice(0, cut) : head).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/**
 * Best-effort repair of JSON written by small models: drops trailing commas and closes a truncated
 * document (an unterminated string, then any open arrays/objects). Never invents values.
 */
export function repairJson(text: string): string {
  let out = "";
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    out += ch;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) break; // ignore anything after the top-level value
    }
  }
  if (inString) out += '"';
  // Remove a dangling separator or a half-written key/value pair at the cut, then close what is open.
  out = out.replace(/[,:]\s*$/, "").replace(/,\s*"[^"]*"\s*$/, "");
  while (stack.length) out += stack.pop();
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function stripThink(raw: string): string {
  return raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim();
}

/* ---------------- LLM Health & Keep-Alive Manager (local Ollama) ---------------- */

const isOllamaEndpoint = (url: string) => isLocalEndpoint(url) && /:11434\b/.test(url);
const ollamaRoot = (baseURL: string) => baseURL.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
const warmedModels = new Set<string>();
/** One context size for every call (warm-up included): a different num_ctx makes Ollama reload the model. */
const OLLAMA_NUM_CTX = 8192;

/** fetch + body read under ONE deadline: a server that sends headers and then stalls can never hang the pipeline. */
async function fetchJsonWithTimeout(url: string, init: RequestInit, ms: number): Promise<{ ok: boolean; status: number; data: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function listOllamaModels(root: string): Promise<string[] | null> {
  try {
    const res = await fetchJsonWithTimeout(`${root}/api/tags`, {}, 2000);
    if (!res.ok) return null;
    const data: any = res.data;
    return Array.isArray(data?.models) ? data.models.map((m: any) => String(m?.name || m?.model || "")) : [];
  } catch {
    return null;
  }
}

/** Pre-flight: make sure Ollama answers /api/tags (auto-start `ollama serve`), and the model is present and warm. */
async function ensureOllamaReady(baseURL: string, model: string, force = false): Promise<void> {
  if (!isOllamaEndpoint(baseURL)) return;
  const root = ollamaRoot(baseURL);
  let models = await listOllamaModels(root);

  if (models === null) {
    log("ollama", "Server unreachable — starting `ollama serve` in background…");
    warmedModels.clear();
    try {
      const child = spawnSilent("ollama", ["serve"], { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true, env: ORIGINAL_ENV });
      child.on("error", (e) => log("ollama", `Could not spawn ollama: ${e.message}`));
      child.unref();
    } catch (err) {
      log("ollama", `spawn failed: ${(err as Error).message}`);
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await sleep(500);
      models = await listOllamaModels(root);
      if (models !== null) break;
    }
    if (models === null) throw new Error("Ollama is not reachable and `ollama serve` did not become ready within 15s");
    log("ollama", "Server is up.");
  }

  const wanted = model.includes(":") ? model : `${model}:latest`;
  if (!models.some((m) => m === model || m === wanted)) {
    log("ollama", `Model "${model}" not found locally (installed: ${models.join(", ") || "none"}). Run: ollama pull ${model}`);
  }

  if (force || !warmedModels.has(model)) {
    try {
      const res = await fetchJsonWithTimeout(
        `${root}/api/generate`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, prompt: "", keep_alive: "10m", stream: false, options: { num_ctx: OLLAMA_NUM_CTX } }) },
        60_000,
      );
      if (res.ok) {
        warmedModels.add(model);
        log("ollama", `Model "${model}" warmed (keep_alive 10m).`);
      }
    } catch (err) {
      log("ollama", `Warm-up skipped: ${(err as Error).message}`);
    }
  }
}

async function chatWithHardTimeout(
  client: LlmClient,
  body: any,
  timeoutMs: number,
  label: string,
  enableThinking = false,
): Promise<OpenAI.Chat.ChatCompletion> {
  await ensureOllamaReady(client.baseURL, String(body.model || client.model));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
      reject(new Error(`${label} LLM call exceeded ${timeoutMs}ms hard timeout`));
    }, timeoutMs);
  });

  try {
    if (isLocalEndpoint(client.baseURL) && /:11434\b/.test(client.baseURL)) {
      const ollamaBase = client.baseURL.replace(/\/v1\/?$/, "");
      const data: any = await Promise.race([
        (async () => {
          const res = await fetch(`${ollamaBase}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              model: body.model,
              messages: body.messages,
              stream: false,
              think: enableThinking,
              keep_alive: "10m",
              format: body.response_format?.type === "json_object" ? "json" : undefined,
              options: {
                temperature: body.temperature ?? 0.25,
                num_predict: body.max_tokens ?? 1200,
                num_ctx: OLLAMA_NUM_CTX,
              },
            }),
          });
          if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`Ollama /api/chat HTTP ${res.status}: ${detail.slice(0, 200)}`);
          }
          return res.json(); // body is read inside the race, so the hard timeout covers it too
        })(),
        timeout,
      ]);
      return {
        choices: [{ message: { content: data?.message?.content || "" } }],
      } as OpenAI.Chat.ChatCompletion;
    }

    const request = client.openai.chat.completions.create(body, { signal: controller.signal });
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestChat(
  client: LlmClient,
  body: any,
  timeoutMs: number,
  label: string,
  enableThinking = false,
): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    return await chatWithHardTimeout(client, body, timeoutMs, label, enableThinking);
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    if (body?.response_format && /response_format|json_object|unsupported|unknown parameter|invalid request/i.test(msg)) {
      const { response_format: _rf, ...rest } = body;
      return chatWithHardTimeout(client, rest, timeoutMs, label, enableThinking);
    }
    if (enableThinking && /think/i.test(msg) && /support|unknown|invalid/i.test(msg)) {
      // Some models (e.g. without a reasoning mode) reject `think: true`: retry the same request without it.
      log("LLM", `${label}: model rejected thinking mode, retrying without it.`);
      return chatWithHardTimeout(client, body, timeoutMs, label, false);
    }
    if (isOllamaEndpoint(client.baseURL) && !/hard timeout/i.test(msg)) {
      // Local model: re-verify the server, re-warm the model and retry once.
      log("ollama", `${label} failed (${msg.slice(0, 120)}) — health-check and one retry.`);
      warmedModels.clear();
      await ensureOllamaReady(client.baseURL, String(body.model || client.model), true);
      return chatWithHardTimeout(client, body, timeoutMs, label, false);
    }
    throw err;
  }
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3, baseDelayMs = 1000): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = (err as Error)?.message || String(err);
      if (/exceeded your current quota|billing|404/i.test(msg)) break;
      // Malformed JSON from a small model is worth one more try: sampling usually gives a valid answer the second time.
      const retryable = /503|429|UNAVAILABLE|overloaded|high demand|ECONNRESET|ETIMEDOUT|fetch failed|not valid JSON|in JSON at position|Unexpected token|Unexpected end of JSON/i.test(msg);
      if (!retryable || i === attempts) break;
      const wait = baseDelayMs * i;
      log(label, `Retry ${i}/${attempts - 1} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ */
/* HTTP & Ports                                                        */
/* ------------------------------------------------------------------ */

function checkHttpServer(urlStr: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(urlStr, (res) => {
      resolve(res.statusCode !== undefined && res.statusCode < 500);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function checkHtmlServer(urlStr: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(urlStr, (res) => {
      const contentType = String(res.headers["content-type"] || "");
      resolve((res.statusCode ?? 500) < 500 && contentType.includes("text/html"));
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Listening TCP sockets as port -> owning pid, from ONE silent netstat call (no shell, no findstr). */
function listListeningSockets(): Map<number, number> {
  const map = new Map<number, number>();
  try {
    if (process.platform === "win32") {
      const out = execFileSilentSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", timeout: 4000 }) as string;
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        const cols = line.trim().split(/\s+/);
        const m = (cols[1] ?? "").match(/:(\d+)$/);
        const pid = Number(cols[cols.length - 1]);
        if (m && Number.isInteger(pid)) map.set(Number(m[1]), pid);
      }
    } else {
      const out = runSilentSync("ss -tlnp 2>/dev/null || lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null", { encoding: "utf8", timeout: 4000 }) as string;
      for (const m of out.matchAll(/:(\d+)\b/g)) map.set(Number(m[1]), 0);
    }
  } catch { /* ignore */ }
  return map;
}

function freePorts(ports: number[]) {
  const wanted = new Set(ports.filter((p) => Number.isInteger(p) && p > 0));
  if (wanted.size === 0) return;
  if (process.platform !== "win32") {
    for (const port of wanted) {
      try {
        runSilentSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: "ignore" });
      } catch { /* ignore */ }
    }
    return;
  }
  const pids = new Set<number>();
  for (const [port, pid] of listListeningSockets()) if (wanted.has(port) && pid > 4) pids.add(pid);
  for (const pid of pids) {
    try { killTreeSilent(pid); } catch { /* ignore */ }
  }
}

function stopProcessTree(child: ChildProcess | null) {
  if (!child || !child.pid) return;
  log("Executor", `Stopping server process tree (pid ${child.pid}) …`);
  try {
    if (process.platform === "win32") killTreeSilent(child.pid);
    else child.kill("SIGINT");
  } catch {
    try { child.kill(); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Universal Repo Study (Any Language, Any Stack)                      */
/* ------------------------------------------------------------------ */

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".venv", "venv", "out", "dist", "build", ".next", "__pycache__",
  ".pytest_cache", ".mypy_cache", "coverage", ".turbo", "target", ".idea", ".vscode",
]);

function findRepoRoot(startPath: string): string {
  let dir = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
  let fallback: string | null = null;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (!fallback && (fs.existsSync(path.join(dir, "README.md")) || fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, "pyproject.toml")))) {
      fallback = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback ?? (fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath));
}

function listTree(root: string, maxDepth = 3, maxEntries = 260): string {
  const output: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (output.length >= maxEntries || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= maxEntries) break;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        output.push(`${rel}/`);
        walk(full, depth + 1);
      } else {
        output.push(rel);
      }
    }
  };
  walk(root, 0);
  return output.join("\n");
}

function collectRepoStudy(repoRoot: string, targetFile: string | null): RepoStudy {
  const readme = readText(path.join(repoRoot, "README.md"), 12000);
  const tree = listTree(repoRoot);

  const manifestNames = new Set([
    "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod",
    "docker-compose.yml", "Makefile", "main.py", "app.py", "server.ts", "index.ts", "page.tsx", "App.tsx",
  ]);

  const candidates: string[] = [];
  if (targetFile && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    candidates.push(targetFile);
  }

  const walk = (dir: string, depth: number) => {
    if (candidates.length >= 14 || depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (candidates.length >= 14) break;
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (manifestNames.has(entry.name)) candidates.push(full);
    }
  };
  walk(repoRoot, 0);

  const seen = new Set<string>();
  const keyFiles: { path: string; content: string }[] = [];
  let budget = 32000;
  for (const full of candidates) {
    if (budget <= 0) break;
    const resolved = path.resolve(full);
    if (seen.has(resolved) || isProbablyBinary(resolved)) continue;
    seen.add(resolved);
    const rel = path.relative(repoRoot, resolved).replace(/\\/g, "/");
    const content = readText(resolved, Math.min(5000, budget));
    if (!content) continue;
    keyFiles.push({ path: rel, content });
    budget -= content.length;
  }

  return {
    root: repoRoot,
    name: path.basename(repoRoot),
    readme,
    tree,
    keyFiles,
    filesScanned: tree.split("\n").filter(Boolean).length,
  };
}

/* ------------------------------------------------------------------ */
/* AI Architect, Backdrop Image & AI SVG Illustrator                   */
/* ------------------------------------------------------------------ */

/** Split a command line into argv, honouring single and double quotes. */
export function tokenizeCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started || cur) out.push(cur);
  return out;
}

/**
 * Turn a launch command line into a direct process call: no shell, no `cmd /c`, no `.cmd` shims.
 *  - `node`, `npm`, `npx` run through the current node binary and npm's own JS entry points,
 *  - everything else is executed as a binary (python, bash, a project exe …).
 * Returns null when the line needs a real shell (pipes, `&&`, env assignments) or a `.cmd`/`.bat` wrapper.
 */
export function resolveDirectLaunch(line: string): { file: string; args: string[] } | null {
  if (/(&&|\|\||[|;<>]|\$\()/.test(line)) return null;
  const tokens = tokenizeCommand(line.trim());
  if (tokens.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return null;
  const [first, ...rest] = tokens;
  const base = path.basename(first).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  const npmDir = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin");
  if (base === "node") return { file: process.execPath, args: rest };
  if (base === "npm" || base === "npx") {
    const cli = path.join(npmDir, `${base}-cli.js`);
    return fs.existsSync(cli) ? { file: process.execPath, args: [cli, ...rest] } : null;
  }
  if (/\.(cmd|bat)$/i.test(first)) return null;
  return { file: first, args: rest };
}

/** Program names an LLM-proposed launch command may start. A repository's README must never be able to make the tool run an arbitrary program. */
const LAUNCH_ALLOWLIST = new Set([
  "python", "python3", "py", "uv", "uvx", "poetry", "pipenv", "flask", "uvicorn", "gunicorn", "streamlit", "gradio", "fastapi",
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno",
  "cargo", "go", "dotnet", "java", "mvn", "gradle", "ruby", "bundle", "rails", "php", "composer", "make",
]);

/**
 * True when a command line only starts a well-known dev runtime: no shell operators, no redirection, no substitutions,
 * and the program is either on the allowlist or a python/node binary that lives inside the repository itself.
 */
export function isSafeLaunchCommand(line: string, repoRoot: string): boolean {
  if (!line || line.length > 400) return false;
  if (/(&&|\|\||[|;<>`]|\$\(|\r|\n)/.test(line)) return false;
  const tokens = tokenizeCommand(line.trim());
  if (tokens.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return false;
  const first = tokens[0];
  const base = path.basename(first).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  if (LAUNCH_ALLOWLIST.has(base)) {
    // An absolute path is fine only when it points inside the repository (e.g. its .venv).
    if (path.isAbsolute(first)) {
      const rel = path.relative(repoRoot, first);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    }
    return true;
  }
  return false;
}

function defaultLaunchCommand(targetFile: string | null, repoRoot: string): string {
  if (targetFile && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    const ext = path.extname(targetFile).toLowerCase();
    if (ext === ".py") {
      const venvWin = path.join(repoRoot, ".venv", "Scripts", "python.exe");
      const venvNix = path.join(repoRoot, ".venv", "bin", "python");
      const py = fs.existsSync(venvWin) ? `"${venvWin}"` : fs.existsSync(venvNix) ? `"${venvNix}"` : process.platform === "win32" ? "python" : "python3";
      return `${py} "${targetFile}"`;
    }
    if (ext === ".ts") return `npx ts-node "${targetFile}"`;
    if (ext === ".js" || ext === ".mjs") return `node "${targetFile}"`;
    if (ext === ".sh") return `bash "${targetFile}"`;
  }
  if (fs.existsSync(path.join(repoRoot, "package.json"))) return "npm run dev";
  return "python main.py";
}

export function extractValidSvg(raw: string): string {
  const cleaned = stripThink(raw)
    .replace(/```(?:svg|xml|html)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const startIdx = cleaned.search(/<svg\b/i);
  if (startIdx < 0) return "";
  let svg = cleaned.slice(startIdx);

  const endIdx = svg.search(/<\/svg>/i);
  if (endIdx >= 0) {
    svg = svg.slice(0, endIdx + 6);
  } else {
    const lastClosedTag = Math.max(svg.lastIndexOf("/>"), svg.lastIndexOf("</g>"), svg.lastIndexOf("</path>"), svg.lastIndexOf("</polygon>"));
    if (lastClosedTag > 40) {
      svg = `${svg.slice(0, lastClosedTag + (svg[lastClosedTag] === "/" ? 2 : 4))}</svg>`;
    } else {
      return "";
    }
  }

  if (svg.length > 120_000) return "";
  if (/<text\b|<tspan\b|<script\b|<foreignObject\b|<image\b/i.test(svg)) return "";
  if (!/viewBox\s*=/i.test(svg)) {
    svg = svg.replace(/^<svg\b/i, '<svg viewBox="0 0 1280 720"');
  }
  return svg;
}

/** Rough check of how many drawable primitives sit in the visible peripheral zones (left / right margins, top skyline). */
export function analyzePeripheralCoverage(svg: string): { total: number; left: number; right: number; top: number } {
  const stats = { total: 0, left: 0, right: 0, top: 0 };
  const tagRe = /<(line|rect|circle|ellipse|polygon|polyline|path)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svg))) {
    const attrs = m[2];
    const num = (name: string) => {
      const r = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"\\s*(-?[\\d.]+)`, "i").exec(attrs);
      return r ? Number(r[1]) : null;
    };
    let x: number | null = null;
    let y: number | null = null;
    const pts = /(?:points|d)\s*=\s*"\s*[A-Za-z]?\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/i.exec(attrs);
    if (pts) {
      x = Number(pts[1]);
      y = Number(pts[2]);
    } else {
      x = num("x1") ?? num("cx") ?? num("x");
      y = num("y1") ?? num("cy") ?? num("y");
    }
    stats.total++;
    if (x === null || y === null || Number.isNaN(x) || Number.isNaN(y)) continue;
    if (x < 150) stats.left++;
    else if (x > 1130) stats.right++;
    if (y < 95) stats.top++;
  }
  return stats;
}

/**
 * How the animated background is produced:
 *  - auto      the model draws an SVG; if it is too sparse, a neutral motif is added at the edges (default)
 *  - generate  the model draws the whole SVG (best with strong models); only an unusable drawing falls back to a motif
 *  - motif     the model only PICKS a motif family, the built-in generator draws it (fast, robust for small models)
 */
type BackdropMode = "auto" | "generate" | "motif";

/** Video format: "demo" = walkthrough with animated backdrop, "promo" = corporate-ad style with camera moves and call-outs. */
type VideoFormat = "demo" | "promo";
const normalizeFormat = (v: unknown): VideoFormat => (String(v ?? "").toLowerCase().trim() === "promo" ? "promo" : "demo");
const formatTimings = (f: VideoFormat) => (f === "promo" ? { introSec: 2.6, outroSec: 3.2 } : { introSec: 1.6, outroSec: 2.2 });
const normalizeBackdropMode = (v: unknown): BackdropMode => {
  const t = String(v ?? "").toLowerCase().trim();
  return t === "generate" || t === "motif" ? t : "auto";
};

/** Generic geometric backdrop families. The LLM picks one that fits its brief; none of them depicts a specific object. */
const BACKDROP_MOTIFS = ["circuit", "lattice", "waves", "skyline", "constellation"] as const;
type BackdropMotif = (typeof BACKDROP_MOTIFS)[number];

export const normalizeMotif = (v: unknown): BackdropMotif | null => {
  const t = String(v ?? "").toLowerCase().trim();
  return (BACKDROP_MOTIFS as readonly string[]).includes(t) ? (t as BackdropMotif) : null;
};

/** Small deterministic PRNG so the same brief always yields the same artwork. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic free fallback / augmentation. Draws a neutral geometric motif family in the visible peripheral zones
 * (left x 15..145, right x 1135..1265, top y 12..92) in the director's palette. Shapes carry no meaning of their own.
 */
export function buildPeripheralFrameSvg(accent: string, secondary: string, motifIn: BackdropMotif | null, seed: string): string {
  const rnd = seededRandom(seed || "ctv");
  const motif: BackdropMotif = motifIn ?? BACKDROP_MOTIFS[Math.floor(rnd() * BACKDROP_MOTIFS.length)];
  const parts: string[] = [];
  const r = (v: number) => Math.round(v * 10) / 10;
  const pick = () => (rnd() < 0.55 ? accent : secondary);
  const rand = (lo: number, hi: number) => lo + rnd() * (hi - lo);

  // Subtle full-canvas grid keeps intro/outro screens rich.
  for (let gx = 0; gx <= 1280; gx += 80) parts.push(`<line x1="${gx}" y1="0" x2="${gx}" y2="720" stroke="${secondary}" stroke-opacity="0.1" stroke-width="1"/>`);
  for (let gy = 0; gy <= 720; gy += 80) parts.push(`<line x1="0" y1="${gy}" x2="1280" y2="${gy}" stroke="${secondary}" stroke-opacity="0.1" stroke-width="1"/>`);

  const zones = [
    { x0: 15, x1: 145, y0: 40, y1: 700, side: "left" },
    { x0: 1135, x1: 1265, y0: 40, y1: 700, side: "right" },
    { x0: 15, x1: 1265, y0: 12, y1: 92, side: "top" },
  ];

  if (motif === "circuit") {
    // Right-angle / 45-degree traces that end in solder pads, plus a few IC packages with pins.
    for (const z of zones) {
      const traces = z.side === "top" ? 9 : 12;
      for (let i = 0; i < traces; i++) {
        let x = rand(z.x0, z.x1);
        let y = rand(z.y0, z.y1);
        let d = `M${r(x)} ${r(y)}`;
        const steps = 3 + Math.floor(rnd() * 4);
        for (let k = 0; k < steps; k++) {
          const horizontal = rnd() < 0.5;
          const len = rand(20, z.side === "top" ? 160 : 90);
          const dir = rnd() < 0.5 ? -1 : 1;
          if (horizontal) x = Math.min(z.x1, Math.max(z.x0, x + dir * len));
          else y = Math.min(z.y1, Math.max(z.y0, y + dir * len));
          d += ` L${r(x)} ${r(y)}`;
          if (rnd() < 0.3) { x = Math.min(z.x1, Math.max(z.x0, x + dir * 14)); y = Math.min(z.y1, Math.max(z.y0, y + 14)); d += ` L${r(x)} ${r(y)}`; }
        }
        const c = pick();
        parts.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="${rand(1.5, 3).toFixed(1)}" stroke-linejoin="round"/>`);
        parts.push(`<circle cx="${r(x)}" cy="${r(y)}" r="${rand(3, 6).toFixed(1)}" fill="${c}" fill-opacity="0.35" stroke="${c}" stroke-width="2"/>`);
      }
      const chips = z.side === "top" ? 3 : 4;
      for (let i = 0; i < chips; i++) {
        const w = rand(24, 44), h = rand(24, 44);
        const cx = rand(z.x0, Math.max(z.x0, z.x1 - w)), cy = rand(z.y0, Math.max(z.y0, z.y1 - h));
        const c = pick();
        parts.push(`<rect x="${r(cx)}" y="${r(cy)}" width="${r(w)}" height="${r(h)}" rx="3" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-width="2"/>`);
        for (let pin = 0; pin < 4; pin++) {
          const py = cy + 6 + pin * ((h - 12) / 3);
          parts.push(`<line x1="${r(cx - 7)}" y1="${r(py)}" x2="${r(cx)}" y2="${r(py)}" stroke="${c}" stroke-width="2"/><line x1="${r(cx + w)}" y1="${r(py)}" x2="${r(cx + w + 7)}" y2="${r(py)}" stroke="${c}" stroke-width="2"/>`);
        }
      }
    }
  } else if (motif === "lattice") {
    // Structural truss frames along the margins and the top edge.
    const truss = (x0: number, x1: number, yTop: number, yBot: number, step: number) => {
      parts.push(`<line x1="${x0}" y1="${yTop}" x2="${x0}" y2="${yBot}" stroke="${accent}" stroke-width="4"/><line x1="${x1}" y1="${yTop}" x2="${x1}" y2="${yBot}" stroke="${accent}" stroke-width="4"/>`);
      let flip = false;
      for (let y = yTop; y + step <= yBot; y += step) {
        parts.push(`<line x1="${flip ? x1 : x0}" y1="${y}" x2="${flip ? x0 : x1}" y2="${y + step}" stroke="${secondary}" stroke-width="2"/><line x1="${x0}" y1="${y + step}" x2="${x1}" y2="${y + step}" stroke="${secondary}" stroke-width="2"/>`);
        flip = !flip;
      }
    };
    truss(40, 100, 40, 700, 44);
    truss(1180, 1240, 40, 700, 44);
    parts.push(`<line x1="15" y1="36" x2="1265" y2="36" stroke="${accent}" stroke-width="4"/><line x1="15" y1="62" x2="1265" y2="62" stroke="${accent}" stroke-width="3"/>`);
    for (let x = 15; x < 1260; x += 40) parts.push(`<line x1="${x}" y1="62" x2="${x + 20}" y2="36" stroke="${secondary}" stroke-width="2"/><line x1="${x + 20}" y1="36" x2="${x + 40}" y2="62" stroke="${secondary}" stroke-width="2"/>`);
  } else if (motif === "waves") {
    // Flowing parallel curves.
    for (let i = 0; i < 7; i++) {
      const y = 20 + i * 11, amp = rand(6, 16), ph = rand(0, 6.28);
      let d = `M15 ${r(y + Math.sin(ph) * amp)}`;
      for (let x = 15; x <= 1265; x += 60) d += ` Q${x + 30} ${r(y + Math.sin(ph + x / 90) * amp * 2)} ${x + 60} ${r(y + Math.sin(ph + (x + 60) / 90) * amp)}`;
      parts.push(`<path d="${d}" fill="none" stroke="${i % 2 ? secondary : accent}" stroke-width="${i % 3 === 0 ? 3 : 1.8}" stroke-opacity="${(0.9 - i * 0.07).toFixed(2)}"/>`);
    }
    for (const x0 of [20, 1140]) {
      for (let i = 0; i < 6; i++) {
        const x = x0 + i * 20, amp = rand(5, 14), ph = rand(0, 6.28);
        let d = `M${r(x + Math.sin(ph) * amp)} 100`;
        for (let y = 100; y <= 700; y += 60) d += ` Q${r(x + Math.sin(ph + y / 80) * amp * 2)} ${y + 30} ${r(x + Math.sin(ph + (y + 60) / 80) * amp)} ${y + 60}`;
        parts.push(`<path d="${d}" fill="none" stroke="${i % 2 ? secondary : accent}" stroke-width="2" stroke-opacity="${(0.9 - i * 0.1).toFixed(2)}"/>`);
      }
    }
  } else if (motif === "skyline") {
    // Rising blocks (equalizer / city-like silhouettes) along the sides and hanging from the top.
    for (const x0 of [15, 1135]) {
      for (let x = x0; x < x0 + 125; x += 18) {
        const h = rand(60, 420);
        const c = pick();
        parts.push(`<rect x="${x}" y="${r(700 - h)}" width="14" height="${r(h)}" fill="${c}" fill-opacity="0.2" stroke="${c}" stroke-width="2"/>`);
      }
    }
    for (let x = 15; x < 1265; x += 20) {
      const h = rand(14, 70);
      const c = pick();
      parts.push(`<rect x="${x}" y="12" width="14" height="${r(h)}" fill="${c}" fill-opacity="0.2" stroke="${c}" stroke-width="2"/>`);
    }
  } else {
    // constellation: nodes joined to their nearest neighbours.
    for (const z of zones) {
      const pts: [number, number][] = Array.from({ length: z.side === "top" ? 16 : 14 }, () => [rand(z.x0, z.x1), rand(z.y0, z.y1)]);
      pts.forEach(([x, y], i) => {
        const near = pts
          .map(([x2, y2], j) => ({ j, d: Math.hypot(x - x2, y - y2) }))
          .filter((n) => n.j !== i)
          .sort((a, b) => a.d - b.d)
          .slice(0, 2);
        for (const n of near) parts.push(`<line x1="${r(x)}" y1="${r(y)}" x2="${r(pts[n.j][0])}" y2="${r(pts[n.j][1])}" stroke="${pick()}" stroke-width="1.6" stroke-opacity="0.8"/>`);
      });
      for (const [x, y] of pts) {
        const c = pick();
        parts.push(`<circle cx="${r(x)}" cy="${r(y)}" r="${rand(3, 7).toFixed(1)}" fill="${c}" fill-opacity="0.3" stroke="${c}" stroke-width="2"/>`);
      }
    }
  }
  return parts.join("\n");
}

/** Free pipeline: LLM vector illustrator -> deterministic validation -> procedural peripheral augmentation. Never fails. */
async function generateBackdropSvg(prompt: string, backdropBrief: string, accent: string, secondary: string, motifHint?: string | null, modeIn?: string | null): Promise<string> {
  const motif = normalizeMotif(motifHint);
  const mode = normalizeBackdropMode(modeIn);
  const seed = `${backdropBrief}|${accent}|${secondary}`;
  let svg = "";
  try {
    if (mode !== "motif") svg = await generateBespokeSvg(prompt, backdropBrief, accent, secondary);
  } catch (err) {
    log("SvgArtist", `LLM backdrop failed: ${(err as Error).message}`);
  }

  if (svg) {
    // Normalize root: canonical viewBox + xmlns + full-canvas sizing.
    svg = svg.replace(/<svg\b[^>]*>/i, '<svg viewBox="0 0 1280 720" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">');
    const cov = analyzePeripheralCoverage(svg);
    const peripheral = cov.left + cov.right + cov.top;
    if (mode === "generate" && cov.total >= 8) {
      log("SvgArtist", `Model-drawn backdrop kept as is (primitives=${cov.total}).`);
      return svg;
    }
    if (cov.total >= 24 && cov.left >= 6 && cov.right >= 6 && peripheral >= 24) {
      log("SvgArtist", `Backdrop validated (primitives=${cov.total}, L/R/T=${cov.left}/${cov.right}/${cov.top}).`);
      return svg;
    }
    log("SvgArtist", `Backdrop too sparse at the edges (primitives=${cov.total}, L/R/T=${cov.left}/${cov.right}/${cov.top}) — augmenting.`);
    return svg.replace(/<\/svg>\s*$/i, `<g id="peripheral-frame">${buildPeripheralFrameSvg(accent, secondary, motif, seed)}</g></svg>`);
  }

  log("SvgArtist", "Using procedural peripheral backdrop (free fallback).");
  return `<svg viewBox="0 0 1280 720" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice"><g id="peripheral-frame">${buildPeripheralFrameSvg(accent, secondary, motif, seed)}</g></svg>`;
}

async function generateBespokeSvg(
  prompt: string,
  backdropBrief: string,
  accent: string,
  secondary: string,
): Promise<string> {
  const client = getLlmClient();
  if (!client) return "";

  const isLocal = isLocalEndpoint(client.baseURL);

  const systemPrompt = `You are a senior vector illustrator creating a rich SVG backdrop (<svg viewBox="0 0 1280 720" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">...</svg>) for a 1280x720 product promo video.
Think through the exact geometric coordinates first so the requested subject is immediately recognizable, detailed, and visually striking.

COMPOSITION & VISIBILITY RULES:
1. A browser window will occupy the central zone (x: 150..1130, y: 95..635). Place the main visual silhouettes and structural framing in the VISIBLE PERIPHERAL ZONES:
  - Left margin (x: 15..145, y: 40..700)
  - Top skyline (x: 15..1265, y: 12..92)
  - Right margin (x: 1135..1265, y: 40..700)
2. Include subtle background geometric framing across the full 1280x720 canvas (opacity 0.08–0.14) so intro and outro screens look rich and cohesive.
3. Build real geometric detail (30 to 65 clean SVG primitives: <line>, <rect>, <polygon>, <circle>, <path>, <g>):
  - Primary strokes: ${accent} (stroke-width 2 to 4)
  - Secondary strokes: ${secondary} (stroke-width 1.5 to 3)
  - Translucent fills: ${accent} and ${secondary} with fill-opacity="0.16" to "0.32"
4. Derive the subject STRICTLY from the user's prompt and motif brief.
5. FORBIDDEN: <text>, <tspan>, <script>, <image>, <foreignObject>, markdown fences, or prose outside <svg>...</svg>. Output ONLY valid SVG markup.`;

  const userMsg = `User Prompt: ${prompt}
Art Direction Motif Brief: ${backdropBrief || prompt}
Primary Accent Color: ${accent}
Secondary Color: ${secondary}

Plan the exact coordinates carefully, then output ONLY the complete <svg viewBox="0 0 1280 720" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">...</svg>.`;

  for (let attempt = 1; attempt <= (isLocal ? 1 : 2); attempt++) {
    const body: any = {
      model: client.model,
      max_tokens: isLocal ? 4500 : 5000,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
    };

    log("SvgArtist", `Generating vector backdrop (attempt ${attempt}) …`);
    const raw = await withRetry(
      "SvgArtist",
      async () => {
        const completion = await requestChat(client, body, SVG_LLM_TIMEOUT_MS, "SvgArtist", true);
        return completion.choices[0]?.message?.content || "";
      },
      1,
      400,
    ).catch((err) => {
      log("SvgArtist", `Attempt ${attempt} failed: ${(err as Error)?.message || err}`);
      return "";
    });

    const svg = extractValidSvg(raw);
    if (svg && svg.length > 400) {
      log("SvgArtist", `LLM generated detailed backdrop (${svg.length} chars, attempt ${attempt}).`);
      return svg;
    }
  }

  log("SvgArtist", "LLM did not return a valid SVG backdrop.");
  return "";
}

async function askAiToPlanEverything(
  study: RepoStudy,
  targetFile: string | null,
  prompt: string,
  publicDir: string,
  backdropMode: BackdropMode = "auto",
): Promise<{ launch: ProjectLaunchPlan; scenario: DirectorScenario }> {
  const client = getLlmClient();
  const fallbackCmd = defaultLaunchCommand(targetFile, study.root);

  const fallbackLaunch: ProjectLaunchPlan = {
    productName: study.name,
    launchCommand: fallbackCmd,
    expectedPorts: [3000, 5173, 8000, 8080],
    summary: study.name,
  };

  if (!client) {
    throw new Error("An LLM provider is required: set LLM_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, or pass --api-key/--base-url.");
  }

  const isLocal = isLocalEndpoint(client.baseURL);
  log("LLM", `Using model "${client.model}" via ${client.baseURL}`);

  const keyFilesText = study.keyFiles
    .map((f) => `### ${f.path}\n${f.content.slice(0, 2600)}`)
    .join("\n\n")
    .slice(0, 16000);

  const result = await withRetry("AiArchitect", async () => {
    const completion = await requestChat(
      client,
      {
        model: client.model,
        max_tokens: 2800,
        reasoning_effort: isLocal ? "none" : "medium",
        temperature: 0.35,
        messages: [
          {
            role: "system",
            content: `You are an autonomous AI Video Director & Software Architect.
Given ANY codebase and ANY user prompt, you must:
1. Determine how to launch the web application locally (command & ports). Use the provided target file if given.
2. Follow EVERY instruction in the user's prompt — especially:
  - Requested output language: write ALL titles, captions, introLine, and outroLine strictly in the language requested by the user (or match the prompt's language if unspecified).
  - Visual style, colors, and mandatory background elements (put every requested background object explicitly into "backdropBrief" in English so the backdrop generator draws it).
  - Pacing & scrolling speed: if the prompt asks to scroll slower / take more time / show details carefully, set slow pacing ("scrollDurationMs": 2000, "scrollStepPx": 320, "dwellAfterActionMs": 1400, "postTrimPadSec": 3.0); otherwise use normal brisk pacing ("scrollDurationMs": 850, "scrollStepPx": 440, "dwellAfterActionMs": 650, "postTrimPadSec": 2.0).

Return ONLY valid JSON:
{
  "launch": {
    "productName": "Product name",
    "launchCommand": "Exact shell command to start the app",
    "expectedPorts": [3000, 8000],
    "summary": "1-sentence product summary"
  },
  "scenario": {
    "videoTitle": "Punchy title in the requested language (max 5 words)",
    "introLine": "Sharp 1-line hook in the requested language",
    "outroLine": "Sharp closing line in the requested language",
    "backdropBrief": "Detailed English visual description of the background illustration requested by the user",
    "backdropMotif": "circuit" | "lattice" | "waves" | "skyline" | "constellation"  (the generic geometric family that best fits the requested background; used only if the drawn illustration is too sparse),
    "pacing": {
      "scrollDurationMs": 1800,
      "scrollStepPx": 320,
      "dwellAfterActionMs": 1300,
      "preTrimPadSec": 0.9,
      "postTrimPadSec": 2.8
    },
    "beats": [
      {
        "id": "beat_1",
        "title": "2-3 word badge in requested language",
        "caption": "Punchy promo caption in requested language (max 55 chars)",
        "targetGoal": "What UI action/screen to show in this beat"
      }
    ],
    "artDirection": {
      "accentColor": "#RRGGBB",
      "secondaryColor": "#RRGGBB",
      "bgStart": "#RRGGBB",
      "bgEnd": "#RRGGBB",
      "isDark": true
    }
  }
}`,
          },
          {
            role: "user",
            content: `User Prompt: ${prompt}
Target file: ${targetFile || "(auto-detect from repo)"}
Repo root: ${study.root}
README:
${study.readme.slice(0, 6000)}
File tree:
${study.tree.slice(0, 3500)}
Key files:
${keyFilesText}`,
          },
        ],
        response_format: { type: "json_object" },
      },
      PLAN_LLM_TIMEOUT_MS,
      "AiArchitect",
      true,
    );

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("Empty response from AI Architect.");
    return parseJsonLoose(raw);
  }, 2, 600);

  const launch: ProjectLaunchPlan = {
    productName: String(result.launch?.productName || fallbackLaunch.productName),
    launchCommand: (() => {
      if (targetFile) return fallbackCmd;
      const proposed = String(result.launch?.launchCommand || "");
      if (proposed && isSafeLaunchCommand(proposed, study.root)) return proposed;
      if (proposed) log("Launch", `Ignored an unsafe launch command proposed by the model: ${proposed.slice(0, 120)}. Using "${fallbackCmd}". Pass --launch "<command>" to choose your own.`);
      return fallbackCmd;
    })(),
    expectedPorts: Array.isArray(result.launch?.expectedPorts)
      ? result.launch.expectedPorts.map(Number).filter((n: number) => n > 0)
      : fallbackLaunch.expectedPorts,
    summary: String(result.launch?.summary || fallbackLaunch.summary),
  };

  const sc = result.scenario || {};
  const art = sc.artDirection || {};
  const rawPacing = sc.pacing || {};

  const clampNum = (val: unknown, fallback: number, min: number, max: number) => {
    const n = Number(val);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };

  const pacing: PacingConfig = {
    scrollDurationMs: clampNum(rawPacing.scrollDurationMs, 950, 450, 3500),
    scrollStepPx: clampNum(rawPacing.scrollStepPx, 360, 220, 520),
    dwellAfterActionMs: clampNum(rawPacing.dwellAfterActionMs, 650, 300, 3000),
    preTrimPadSec: clampNum(rawPacing.preTrimPadSec, 0.85, 0.4, 2.0),
    postTrimPadSec: clampNum(rawPacing.postTrimPadSec, 2.2, 1.2, 4.5),
  };

  const normalizeHex = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const v = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      return `#${v.slice(1).split("").map((c) => c + c).join("")}`.toLowerCase();
    }
    return null;
  };

  const accentColor = normalizeHex(art.accentColor);
  const secondaryColor = normalizeHex(art.secondaryColor);
  const bgStart = normalizeHex(art.bgStart);
  const bgEnd = normalizeHex(art.bgEnd);
  if (!accentColor || !secondaryColor || !bgStart || !bgEnd) {
    throw new Error("LLM plan is missing a complete artDirection palette (#RRGGBB colors are required).");
  }

  const bgLuminance = (() => {
    const n = parseInt(bgStart.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  })();

  const rawBeats = Array.isArray(sc.beats) ? sc.beats : [];
  if (rawBeats.length === 0) {
    throw new Error("LLM plan did not contain any story beats.");
  }

  const beats: StoryBeatPlan[] = rawBeats.slice(0, 6).map((b: any, i: number) => ({
    id: String(b.id || `beat_${i + 1}`),
    title: clipText(String(b.title || b.caption || `Beat ${i + 1}`), 40),
    caption: clipText(String(b.caption || b.title || ""), 68),
    targetGoal: String(b.targetGoal || b.caption || "").slice(0, 140),
  }));

  const backdropBrief = String(sc.backdropBrief || "").slice(0, 600);
  const backdropMotif = normalizeMotif(sc.backdropMotif);
  const backdropImage = "";
  const bespokeSvg = await generateBackdropSvg(prompt, backdropBrief, accentColor, secondaryColor, backdropMotif, backdropMode);

  const scenario: DirectorScenario = {
    videoTitle: String(sc.videoTitle || launch.productName).slice(0, 64),
    introLine: String(sc.introLine || launch.summary).slice(0, 180),
    outroLine: String(sc.outroLine || launch.summary).slice(0, 180),
    beats,
    pacing,
    artDirection: {
      accentColor,
      secondaryColor,
      bgStart,
      bgEnd,
      isDark: typeof art.isDark === "boolean" ? art.isDark : bgLuminance < 0.5,
      backdropSvg: bespokeSvg,
      backdropImage,
    },
  };

  fs.writeFileSync(path.join(publicDir, "promo-plan.json"), JSON.stringify({ prompt, launch, scenario }, null, 2), "utf8");
  log(
    "AI Architect",
    `Planned "${scenario.videoTitle}" (${beats.length} beats, scroll=${pacing.scrollDurationMs}ms, step=${pacing.scrollStepPx}px, backdrop=${backdropImage || (bespokeSvg ? `SVG ${bespokeSvg.length}ch` : "gradient")})`,
  );
  return { launch, scenario };
}

/* ------------------------------------------------------------------ */
/* FFmpeg & Video Probing                                              */
/* ------------------------------------------------------------------ */

function findBinary(name: "ffmpeg" | "ffprobe"): string | null {
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    path.resolve(`node_modules/@remotion/compositor-win32-x64-msvc/${name}${ext}`),
    path.resolve(`node_modules/@remotion/compositor-darwin-arm64/${name}`),
    path.resolve(`node_modules/@remotion/compositor-darwin-x64/${name}`),
    path.resolve(`node_modules/@remotion/compositor-linux-x64-gnu/${name}`),
    path.resolve(`node_modules/@remotion/compositor-linux-x64-musl/${name}`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const out = execFileSilentSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" }) as string;
    return out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

async function probeVideoDuration(file: string): Promise<number | null> {
  const ffprobe = findBinary("ffprobe");
  if (!ffprobe) return null;
  try {
    const out = (execFileSilentSync(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { encoding: "utf8", timeout: 20000 },
    ) as string).trim();
    const d = Number.parseFloat(out);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

const VIEWPORT = { width: 1280, height: 720 };

/** Output heights offered to users. Anything from 480 upwards is accepted; width follows 16:9 (even number). */
const MIN_QUALITY = 480;
const MAX_QUALITY = 2160;
export function normalizeQuality(v: unknown): number {
  const n = Math.round(Number(String(v ?? "").replace(/p$/i, "")));
  if (!Number.isFinite(n) || n <= 0) return 720;
  return Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, n));
}
export const qualityWidth = (height: number) => 2 * Math.round((height * 16) / 9 / 2);

async function finalizeCaptureWithFfmpeg(
  rawPath: string,
  publicDir: string,
  events: UiEvent[],
  pacing: PacingConfig,
  startSec = 0,
): Promise<{ durationSec: number; mp4Path: string; trimmedEvents: UiEvent[] }> {
  const mp4Path = path.join(publicDir, `ui-capture-${RUN_ID}.mp4`);
  const ffmpeg = findBinary("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg not found.");

  const rawDuration = (await probeVideoDuration(rawPath)) ?? 15;

  const actionTimes = events
    .filter((e) => e.kind !== "intro" && e.kind !== "done")
    .map((e) => e.atSec)
    .sort((a, b) => a - b);

  type Span = { start: number; end: number };
  // Keep a single continuous capture from 0 to the end of the last action + postTrimPadSec
  // so cursor transitions and smooth scrolls are never sliced mid-motion.
  const lastActiveSec = actionTimes.length > 0 ? actionTimes[actionTimes.length - 1] : rawDuration;
  const clipEnd = Math.min(rawDuration, lastActiveSec + pacing.postTrimPadSec);
  const merged: Span[] = [{ start: startSec, end: Math.max(startSec + 1.5, clipEnd) }];

  const mapTime = (origSec: number): number => {
    let acc = 0;
    for (const s of merged) {
      if (origSec <= s.start) return acc;
      if (origSec <= s.end) return acc + (origSec - s.start);
      acc += s.end - s.start;
    }
    return acc;
  };

  const trimmedEvents: UiEvent[] = events.map((ev) => ({
    ...ev,
    atSec: Number(mapTime(ev.atSec).toFixed(3)),
  }));

  log("FFmpeg", `Encoding continuous capture (${merged[0].end.toFixed(1)}s of ${rawDuration.toFixed(1)}s raw, 30 fps) …`);

  const inputArgs = merged.flatMap((s) => ["-ss", s.start.toFixed(3), "-to", s.end.toFixed(3), "-i", rawPath]);
  const concatInputs = merged.map((_, idx) => `[${idx}:v]`).join("");
  const filterComplex = `${concatInputs}concat=n=${merged.length}:v=1:a=0[outv]`;

  execFileSilentSync(ffmpeg, ["-y", ...inputArgs, "-filter_complex", filterComplex, "-map", "[outv]", ...CLIP_ENCODE_ARGV, mp4Path], {
    timeout: 8 * 60 * 1000,
    stdio: "pipe",
  });

  const probed = await probeVideoDuration(mp4Path);
  const summed = merged.reduce((sum, s) => sum + (s.end - s.start), 0);
  const baseSec = probed ?? summed;
  const safeFrames = Math.max(1, Math.floor(baseSec * 30) - 1);
  const durationSec = Number((safeFrames / 30).toFixed(3));

  log("FFmpeg", `Wrote ${mp4Path} (${durationSec.toFixed(2)}s, continuous smooth motion)`);
  return { durationSec, mp4Path, trimmedEvents };
}

/* ------------------------------------------------------------------ */
/* Universal Playwright Browser Agent                                  */
/* ------------------------------------------------------------------ */

function installAiCursor() {
  const mount = () => {
    try {
      if (window.top !== window || !document.documentElement || document.getElementById("__ai_cursor")) return;
      const style = document.createElement("style");
      style.textContent = `
      #__ai_cursor {
        position: fixed; left: 0; top: 0; z-index: 2147483647;
        pointer-events: none; transform: translate3d(-140px, -140px, 0);
        transition: transform 0.65s cubic-bezier(0.16, 1, 0.3, 1);
        filter: drop-shadow(0 0 10px rgba(34, 211, 238, 0.9));
      }
      #__ai_ripple {
        position: fixed; width: 22px; height: 22px; margin-left: -11px; margin-top: -11px;
        border-radius: 50%; border: 3px solid #22d3ee; box-shadow: 0 0 18px #22d3ee;
        z-index: 2147483646; pointer-events: none; opacity: 0;
      }
      #__ai_ripple.__ai_go { animation: __ai_ripple_anim 0.6s ease-out forwards; }
      @keyframes __ai_ripple_anim {
        0% { opacity: 0.95; transform: scale(0.35); }
        100% { opacity: 0; transform: scale(3.0); }
      }`;
      document.documentElement.appendChild(style);

      const cursor = document.createElement("div");
      cursor.id = "__ai_cursor";
      cursor.innerHTML = `<svg viewBox="0 0 32 32" width="28" height="28"><path d="M5 3 L27 15 L17.5 17.5 L22.5 27.5 L18.5 29.5 L13.5 19.5 L5 26 Z" fill="#22d3ee" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
      document.documentElement.appendChild(cursor);

      const ripple = document.createElement("div");
      ripple.id = "__ai_ripple";
      document.documentElement.appendChild(ripple);
    } catch { /* ignore */ }
  };
  if (document.documentElement) mount();
  else requestAnimationFrame(mount);
}

type CursorState = { x: number; y: number };

async function moveCursor(page: Page, cursor: CursorState, x: number, y: number, waitMs = 660) {
  cursor.x = x;
  cursor.y = y;
  await page.evaluate(({ x, y }) => {
    const el = document.getElementById("__ai_cursor");
    if (el) el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, { x, y }).catch(() => undefined);
  if (waitMs > 0) await page.waitForTimeout(waitMs);
}

async function rippleAt(page: Page, x: number, y: number) {
  await page.evaluate(({ x, y }) => {
    const el = document.getElementById("__ai_ripple");
    if (!el) return;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.classList.remove("__ai_go");
    void (el as HTMLElement).offsetWidth;
    el.classList.add("__ai_go");
  }, { x, y }).catch(() => undefined);
  await page.waitForTimeout(120);
}

async function smoothScrollBy(page: Page, delta: number, duration = 1400) {
  const clampedDelta = Math.max(-360, Math.min(360, delta));
  await page.evaluate(async ({ delta, duration }) => {
    const findScroller = (): Element => {
      const root = document.scrollingElement ?? document.documentElement;
      if (root.scrollHeight - root.clientHeight > 60) return root;
      let best: Element = root;
      let bestOverflow = 0;
      for (const el of Array.from(document.querySelectorAll("main, section, div"))) {
        const style = getComputedStyle(el);
        if (!/(auto|scroll)/.test(style.overflowY)) continue;
        const overflow = el.scrollHeight - el.clientHeight;
        if (overflow > bestOverflow && el.clientHeight > 220) {
          bestOverflow = overflow;
          best = el;
        }
      }
      return best;
    };

    const scroller = findScroller();
    const start = scroller.scrollTop;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const target = Math.max(0, Math.min(maxTop, start + delta));
    const distance = target - start;
    if (Math.abs(distance) < 4) return;

    const startTime = performance.now();
    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        const p = Math.min(1, (now - startTime) / Math.max(300, duration));
        const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        scroller.scrollTop = start + distance * eased;
        if (p < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }, { delta: clampedDelta, duration }).catch(() => undefined);
}

async function measureDwell(page: Page): Promise<PageDwellProfile> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    let scroller: Element = root;
    let bestOverflow = Math.max(0, root.scrollHeight - root.clientHeight);
    for (const el of Array.from(document.querySelectorAll("main, section, div"))) {
      const style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow > bestOverflow && el.clientHeight > 220) {
        bestOverflow = overflow;
        scroller = el;
      }
    }
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const remainingScroll = Math.max(0, maxScroll - scroller.scrollTop);
    // A visible, disabled, filled primary button means the flow is waiting for something (analysis, input, ...).
    const pendingPrimary = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).some((o) => {
      const b = o as HTMLButtonElement;
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (!(b.disabled || b.getAttribute("aria-disabled") === "true")) return false;
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(b).backgroundColor || "");
      const p = m ? m[1].split(",").map((v) => parseFloat(v)) : [0, 0, 0, 0];
      return (p.length > 3 ? p[3] : 1) > 0.05;
    });
    const isBusy = (() => {
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  if (Array.from(document.querySelectorAll('[aria-busy="true"]')).some(visible)) return true;
  // A progressbar only counts as busy while it is visible and not yet complete (aria-valuenow < aria-valuemax).
  return Array.from(document.querySelectorAll('[role="progressbar"], progress')).some((el) => {
    if (!visible(el)) return false;
    const nowRaw = el.getAttribute("aria-valuenow") ?? (el as HTMLProgressElement).value?.toString();
    const maxRaw = el.getAttribute("aria-valuemax") ?? ((el as HTMLProgressElement).max ? String((el as HTMLProgressElement).max) : "100");
    const now = parseFloat(nowRaw ?? "");
    const max = parseFloat(maxRaw);
    if (Number.isNaN(now)) return true; // indeterminate
    return now < (Number.isNaN(max) ? 100 : max);
  });
})();
    return { maxScroll, remainingScroll, isBusy, pendingPrimary };
  }).catch(() => ({ maxScroll: 0, remainingScroll: 0, isBusy: false, pendingPrimary: false }));
}

interface NavigationInput {
  url: string;
  prompt: string;
  beats: StoryBeatPlan[];
  pacing: PacingConfig;
  step: number;
  history: string[];
  clickedOnCurrentUrl: Set<string>;
  uploadedUrls: Set<string>;
  elements: InteractiveElement[];
  dwell: PageDwellProfile;
  pageSnippet: string;
  uploadsRemaining: number;
  uploadsProvided: number;
}

/**
 * One page-side pass over every interactive element (a single CDP round trip, a few ms even on huge pages).
 * Returns visible + enabled controls with W3C/ARIA/geometry facts and tags each with data-ai-id for later locating.
 */
export async function collectInteractiveElements(page: Page): Promise<InteractiveElement[]> {
  const selector = 'button, a, summary, [role="tab"], [role="button"], [role="menuitem"], input, textarea, select, [contenteditable="true"]';

  const raw: any[] = await page
    .evaluate((sel: string) => {
      document.querySelectorAll("[data-ai-id]").forEach((el) => el.removeAttribute("data-ai-id"));

      const metaOf = (n: any) => {
      const tag = String(n.tagName || "div").toLowerCase();
      const type = String(n.getAttribute("type") || tag).toLowerCase();
      const rect = n.getBoundingClientRect();
      const inNav = Boolean(n.closest("header, nav, [role='navigation']"));
      const inDialog = Boolean(n.closest("dialog[open], [role='dialog'], [aria-modal='true']"));
      const inForm = Boolean(n.closest("form"));
      const isFile = tag === "input" && type === "file";
      const hasFiles = isFile ? Boolean(n.files && n.files.length > 0) : false;
      const isFieldTag =
        tag === "textarea" ||
        tag === "select" ||
        (tag === "input" && !["submit", "button", "image", "reset", "checkbox", "radio", "file", "range", "color", "hidden"].includes(type)) ||
        Boolean(n.isContentEditable);
      const rawValue = isFile ? "" : (typeof n.value === "string" ? n.value : n.isContentEditable ? n.innerText : "");
      const isFieldEmpty = isFile ? !hasFiles : (isFieldTag ? String(rawValue ?? "").trim() === "" : false);
      const required = Boolean(n.required) || n.getAttribute("aria-required") === "true";
      const isDisabled = Boolean(n.disabled) || n.getAttribute("aria-disabled") === "true";
      const isSubmit =
        (tag === "input" && (type === "submit" || type === "image")) ||
        (tag === "button" && ((n.getAttribute("type") || "").toLowerCase() === "submit" || inForm));
      const explicitType = tag === "input" ? type : String(n.getAttribute("type") || tag).toLowerCase();

      const rel = (n.getAttribute("rel") || "").toLowerCase();
      const role = (n.getAttribute("role") || "").toLowerCase();
      const ariaLabel = (n.getAttribute("aria-label") || "").toLowerCase();
      // innerText is empty while an element is mid-transition (visibility/opacity animations); textContent is not.
      const innerText = String(n.innerText || n.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
      const combined = `${ariaLabel} ${innerText}`.trim();

      // Back / cancel / close, structural signals only (rel=prev, type=reset, formnovalidate, dismiss attributes,
      // ghost button next to a filled primary). Label meaning is decided by the LLM (see classifyControlRoles).
      // Visual affordance (language-free): a ghost/outline button that sits in the same row as a filled
      // primary button (enabled or not) is a secondary action such as back / cancel.
      const bgOf = (el: Element) => {
        const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor || "");
        if (!m) return { a: 0, rgb: "" };
        const p = m[1].split(",").map((v) => parseFloat(v));
        return { a: p.length > 3 ? p[3] : 1, rgb: p.slice(0, 3).join(",") };
      };
      const ancestorRgb = (el: Element) => {
        for (let q = el.parentElement; q; q = q.parentElement) {
          const b = bgOf(q);
          if (b.a > 0.05) return b.rgb;
        }
        return "255,255,255";
      };
      const isGhost = (el: Element) => {
        const b = bgOf(el);
        return b.a < 0.05 || b.rgb === ancestorRgb(el);
      };
      const buttonLike = (el: Element) =>
        el.tagName === "BUTTON" || el.getAttribute("role") === "button" || (el.tagName === "INPUT" && ["submit", "button"].includes((el.getAttribute("type") || "").toLowerCase()));
      let hasFilledSibling = false;
      if (buttonLike(n) && isGhost(n)) {
        const cy = rect.y + rect.height / 2;
        hasFilledSibling = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).some((o) => {
          if (o === n) return false;
          const r = o.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && Math.abs(r.y + r.height / 2 - cy) < 16 && !isGhost(o);
        });
      }

      const semanticBack =
        hasFilledSibling ||
        rel.includes("prev") ||
        type === "reset" ||
        n.hasAttribute("formnovalidate") ||
        n.hasAttribute("data-dismiss") ||
        n.hasAttribute("data-bs-dismiss");
      const isBackCancel = Boolean(semanticBack);

      const isFilterOrTab =
        role === "tab" ||
        n.getAttribute("aria-pressed") !== null ||
        n.getAttribute("aria-expanded") !== null;

      return {
        tag,
        type: explicitType,
        y: rect.y,
        x: rect.x,
        width: rect.width,
        height: rect.height,
        inNav,
        inDialog,
        inForm,
        hasFiles,
        isFieldEmpty,
        required,
        isDisabled,
        isSubmit,
        isBackCancel,
        isFilterOrTab,
      };
      };

      const out: any[] = [];
      for (const n of Array.from(document.querySelectorAll(sel)) as any[]) {
        if (out.length >= 300) break;
        const rect = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        const isVisible = rect.width > 0 && rect.height > 0 && cs.visibility !== "hidden";
        const isEnabled = !(n.disabled || n.closest("fieldset[disabled]") || n.getAttribute("aria-disabled") === "true");
        const meta = metaOf(n);
        const isFile = meta.tag === "input" && meta.type === "file";
        if (!isEnabled || (!isVisible && !isFile) || meta.type === "hidden") continue;

        const rawText = [n.innerText, n.getAttribute("aria-label"), n.getAttribute("placeholder"), n.getAttribute("title"), n.getAttribute("name"), n.getAttribute("alt")]
          .filter(Boolean)
          .join(" ")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        const index = out.length;
        n.setAttribute("data-ai-id", String(index));
        out.push({ ...meta, isVisible, isEnabled, index, text: rawText || (isFile ? "File upload input" : "") });
      }
      return out;
    }, selector)
    .catch(() => []);

  return raw.map((m) => ({
    index: m.index,
    selector: `[data-ai-id="${m.index}"]`,
    tag: m.tag,
    text: m.text,
    type: m.type,
    zone: m.inDialog ? "dialog" : m.tag === "input" && m.type === "file" ? "main" : m.inNav || m.y < 145 ? "nav" : "main",
    isEnabled: m.isEnabled,
    isVisible: m.isVisible,
    isDisabled: m.isDisabled,
    required: m.required,
    hasFiles: m.hasFiles,
    isFieldEmpty: m.isFieldEmpty,
    inDialog: m.inDialog,
    inForm: m.inForm,
    isSubmit: m.isSubmit,
    isBackCancel: m.isBackCancel,
    isFilterOrTab: m.isFilterOrTab,
    rect: { x: m.x, y: m.y, width: m.width, height: m.height },
  }));
}

type ControlRole = "forward" | "secondary" | "auxiliary";
const controlRoleCache = new Map<string, ControlRole>();
let roleClassifierFailures = 0;
const roleAttempts = new Map<string, number>();
const roleKey = (label: string) => label.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Language-free control roles decided by the connected LLM (no word lists in code):
 *  - forward   advances the workflow (submit, continue, confirm, start, export …)
 *  - secondary goes back, cancels, closes/dismisses, resets, skips
 *  - auxiliary opens help/info, toggles theme/language/menus, filters, tabs
 * One call classifies every label not seen before; answers are cached per label for the whole run.
 */
async function classifyControlRoles(elements: InteractiveElement[]): Promise<void> {
  const client = getLlmClient();
  if (!client || roleClassifierFailures >= 2) return;
  const labels: string[] = [];
  for (const e of elements) {
    const clickable = e.tag === "button" || e.tag === "a" || e.tag === "summary" || e.isSubmit;
    const key = roleKey(e.text);
    if (clickable && e.type !== "file" && key && !controlRoleCache.has(key) && !labels.some((l) => roleKey(l) === key)) {
      labels.push(e.text.slice(0, 60));
    }
  }
  if (labels.length === 0) return;

  // Small batches keep a 4B model accurate; labels that stay unanswered twice default to "forward".
  const BATCH = 12;
  for (let from = 0; from < Math.min(labels.length, BATCH * 4); from += BATCH) {
    const batch = labels.slice(from, from + BATCH);
    try {
      const res = await requestChat(
        client,
        {
          model: client.model,
          max_tokens: 700,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `You classify web UI controls by what they do, judging only the visible label (any language).
Roles:
- "forward": advances the user's workflow (submit, continue, next, confirm, evaluate, start, export, mark as done, upload …)
- "secondary": goes back, cancels, closes or dismisses, resets, skips
- "auxiliary": opens help/info/explanations, toggles theme/language/menus, filters, tabs, settings switches
Answer for EVERY label. Reply with ONE JSON object: {"roles":{"<label exactly as given>":"forward|secondary|auxiliary"}}`,
            },
            { role: "user", content: batch.map((l, i) => `${i + 1}. ${l}`).join("\n") },
          ],
        },
        NAV_LLM_TIMEOUT_MS,
        "ControlRoles",
        false,
      );
      const parsed = parseJsonLoose(res.choices[0]?.message?.content || "");
      const roles = parsed?.roles ?? parsed;
      let got = 0;
      for (const l of batch) {
        const key = roleKey(l);
        const v = roles?.[l] ?? roles?.[key];
        if (v === "forward" || v === "secondary" || v === "auxiliary") {
          controlRoleCache.set(key, v);
          got++;
        } else {
          const tries = (roleAttempts.get(key) ?? 0) + 1;
          roleAttempts.set(key, tries);
          if (tries >= 2) controlRoleCache.set(key, "forward");
        }
      }
      if (got === 0) roleClassifierFailures++;
      else log("Roles", batch.map((l) => `${l.slice(0, 28)}=${controlRoleCache.get(roleKey(l)) ?? "?"}`).join(", ").slice(0, 400));
    } catch (err) {
      roleClassifierFailures++;
      log("Roles", `classification skipped (${(err as Error).message.slice(0, 80)}); structural signals only`);
      return;
    }
  }
}

/** Fold cached LLM roles into the element flags. Submit controls are never demoted to "secondary". */
function applyControlRoles(elements: InteractiveElement[]): InteractiveElement[] {
  for (const e of elements) {
    const role = controlRoleCache.get(roleKey(e.text));
    if (role === "secondary" && !e.isSubmit) e.isBackCancel = true;
    else if (role === "auxiliary") e.isFilterOrTab = true;
  }
  return elements;
}

async function collectWithRoles(page: Page): Promise<InteractiveElement[]> {
  const t0 = Date.now();
  const elements = await collectInteractiveElements(page);
  const t1 = Date.now();
  await classifyControlRoles(elements);
  if (Date.now() - t0 > 4000) log("Playwright", `slow screen scan: collect ${t1 - t0}ms, classify ${Date.now() - t1}ms, ${elements.length} controls`);
  return applyControlRoles(elements);
}

function chooseDeterministicStep(input: NavigationInput): LlmNavigationDecision | null {
  const emptyFiles = input.elements.filter((e) => e.type === "file" && !e.hasFiles);
  const forwardControls = input.elements.filter(
    (e) =>
      e.zone === "main" &&
      (e.tag === "button" || e.isSubmit) &&
      !e.isBackCancel &&
      !e.isFilterOrTab,
  );
  const enabledForward = forwardControls.filter(
    (e) => e.isEnabled && !e.isDisabled && !input.clickedOnCurrentUrl.has(e.text),
  );

  if (input.uploadsRemaining > 0 && emptyFiles.length > 0) {
    const alreadyUploadedHere = input.uploadedUrls.has(input.url);
    if (!alreadyUploadedHere || enabledForward.length === 0) {
      const targetFileInput = emptyFiles.find((e) => e.required) ?? emptyFiles[0];
      return {
        action: "upload",
        elementIndex: targetFileInput.index,
        label: targetFileInput.text || "Upload input file",
        kind: "upload",
      };
    }
  }

  const dialogButtons = input.elements.filter(
    (e) => e.inDialog && e.isEnabled && !e.isDisabled && (e.tag === "button" || e.isSubmit),
  );
  if (dialogButtons.length > 0) {
    const forwardDialogBtn = dialogButtons.find((e) => !e.isBackCancel && !input.clickedOnCurrentUrl.has(e.text));
    const pick = forwardDialogBtn ?? dialogButtons[0];
    return {
      action: "click",
      elementIndex: pick.index,
      label: pick.text || "Dialog action",
      kind: "navigate",
    };
  }

  if (enabledForward.length > 0) {
    const sortedForward = [...enabledForward].sort((a, b) => {
      if (a.isSubmit !== b.isSubmit) return a.isSubmit ? -1 : 1;
      return (b.rect?.y ?? 0) - (a.rect?.y ?? 0);
    });
    const best = sortedForward[0];
    return {
      action: "click",
      elementIndex: best.index,
      label: best.text || "Continue workflow",
      kind: "navigate",
    };
  }

  // Track scrolls strictly per URL state so non-navigating actions (e.g. file downloads that reset scrollTop)
  // never cause an infinite up-and-down scroll loop.
  const scrollsOnThisUrl = input.history.filter((h) => h.includes(`@${input.url}`) && h.includes("scroll")).length;
  if (input.dwell.remainingScroll > 40 && scrollsOnThisUrl < 3) {
    return {
      action: "scroll",
      label: "Scroll down to inspect content",
      kind: "scroll",
      scrollDelta: Math.min(input.dwell.remainingScroll, input.pacing.scrollStepPx),
    };
  }

  const hasUnfilledRequired = input.elements.some((e) => e.required && e.isFieldEmpty);
  if (!hasUnfilledRequired && enabledForward.length === 0) {
    return {
      action: "done",
      label: "Workflow complete",
      kind: "done",
      completedNaturally: true,
    };
  }

  return null;
}

async function decideNextActionWithAi(input: NavigationInput): Promise<LlmNavigationDecision> {
  const deterministic = chooseDeterministicStep(input);
  if (deterministic) return { ...deterministic, source: "rules" };

  const client = getLlmClient();
  if (!client) {
    return {
      action: "done",
      label: "Workflow finished",
      kind: "done",
      completedNaturally: true,
    };
  }

  const activeBeat = input.beats[Math.min(input.step, Math.max(0, input.beats.length - 1))];
  const openDialog = input.elements.some((e) => e.inDialog);

  const hasOtherMainActions = input.elements.some(
    (e) => e.zone === "main" && e.isEnabled && !e.isDisabled && !e.isBackCancel && e.type !== "file",
  );
  const filteredElements = input.elements.filter(
    (e) => !(e.isBackCancel && (hasOtherMainActions || input.dwell.remainingScroll > 80)),
  );

  const elementsList = filteredElements
    .slice(0, 45)
    .sort((a, b) => (a.rect?.y ?? 0) - (b.rect?.y ?? 0))
    .map((e) => {
      const flags = [
        e.inDialog ? "dialog" : "",
        e.required ? "required" : "",
        e.isFieldEmpty ? "empty" : "",
        e.type === "file" ? (e.hasFiles ? "file-filled" : "file-empty") : "",
        e.isSubmit ? "submit" : "",
        e.isDisabled || !e.isEnabled ? "disabled" : "",
        e.isBackCancel ? "back-cancel" : "",
      ].filter(Boolean).join(",");
      const rect = e.rect ? ` pos=(${Math.round(e.rect.x)},${Math.round(e.rect.y)})` : "";
      return `[#${e.index}] ${e.tag}/${e.type} zone=${e.zone}${flags ? ` (${flags})` : ""}${rect} text="${e.text}"`;
    })
    .join("\n");

  const isLocal = isLocalEndpoint(client.baseURL);
  const raw = await withRetry(
    "NavigatorAI",
    async () => {
      const completion = await requestChat(
        client,
        {
          model: client.model,
          max_tokens: 600,
          reasoning_effort: isLocal ? "none" : "medium",
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content: `You are an autonomous browser agent recording a product promo video of ANY web application.
Inspect the DOM state and choose ONE immediate action that advances the workflow toward the Goal.
Return ONLY valid JSON:
{
  "action": "click" | "fill" | "upload" | "scroll" | "done",
  "elementIndex": number | null,
  "value": string | null,
  "label": "Short description of action",
  "kind": "upload" | "fill" | "navigate" | "scroll" | "done",
  "scrollDelta": number,
  "completed": boolean,
  "reason": "Only when action is done and completed is false: why progression was blocked"
}
Rules:
- elementIndex MUST reference an enabled element from the list.
- NEVER press back/previous/cancel buttons.
- Do NOT click disabled controls. If the next workflow step is disabled because a required file or input is missing and no files remain, return "done" with "completed": false and a clear "reason".
- When no forward navigation step remains on the screen, return "done" with "completed": true.`,
            },
            {
              role: "user",
              content: `Goal: ${input.prompt}
Current Story Beat: ${activeBeat ? `${activeBeat.title} — ${activeBeat.targetGoal}` : "Workflow progression"}
URL: ${input.url}
Step so far: ${input.step + 1}
Files available for upload: ${input.uploadsRemaining} of ${input.uploadsProvided}
Open dialog: ${openDialog ? "yes" : "no"}
remainingScroll: ${input.dwell.remainingScroll}px
History:
${input.history.join("\n") || "(start)"}

Visible page text excerpt:
${input.pageSnippet.slice(0, 450)}

Interactive elements (top-to-bottom):
${elementsList || "(none)"}`,
            },
          ],
          response_format: { type: "json_object" },
        },
        NAV_LLM_TIMEOUT_MS,
        "NavigatorAI",
      );
      return completion.choices[0]?.message?.content || "";
    },
    1,
    300,
  ).catch(() => null);

  let parsed: any = null;
  if (raw) {
    try {
      parsed = parseJsonLoose(raw);
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    return {
      action: "done",
      label: "Done",
      kind: "done",
      completedNaturally: true,
    };
  }

  const allowed = ["click", "fill", "upload", "scroll", "done"];
  const action: LlmNavigationDecision["action"] = allowed.includes(parsed.action) ? parsed.action : "done";
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : undefined;
  const completedNaturally = parsed.completed === true || (reason ? /^workflow completed/i.test(reason.trim()) : false);
  const idx =
    typeof parsed.elementIndex === "number" && input.elements[parsed.elementIndex]
      ? parsed.elementIndex
      : undefined;

  if (action === "click" || action === "fill") {
    if (idx === undefined) {
      return { action: "done", label: "Done", kind: "done", stopReason: completedNaturally ? undefined : reason, completedNaturally };
    }
    const picked = input.elements[idx];
    if (!picked.isEnabled || picked.isDisabled || picked.isBackCancel) {
      return { action: "done", label: "Done", kind: "done", stopReason: completedNaturally ? undefined : reason, completedNaturally };
    }

    if (picked.type === "file") {
      if (input.uploadsRemaining <= 0) {
        return {
          action: "done",
          label: "Missing required file",
          kind: "done",
          stopReason: `Stopped at ${input.url}: additional file upload required (${input.uploadsProvided} provided)`,
        };
      }
      return { action: "upload", elementIndex: picked.index, label: picked.text || "Upload file", kind: "upload" };
    }

    if (action === "fill") {
      const value = typeof parsed.value === "string" ? parsed.value : "";
      if (!value) return { action: "done", label: "Done", kind: "done", stopReason: reason };
      return {
        action: "fill",
        elementIndex: picked.index,
        value,
        label: String(parsed.label || picked.text || "Fill field"),
        kind: "fill",
      };
    }

    return {
      action: "click",
      elementIndex: picked.index,
      label: String(parsed.label || picked.text || "Click"),
      kind: String(parsed.kind || "navigate"),
    };
  }

  if (action === "upload") {
    if (input.uploadsRemaining <= 0) {
      return {
        action: "done",
        label: "Missing required file",
        kind: "done",
        stopReason: `Stopped at ${input.url}: additional file upload required (${input.uploadsProvided} provided)`,
      };
    }
    const target =
      (idx !== undefined && input.elements[idx]?.type === "file" ? input.elements[idx] : undefined) ??
      input.elements.find((e) => e.type === "file" && !e.hasFiles);
    if (!target) return { action: "done", label: "Done", kind: "done", stopReason: reason };
    return { action: "upload", elementIndex: target.index, label: target.text || "Upload file", kind: "upload" };
  }

  if (action === "scroll") {
    if (input.dwell.remainingScroll <= 20) return { action: "done", label: "Done", kind: "done", completedNaturally: true };
    const delta = typeof parsed.scrollDelta === "number" ? parsed.scrollDelta : input.pacing.scrollStepPx;
    return {
      action: "scroll",
      label: String(parsed.label || "Scroll"),
      kind: "scroll",
      scrollDelta: Math.max(120, Math.min(delta, input.pacing.scrollStepPx)),
    };
  }

  return {
    action: "done",
    label: String(parsed.label || "Done"),
    kind: "done",
    stopReason: completedNaturally ? undefined : reason,
    completedNaturally,
  };
}

function analyzeDeadEnd(input: {
  url: string;
  elements: InteractiveElement[];
  uploadsProvided: number;
  uploadsRemaining: number;
  stagnantRounds: number;
  dwell: PageDwellProfile;
}): string | null {
  const emptyFileInputs = input.elements.filter((e) => e.type === "file" && !e.hasFiles);
  const requiredEmptyFiles = emptyFileInputs.filter((e) => e.required);
  const emptyRequiredFields = input.elements.filter((e) => e.required && e.isFieldEmpty);
  const forwardControls = input.elements.filter((e) => e.isSubmit && e.zone !== "nav");
  const disabledForward = forwardControls.filter((e) => e.isDisabled || !e.isEnabled);
  const enabledForward = forwardControls.filter((e) => !e.isDisabled && e.isEnabled);
  const facts: string[] = [];

  const missingFiles = input.uploadsRemaining === 0 && emptyFileInputs.length > 0;
  const forwardBlocked = forwardControls.length > 0 && enabledForward.length === 0;
  if (
    missingFiles &&
    (requiredEmptyFiles.length > 0 || input.stagnantRounds >= 2 || (input.stagnantRounds >= 1 && forwardBlocked))
  ) {
    facts.push(
      `${emptyFileInputs.length} file upload field(s) still empty and no further file is available (${input.uploadsProvided} provided)`,
    );
  }

  if (
    emptyRequiredFields.length > 0 &&
    input.uploadsRemaining === 0 &&
    input.stagnantRounds >= 1 &&
    forwardControls.length > 0 &&
    enabledForward.length === 0
  ) {
    facts.push(
      `${disabledForward.length} forward control(s) disabled by validation with ${emptyRequiredFields.length} required field(s) still empty`,
    );
  }

  if (input.stagnantRounds >= 3 && enabledForward.length === 0 && input.dwell.remainingScroll <= 40) {
    facts.push(`no URL/DOM change after ${input.stagnantRounds} repeated interactions`);
  }

  if (facts.length === 0) return null;
  return `Stopped at ${input.url}: ${facts.join("; ")}`;
}

async function waitUntilSettled(page: Page, maxMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const busy = await page.evaluate(() => {
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  if (Array.from(document.querySelectorAll('[aria-busy="true"]')).some(visible)) return true;
  // A progressbar only counts as busy while it is visible and not yet complete (aria-valuenow < aria-valuemax).
  return Array.from(document.querySelectorAll('[role="progressbar"], progress')).some((el) => {
    if (!visible(el)) return false;
    const nowRaw = el.getAttribute("aria-valuenow") ?? (el as HTMLProgressElement).value?.toString();
    const maxRaw = el.getAttribute("aria-valuemax") ?? ((el as HTMLProgressElement).max ? String((el as HTMLProgressElement).max) : "100");
    const now = parseFloat(nowRaw ?? "");
    const max = parseFloat(maxRaw);
    if (Number.isNaN(now)) return true; // indeterminate
    return now < (Number.isNaN(max) ? 100 : max);
  });
}).catch(() => false);
    if (!busy) return;
    await page.waitForTimeout(150);
  }
}

async function detectSiteTheme(page: Page): Promise<{ bg: string; isDark: boolean }> {
  return page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor || "";
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return { bg, isDark: true };
    const [r, g, b, a = 1] = m[1].split(",").map((x) => Number(x.trim()));
    if (a <= 0.1) return { bg, isDark: true };
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return { bg, isDark: lum < 0.5 };
  }).catch(() => ({ bg: "", isDark: true }));
}

function normRect(box: { x: number; y: number; width: number; height: number } | null | undefined) {
  if (!box || box.width <= 0 || box.height <= 0) return undefined;
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return {
    x: Number(c(box.x / VIEWPORT.width).toFixed(4)),
    y: Number(c(box.y / VIEWPORT.height).toFixed(4)),
    w: Number(c(box.width / VIEWPORT.width).toFixed(4)),
    h: Number(c(box.height / VIEWPORT.height).toFixed(4)),
  };
}

/** Fast, cursor-less replay of a recorded action (used to reach a scene's starting state during a re-shoot). */
async function replayAction(page: Page, a: RecordedAction, uploadFiles: string[]) {
  try {
    if (a.kind === "scroll") {
      await smoothScrollBy(page, a.scrollDelta ?? 0, 60);
    } else if (a.kind === "upload") {
      const file = uploadFiles[a.uploadIndex ?? 0];
      if (!file) return;
      const specific = a.selector ? page.locator(a.selector) : null;
      const input = specific && (await specific.count().catch(() => 0)) > 0 ? specific : page.locator('input[type="file"]:not([disabled])').first();
      await input.setInputFiles(file);
    } else if (a.selector) {
      const loc = page.locator(a.selector);
      if (a.kind === "fill") {
        if (a.fillMode === "select") await loc.selectOption(a.value ?? "");
        else if (a.fillMode === "check") await loc.check();
        else await loc.fill(a.value ?? "");
      } else {
        await loc.click({ noWaitAfter: true, timeout: 3000 });
      }
    }
  } catch (err) {
    log("Playwright", `Replay step skipped (${a.kind} "${a.label}"): ${(err as Error).message.slice(0, 80)}`);
  }
  await waitUntilSettled(page, 1500);
}

async function recordWebUi(args: {
  url: string;
  prompt: string;
  uploadFiles: string[];
  requestedTheme: string;
  beats: StoryBeatPlan[];
  pacing: PacingConfig;
  publicDir: string;
  /** Re-shoot mode: silently replay these actions first (video is trimmed to start right after them). */
  replay?: RecordedAction[];
  /** Hard cap on AI-driven steps (used by single-scene re-shoot). */
  stepBudget?: number;
  /** Output height (480+). Browser capture runs at a matching device scale factor so detail is real, not upscaled. */
  quality?: number;
}): Promise<RecordResult> {
  const { url: urlToRecord, prompt: promptText, uploadFiles, requestedTheme, beats, pacing } = args;
  // Capture sharper than 720p only when the requested output needs it (cap 3x to keep recording fast).
  const captureScale = Math.min(3, Math.max(1, normalizeQuality(args.quality) / VIEWPORT.height));
  const publicDir = args.publicDir || path.resolve("public");
  fs.mkdirSync(publicDir, { recursive: true });

  const events: UiEvent[] = [];
  const history: string[] = [];
  const steps: string[] = [];
  const clickedByUrl = new Map<string, Set<string>>();
  const uploadedUrls = new Set<string>();
  const maxCaptureSec = 180;
  const safetyDeadlineMs = 10 * 60 * 1000;
  const maxSteps = args.stepBudget ?? 45;
  const actions: RecordedAction[] = [];
  const states: { atSec: number; url: string; snippet: string }[] = [];
  let replayOffsetSec = 0;

  let uploadIndex = 0;
  let stopReason: string | null = null;
  let step = 0;
  let stagnantRounds = 0;
  let lastStateSignature = "";

  log("Playwright", `Recording live UI of ${urlToRecord} (max ${maxCaptureSec}s, ${uploadFiles.length} file(s), scroll=${pacing.scrollDurationMs}ms) …`);

  let browser: Browser | null = null;
  try {
    // A real browser-level device scale factor makes the screencast frames genuinely larger. Emulated DPR
    // (context.deviceScaleFactor) does NOT: Playwright then pads the small frame with grey up to the video size.
    browser = await chromium.launch({
      headless: true,
      args: captureScale > 1 ? [`--force-device-scale-factor=${captureScale}`] : [],
    });

    // Unrecorded warm-up pass: classify the first screen's controls (slow first LLM call) so none of that
    // waiting time ends up in the video. Roles are cached by label for the whole run.
    try {
      const warm = await browser.newContext({ viewport: VIEWPORT });
      const warmPage = await warm.newPage();
      warmPage.setDefaultTimeout(4000);
      await warmPage.goto(urlToRecord, { waitUntil: "domcontentloaded", timeout: 30000 });
      await warmPage.waitForTimeout(800);
      await collectWithRoles(warmPage);
      await warm.close();
    } catch (err) {
      log("Playwright", `Warm-up pass skipped: ${(err as Error).message.slice(0, 80)}`);
    }

    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: publicDir, size: { width: Math.round(VIEWPORT.width * captureScale), height: Math.round(VIEWPORT.height * captureScale) } },
    });
    await context.addInitScript(installAiCursor);

    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    const cursor: CursorState = { x: VIEWPORT.width * 0.5, y: VIEWPORT.height * 0.45 };
    const recordStart = Date.now();

    await page.goto(urlToRecord, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(pacing.dwellAfterActionMs);
    await moveCursor(page, cursor, VIEWPORT.width * 0.5, VIEWPORT.height * 0.45, 400);
    events.push({ atSec: elapsedSec(recordStart), kind: "intro", label: "Start" });

    if (args.replay && args.replay.length > 0) {
      log("Playwright", `Replaying ${args.replay.length} earlier action(s) to reach the scene start …`);
      for (const a of args.replay) {
        await replayAction(page, a, uploadFiles);
        if (a.kind === "upload") {
          uploadIndex++;
          uploadedUrls.add(a.url);
        }
        if (a.kind === "click" && a.label) {
          const set = clickedByUrl.get(a.url) ?? new Set<string>();
          set.add(a.label);
          clickedByUrl.set(a.url, set);
        }
        history.push(`0. ${a.kind} "${a.label}" @${a.url}`);
      }
      await waitUntilSettled(page, 2500);
      await page.waitForTimeout(pacing.dwellAfterActionMs);
      replayOffsetSec = elapsedSec(recordStart);
      events.length = 0;
      events.push({ atSec: replayOffsetSec, kind: "intro", label: "Scene start" });
    }

    while (Date.now() - recordStart < safetyDeadlineMs) {
      await waitUntilSettled(page, 2500);

      const currentUrl = page.url();
      let dwell = await measureDwell(page);
      let elements = await collectWithRoles(page);

      // Never fall back to a secondary control while the app is visibly still working: wait for the primary one.
      const waitStart = Date.now();
      while (Date.now() - waitStart < 12000) {
        const remainingUploads = Math.max(0, uploadFiles.length - uploadIndex);
        const canAct =
          elements.some((e) => e.inDialog || (e.type === "file" && !e.hasFiles && remainingUploads > 0)) ||
          elements.some((e) => e.zone === "main" && (e.tag === "button" || e.isSubmit) && !e.isBackCancel && !e.isFilterOrTab && !(clickedByUrl.get(page.url())?.has(e.text))) ||
          dwell.remainingScroll > 40;
        if (canAct || !(dwell.pendingPrimary || dwell.isBusy)) break;
        log("Playwright", `Waiting for the app (pendingPrimary=${dwell.pendingPrimary}, busy=${dwell.isBusy}) …`);
        await page.waitForTimeout(500);
        dwell = await measureDwell(page);
        elements = await collectWithRoles(page);
      }
      const pageSnippet = await page
        .evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 700))
        .catch(() => "");

      states.push({ atSec: elapsedSec(recordStart), url: currentUrl, snippet: pageSnippet.slice(0, 400) });

      const signature = [
        currentUrl,
        pageSnippet.slice(0, 200),
        elements.map((e) => `${e.index}:${e.text}:${e.hasFiles ? 1 : 0}:${e.isFieldEmpty ? 1 : 0}:${e.isEnabled ? 1 : 0}`).join("|"),
      ].join("|");

      if (signature === lastStateSignature) {
        stagnantRounds++;
      } else {
        stagnantRounds = 0;
        lastStateSignature = signature;
      }

      const deadEnd = analyzeDeadEnd({
        url: currentUrl,
        elements,
        uploadsProvided: uploadFiles.length,
        uploadsRemaining: Math.max(0, uploadFiles.length - uploadIndex),
        stagnantRounds,
        dwell,
      });
      if (deadEnd) {
        stopReason = deadEnd;
        log("Playwright", deadEnd);
        break;
      }

      if (step >= maxSteps) {
        stopReason = `Stopped at ${currentUrl}: capture step limit (${maxSteps}) reached`;
        log("Playwright", stopReason);
        break;
      }

      const clickedSet = clickedByUrl.get(currentUrl) ?? new Set<string>();
      clickedByUrl.set(currentUrl, clickedSet);

      const decision = await decideNextActionWithAi({
        url: currentUrl,
        prompt: promptText,
        beats,
        pacing,
        step,
        history,
        clickedOnCurrentUrl: clickedSet,
        uploadedUrls,
        elements,
        dwell,
        pageSnippet,
        uploadsRemaining: Math.max(0, uploadFiles.length - uploadIndex),
        uploadsProvided: uploadFiles.length,
      });

      {
        const picked = decision.elementIndex !== undefined ? elements[decision.elementIndex] : undefined;
        const flags = picked
          ? ` [#${picked.index} ${picked.tag}/${picked.type} zone=${picked.zone} y=${Math.round(picked.rect?.y ?? 0)} submit=${picked.isSubmit} backCancel=${picked.isBackCancel} dialog=${picked.inDialog} text="${picked.text}"]`
          : "";
        log("Playwright", `Step ${step + 1}: ${decision.action} — ${decision.label} (via ${decision.source ?? "llm"})${flags}`);
      }
      if (decision.action === "done") {
        if (!decision.completedNaturally && decision.stopReason) {
          stopReason = decision.stopReason;
        }
        break;
      }
      step++;

      if (decision.action === "upload") {
        const file = uploadFiles[uploadIndex];
        if (!file) {
          stopReason = `Stopped at ${currentUrl}: upload requested but no files remain (${uploadFiles.length} provided)`;
          log("Playwright", stopReason);
          break;
        }
        const target = decision.elementIndex !== undefined ? elements[decision.elementIndex] : undefined;
        const input = target && target.type === "file"
          ? page.locator(target.selector)
          : page.locator('input[type="file"]:not([disabled])').first();

        if ((await input.count().catch(() => 0)) === 0) {
          stopReason = `Stopped at ${currentUrl}: no usable file input was found for the requested upload`;
          log("Playwright", stopReason);
          break;
        }

        const actStart = elapsedSec(recordStart);
        const box = await input.boundingBox().catch(() => null);
        if (box) {
          await moveCursor(page, cursor, box.x + box.width / 2, box.y + box.height / 2, 660);
          await rippleAt(page, box.x + box.width / 2, box.y + box.height / 2);
        }

        try {
          await input.setInputFiles(file);
        } catch (err) {
          stopReason = `Stopped at ${currentUrl}: file upload failed (${(err as Error)?.message || err})`;
          log("Playwright", stopReason);
          break;
        }

        uploadIndex++;
        uploadedUrls.add(currentUrl);
        events.push({ atSec: elapsedSec(recordStart), kind: "upload", label: `${decision.label}: ${path.basename(file)}` });
        const line = `${step}. upload "${path.basename(file)}"`;
        history.push(`${line} @${currentUrl}`);
        steps.push(line);
        await waitUntilSettled(page, 2000);
        await page.waitForTimeout(pacing.dwellAfterActionMs);
        actions.push({
          kind: "upload",
          startSec: actStart,
          endSec: elapsedSec(recordStart),
          url: currentUrl,
          label: decision.label,
          selector: target && target.type === "file" ? target.selector : undefined,
          uploadIndex: uploadIndex - 1,
          rect: normRect(box),
        });
        continue;
      }

      if (decision.action === "fill" && decision.elementIndex !== undefined && decision.value) {
        const el = elements[decision.elementIndex];
        if (el) {
          const loc = page.locator(el.selector);
          const actStart = elapsedSec(recordStart);
          const box = await loc.boundingBox().catch(() => null);
          if (box) {
            await moveCursor(page, cursor, box.x + box.width / 2, box.y + box.height / 2, 660);
            await rippleAt(page, box.x + box.width / 2, box.y + box.height / 2);
          }

          if (el.tag === "select") {
            await loc.selectOption(decision.value).catch(() => undefined);
          } else if (el.tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
            await loc.check().catch(() => undefined);
          } else {
            await loc.fill(decision.value).catch(() => undefined);
          }

          events.push({ atSec: elapsedSec(recordStart), kind: "fill", label: decision.label });
          const line = `${step}. fill "${el.text || el.type}" with "${decision.value}"`;
          history.push(`${line} @${currentUrl}`);
          steps.push(line);
          await waitUntilSettled(page, 1200);
          await page.waitForTimeout(pacing.dwellAfterActionMs);
          actions.push({
            kind: "fill",
            startSec: actStart,
            endSec: elapsedSec(recordStart),
            url: currentUrl,
            label: decision.label,
            selector: el.selector,
            value: decision.value,
            fillMode: el.tag === "select" ? "select" : el.tag === "input" && (el.type === "checkbox" || el.type === "radio") ? "check" : "fill",
            rect: normRect(box),
          });
        }
        continue;
      }

      if (decision.action === "click" && decision.elementIndex !== undefined) {
        const el = elements[decision.elementIndex];
        if (el) {
          if (el.text) clickedSet.add(el.text);
          const loc = page.locator(el.selector);
          const actStart = elapsedSec(recordStart);
          const box = await loc.boundingBox().catch(() => null);
          if (box) {
            if (box.y < 60 || box.y + box.height > VIEWPORT.height - 20) {
              await smoothScrollBy(page, box.y - VIEWPORT.height * 0.65, pacing.scrollDurationMs);
            }
            const updatedBox = (await loc.boundingBox().catch(() => null)) ?? box;
            const x = updatedBox.x + updatedBox.width / 2;
            const y = updatedBox.y + updatedBox.height / 2;
            await moveCursor(page, cursor, x, y, 660);
            await rippleAt(page, x, y);
          }

          const urlBeforeClick = page.url();
          let clickEffectSec = elapsedSec(recordStart);
          await loc.click({ noWaitAfter: true, timeout: 3000 }).catch(() => undefined);
          clickEffectSec = elapsedSec(recordStart);
          await waitUntilSettled(page, 2500);
          const urlAfterClick = page.url();
          // Static, finished screen with a ready forward control: hold only the standard dwell, no extra pause.
          const settledView = await measureDwell(page);
          const readyForward = await page
            .evaluate(() =>
              Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).some((el) => {
                const b = el as HTMLButtonElement;
                const r = b.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && !b.disabled && b.getAttribute("aria-disabled") !== "true" && b.getAttribute("rel") !== "prev";
              }),
            )
            .catch(() => false);
          const staticScreen = !settledView.isBusy && settledView.maxScroll === 0 && readyForward;
          const viewHoldMs = urlAfterClick !== urlBeforeClick && !staticScreen
            ? Math.max(1200, pacing.dwellAfterActionMs)
            : pacing.dwellAfterActionMs;
          // Classify the new screen's labels while the viewer reads it (hides the LLM latency).
          await Promise.all([page.waitForTimeout(viewHoldMs), collectWithRoles(page).catch(() => undefined)]);

          events.push({ atSec: elapsedSec(recordStart), kind: "click", label: el.text || decision.label });
          const line = `${step}. click "${el.text || decision.label}"`;
          history.push(`${line} @${urlBeforeClick}`);
          steps.push(line);
          actions.push({
            kind: "click",
            startSec: actStart,
            endSec: elapsedSec(recordStart),
            effectSec: clickEffectSec,
            url: urlBeforeClick,
            label: el.text || decision.label,
            selector: el.selector,
            rect: normRect(box),
          });

          const postDwell = await measureDwell(page);
          if (urlAfterClick === urlBeforeClick && postDwell.remainingScroll > 100 && postDwell.maxScroll > 0) {
            const scrollsHere = history.filter((h) => h.includes(`@${urlAfterClick}`) && h.includes("scroll")).length;
            if (scrollsHere < 2) {
              const scrollDelta = Math.min(postDwell.remainingScroll, pacing.scrollStepPx);
              await smoothScrollBy(page, scrollDelta, pacing.scrollDurationMs);
              history.push(`${step}. scroll ${scrollDelta}px @${urlAfterClick}`);
              await page.waitForTimeout(Math.round(pacing.dwellAfterActionMs * 0.7));
            }
          }
        }
        continue;
      }

      if (decision.action === "scroll") {
        const delta = Math.min(decision.scrollDelta ?? pacing.scrollStepPx, pacing.scrollStepPx);
        const actStart = elapsedSec(recordStart);
        await smoothScrollBy(page, delta, pacing.scrollDurationMs);
        events.push({ atSec: elapsedSec(recordStart), kind: "scroll", label: decision.label });
        actions.push({ kind: "scroll", startSec: actStart, endSec: elapsedSec(recordStart), url: currentUrl, label: decision.label, scrollDelta: delta });
        const line = `${step}. scroll ${delta}px`;
        history.push(`${line} @${currentUrl}`);
        steps.push(line);
        await page.waitForTimeout(Math.round(pacing.dwellAfterActionMs * 0.8));
      }
    }

    if (!stopReason && Date.now() - recordStart >= safetyDeadlineMs) {
      stopReason = `Stopped at ${page.url()}: capture time limit reached`;
      log("Playwright", stopReason);
    }

    await page.waitForTimeout(Math.round(pacing.dwellAfterActionMs * 0.8));
    events.push({ atSec: elapsedSec(recordStart), kind: "done", label: stopReason ? "Stopped" : "Done" });
    const site = await detectSiteTheme(page);

    const video = page.video();
    await page.close().catch(() => undefined);
    await context.close();
    await browser.close();
    browser = null;

    if (!video) throw new Error("Playwright did not record video.");
    const savedPath = await video.path();
    const finalized = await finalizeCaptureWithFfmpeg(savedPath, publicDir, events, pacing, replayOffsetSec);
    try { fs.unlinkSync(savedPath); } catch { /* ignore */ }

    const detectedTheme = site.isDark ? "dark" : "light";
    const effectiveTheme = requestedTheme === "auto" ? (site.isDark ? "dark-neon" : "clean-light") : requestedTheme;

    return {
      recorded: true,
      capturePath: finalized.mp4Path,
      actions: actions.map((a) => ({
        ...a,
        startSec: Number(Math.max(0, a.startSec - replayOffsetSec).toFixed(3)),
        endSec: Number(Math.max(0, a.endSec - replayOffsetSec).toFixed(3)),
        effectSec: a.effectSec === undefined ? undefined : Number(Math.max(0, a.effectSec - replayOffsetSec).toFixed(3)),
      })),
      states: states.map((st) => ({ ...st, atSec: Number(Math.max(0, st.atSec - replayOffsetSec).toFixed(3)) })),
      replayOffsetSec,
      durationSec: finalized.durationSec,
      uiEvents: finalized.trimmedEvents,
      siteBg: site.bg,
      detectedTheme,
      effectiveTheme,
      displayUrl: urlToRecord,
      uploadName: uploadFiles.map((f) => path.basename(f)).join(", "),
      stopReason,
      steps,
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Server Detection & Render                                           */
/* ------------------------------------------------------------------ */

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+/gi) ?? [];
  return [...new Set(matches.map((u) =>
    u
      .replace(/\/$/, "")
      .replace(/0\.0\.0\.0|\[::1?\]/gi, "localhost"),
  ))];
}

/** Ports that started listening after `baseline` was captured (the launched app's ports), from one netstat call. */
function discoverNewListeningPorts(baseline: Set<number>): number[] {
  return [...listListeningSockets().keys()].filter((p) => p >= 1024 && p <= 65535 && !baseline.has(p));
}

async function waitForAppUrl(
  explicit: string | null,
  getUrls: () => string[],
  ports: number[],
  timeoutMs = 50000,
  baselinePorts: Set<number> = new Set(),
  explicitPort: number | null = null,
): Promise<string | null> {
  const start = Date.now();
  let lastNetstat = 0;
  let dynamicPorts: number[] = [];
  while (Date.now() - start < timeoutMs) {
    // Cheap in-process candidates first (URLs from logs, expected ports); netstat only every 3 s as a fallback.
    if (Date.now() - lastNetstat > 3000) {
      dynamicPorts = discoverNewListeningPorts(baselinePorts);
      lastNetstat = Date.now();
    }
    const allPorts = [...new Set([...(explicitPort ? [explicitPort] : []), ...ports, ...dynamicPorts])];
    const candidates = [...new Set([
      ...(explicit ? [explicit] : []),
      ...(explicitPort ? [`http://localhost:${explicitPort}`] : []),
      ...getUrls(),
      ...allPorts.map((p) => `http://localhost:${p}`),
    ])];
    for (const url of candidates) {
      if (await checkHtmlServer(url)) return url;
    }
    await sleep(900);
  }
  for (const url of [...new Set([
    ...(explicit ? [explicit] : []),
    ...(explicitPort ? [`http://localhost:${explicitPort}`] : []),
    ...getUrls(),
  ])]) {
    if (await checkHttpServer(url)) return url;
  }
  return null;
}

/** All renders use 1280x720 (the 1920x1080 layout is scaled inside the composition) so partial renders can be spliced with `-c copy`. */

async function renderVideo(propsPath: string, outPath: string, concurrency = 4, frames?: { from: number; to: number }, composition = "DemoScene") {
  // Run the Remotion CLI with the current node binary directly: no cmd.exe, no npx shim, no console window.
  const cli = path.resolve("node_modules", "@remotion", "cli", "remotion-cli.js");
  const args = [cli, "render", "src/index.ts", composition, outPath, `--props=${propsPath}`, `--concurrency=${concurrency}`];
  if (frames) args.push(`--frames=${frames.from}-${frames.to}`);
  log("Render", `remotion render ${composition} ${path.basename(outPath)}${frames ? ` frames ${frames.from}-${frames.to}` : ""}`);
  const { stdout, stderr } = await execFileSilentAsync(process.execPath, args, { maxBuffer: 64 * 1024 * 1024, timeout: 25 * 60 * 1000 });
  if (stdout.trim()) console.log(stdout.trim().split(/\r?\n/).slice(-4).join("\n"));
  if (stderr.trim()) console.error(stderr.trim().split(/\r?\n/).slice(-4).join("\n"));
}

/* ------------------------------------------------------------------ */
/* Sessions, scene manifest & modular editing                          */
/* ------------------------------------------------------------------ */

const CLIP_ENCODE_ARGV = ["-r", "30", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-bf", "0", "-g", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"];
const SESSIONS_ROOT = () => path.resolve("out", "sessions");

interface SceneManifestEntry {
  id: string;
  index: number;
  title: string;
  caption: string;
  targetGoal: string;
  requiredActions: string[];
  /** Position of this scene inside the assembled UI video (seconds). */
  startSec: number;
  endSec: number;
  durationSec: number;
  clipFile: string;
  startUrl: string;
  domSnapshot: string;
  /** Replayable actions; times are relative to the scene clip. */
  actions: RecordedAction[];
}

interface SessionManifest {
  version: 2;
  id: string;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  theme: string;
  uploadFiles: string[];
  llm: { model: string; baseUrl: string };
  target: {
    explicitUrl: string | null;
    filePath: string | null;
    repoRoot: string;
    port: number | null;
    launch: ProjectLaunchPlan;
  };
  publicDir: string;
  outPath: string;
  videoTitle: string;
  introLine: string;
  outroLine: string;
  introSec: number;
  outroSec: number;
  /** Output height in pixels (width follows 16:9). */
  quality?: number;
  backdropMode?: BackdropMode;
  format?: VideoFormat;
  artDirection: ArtDirection;
  pacing: PacingConfig;
  record: {
    displayUrl: string;
    uploadName: string;
    siteBg: string;
    detectedTheme: string;
    effectiveTheme: string;
    stopReason: string | null;
    steps: string[];
  };
  scenes: SceneManifestEntry[];
}

const clipName = (index: number) => `scene_${String(index + 1).padStart(2, "0")}.mp4`;

function encodeClip(src: string, startSec: number, endSec: number, dst: string) {
  const ffmpeg = findBinary("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg not found.");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  execFileSilentSync(ffmpeg, ["-y", "-ss", startSec.toFixed(3), "-to", endSec.toFixed(3), "-i", src, ...CLIP_ENCODE_ARGV, dst], {
    timeout: 5 * 60 * 1000,
    stdio: "pipe",
  });
}

/** Concatenate the (identically encoded) scene clips into the single capture file that Remotion plays. */
function assembleUiVideo(sessionDir: string, scenes: SceneManifestEntry[], publicDir: string): string {
  const ffmpeg = findBinary("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg not found.");
  const listPath = path.join(sessionDir, "concat.txt");
  fs.writeFileSync(
    listPath,
    scenes.map((s) => `file '${path.join(sessionDir, s.clipFile).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
    "utf8",
  );
  const dst = path.join(publicDir, `ui-session-${RUN_ID}.mp4`);
  try {
    execFileSilentSync(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", dst], { timeout: 5 * 60 * 1000, stdio: "pipe" });
  } catch {
    execFileSilentSync(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, ...CLIP_ENCODE_ARGV, dst], { timeout: 8 * 60 * 1000, stdio: "pipe" });
  }
  return dst;
}

/** Re-probe every clip and rebuild the cumulative timeline. */
async function refreshTimeline(sessionDir: string, scenes: SceneManifestEntry[]): Promise<number> {
  let t = 0;
  for (const s of scenes) {
    const d = (await probeVideoDuration(path.join(sessionDir, s.clipFile))) ?? s.durationSec ?? 1;
    s.durationSec = Number(d.toFixed(3));
    s.startSec = Number(t.toFixed(3));
    t += d;
    s.endSec = Number(t.toFixed(3));
  }
  return Number(t.toFixed(3));
}

/** Split the continuous capture into scenes at quiet moments between actions (no mid-motion cuts). */
export function planScenes(
  record: Pick<RecordResult, "durationSec" | "actions" | "states" | "displayUrl">,
  beats: StoryBeatPlan[],
) {
  const total = Math.max(0.5, record.durationSec);
  const acts = [...record.actions].sort((a, b) => a.startSec - b.startSec);
  const M = acts.length;
  const N = Math.max(1, Math.min(beats.length, M || 1));
  const chosen = N === beats.length ? beats : Array.from({ length: N }, (_, i) => beats[Math.floor((i * beats.length) / N)]);
  const minGap = Math.min(1, total / (N * 2));

  const bounds = [0];
  for (let k = 1; k < N; k++) {
    const s = Math.floor((k * M) / N);
    const prev = acts[s - 1];
    const next = acts[s];
    // Chapter changes exactly when the transition click lands; other actions fall back to the quiet gap.
    let b = prev && next ? (prev.kind === "click" && prev.effectSec !== undefined ? prev.effectSec + 0.15 : (prev.endSec + next.startSec) / 2) : (total * k) / N;
    b = Math.max(bounds[k - 1] + minGap, Math.min(b, total - (N - k) * minGap));
    bounds.push(b);
  }
  bounds.push(total);

  return chosen.map((beat, k) => {
    const from = Math.floor((k * M) / N);
    const to = Math.floor(((k + 1) * M) / N);
    const start = bounds[k];
    const state = [...record.states].reverse().find((st) => st.atSec <= start + 0.05) ?? record.states[0];
    return {
      beat,
      start,
      end: bounds[k + 1],
      actions: acts.slice(from, to).map((a) => ({
        ...a,
        startSec: Number(Math.max(0, a.startSec - start).toFixed(3)),
        endSec: Number(Math.max(0, a.endSec - start).toFixed(3)),
        effectSec: a.effectSec === undefined ? undefined : Number(Math.max(0, a.effectSec - start).toFixed(3)),
      })),
      startUrl: state?.url ?? record.displayUrl,
      domSnapshot: state?.snippet ?? "",
    };
  });
}

function newSessionId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function resolveSessionDir(projectDir?: string | null, session?: string | null): string {
  if (projectDir) return path.resolve(projectDir);
  if (session) {
    const direct = path.resolve(session);
    if (fs.existsSync(path.join(direct, "manifest.json"))) return direct;
    return path.join(SESSIONS_ROOT(), session);
  }
  const root = SESSIONS_ROOT();
  const candidates = fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .map((n) => path.join(root, n))
        .filter((d) => fs.existsSync(path.join(d, "manifest.json")))
        .sort((a, b) => fs.statSync(path.join(b, "manifest.json")).mtimeMs - fs.statSync(path.join(a, "manifest.json")).mtimeMs)
    : [];
  if (candidates.length === 0) throw new Error(`No saved session found in ${root}. Pass --project-dir or --session.`);
  return candidates[0];
}

function saveManifest(sessionDir: string, manifest: SessionManifest) {
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

/** Remotion props derived from the manifest (dynamic fields) on top of the saved base props (static fields). */
function propsFromManifest(m: SessionManifest, base: Record<string, any>, uiUsedSec: number, uiDurationSec: number) {
  const beats = m.scenes.map((s) => ({ id: s.id, title: s.title, caption: s.caption, targetGoal: s.targetGoal }));
  return {
    ...base,
    videoTitle: m.videoTitle,
    introLine: m.introLine,
    outroLine: m.outroLine,
    chapters: beats.map((b) => ({ title: b.title, caption: b.caption })),
    captions: beats.map((b) => b.caption),
    storyBeats: beats,
    sceneTimings: m.scenes.map((s) => ({ startSec: s.startSec, endSec: s.endSec })),
    uiDurationSec,
    uiUsedSec,
    introSec: m.introSec,
    outroSec: m.outroSec,
    outHeight: normalizeQuality(m.quality),
    format: normalizeFormat(m.format),
    focusPoints: m.scenes.flatMap((sc) =>
      sc.actions
        .filter((a) => a.rect)
        .map((a) => ({ atSec: Number((sc.startSec + (a.effectSec ?? a.endSec)).toFixed(3)), label: a.label, kind: a.kind, ...a.rect! })),
    ),
    durationInFrames: Math.max(1, Math.round((m.introSec + uiUsedSec + m.outroSec) * CAPTURE_FPS)),
    fps: CAPTURE_FPS,
    theme: m.record.effectiveTheme,
    detectedTheme: m.record.detectedTheme,
    siteBg: m.record.siteBg,
    displayUrl: m.record.displayUrl,
    uploadName: m.record.uploadName,
    artDirection: m.artDirection,
    stopReason: m.record.stopReason,
    comment: m.record.stopReason,
    steps: m.record.steps,
  };
}

const stableJson = (v: any): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val,
  );

function probeVideoGeometry(file: string): { width: number; height: number } | null {
  const ffprobe = findBinary("ffprobe");
  if (!ffprobe || !fs.existsSync(file)) return null;
  try {
    const out = (execFileSilentSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8", timeout: 20000 }) as string).trim();
    const [w, h] = out.split(",").map(Number);
    return w && h ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}

/** Frame indices (at fps) of every key frame in a video. */
function probeKeyframes(file: string, fps: number): number[] {
  const ffprobe = findBinary("ffprobe");
  if (!ffprobe) return [];
  try {
    const out = execFileSilentSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const frames: number[] = [];
    for (const line of out.split(/\r?\n/)) {
      const [t, flags] = line.split(",");
      if (flags && flags.includes("K") && t) frames.push(Math.round(Number(t) * fps));
    }
    return [...new Set(frames)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * If only the edited scene's own texts changed, return the key-frame-aligned frame range that must be re-rendered.
 * Everything else is copied from the previous final video. Returns null when a full render is required.
 */
export function planPartialRender(
  prevProps: Record<string, any>,
  newProps: Record<string, any>,
  sceneIndex: number,
  scene: Pick<SceneManifestEntry, "startSec" | "endSec">,
  outPath: string,
  probes = { probeVideoGeometry, probeKeyframes },
): { from: number; to: number; totalFrames: number } | null {
  const no = (why: string) => {
    log("Render", `Partial render not possible: ${why} — full render.`);
    return null;
  };
  if (!prevProps || !prevProps.durationInFrames) return no("no previous props");
  if (prevProps.durationInFrames !== newProps.durationInFrames) return no(`duration changed ${prevProps.durationInFrames} -> ${newProps.durationInFrames}`);
  const strip = (p: Record<string, any>) => {
    const c = JSON.parse(JSON.stringify(p));
    delete c.uiVideoFile; // run-unique temp file name, irrelevant for frame content
    for (const key of ["storyBeats", "chapters", "captions"]) {
      if (Array.isArray(c[key])) c[key] = c[key].filter((_: any, i: number) => i !== sceneIndex);
    }
    return c;
  };
  {
    const a = strip(prevProps);
    const b = strip(newProps);
    if (stableJson(a) !== stableJson(b)) {
      const diff = Object.keys({ ...a, ...b }).filter((k) => stableJson(a[k]) !== stableJson(b[k]));
      return no(`global props changed (${diff.join(", ")})`);
    }
  }

  const geo = probes.probeVideoGeometry(outPath);
  const wantH = normalizeQuality(newProps.outHeight);
  if (!geo || geo.height !== wantH || geo.width !== qualityWidth(wantH)) return no(`previous video is not ${qualityWidth(wantH)}x${wantH}`);
  const fps = Number(newProps.fps) || CAPTURE_FPS;
  const total = Number(newProps.durationInFrames);
  const introFrames = Math.max(1, Math.round(Number(newProps.introSec) * fps));
  const f0 = Math.max(0, introFrames + Math.round(scene.startSec * fps) - 1);
  const f1 = Math.min(total - 1, introFrames + Math.round(scene.endSec * fps) + 1);

  const keys = probes.probeKeyframes(outPath, fps);
  if (keys.length === 0) return no("no keyframes probed");
  const from = [...keys].reverse().find((k) => k <= f0) ?? 0;
  const next = keys.find((k) => k > f1);
  const to = next === undefined ? total - 1 : next - 1;
  return { from, to, totalFrames: total };
}

/** Splice: copy [0,from) and (to,end] from the previous final, insert the freshly rendered middle. All `-c copy`. */
function splicePartial(prevFinal: string, partPath: string, plan: { from: number; to: number; totalFrames: number }, sessionDir: string, fps: number, outPath: string) {
  const ffmpeg = findBinary("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg not found.");
  const parts: string[] = [];
  if (plan.from > 0) {
    const pre = path.join(sessionDir, "splice_pre.mp4");
    execFileSilentSync(ffmpeg, ["-y", "-i", prevFinal, "-t", (plan.from / fps).toFixed(5), "-c", "copy", "-an", pre], { stdio: "pipe", timeout: 120000 });
    parts.push(pre);
  }
  parts.push(partPath);
  if (plan.to < plan.totalFrames - 1) {
    const post = path.join(sessionDir, "splice_post.mp4");
    execFileSilentSync(ffmpeg, ["-y", "-ss", ((plan.to + 1) / fps).toFixed(5), "-i", prevFinal, "-c", "copy", "-an", post], { stdio: "pipe", timeout: 120000 });
    parts.push(post);
  }
  const list = path.join(sessionDir, "splice.txt");
  fs.writeFileSync(list, parts.map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  const tmp = `${outPath}.splice.mp4`;
  execFileSilentSync(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", tmp], { stdio: "pipe", timeout: 120000 });
  fs.renameSync(tmp, outPath);
  for (const f of parts) if (f !== partPath) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

/** Assemble clips -> props -> Remotion render (with the EOF-safety retry loop). Returns final duration. */
async function composeAndRender(
  sessionDir: string,
  manifest: SessionManifest,
  baseProps: Record<string, any>,
  outPath: string,
  partial?: { scene: SceneManifestEntry; prevProps: Record<string, any> } | null,
): Promise<{ durationSec: number; uiUsedSec: number; partialFrames?: string }> {
  const publicDir = manifest.publicDir;
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const uiTotal = await refreshTimeline(sessionDir, manifest.scenes);
  const uiVideoPath = assembleUiVideo(sessionDir, manifest.scenes, publicDir);
  const probed = await probeVideoDuration(uiVideoPath);
  const baseSec = probed ?? uiTotal;
  // uiFrames = floor(baseSec * 30) - 1 so <OffthreadVideo> never requests a frame past EOF.
  let uiUsedSec = Math.max(0.5, Number(((Math.max(1, Math.floor(baseSec * CAPTURE_FPS) - 1)) / CAPTURE_FPS).toFixed(3)));

  const propsPath = path.join(sessionDir, "props.json");
  // Each session keeps its own final video; the shared output path only receives a copy.
  const finalPath = path.join(sessionDir, "final.mp4");
  const renderPropsPath = path.resolve(publicDir, `temp-props-${RUN_ID}.json`);
  const composition = normalizeFormat(manifest.format) === "promo" ? "PromoScene" : "DemoScene";
  const concurrencies = [4, 2, 1, 1];
  let partialFrames: string | undefined;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const props = { ...propsFromManifest(manifest, baseProps, uiUsedSec, baseSec), uiVideoFile: path.basename(uiVideoPath) };
    fs.writeFileSync(renderPropsPath, JSON.stringify(props), "utf8");
    try {
      const plan = attempt === 1 && partial ? planPartialRender(partial.prevProps, props, partial.scene.index, partial.scene, finalPath) : null;
      if (plan && partial) {
        const partPath = path.join(sessionDir, "render_part.mp4");
        log("Render", `Partial render: frames ${plan.from}-${plan.to} of ${plan.totalFrames} (scene ${partial.scene.index + 1}), rest copied.`);
        try {
          await renderVideo(renderPropsPath, partPath, concurrencies[0], { from: plan.from, to: plan.to }, composition);
          splicePartial(finalPath, partPath, plan, sessionDir, Number(props.fps) || CAPTURE_FPS, finalPath);
          try { fs.unlinkSync(partPath); } catch { /* ignore */ }
          partialFrames = `${plan.from}-${plan.to}`;
          fs.writeFileSync(propsPath, JSON.stringify(props, null, 2), "utf8");
          break;
        } catch (err) {
          log("Render", `Partial render failed (${(err as Error).message.slice(0, 120)}) — falling back to a full render.`);
        }
      }
      fs.writeFileSync(propsPath, JSON.stringify(props, null, 2), "utf8");
      await renderVideo(renderPropsPath, finalPath, concurrencies[attempt - 1] ?? 1, undefined, composition);
      break;
    } catch (err: any) {
      const fullErr = `${err?.message || ""} ${err?.stderr || ""} ${err?.stdout || ""}`;
      if (/No frame found at position/i.test(fullErr) && attempt < 4 && uiUsedSec > 0.8) {
        uiUsedSec = Math.max(0.5, Number((uiUsedSec - 0.35).toFixed(3)));
        log("Render", `No frame found at position; retrying with uiUsedSec=${uiUsedSec}s (attempt ${attempt + 1}/4) …`);
        continue;
      }
      throw err;
    }
  }
  fs.copyFileSync(finalPath, outPath);
  // Subtitles always match the video that was just rendered (scene titles/captions + timings from the manifest).
  try {
    writeSubtitles(sessionDir, manifest);
  } catch (err) {
    log("Subtitles", `Skipped: ${(err as Error).message}`);
  }
  for (const tmp of [uiVideoPath, renderPropsPath]) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  const final = await probeVideoDuration(finalPath);
  return { durationSec: final ?? Number((manifest.introSec + uiUsedSec + manifest.outroSec).toFixed(3)), uiUsedSec, partialFrames };
}

interface RunningApp {
  appUrl: string;
  output: () => string;
  stop: () => void;
}

/** Process Executor: reuse a running URL or launch the project in a clean env, detect URL/port, expose a stop() handle. */
async function startTargetApp(o: {
  explicitUrl: string | null;
  launch: ProjectLaunchPlan;
  repoRoot: string;
  port: number | null;
  managedPorts: number[];
}): Promise<RunningApp> {
  if (o.explicitUrl) {
    if (!(await checkHttpServer(o.explicitUrl))) throw new Error(`The provided URL is not reachable: ${o.explicitUrl}`);
    log("Executor", `Using already running UI at ${o.explicitUrl}`);
    return { appUrl: o.explicitUrl, output: () => "", stop: () => undefined };
  }

  freePorts(o.managedPorts);
  log("Executor", `Launching: ${o.launch.launchCommand}`);

  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value !== undefined) cleanEnv[key] = value;
  }
  if (o.port) cleanEnv.PORT = String(o.port);
  cleanEnv.FORCE_COLOR = "1";
  cleanEnv.PYTHONUNBUFFERED = "1";

  const detectedUrls: string[] = [];
  let terminalOutput = "";
  const baselinePorts = new Set(listListeningSockets().keys());
  const spawnOpts = { cwd: o.repoRoot, env: cleanEnv, shell: false, detached: false };
  const direct = resolveDirectLaunch(o.launch.launchCommand);
  let serverProcess: ChildProcess;
  try {
    if (!direct) throw new Error("needs a shell");
    serverProcess = spawnSilent(direct.file, direct.args, spawnOpts);
  } catch (err) {
    // Rare: pipes / `&&` / .cmd wrappers. Still hidden, but goes through the platform shell.
    log("Executor", `Direct launch not possible (${(err as Error).message}); using the hidden platform shell.`);
    serverProcess = process.platform === "win32"
      ? spawnSilent(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", o.launch.launchCommand], { ...spawnOpts, windowsVerbatimArguments: true })
      : spawnSilent("sh", ["-c", o.launch.launchCommand], spawnOpts);
  }
  serverProcess.on("error", (e) => log("Executor", `App process error: ${e.message}`));
  const stop = () => {
    stopProcessTree(serverProcess);
    if (o.managedPorts.length > 0) freePorts(o.managedPorts);
  };

  const onOutput = (chunkBuf: Buffer) => {
    const chunk = chunkBuf.toString();
    terminalOutput += chunk;
    if (terminalOutput.length > 160000) terminalOutput = terminalOutput.slice(-120000);
    process.stdout.write(chunk);
    for (const u of extractUrls(chunk)) {
      if (!detectedUrls.includes(u)) detectedUrls.push(u);
    }
  };
  serverProcess.stdout?.on("data", onOutput);
  serverProcess.stderr?.on("data", onOutput);

  const appUrl = await waitForAppUrl(null, () => detectedUrls, o.managedPorts, 50000, baselinePorts, o.port);
  if (!appUrl) {
    stop();
    throw new Error("Could not detect a running web UI URL.");
  }
  log("Executor", `UI ready at ${appUrl}`);
  return { appUrl, output: () => terminalOutput, stop };
}

interface ScenePatch {
  mode: "metadata" | "reshoot";
  title?: string;
  caption?: string;
  targetGoal?: string;
  backdropBrief?: string;
  backdropMotif?: string;
  accentColor?: string;
  secondaryColor?: string;
  bgStart?: string;
  bgEnd?: string;
  videoTitle?: string;
  introLine?: string;
  outroLine?: string;
}

/** Pure part of planSceneEdit(): sanitise a decoded LLM patch without contacting the model. */
export function normalizeScenePatch(raw: any, allowReshoot: boolean): ScenePatch {
  const hex = (v: any) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : undefined);
  const str = (v: any, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  // On-screen texts are cut at a word boundary, exactly like when the plan is first written.
  const onScreen = (v: any, max: number) => (typeof v === "string" && v.trim() ? clipText(v, max) : undefined);
  return {
    mode: allowReshoot && raw?.mode === "reshoot" ? "reshoot" : "metadata",
    title: onScreen(raw?.title, 40),
    caption: onScreen(raw?.caption, 68),
    targetGoal: str(raw?.targetGoal, 140),
    backdropBrief: str(raw?.backdropBrief, 600),
    backdropMotif: str(raw?.backdropMotif, 20),
    accentColor: hex(raw?.accentColor),
    secondaryColor: hex(raw?.secondaryColor),
    bgStart: hex(raw?.bgStart),
    bgEnd: hex(raw?.bgEnd),
    videoTitle: str(raw?.videoTitle, 64),
    introLine: str(raw?.introLine, 180),
    outroLine: str(raw?.outroLine, 180),
  };
}

/** Pure part of runEdit(): clear fields that merely echo the current manifest values. */
export function dropNoOpEditFields(
  patch: ScenePatch,
  current: {
    artDirection: Pick<ArtDirection, "accentColor" | "secondaryColor" | "bgStart" | "bgEnd">;
    videoTitle: string;
    introLine: string;
    outroLine: string;
  },
): ScenePatch {
  const same = (a?: string, b?: string) => !a || (b ?? "").toLowerCase() === a.toLowerCase();
  const cleaned: ScenePatch = { ...patch };
  if (same(cleaned.accentColor, current.artDirection.accentColor)) cleaned.accentColor = undefined;
  if (same(cleaned.secondaryColor, current.artDirection.secondaryColor)) cleaned.secondaryColor = undefined;
  if (same(cleaned.bgStart, current.artDirection.bgStart)) cleaned.bgStart = undefined;
  if (same(cleaned.bgEnd, current.artDirection.bgEnd)) cleaned.bgEnd = undefined;
  if (same(cleaned.videoTitle, current.videoTitle)) cleaned.videoTitle = undefined;
  if (same(cleaned.introLine, current.introLine)) cleaned.introLine = undefined;
  if (same(cleaned.outroLine, current.outroLine)) cleaned.outroLine = undefined;
  return cleaned;
}

/** LLM decides what an edit instruction changes: texts/style (Mode A) or the on-screen walkthrough (Mode B). */
async function planSceneEdit(manifest: SessionManifest, scene: SceneManifestEntry, editPrompt: string, allowReshoot: boolean): Promise<ScenePatch> {
  const client = getLlmClient();
  if (!client) throw new Error("An LLM is required to interpret --edit-prompt.");
  const system = `You edit ONE scene of a product promo video. Reply with ONE JSON object and nothing else.
Fields (include only what the instruction changes):
{"mode":"metadata"|"reshoot","title":"short badge","caption":"subtitle","targetGoal":"screen/element to show","backdropBrief":"English description of a NEW background illustration","backdropMotif":"circuit|lattice|waves|skyline|constellation","accentColor":"#rrggbb","secondaryColor":"#rrggbb","bgStart":"#rrggbb","bgEnd":"#rrggbb","videoTitle":"","introLine":"","outroLine":""}
Rules:
- mode "reshoot" ONLY if the instruction asks to change what is shown or done in the browser (scroll somewhere else, click/open something else, redo the walkthrough of this step). Text, subtitle, title, colours, background, wording => "metadata".
- Keep the language of the existing scene texts unless the instruction names another language. Use the exact wording the instruction gives for new texts.
- Include ONLY the fields the instruction explicitly asks to change. Never repeat unchanged values and never invent colours, background or other fields.
- title <= 40 chars, caption <= 68 chars.`;
  const user = `Existing scene ${scene.index + 1} (${scene.id}):
title: ${scene.title}
caption: ${scene.caption}
targetGoal: ${scene.targetGoal}
Video language sample: ${manifest.videoTitle} / ${manifest.introLine}
Instruction: ${editPrompt}`;

  const call = async (compact: boolean) => {
    const res = await requestChat(
      client,
      {
        model: client.model,
        max_tokens: 500,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: compact ? "Return ONLY a JSON object with keys from: mode,title,caption,targetGoal,backdropBrief,accentColor,secondaryColor,bgStart,bgEnd. mode is \"metadata\" or \"reshoot\"." : system },
          { role: "user", content: user },
        ],
      },
      PLAN_LLM_TIMEOUT_MS,
      "SceneEdit",
      false,
    );
    return parseJsonLoose(res.choices[0]?.message?.content || "");
  };

  let raw: any;
  try {
    raw = await call(false);
  } catch (err) {
    log("SceneEdit", `First attempt failed (${(err as Error).message.slice(0, 100)}) — retrying with compact prompt.`);
    raw = await call(true);
  }

  return normalizeScenePatch(raw, allowReshoot);
}

/** Pure lookup used by --edit-scene: exact id first, then a trailing 1-based number. */
export function findScene(manifest: SessionManifest, ref: string): SceneManifestEntry {
  const key = String(ref).trim();
  const byId = manifest.scenes.find((s) => s.id === key);
  if (byId) return byId;
  const digits = /(\d+)\s*$/.exec(key);
  if (digits) {
    const idx = Number(digits[1]) - 1;
    if (manifest.scenes[idx]) return manifest.scenes[idx];
  }
  throw new Error(`Scene "${ref}" not found. Available: ${manifest.scenes.map((s, i) => `${i + 1}=${s.id}`).join(", ")}`);
}

async function runEdit(options: PipelineOptions): Promise<PipelineResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const sessionDir = resolveSessionDir(options.projectDir, options.session);
  const manifest: SessionManifest = JSON.parse(fs.readFileSync(path.join(sessionDir, "manifest.json"), "utf8"));
  const baseProps: Record<string, any> = fs.existsSync(path.join(sessionDir, "props.json"))
    ? JSON.parse(fs.readFileSync(path.join(sessionDir, "props.json"), "utf8"))
    : {};
  log("Editor", `Session ${manifest.id} (${manifest.scenes.length} scenes) at ${sessionDir}`);

  llmOverrides = {
    model: options.model ?? manifest.llm.model,
    baseUrl: options.baseUrl ?? manifest.llm.baseUrl,
    apiKey: options.apiKey ?? null,
  };
  const outPath = path.resolve(options.outPath || manifest.outPath);
  if (options.quality !== undefined && options.quality !== null && String(options.quality) !== "") manifest.quality = normalizeQuality(options.quality);
  if (options.backdropMode) manifest.backdropMode = normalizeBackdropMode(options.backdropMode);
  if (options.format) {
    manifest.format = normalizeFormat(options.format);
    Object.assign(manifest, formatTimings(manifest.format));
  }
  const hasEdit = options.editScene !== undefined && options.editScene !== null && String(options.editScene).trim() !== "";
  const editPrompt = (options.editPrompt || "").trim();
  let partialScene: SceneManifestEntry | null = null;

  if (hasEdit) {
    const scene = findScene(manifest, String(options.editScene));
    if (!editPrompt) throw new Error("--edit-scene requires --edit-prompt.");
    const plannedPatch = await planSceneEdit(manifest, scene, editPrompt, !options.reRenderOnly);
    // Drop no-op fields so small models that echo unchanged values never trigger global re-renders.
    const patch = dropNoOpEditFields(plannedPatch, manifest);
    log("Editor", `Patch: ${JSON.stringify(patch)}`);
    log("Editor", `Scene ${scene.index + 1} (${scene.id}) edit mode: ${patch.mode === "reshoot" ? "B (re-shoot clip)" : "A (metadata/style, clips untouched)"}`);
    if (patch.mode === "metadata") partialScene = scene;

    if (patch.title) scene.title = patch.title;
    if (patch.caption) scene.caption = patch.caption;
    if (patch.targetGoal) scene.targetGoal = patch.targetGoal;
    if (patch.videoTitle) manifest.videoTitle = patch.videoTitle;
    if (patch.introLine) manifest.introLine = patch.introLine;
    if (patch.outroLine) manifest.outroLine = patch.outroLine;
    const art = manifest.artDirection;
    if (patch.accentColor) art.accentColor = patch.accentColor;
    if (patch.secondaryColor) art.secondaryColor = patch.secondaryColor;
    if (patch.bgStart) art.bgStart = patch.bgStart;
    if (patch.bgEnd) art.bgEnd = patch.bgEnd;
    if (patch.backdropBrief || patch.accentColor || patch.secondaryColor) {
      const brief = patch.backdropBrief || "";
      if (brief) art.backdropSvg = await generateBackdropSvg(manifest.prompt, brief, art.accentColor, art.secondaryColor, patch.backdropMotif, manifest.backdropMode);
    }

    if (patch.mode === "reshoot") {
      const sc = scene;
      const replay = manifest.scenes.slice(0, sc.index).flatMap((s) => s.actions);
      const launch = manifest.target.launch;
      const managedPorts = [...new Set([...launch.expectedPorts, ...(manifest.target.port ? [manifest.target.port] : [])])];
      const app = await startTargetApp({
        explicitUrl: manifest.target.explicitUrl,
        launch,
        repoRoot: manifest.target.repoRoot,
        port: manifest.target.port,
        managedPorts,
      });
      try {
        const beat: StoryBeatPlan = { id: sc.id, title: sc.title, caption: sc.caption, targetGoal: `${sc.targetGoal}. Edit instruction: ${editPrompt}` };
        const record = await recordWebUi({
          url: app.appUrl,
          prompt: `${manifest.prompt}\nRE-SHOOT of this single step only. Instruction: ${editPrompt}`,
          uploadFiles: manifest.uploadFiles,
          requestedTheme: manifest.theme,
          beats: [beat],
          pacing: manifest.pacing,
          publicDir: manifest.publicDir,
          replay,
          stepBudget: Math.max(3, sc.actions.length + 2),
          quality: manifest.quality,
        });
        const dst = path.join(sessionDir, sc.clipFile);
        fs.copyFileSync(record.capturePath, dst);
        try { fs.unlinkSync(record.capturePath); } catch { /* ignore */ }
        sc.actions = record.actions;
        sc.requiredActions = [...new Set(record.actions.map((a) => a.kind))];
        sc.startUrl = record.states[0]?.url ?? sc.startUrl;
        sc.domSnapshot = record.states[0]?.snippet ?? sc.domSnapshot;
        manifest.record.stopReason = record.stopReason ?? manifest.record.stopReason;
      } finally {
        app.stop();
      }
    }
  } else if (!options.reRenderOnly) {
    throw new Error("Nothing to do: pass --edit-scene <n|id> --edit-prompt \"...\" and/or --re-render-only.");
  } else {
    log("Editor", "Re-render only: assembling saved clips with the current manifest.");
  }

  saveManifest(sessionDir, manifest);
  const rendered = await composeAndRender(
    sessionDir,
    manifest,
    baseProps,
    outPath,
    partialScene ? { scene: partialScene, prevProps: baseProps } : null,
  );
  saveManifest(sessionDir, manifest);
  if (rendered.partialFrames) log("Editor", `Partial render of frames ${rendered.partialFrames}; remaining frames copied untouched.`);
  log("Editor", `Done in ${elapsedSec(t0).toFixed(1)}s -> ${outPath}`);

  return {
    status: manifest.record.stopReason ? "stopped" : "ok",
    mp4Path: outPath,
    durationSec: rendered.durationSec,
    steps: manifest.record.steps,
    stopReason: manifest.record.stopReason,
    comment: manifest.record.stopReason,
    displayUrl: manifest.record.displayUrl,
    videoTitle: manifest.videoTitle,
    productName: manifest.target.launch.productName,
    uploadNames: manifest.uploadFiles.map((u) => path.basename(u)),
    elapsedSec: Number(elapsedSec(t0).toFixed(1)),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Main pipeline (programmatic + CLI entry)                            */
/* ------------------------------------------------------------------ */

function resolveUploadPaths(raw: string[], repoRoot: string): string[] {
  const resolved: string[] = [];
  for (const item of raw) {
    const candidates = path.isAbsolute(item) ? [item] : [path.resolve(repoRoot, item), path.resolve(item)];
    const found = candidates.find((c) => {
      try { return fs.existsSync(c) && fs.statSync(c).isFile(); } catch { return false; }
    });
    if (found) resolved.push(found);
    else log("Upload", `Ignoring missing upload file: ${item}`);
  }
  return resolved;
}

export async function runPipeline(options: PipelineOptions = {}): Promise<PipelineResult> {
  if (options.reRenderOnly || (options.editScene !== undefined && options.editScene !== null && String(options.editScene) !== "")) {
    return runEdit(options);
  }

  const startedAt = new Date().toISOString();
  const pipelineStart = Date.now();
  const promptText = (options.prompt || "").trim() || DEFAULT_PROMPT;
  const theme = options.theme || "auto";
  const publicDir = path.resolve(options.publicDir || "public");
  const outPath = path.resolve(options.outPath || "out/demo.mp4");

  log("AI Video Director", "Starting autonomous prompt-to-video pipeline (FFmpeg, zero-audio) …");

  llmOverrides = {
    model: options.model ?? null,
    baseUrl: options.baseUrl ?? null,
    apiKey: options.apiKey ?? null,
  };

  const llm = getLlmClient();
  if (!llm) {
    throw new Error(
      "No LLM provider configured. Pass model/baseUrl/apiKey or set LLM_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY.",
    );
  }
  log("LLM", `Model "${llm.model}" via ${llm.baseURL}`);
  await ensureOllamaReady(llm.baseURL, llm.model);

  // Small local models need minutes to draw an SVG and rarely do it well: default them to the fast "motif" mode.
  const backdropMode: BackdropMode = options.backdropMode ? normalizeBackdropMode(options.backdropMode) : isLocalEndpoint(llm.baseURL) ? "motif" : "auto";
  log("Backdrop", `Mode: ${backdropMode}${options.backdropMode ? "" : " (default for this endpoint)"}`);

  const explicitUrl = (options.url || "").trim() || null;
  const requestedTarget = (options.filePath || "").trim() || null;

  let repoRoot = process.cwd();
  let targetFile: string | null = null;
  let study: RepoStudy;

  if (requestedTarget) {
    const absoluteTarget = path.isAbsolute(requestedTarget) ? requestedTarget : path.resolve(requestedTarget);
    if (!fs.existsSync(absoluteTarget)) throw new Error(`Path not found: ${absoluteTarget}`);
    repoRoot = findRepoRoot(absoluteTarget);
    targetFile = fs.statSync(absoluteTarget).isFile() ? absoluteTarget : null;
    study = collectRepoStudy(repoRoot, targetFile);
    log("Repo Study", `Root: ${repoRoot} (${study.filesScanned} paths, ${study.keyFiles.length} key files)`);
  } else if (explicitUrl) {
    let host = "web-app";
    try { host = new URL(explicitUrl).hostname || host; } catch { /* ignore */ }
    study = { root: process.cwd(), name: host, readme: "", tree: "", keyFiles: [], filesScanned: 0 };
    log("Repo Study", "URL mode: skipping repository scan (app is already running).");
  } else {
    throw new Error("Provide a project path (filePath/repoPath/file) or an already running app URL.");
  }

  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const { launch, scenario } = await askAiToPlanEverything(study, targetFile, promptText, publicDir, backdropMode);
  if (options.launchCommand && options.launchCommand.trim()) launch.launchCommand = options.launchCommand.trim();
  const managedPorts = [...new Set([...launch.expectedPorts, ...(options.port ? [options.port] : [])])];
  const uploads = resolveUploadPaths(options.uploadFiles || [], repoRoot);

  const app = await startTargetApp({ explicitUrl, launch, repoRoot, port: options.port ?? null, managedPorts });

  try {
    const record = await recordWebUi({
      url: app.appUrl,
      prompt: promptText,
      uploadFiles: uploads,
      requestedTheme: theme,
      beats: scenario.beats,
      pacing: scenario.pacing,
      publicDir,
      stepBudget: options.maxSteps,
      quality: options.quality as number | undefined,
    });

    app.stop();

    const sourceCode = targetFile ? readText(targetFile, 8000) : "";
    const highlightedHtml = await codeToHtml(sourceCode || "// project", {
      lang: "text",
      theme: scenario.artDirection.isDark ? "github-dark" : "github-light",
    }).catch(() => "");

    // Persist the run as a session: manifest + isolated per-scene clips (continuous slices of one capture).
    const sessionId = newSessionId();
    const sessionDir = path.join(SESSIONS_ROOT(), sessionId);
    fs.mkdirSync(path.join(sessionDir, "clips"), { recursive: true });

    const planned = planScenes(record, scenario.beats);
    const capturePath = record.capturePath;
    const usedIds = new Set<string>();
    const scenes: SceneManifestEntry[] = planned.map((p, i) => {
      let id = p.beat.id || `scene_${i + 1}`;
      if (usedIds.has(id)) id = `${id}_${i + 1}`;
      usedIds.add(id);
      const file = clipName(i);
      encodeClip(capturePath, p.start, p.end, path.join(sessionDir, "clips", file));
      return {
        id,
        index: i,
        title: p.beat.title,
        caption: p.beat.caption,
        targetGoal: p.beat.targetGoal,
        requiredActions: [...new Set(p.actions.map((a) => a.kind))],
        startSec: 0,
        endSec: 0,
        durationSec: 0,
        clipFile: `clips/${file}`,
        startUrl: p.startUrl,
        domSnapshot: p.domSnapshot,
        actions: p.actions,
      };
    });
    log("Scenes", `Saved ${scenes.length} scene clip(s) to ${path.join(sessionDir, "clips")}`);
    try { fs.unlinkSync(capturePath); } catch { /* intermediate capture is no longer needed */ }

    const manifest: SessionManifest = {
      version: 2,
      id: sessionId,
      createdAt: startedAt,
      updatedAt: startedAt,
      prompt: promptText,
      theme,
      uploadFiles: uploads,
      llm: { model: llm.model, baseUrl: llm.baseURL },
      target: { explicitUrl, filePath: targetFile, repoRoot, port: options.port ?? null, launch },
      publicDir,
      outPath,
      videoTitle: scenario.videoTitle,
      introLine: scenario.introLine,
      outroLine: scenario.outroLine,
      introSec: formatTimings(normalizeFormat(options.format)).introSec,
      outroSec: formatTimings(normalizeFormat(options.format)).outroSec,
      quality: normalizeQuality(options.quality),
      backdropMode,
      format: normalizeFormat(options.format),
      artDirection: scenario.artDirection,
      pacing: scenario.pacing,
      record: {
        displayUrl: record.displayUrl,
        uploadName: record.uploadName,
        siteBg: record.siteBg,
        detectedTheme: record.detectedTheme,
        effectiveTheme: record.effectiveTheme,
        stopReason: record.stopReason,
        steps: record.steps,
      },
      scenes,
    };

    const baseProps: Record<string, any> = {
      uiEvents: record.uiEvents,
      filesScanned: study.filesScanned,
      fileName: targetFile ? path.basename(targetFile) : study.name,
      repoName: launch.productName,
      repoSummary: launch.summary,
      executionTime: elapsedSec(pipelineStart).toFixed(1),
      terminalOutput: cleanAnsi(app.output()).slice(-10000),
      code: sourceCode,
      highlightedHtml,
      stats: { items: null, findings: null, score: null },
    };

    saveManifest(sessionDir, manifest);
    const rendered = options.noRender
      ? { durationSec: record.durationSec, uiUsedSec: record.durationSec }
      : await composeAndRender(sessionDir, manifest, baseProps, outPath);
    if (options.noRender) log("AI Video Director", "Render skipped (--no-render); session saved with scene clips.");
    saveManifest(sessionDir, manifest);

    const stopReason = record.stopReason;
    if (stopReason) log("AI Video Director", `Capture stopped early: ${stopReason}`);
    log("AI Video Director", `Session saved: ${sessionDir}`);
    log("AI Video Director", `Finished in ${elapsedSec(pipelineStart).toFixed(1)}s -> ${outPath}`);

    return {
      status: stopReason ? "stopped" : "ok",
      mp4Path: outPath,
      durationSec: rendered.durationSec,
      steps: record.steps,
      stopReason,
      comment: stopReason,
      displayUrl: record.displayUrl,
      videoTitle: scenario.videoTitle,
      productName: launch.productName,
      uploadNames: uploads.map((u) => path.basename(u)),
      elapsedSec: Number(elapsedSec(pipelineStart).toFixed(1)),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } finally {
    app.stop();
  }
}

async function cliMain() {
  const config = parseCli(process.argv.slice(2));
  const editMode = config.reRenderOnly || config.editScene !== null;
  if (!editMode && !config.filePath && !config.url) {
    console.error(
      "Usage: npx ts-node scripts/demo-pipeline.ts --file <repo-or-file> [--url <app-url>] [--prompt <text>] " +
      "[--upload <file>]... [--model <name>] [--base-url <url>] [--api-key <key>] [--theme auto|dark|light] [--port <n>]\n" +
      "Edit: --project-dir <session> | --session <id>  --edit-scene <n|id> --edit-prompt \"...\"  [--re-render-only]",
    );
    process.exitCode = 1;
    return;
  }

  const result = await runPipeline({
    prompt: config.prompt || (editMode ? "" : DEFAULT_PROMPT),
    filePath: config.filePath,
    url: config.url,
    port: config.port,
    theme: config.theme,
    uploadFiles: config.uploadFiles,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    outPath: config.outPath || undefined,
    projectDir: config.projectDir,
    session: config.session,
    editScene: config.editScene,
    editPrompt: config.editPrompt,
    reRenderOnly: config.reRenderOnly,
    maxSteps: config.maxSteps ?? undefined,
    noRender: config.noRender,
    quality: config.quality ?? undefined,
    backdropMode: config.backdropMode ?? undefined,
    format: config.format ?? undefined,
    launchCommand: config.launchCommand ?? undefined,
  });

  console.log(`[Result] status=${result.status} mp4=${result.mp4Path} duration=${result.durationSec}s`);
  if (result.steps.length > 0) console.log(`[Result] steps:\n${result.steps.join("\n")}`);
  if (result.stopReason) console.log(`[Result] stopReason: ${result.stopReason}`);
}

if (require.main === module) {
  cliMain().catch((error) => {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  });
}