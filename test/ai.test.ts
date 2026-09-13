// The ai plugin: a chat over the instance whose tools are the MCP server's tool list for the caller, run in process,
// against a scripted fake AI binding. No model, no database.
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { provideAuthLookup } from "@voidbase-cloud/voidbase/testing";
import { invalidateCollections, type Collection } from "@voidbase-cloud/voidbase/testing";
import { ApiError } from "@voidbase-cloud/voidbase/testing";
import { createKernel, load } from "@voidbase-cloud/voidbase/testing";
import { aiRoute, aiWith, DEFAULT_MODEL, NOT_BOUND, RATE, toolCallsOf } from "./support";
import { auth, provider } from "@voidbase-cloud/voidbase/testing";
import { openapiWith } from "@voidbase-cloud/voidbase/testing";
// mcp provides mcp@1, which the ai plugin builds its tools on
import { mcpWith } from "./mcp";
import type { AppEnv, AuthRecord, Bindings } from "@voidbase-cloud/voidbase/testing";

// the collections cache is per isolate, and other files in the same test process fill it; a test here must not
// answer from what another file's database left behind
beforeEach(() => invalidateCollections());

const f = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ id: `f_${name}`, name, type, system: false, hidden: false, presentable: false, required: false, help: "", ...extra });
const collection = (name: string, type: Collection["type"], rules: Partial<Pick<Collection, "listRule" | "viewRule" | "createRule" | "updateRule" | "deleteRule">>, fields: Record<string, unknown>[], system = false): Collection =>
  ({ id: `c_${name}`, name, type, system, fields: fields as Collection["fields"], indexes: [], options: {}, created: "", updated: "", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules }) as Collection;
const AUTH_FIELDS = [f("password", "password", { system: true, hidden: true, required: true }), f("tokenKey", "text", { system: true, hidden: true, required: true }), f("email", "email", { system: true, required: true }), f("emailVisibility", "bool", { system: true }), f("verified", "bool", { system: true })];
const COLLECTIONS: Collection[] = [
  collection("_superusers", "auth", {}, [f("id", "text", { primaryKey: true, system: true }), ...AUTH_FIELDS], true),
  collection("users", "auth", { listRule: "id = @request.auth.id", viewRule: "id = @request.auth.id", createRule: "", updateRule: "id = @request.auth.id", deleteRule: "id = @request.auth.id" }, [f("id", "text", { primaryKey: true, system: true }), ...AUTH_FIELDS]),
  collection("posts", "base", { listRule: "", viewRule: "", createRule: '@request.auth.id != ""', updateRule: "author = @request.auth.id", deleteRule: null }, [f("id", "text", { primaryKey: true, system: true }), f("title", "text", { required: true })]),
  collection("secrets", "base", {}, [f("id", "text", { primaryKey: true, system: true }), f("value", "text")]),
];
const superuser = { collection: COLLECTIONS[0], row: { id: "s1" } } as AuthRecord;
const user = { collection: COLLECTIONS[1], row: { id: "u1" } } as AuthRecord;
const TOKENS: Record<string, AuthRecord> = { "su-token": superuser, "user-token": user };

type AiInput = { messages: { role: string; content: string; name?: string }[]; tools?: { type: string; function: { name: string; description: string; parameters: { type: string; properties: Record<string, unknown>; required: string[] } } }[] };
type Seen = { method: string; path: string; query: Record<string, string>; body: unknown; authorization: string | undefined };

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

