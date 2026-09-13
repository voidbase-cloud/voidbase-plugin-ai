// The ai plugin's persistent half: conversations and messages as records of the signed-in caller, the routes that
// create and append them over the same loop as /api/ai/chat, and the streamed final answer. The routes run against
// a scripted fake AI binding and in-memory rows; one instance on bun:sqlite proves the collections, the cascade and
// the /api/plugins field for real.
import { describe, expect, test } from "bun:test";
import { migrateDatabase } from "@voidbase-cloud/voidbase/testing";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { d1 } from "@voidbase-cloud/voidbase/testing";
import { provideAuthLookup } from "@voidbase-cloud/voidbase/testing";
import { insertCollection } from "@voidbase-cloud/voidbase/testing";
import { invalidateCollections, listCollections, type Collection } from "@voidbase-cloud/voidbase/testing";
import { createCollection } from "@voidbase-cloud/voidbase/testing";
import { systemCollections } from "@voidbase-cloud/voidbase/testing";
import { ApiError } from "@voidbase-cloud/voidbase/testing";
import { createKernel, load, runBootstraps } from "@voidbase-cloud/voidbase/testing";
import { AI_CONVERSATIONS, AI_MESSAGES, aiRoute, aiWith, DEFAULT_MODEL, deltasOf, HISTORY, NOT_BOUND, RATE, TITLE_LENGTH, titleOf, type AiCollection, type AiRows } from "./support";
import { auth, provider } from "@voidbase-cloud/voidbase/testing";
import { openapiWith } from "@voidbase-cloud/voidbase/testing";
// mcp provides mcp@1, which the ai plugin builds its tools on
import { mcpWith } from "./mcp";
import { ensureSettingsRow, invalidateSettings } from "@voidbase-cloud/voidbase/testing";
import type { AppEnv, AuthRecord, Bindings, Row } from "@voidbase-cloud/voidbase/testing";


const f = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ id: `f_${name}`, name, type, system: false, hidden: false, presentable: false, required: false, help: "", ...extra });
const collection = (name: string, type: Collection["type"], rules: Partial<Pick<Collection, "listRule" | "viewRule" | "createRule" | "updateRule" | "deleteRule">>, fields: Record<string, unknown>[], system = false): Collection =>
  ({ id: `c_${name}`, name, type, system, fields: fields as Collection["fields"], indexes: [], options: {}, created: "", updated: "", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules }) as Collection;
const AUTH_FIELDS = [f("password", "password", { system: true, hidden: true, required: true }), f("tokenKey", "text", { system: true, hidden: true, required: true }), f("email", "email", { system: true, required: true }), f("emailVisibility", "bool", { system: true }), f("verified", "bool", { system: true })];
const COLLECTIONS: Collection[] = [
  collection("_superusers", "auth", {}, [f("id", "text", { primaryKey: true, system: true }), ...AUTH_FIELDS], true),
  collection("users", "auth", { listRule: "id = @request.auth.id", viewRule: "id = @request.auth.id", createRule: "", updateRule: "id = @request.auth.id", deleteRule: "id = @request.auth.id" }, [f("id", "text", { primaryKey: true, system: true }), ...AUTH_FIELDS]),
  collection("posts", "base", { listRule: "", viewRule: "", createRule: '@request.auth.id != ""', updateRule: "author = @request.auth.id", deleteRule: null }, [f("id", "text", { primaryKey: true, system: true }), f("title", "text", { required: true })]),
];
const ada = { collection: COLLECTIONS[1], row: { id: "u1" } } as AuthRecord;
const bob = { collection: COLLECTIONS[1], row: { id: "u2" } } as AuthRecord;
const TOKENS: Record<string, AuthRecord> = { "ada-token": ada, "bob-token": bob };

type AiInput = { messages: { role: string; content: string; name?: string }[]; tools?: { function: { name: string } }[]; stream?: boolean };

/** a fake AI binding scripted per test: each run() answers the next script entry (a function of the input, or a value) */
function fakeAI(script: (unknown | ((input: AiInput, model: string) => unknown))[]) {
  const runs: { model: string; input: AiInput }[] = [];
  return {
    runs,
    async run(model: string, input: unknown) {
      runs.push({ model, input: input as AiInput });
      const next = script.shift();
      if (next === undefined) throw new Error("the fake AI has no answer left");
      return typeof next === "function" ? (next as (i: AiInput, m: string) => unknown)(input as AiInput, model) : next;
    },
  };
}