async function appWith(opts: { ai?: ReturnType<typeof fakeAI>; now?: () => number; model?: string } = {}) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("auth", TOKENS[c.req.header("authorization") ?? ""] ?? null); await next(); });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ message: err.message }, err.status as 400) : c.json({ message: String(err) }, 500)));
  const seen: Seen[] = [];
  const record = async (c: { req: { method: string; path: string; query(): Record<string, string>; header(n: string): string | undefined; json(): Promise<unknown> } }) => {
    let body: unknown = null; try { body = await c.req.json(); } catch { body = null; }
    seen.push({ method: c.req.method, path: c.req.path, query: c.req.query(), body, authorization: c.req.header("authorization") });
  };
  app.get("/api/collections/:c/records", async (c) => { await record(c); return c.json({ page: 1, perPage: 30, totalItems: 2, totalPages: 1, items: [{ id: "p1", title: "hello" }, { id: "p2", title: "world" }] }); });
  app.get("/api/collections/:c/records/:id", async (c) => { await record(c); return c.req.param("id") === "missing" ? c.json({ status: 404, message: "The requested resource wasn't found.", data: {} }, 404) : c.json({ id: c.req.param("id"), title: "x".repeat(600) }); });
  app.post("/api/collections/:c/records", async (c) => { await record(c); return c.json({ id: "new1", title: "made" }); });
  app.get("/api/health", (c) => c.json({ code: 200, message: "API is healthy.", data: {} }));
  const kernel = createKernel(app);
  const source = { collections: async () => COLLECTIONS, appName: async () => "Shop" };
  await load(kernel, [auth, openapiWith(source), mcpWith(source, "0.9.0"), aiWith(source, "0.9.0", opts.now ?? Date.now)], "0.9.0");
  provideAuthLookup(() => provider);
  const env = { DB: {} as D1Database, STORAGE: {} as R2Bucket, ...(opts.ai ? { AI: opts.ai } : {}), ...(opts.model ? { VOIDBASE_AI: opts.model } : {}) } as unknown as Bindings;
  const chat = async (body: unknown, token = "", headers: Record<string, string> = {}) => {
    const r = await app.request("http://shop.example/api/ai/chat", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, env);
    return { status: r.status, headers: r.headers, json: (await r.json()) as { message: { role: string; content: string } | string; steps?: { tool: string; arguments: Record<string, unknown>; result: string }[]; model?: string } };
  };
  return { app, chat, seen, env };
}
const ask = (content: string, extra: Record<string, unknown> = {}) => ({ messages: [{ role: "user", content }], ...extra });
const toolNames = (input: AiInput) => (input.tools ?? []).map((t) => t.function.name).sort();

describe("without the binding", () => {
  test("the route answers 503 and names the knob; /api/plugins reports via none", async () => {
    const { chat, env } = await appWith();
    const r = await chat(ask("hi"));
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ message: NOT_BOUND });
    expect(NOT_BOUND).toContain("VOIDBASE_AI=1");
    expect(await aiRoute(env)).toEqual({ via: "none" });
  });

  test("with the binding /api/plugins names the model: the default, or the knob's; conversations false until the collections exist", async () => {
    expect(await aiRoute({ AI: fakeAI([]) } as unknown as Bindings)).toEqual({ via: "workers-ai", model: DEFAULT_MODEL, conversations: false });
    expect(await aiRoute({ AI: fakeAI([]), VOIDBASE_AI: "1" } as unknown as Bindings)).toEqual({ via: "workers-ai", model: DEFAULT_MODEL, conversations: false });
    expect(await aiRoute({ AI: fakeAI([]), VOIDBASE_AI: "@cf/qwen/qwen3-30b-a3b-fp8" } as unknown as Bindings)).toEqual({ via: "workers-ai", model: "@cf/qwen/qwen3-30b-a3b-fp8", conversations: false });
  });
});