/** what Workers AI streams: SSE chunks with `response`, then [DONE], as bytes */
const sseStream = (chunks: string[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    const enc = new TextEncoder();
    for (const chunk of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify({ response: chunk, p: "x" })}\n\n`));
    controller.enqueue(enc.encode("data: [DONE]\n\n"));
    controller.close();
  },
});

/** rows in memory, ordered as the D1 ones are; a deleted conversation takes its messages with it */
function memoryRows(seed: Partial<Record<AiCollection, Row[]>> = {}) {
  const tables: Record<AiCollection, Row[]> = { ai_conversations: [...(seed.ai_conversations ?? [])], ai_messages: [...(seed.ai_messages ?? [])] };
  const log: string[] = [];
  let n = tables.ai_conversations.length + tables.ai_messages.length, clock = 0;
  const rows: AiRows = {
    async get(c, id) { return tables[c].find((r) => r.id === id) ?? null; },
    async conversations(user, page, perPage) {
      const mine = tables.ai_conversations.filter((r) => r.owner === user).sort((a, b) => String(b.lastMessageAt ?? "").localeCompare(String(a.lastMessageAt ?? "")) || String(b.created).localeCompare(String(a.created)));
      return { items: mine.slice((page - 1) * perPage, page * perPage), totalItems: mine.length };
    },
    async messages(conversation, last) { const all = tables.ai_messages.filter((r) => r.conversation === conversation); return last ? all.slice(-last) : all; },
    async create(c, values) { const row: Row = { id: `${c === AI_MESSAGES ? "m" : "c"}${++n}`, created: String(++clock).padStart(6, "0"), ...values }; tables[c].push(row); log.push(`create ${c} ${String(row.id)}`); return row; },
    async update(c, id, values) { const row = tables[c].find((r) => r.id === id); if (!row) throw new Error(`no ${c} ${id}`); Object.assign(row, values); log.push(`update ${c} ${id}`); return row; },
    async delete(c, id) { tables[c] = tables[c].filter((r) => r.id !== id); if (c === AI_CONVERSATIONS) tables.ai_messages = tables.ai_messages.filter((r) => r.conversation !== id); log.push(`delete ${c} ${id}`); },
  };
  return { rows, tables, log };
}

async function appWith(opts: { ai?: ReturnType<typeof fakeAI>; rows?: AiRows; now?: () => number } = {}) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("auth", TOKENS[c.req.header("authorization") ?? ""] ?? null); await next(); });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ message: err.message }, err.status as 400) : c.json({ message: String(err) }, 500)));
  const seen: string[] = [];
  app.get("/api/collections/:c/records", async (c) => { seen.push(`${c.req.path} ${c.req.header("authorization") ?? ""}`); return c.json({ page: 1, perPage: 30, totalItems: 1, totalPages: 1, items: [{ id: "p1", title: "hello" }] }); });
  app.get("/api/health", (c) => c.json({ code: 200, message: "API is healthy.", data: {} }));
  const kernel = createKernel(app);
  const source = { collections: async () => COLLECTIONS, appName: async () => "Shop" };
  const { rows, tables, log } = opts.rows ? { rows: opts.rows, tables: undefined, log: undefined } : memoryRows();
  await load(kernel, [auth, openapiWith(source), mcpWith(source, "0.9.0"), aiWith(source, "0.9.0", opts.now ?? Date.now, () => rows)], "0.9.0");
  provideAuthLookup(() => provider);
  const env = { DB: {} as D1Database, STORAGE: {} as R2Bucket, ...(opts.ai ? { AI: opts.ai } : {}) } as unknown as Bindings;
  const call = async (method: string, path: string, body?: unknown, token = "") => {
    const r = await app.request(`http://shop.example${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: token } : {}) }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) }, env);
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
    return { status: r.status, headers: r.headers, text, json };
  };
  return { app, call, env, rows, tables, log, seen };
}