describe("the tool list follows the caller's scope", () => {
  test("anonymous: the public API only, in Workers AI's function shape; the system prompt names the instance and the caller", async () => {
    const ai = fakeAI([{ response: "Hello from Shop." }]);
    const { chat } = await appWith({ ai });
    const r = await chat(ask("hi"));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ message: { role: "assistant", content: "Hello from Shop." }, steps: [], model: DEFAULT_MODEL });
    expect(ai.runs).toHaveLength(1);
    const input = ai.runs[0]!.input;
    expect(toolNames(input)).toEqual(["_superusers_auth_with_password", "posts_get", "posts_list", "users_auth_with_password", "users_create", "voidbase_describe", "voidbase_health"]);
    const list = input.tools!.find((t) => t.function.name === "posts_list")!;
    expect(list.type).toBe("function");
    expect(list.function.description).toBe("List posts records. Public: anyone may call this.");
    expect(list.function.parameters.type).toBe("object");
    expect(Object.keys(list.function.parameters.properties)).toEqual(["page", "perPage", "sort", "filter", "expand", "fields", "skipTotal"]);
    expect(list.function.parameters.required).toEqual([]);
    expect(input.tools!.find((t) => t.function.name === "posts_get")!.function.parameters.required).toEqual(["id"]);
    expect(input.messages[0]!.role).toBe("system");
    expect(input.messages[0]!.content).toContain('"Shop"');
    expect(input.messages[0]!.content).toContain("anonymous");
    expect(input.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("a superuser: everything, the locked collection included; the prompt says superuser", async () => {
    const ai = fakeAI([{ response: "ok" }]);
    const { chat } = await appWith({ ai });
    await chat(ask("hi"), "su-token");
    const names = toolNames(ai.runs[0]!.input);
    expect(names.filter((n) => n.startsWith("secrets_"))).toEqual(["secrets_create", "secrets_delete", "secrets_get", "secrets_list", "secrets_update"]);
    expect(names).toContain("posts_delete");
    expect(ai.runs[0]!.input.messages[0]!.content).toContain("superuser");
  });

  test("a user: the gated tools, not the locked ones; tools: false sends none", async () => {
    const ai = fakeAI([{ response: "ok" }, { response: "no tools" }]);
    const { chat } = await appWith({ ai });
    await chat(ask("hi"), "user-token");
    const names = toolNames(ai.runs[0]!.input);
    expect(names).toContain("posts_create");
    expect(names).not.toContain("posts_delete");
    expect(names).not.toContain("secrets_list");
    expect(ai.runs[0]!.input.messages[0]!.content).toContain("users collection (id u1)");
    const r = await chat(ask("hi", { tools: false }), "user-token");
    expect(r.json.message).toEqual({ role: "assistant", content: "no tools" });
    expect(ai.runs[1]!.input.tools).toBeUndefined();
  });
});

describe("the loop runs the tool in process and feeds the result back", () => {
  test("one call, then the answer: the route saw the token, the model saw the result, the step reports it", async () => {
    const ai = fakeAI([
      { response: "", tool_calls: [{ name: "posts_list", arguments: { perPage: 2, sort: "-created" } }] },
      (input: AiInput) => {
        const last = input.messages.slice(-2);
        expect(last[0]).toEqual({ role: "assistant", content: JSON.stringify({ name: "posts_list", arguments: { perPage: 2, sort: "-created" } }) });
        expect(last[1]!.role).toBe("tool");
        expect(last[1]!.name).toBe("posts_list");
        expect(JSON.parse(last[1]!.content)).toMatchObject({ totalItems: 2, items: [{ id: "p1" }, { id: "p2" }] });
        expect(input.tools).toBeDefined();
        return { response: "There are 2 posts: hello and world." };
      },
    ]);
    const { chat, seen } = await appWith({ ai });
    const r = await chat(ask("how many posts?"), "user-token");
    expect(r.status).toBe(200);
    expect(r.json.message).toEqual({ role: "assistant", content: "There are 2 posts: hello and world." });
    expect(r.json.model).toBe(DEFAULT_MODEL);
    expect(r.json.steps).toHaveLength(1);
    expect(r.json.steps![0]!.tool).toBe("posts_list");
    expect(r.json.steps![0]!.arguments).toEqual({ perPage: 2, sort: "-created" });
    expect(JSON.parse(r.json.steps![0]!.result)).toMatchObject({ totalItems: 2 });
    expect(seen).toEqual([{ method: "GET", path: "/api/collections/posts/records", query: { perPage: "2", sort: "-created" }, body: null, authorization: "user-token" }]);
    expect(ai.runs).toHaveLength(2);
    expect(ai.runs[1]!.model).toBe(DEFAULT_MODEL);
  });

  test("the OpenAI-style call shape is read too, arguments as a JSON string; the step's result is cut at 500 chars", async () => {
    const ai = fakeAI([
      { response: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "posts_get", arguments: JSON.stringify({ id: "p1" }) } }] },
      { response: "done" },
    ]);
    const { chat, seen } = await appWith({ ai });
    const r = await chat(ask("show p1"));
    expect(seen.map((s) => s.path)).toEqual(["/api/collections/posts/records/p1"]);
    expect(r.json.steps![0]!.result).toHaveLength(500);
    expect(ai.runs[1]!.input.messages.at(-1)!.content.length).toBeGreaterThan(500);
    expect(toolCallsOf({ tool_calls: [{ id: "x", type: "function", function: { name: "a", arguments: "{bad" } }, { name: "b" }, "junk", { function: {} }] })).toEqual([{ name: "a", arguments: {} }, { name: "b", arguments: {} }]);
  });

  test("a tool outside the caller's scope, a refused route and a missing argument are results the model sees, not errors", async () => {
    const ai = fakeAI([
      { response: "", tool_calls: [{ name: "secrets_list", arguments: {} }, { name: "posts_get", arguments: { id: "missing" } }, { name: "posts_get", arguments: {} }] },
      (input: AiInput) => {
        const tools = input.messages.filter((m) => m.role === "tool");
        expect(tools).toHaveLength(3);
        expect(JSON.parse(tools[0]!.content).error).toMatch(/no tool called "secrets_list"/);
        expect(JSON.parse(tools[1]!.content)).toMatchObject({ status: 404 });
        expect(JSON.parse(tools[2]!.content).error).toMatch(/needs id/);
        return { response: "I could not read that." };
      },
    ]);
    const { chat, seen } = await appWith({ ai });
    const r = await chat(ask("read the secrets"));
    expect(r.status).toBe(200);
    expect(r.json.steps!.map((s) => s.tool)).toEqual(["secrets_list", "posts_get", "posts_get"]);
    expect(seen.map((s) => s.path)).toEqual(["/api/collections/posts/records/missing"]);
  });

  test("the request's model wins over the binding's; a plain string answer is the content", async () => {
    const ai = fakeAI(["just text"]);
    const { chat } = await appWith({ ai, model: "@cf/meta/llama-3.1-8b-instruct" });
    const r = await chat(ask("hi", { model: "@cf/qwen/qwen3-30b-a3b-fp8" }));
    expect(ai.runs[0]!.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(r.json).toEqual({ message: { role: "assistant", content: "just text" }, steps: [], model: "@cf/qwen/qwen3-30b-a3b-fp8" });
    const ai2 = fakeAI([{ response: "x" }]);
    const { chat: chat2 } = await appWith({ ai: ai2, model: "@cf/meta/llama-3.1-8b-instruct" });
    expect((await chat2(ask("hi"))).json.model).toBe("@cf/meta/llama-3.1-8b-instruct");
    expect(ai2.runs[0]!.model).toBe("@cf/meta/llama-3.1-8b-instruct");
  });
});