describe("anonymous callers get no persistence", () => {
  test("every conversation route answers 401; the stateless chat stays", async () => {
    const ai = fakeAI([{ response: "hi" }]);
    const { call } = await appWith({ ai });
    expect((await call("POST", "/api/ai/conversations", {})).status).toBe(401);
    expect((await call("GET", "/api/ai/conversations")).status).toBe(401);
    expect((await call("GET", "/api/ai/conversations/c1")).status).toBe(401);
    expect((await call("POST", "/api/ai/conversations/c1/messages", { content: "x" })).status).toBe(401);
    expect((await call("DELETE", "/api/ai/conversations/c1")).status).toBe(401);
    expect((await call("POST", "/api/ai/chat", { messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
    expect(ai.runs).toHaveLength(1);
  });

  test("without the binding the writes answer 503 and name the knob", async () => {
    const { call } = await appWith();
    expect((await call("POST", "/api/ai/conversations", {}, "ada-token")).json).toEqual({ message: NOT_BOUND });
    expect((await call("POST", "/api/ai/conversations/c1/messages", { content: "x" }, "ada-token")).status).toBe(503);
  });
});

describe("a conversation is a record of its user", () => {
  test("create: the caller's, tools on by default, the title cut to 60 chars; the body is checked", async () => {
    const { call, tables } = await appWith({ ai: fakeAI([]) });
    const r = await call("POST", "/api/ai/conversations", {}, "ada-token");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: "c1", owner: "u1", user: "u1", title: "", model: "", system: "", tools: true, lastMessageAt: "" });
    const long = "x".repeat(100);
    const r2 = await call("POST", "/api/ai/conversations", { title: `  ${long}`, model: " @cf/qwen/qwen3-30b-a3b-fp8 ", system: "Be terse.", tools: false }, "ada-token");
    expect(r2.json).toMatchObject({ title: "x".repeat(TITLE_LENGTH), model: "@cf/qwen/qwen3-30b-a3b-fp8", system: "Be terse.", tools: false });
    expect(tables!.ai_conversations).toHaveLength(2);
    expect((await call("POST", "/api/ai/conversations", { tools: "yes" }, "ada-token")).status).toBe(400);
    expect((await call("POST", "/api/ai/conversations", { title: 1 }, "ada-token")).json.message).toMatch(/title/i);
    expect((await call("POST", "/api/ai/conversations", "{nope", "ada-token")).status).toBe(400);
    expect(titleOf("  a\n b   c ")).toBe("a b c");
  });

  test("list: mine only, newest first by last message, paginated like records", async () => {
    const { rows } = memoryRows({ ai_conversations: [
      { id: "c1", owner: "u1", user: "u1", title: "old", created: "000001", lastMessageAt: "2026-09-01T00:00:00.000Z" },
      { id: "c2", owner: "u2", user: "u2", title: "bob's", created: "000002", lastMessageAt: "2026-09-05T00:00:00.000Z" },
      { id: "c3", owner: "u1", user: "u1", title: "new", created: "000003", lastMessageAt: "2026-09-03T00:00:00.000Z" },
      { id: "c4", owner: "u1", user: "u1", title: "fresh", created: "000004", lastMessageAt: "" },
    ] });
    const { call } = await appWith({ ai: fakeAI([]), rows });
    const r = await call("GET", "/api/ai/conversations", undefined, "ada-token");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ page: 1, perPage: 30, totalItems: 3, totalPages: 1 });
    expect((r.json.items as Row[]).map((c) => c.id)).toEqual(["c3", "c1", "c4"]);
    const page2 = await call("GET", "/api/ai/conversations?page=2&perPage=2", undefined, "ada-token");
    expect(page2.json).toMatchObject({ page: 2, perPage: 2, totalItems: 3, totalPages: 2 });
    expect((page2.json.items as Row[]).map((c) => c.id)).toEqual(["c4"]);
    expect((await call("GET", "/api/ai/conversations", undefined, "bob-token")).json.totalItems).toBe(1);
  });

  test("get: the conversation with its messages oldest first; somebody else's is a 404", async () => {
    const { rows } = memoryRows({
      ai_conversations: [{ id: "c1", owner: "u1", user: "u1", title: "t", created: "000001" }],
      ai_messages: [{ id: "m1", conversation: "c1", role: "user", content: "hi", created: "000002" }, { id: "m2", conversation: "c1", role: "assistant", content: "hello", created: "000003" }, { id: "m9", conversation: "other", role: "user", content: "no", created: "000004" }],
    });
    const { call } = await appWith({ ai: fakeAI([]), rows });
    const r = await call("GET", "/api/ai/conversations/c1", undefined, "ada-token");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: "c1", title: "t" });
    expect((r.json.messages as Row[]).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect((await call("GET", "/api/ai/conversations/c1", undefined, "bob-token")).status).toBe(404);
    expect((await call("GET", "/api/ai/conversations/nope", undefined, "ada-token")).status).toBe(404);
  });

  test("delete: gone with its messages; somebody else's is a 404 and stays", async () => {
    const { rows, tables } = memoryRows({
      ai_conversations: [{ id: "c1", owner: "u1", user: "u1", created: "000001" }, { id: "c2", owner: "u2", user: "u2", created: "000002" }],
      ai_messages: [{ id: "m1", conversation: "c1", role: "user", content: "hi", created: "000003" }, { id: "m2", conversation: "c2", role: "user", content: "bob", created: "000004" }],
    });
    const { call } = await appWith({ ai: fakeAI([]), rows });
    expect((await call("DELETE", "/api/ai/conversations/c2", undefined, "ada-token")).status).toBe(404);
    expect((await call("DELETE", "/api/ai/conversations/c1", undefined, "ada-token")).status).toBe(204);
    expect(tables.ai_conversations.map((c) => c.id)).toEqual(["c2"]);
    expect(tables.ai_messages.map((m) => m.id)).toEqual(["m2"]);
    expect((await call("GET", "/api/ai/conversations/c1", undefined, "ada-token")).status).toBe(404);
  });
});

describe("appending a message runs the loop over the history", () => {
  test("the user message is stored first, the model sees the prompts and the history, the reply lands with its steps and tokens; the title comes from the first user message", async () => {
    let t = Date.UTC(2026, 8, 11, 12, 0, 0);
    const { rows, tables, log } = memoryRows({
      ai_conversations: [{ id: "c1", owner: "u1", user: "u1", title: "", model: "", system: "Answer in French.", tools: true, created: "000001" }],
      ai_messages: [{ id: "m1", conversation: "c1", role: "user", content: "  What is   in the shop?  ", created: "000002" }, { id: "m2", conversation: "c1", role: "assistant", content: "Posts.", steps: [], created: "000003" }],
    });
    const ai = fakeAI([
      (input: AiInput) => {
        expect(input.messages.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "user"]);
        expect(input.messages[0]!.content).toContain("users collection (id u1)");
        expect(input.messages[1]).toEqual({ role: "system", content: "Answer in French." });
        expect(input.messages[4]).toEqual({ role: "user", content: "how many posts?" });
        expect((input.tools ?? []).map((t) => t.function.name)).toContain("posts_list");
        return { response: "", tool_calls: [{ name: "posts_list", arguments: { perPage: 1 } }], usage: { total_tokens: 10 } };
      },
      (input: AiInput) => {
        expect(input.messages.at(-1)!.role).toBe("tool");
        return { response: "Un seul post.", usage: { total_tokens: 15 } };
      },
    ]);
    const { call, seen } = await appWith({ ai, rows, now: () => t });
    const r = await call("POST", "/api/ai/conversations/c1/messages", { content: "how many posts?" }, "ada-token");
    expect(r.status).toBe(200);
    expect(r.json.model).toBe(DEFAULT_MODEL);
    expect(r.json.message).toMatchObject({ id: "m5", conversation: "c1", role: "assistant", content: "Un seul post.", tokens: 25 });
    expect(r.json.steps).toEqual([{ tool: "posts_list", arguments: { perPage: 1 }, result: expect.stringContaining('"totalItems":1') }]);
    expect((r.json.message as Row).steps).toEqual(r.json.steps);
    expect(r.json.conversation).toMatchObject({ id: "c1", title: "What is in the shop?", lastMessageAt: "2026-09-11T12:00:00.000Z" });
    expect(seen).toEqual(["/api/collections/posts/records ada-token"]);
    expect(tables.ai_messages.map((m) => `${String(m.role)}:${String(m.content)}`)).toEqual(["user:  What is   in the shop?  ", "assistant:Posts.", "user:how many posts?", "assistant:Un seul post."]);
    expect(log).toEqual(["create ai_messages m4", "create ai_messages m5", "update ai_conversations c1"]);
    // a second turn: the model sees both turns, the title stays
    t += 1000;
    const second = fakeAI([{ response: "Toujours un." }]);
    const { call: call2 } = await appWith({ ai: second, rows, now: () => t });
    const r2 = await call2("POST", "/api/ai/conversations/c1/messages", { content: "still?", maxSteps: 0 }, "ada-token");
    expect(second.runs[0]!.input.messages.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "user", "assistant", "user"]);
    expect(r2.json.conversation).toMatchObject({ title: "What is in the shop?", lastMessageAt: "2026-09-11T12:00:01.000Z" });
    expect((r2.json.message as Row).tokens).toBeUndefined();
  });

  test("the conversation's model and tools: false win; the history is the last 40 messages; the body is checked", async () => {
    const messages: Row[] = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, conversation: "c1", role: i % 2 ? "assistant" : "user", content: `n${i}`, created: String(i).padStart(6, "0") }));
    const { rows } = memoryRows({ ai_conversations: [{ id: "c1", owner: "u1", user: "u1", title: "t", model: "@cf/qwen/qwen3-30b-a3b-fp8", system: "", tools: false, created: "000000" }], ai_messages: messages });
    const ai = fakeAI([{ response: "ok" }]);
    const { call } = await appWith({ ai, rows });
    const r = await call("POST", "/api/ai/conversations/c1/messages", { content: "last" }, "ada-token");
    expect(r.status).toBe(200);
    expect(r.json.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(ai.runs[0]!.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(ai.runs[0]!.input.tools).toBeUndefined();
    const sent = ai.runs[0]!.input.messages;
    expect(sent).toHaveLength(1 + HISTORY);
    expect(sent[1]!.content).toBe("n6");
    expect(sent.at(-1)!.content).toBe("last");
    expect((await call("POST", "/api/ai/conversations/c1/messages", { content: "  " }, "ada-token")).status).toBe(400);
    expect((await call("POST", "/api/ai/conversations/c1/messages", { content: "x", maxSteps: 21 }, "ada-token")).json.message).toMatch(/maxSteps/i);
    expect((await call("POST", "/api/ai/conversations/c1/messages", { content: "x", stream: "yes" }, "ada-token")).json.message).toMatch(/stream/i);
    expect((await call("POST", "/api/ai/conversations/c9/messages", { content: "x" }, "ada-token")).status).toBe(404);
    expect(ai.runs).toHaveLength(1);
  });

  test("the cap is the chat's: 30 a minute per caller across both routes", async () => {
    const { rows } = memoryRows({ ai_conversations: [{ id: "c1", owner: "u1", user: "u1", title: "t", tools: false, created: "000000" }] });
    const ai = fakeAI(Array.from({ length: 40 }, () => ({ response: "ok" })));
    const { call } = await appWith({ ai, rows, now: () => 1_000_000 });
    for (let i = 0; i < RATE.limit - 1; i++) expect((await call("POST", "/api/ai/chat", { messages: [{ role: "user", content: "hi" }] }, "ada-token")).status).toBe(200);
    expect((await call("POST", "/api/ai/conversations/c1/messages", { content: "one more" }, "ada-token")).status).toBe(200);
    const over = await call("POST", "/api/ai/conversations/c1/messages", { content: "too many" }, "ada-token");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect((await call("POST", "/api/ai/conversations/c1/messages", { content: "bob's first" }, "bob-token")).status).toBe(404);
  });
});