describe("maxSteps stops a runaway", () => {
  test("a model that always asks for a tool is stopped after maxSteps executions and one more call", async () => {
    const always = { response: "", tool_calls: [{ name: "posts_list", arguments: {} }] };
    const ai = fakeAI(Array.from({ length: 10 }, () => always));
    const { chat, seen } = await appWith({ ai });
    const r = await chat(ask("loop", { maxSteps: 2 }));
    expect(r.status).toBe(200);
    expect(r.json.steps).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(ai.runs).toHaveLength(3);
    expect(r.json.message.content).toMatch(/stopped after 2 tool calls/);
  });

  test("the default is 6; 0 means no execution at all; above 20 is refused", async () => {
    const always = { response: "", tool_calls: [{ name: "posts_list", arguments: {} }] };
    const ai = fakeAI(Array.from({ length: 10 }, () => always));
    const { chat, seen } = await appWith({ ai });
    expect((await chat(ask("loop"))).json.steps).toHaveLength(6);
    expect(ai.runs).toHaveLength(7);
    expect((await chat(ask("loop", { maxSteps: 0 }))).json.steps).toHaveLength(0);
    expect(seen).toHaveLength(6);
    expect((await chat(ask("loop", { maxSteps: 21 }))).status).toBe(400);
  });
});

describe("the rate cap", () => {
  test("30 per minute per caller, in memory; the window slides on the clock; callers are counted apart", async () => {
    let t = 1_000_000;
    const ai = fakeAI(Array.from({ length: 200 }, () => ({ response: "ok" })));
    const { chat } = await appWith({ ai, now: () => t });
    for (let i = 0; i < RATE.limit; i++) expect((await chat(ask("hi"), "user-token")).status).toBe(200);
    const over = await chat(ask("hi"), "user-token");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(over.json.message).toMatch(/30 per minute/);
    expect((await chat(ask("hi"), "su-token")).status).toBe(200);
    expect((await chat(ask("hi"), "", { "cf-connecting-ip": "203.0.113.9" })).status).toBe(200);
    t += RATE.periodMs;
    expect((await chat(ask("hi"), "user-token")).status).toBe(200);
  });
});

describe("the body is checked", () => {
  test("bad JSON, no messages, a bad role, stream: true are 400 with a reason", async () => {
    const ai = fakeAI([]);
    const { chat } = await appWith({ ai });
    expect((await chat("{nope")).status).toBe(400);
    expect((await chat({ messages: [] })).json.message).toMatch(/messages/);
    expect((await chat({ messages: [{ role: "robot", content: "x" }] })).json.message).toMatch(/role/);
    expect((await chat({ messages: [{ role: "user", content: 1 }] })).status).toBe(400);
    expect((await chat(ask("hi", { tools: "yes" }))).json.message).toMatch(/tools/);
    const s = await chat(ask("hi", { stream: true }));
    expect(s.status).toBe(400);
    expect(s.json.message).toMatch(/stream is not supported/);
    expect(ai.runs).toHaveLength(0);
  });
});