describe("stream: true streams the final answer", () => {
  const events = (text: string) => text.split("\n\n").filter(Boolean).map((line) => { expect(line.startsWith("data: ")).toBe(true); return JSON.parse(line.slice(6)) as Record<string, unknown>; });

  test("the tool steps run first, then one last call without tools streams; the full text is stored before done", async () => {
    const { rows, tables } = memoryRows({ ai_conversations: [{ id: "c1", owner: "u1", user: "u1", title: "", tools: true, created: "000000" }] });
    const ai = fakeAI([
      { response: "", tool_calls: [{ name: "posts_list", arguments: {} }] },
      { response: "one post (not streamed)" },
      (input: AiInput) => { expect(input.stream).toBe(true); expect(input.tools).toBeUndefined(); expect(input.messages.at(-1)!.role).toBe("tool"); return sseStream(["There ", "is one ", "post."]); },
    ]);
    const { call } = await appWith({ ai, rows });
    const r = await call("POST", "/api/ai/conversations/c1/messages", { content: "count the posts", stream: true }, "ada-token");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const got = events(r.text);
    expect(got.slice(0, 3)).toEqual([{ delta: "There " }, { delta: "is one " }, { delta: "post." }]);
    expect(got).toHaveLength(4);
    const done = got[3]!;
    expect(done.done).toBe(true);
    expect(done.model).toBe(DEFAULT_MODEL);
    expect(done.steps).toEqual([{ tool: "posts_list", arguments: {}, result: expect.stringContaining("p1") }]);
    expect(done.message).toMatchObject({ role: "assistant", content: "There is one post.", steps: done.steps });
    expect(done.conversation).toMatchObject({ id: "c1", title: "count the posts" });
    expect(tables.ai_messages.map((m) => String(m.content))).toEqual(["count the posts", "There is one post."]);
    expect(ai.runs).toHaveLength(3);
  });

  test("without tools the streamed call is the only one; an answer that did not stream is one delta; the error is an event", async () => {
    const { rows } = memoryRows({ ai_conversations: [{ id: "c1", owner: "u1", user: "u1", title: "t", tools: false, created: "000000" }] });
    const ai = fakeAI([sseStream(["a", "b"]), { response: "whole" }, () => { throw new Error("model down"); }]);
    const { call } = await appWith({ ai, rows });
    expect(events((await call("POST", "/api/ai/conversations/c1/messages", { content: "x", stream: true }, "ada-token")).text).map((e) => e.delta ?? e.done)).toEqual(["a", "b", true]);
    expect(ai.runs[0]!.input.stream).toBe(true);
    expect(ai.runs[0]!.input.tools).toBeUndefined();
    expect(events((await call("POST", "/api/ai/conversations/c1/messages", { content: "y", stream: true }, "ada-token")).text)[0]).toEqual({ delta: "whole" });
    expect(events((await call("POST", "/api/ai/conversations/c1/messages", { content: "z", stream: true }, "ada-token")).text)).toEqual([{ error: "model down" }]);
  });

  test("deltasOf reads the SSE chunks across byte boundaries and ignores what is not one", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode(`data: {"response":"Hé"}\n\ndata: {"response":""}\n\n: comment\n\ndata: {"other":1}\n\ndata: not json\n\ndata: {"response":"llo"}\n\ndata: [DONE]\n\n`);
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); } });
    const out: string[] = [];
    for await (const d of deltasOf(stream)) out.push(d);
    expect(out).toEqual(["Hé", "llo"]);
    expect(await Array.fromAsync(deltasOf("plain"))).toEqual(["plain"]);
    expect(await Array.fromAsync(deltasOf({ response: "obj" }))).toEqual(["obj"]);
    expect(await Array.fromAsync(deltasOf(null))).toEqual([]);
  });
});

describe("on an instance: the collections, the rows through the records service, the cascade", () => {
  /** the schema the migrations create, the system collections, the settings row, a users collection with one user */
  async function instance() {
    const sqlite = new Database(":memory:");
    migrateDatabase(sqlite);
    const db = d1(sqlite);
    invalidateCollections(); invalidateSettings();
    for (const c of systemCollections()) await insertCollection(db, c);
    await ensureSettingsRow(db);
    const users = await createCollection(db, { name: "users", type: "auth", fields: [{ name: "name", type: "text" }] });
    sqlite.run("INSERT INTO users (id, password, tokenKey, email, name) VALUES ('u1', 'hash', 'tk', 'u@example.com', 'Una')");
    return { sqlite, db, users };
  }

  test("bootstrap creates ai_conversations and ai_messages only with the binding; /api/plugins says so; a turn is two rows and delete takes them", async () => {
    const { sqlite, db, users } = await instance();
    const app = new Hono<AppEnv>();
    const una = { collection: users, row: { id: "u1" } } as AuthRecord;
    app.use("*", async (c, next) => { c.set("auth", c.req.header("authorization") === "una" ? una : null); await next(); });
    app.onError((err, c) => (err instanceof ApiError ? c.json({ message: err.message, data: (err as ApiError & { data?: unknown }).data }, err.status as 400) : c.json({ message: String(err) }, 500)));
    const kernel = createKernel(app);
    const source = { collections: (env: Bindings) => listCollections(env.DB), appName: async () => "Shop" };
    await load(kernel, [auth, openapiWith(source), mcpWith(source, "0.9.0"), aiWith(source, "0.9.0", () => Date.UTC(2026, 8, 11))], "0.9.0");
    provideAuthLookup(() => provider);
    const storage = { list: async () => ({ objects: [], truncated: false }) } as unknown as R2Bucket;
    const bare = { DB: db, STORAGE: storage } as Bindings;
    await runBootstraps(kernel, bare);
    expect((await listCollections(db)).map((c) => c.name)).not.toContain(AI_CONVERSATIONS);
    expect(await aiRoute(bare)).toEqual({ via: "none" });

    const ai = fakeAI([{ response: "Bonjour.", usage: { total_tokens: 7 } }]);
    const env = { DB: db, STORAGE: storage, AI: ai } as unknown as Bindings;
    const fresh = createKernel(new Hono<AppEnv>());
    await load(fresh, [aiWith(source, "0.9.0")], "0.9.0");
    await runBootstraps(fresh, env);
    const names = (await listCollections(db)).map((c) => c.name);
    expect(names).toContain(AI_CONVERSATIONS);
    expect(names).toContain(AI_MESSAGES);
    const conversations = (await listCollections(db)).find((c) => c.name === AI_CONVERSATIONS)!;
    expect(conversations).toMatchObject({ listRule: "owner = @request.auth.id", deleteRule: "owner = @request.auth.id", createRule: null, updateRule: null });
    expect((conversations.fields as { name: string; collectionId?: string }[]).find((x) => x.name === "user")!.collectionId).toBe(users.id);
    expect((await listCollections(db)).find((c) => c.name === AI_MESSAGES)).toMatchObject({ listRule: "conversation.owner = @request.auth.id", viewRule: "conversation.owner = @request.auth.id" });
    expect(await aiRoute(env)).toEqual({ via: "workers-ai", model: DEFAULT_MODEL, conversations: true });
    // the collections cache is per isolate, and it holds ai_conversations right now: a route with no database must
    // not read it (in CI, 2026-09-11, the next test file asked with no database inside the cache's lifetime and
    // was told there were conversations)
    expect(await aiRoute({ ...env, DB: undefined } as typeof env)).toEqual({ via: "workers-ai", model: DEFAULT_MODEL, conversations: false });
    await runBootstraps(fresh, env); // a second time creates nothing
    expect((await listCollections(db)).filter((c) => c.name.startsWith("ai_"))).toHaveLength(2);

    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.request(`http://shop.example${path}`, { method, headers: { authorization: "una", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
      return { status: r.status, json: r.status === 204 ? {} : ((await r.json()) as Record<string, unknown>) };
    };
    const made = await call("POST", "/api/ai/conversations", { system: "Réponds en français.", tools: false });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ collectionName: AI_CONVERSATIONS, owner: "u1", user: "u1", tools: false, title: "" });
    const id = String(made.json.id);
    const turn = await call("POST", `/api/ai/conversations/${id}/messages`, { content: "Salut, ça va ?" });
    expect(turn.status).toBe(200);
    expect(turn.json.message).toMatchObject({ collectionName: AI_MESSAGES, conversation: id, role: "assistant", content: "Bonjour.", steps: [], tokens: 7 });
    expect(turn.json.conversation).toMatchObject({ id, title: "Salut, ça va ?", lastMessageAt: "2026-09-11 00:00:00.000Z" });
    expect(ai.runs[0]!.input.messages.map((m) => m.role)).toEqual(["system", "system", "user"]);
    const got = await call("GET", `/api/ai/conversations/${id}`);
    expect((got.json.messages as Row[]).map((m) => [m.role, m.content])).toEqual([["user", "Salut, ça va ?"], ["assistant", "Bonjour."]]);
    expect((got.json.messages as Row[])[1]!.steps).toEqual([]);
    const list = await call("GET", "/api/ai/conversations");
    expect(list.json).toMatchObject({ totalItems: 1, items: [{ id, title: "Salut, ça va ?" }] });
    expect(sqlite.query("SELECT COUNT(*) AS n FROM ai_messages").get()).toEqual({ n: 2 });
    expect((await call("DELETE", `/api/ai/conversations/${id}`)).status).toBe(204);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM ai_messages").get()).toEqual({ n: 0 });
    expect(sqlite.query("SELECT COUNT(*) AS n FROM ai_conversations").get()).toEqual({ n: 0 });
    sqlite.close();
  });
});
