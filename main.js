// A chat over the instance on Workers AI, as the plugin `ai`: the model talks to whoever is asking, with the
// instance's own API as its tools, scoped to the token the request carries.
//
// POST /api/ai/chat takes a conversation and answers it. The tools the model may call are the MCP server's tool
// list for the same caller (mcp.ts, toolsOf over the caller's OpenAPI document): anonymous sees the public API,
// a user what that user may call, a superuser everything. A call the model makes runs the way tools/call runs it,
// the instance's own route in process with the caller's token forwarded (mcp.ts, runTool), so the rules judge it
// and nothing here decides access. The loop is the traditional function-calling loop Workers AI documents
// (developers.cloudflare.com/workers-ai/features/function-calling/traditional, and Cloudflare's own
// @cloudflare/ai-utils runWithTools): `env.AI.run(model, { messages, tools })` answers `response` and, when it
// wants a tool, `tool_calls: [{ name, arguments }]`; each call's result goes back as an assistant message carrying
// the call and a `{ role: "tool", name, content }` message carrying the answer, and the model is asked again, until
// it answers without a call or maxSteps is reached. The OpenAI-style call (`{ id, type, function: { name,
// arguments } }`, which @cloudflare/workers-types also declares) is read the same way.
//
// A conversation is a record. Cloudflare's Think (developers.cloudflare.com/agents/harnesses/think/, the npm
// package @cloudflare/think) keeps a chat in a Durable Object's SQLite; here the persistent half is two collections
// the plugin owns, `ai_conversations` and `ai_messages`, created at bootstrap once the binding is there (the way
// the payment plugins create theirs), so an instance without VOIDBASE_AI never sees them. A signed-in user reads
// and deletes their own through the records API (`owner = @request.auth.id`, `conversation.owner = @request.auth.id`;
// `owner` is the auth record's id whichever auth collection it is in, `user` the relation when that is `users`)
// and writes through the routes under /api/ai/conversations, which store every row through the records service as
// a superuser: hooks fire and realtime publishes, so a subscriber on `ai_messages` sees the reply land. Anonymous
// callers keep the stateless route and get no persistence.
//
// Streaming: a call that streams cannot also hand back tool_calls to act on, so POST /api/ai/chat answers one JSON
// body and refuses `stream: true`. The messages route streams the way Cloudflare's runWithTools does with
// streamFinalResponse: the tool steps run first, then one last call is made with `stream: true` and no tools
// (the overload @cloudflare/workers-types declares as answering a ReadableStream), and its SSE chunks
// (`data: {"response": "..."}`, then `data: [DONE]`, as Cloudflare's workers-ai-provider reads them) are forwarded
// as `data: {"delta": "..."}` events, the full text stored when the stream ends.
//
// The binding arrives with the request, not at load: without it the routes answer 503 and name the knob, and
// GET /api/plugins reports `ai: { via: "none" }`. The rate cap is per caller, in memory, so per isolate: the
// hardening plugin's rules are keyed by settings, not by a route a plugin registers, and Workers AI is metered.
import { env as voidEnv } from "@voidbase-cloud/voidbase/platform";
import { all, ApiError, badRequest, collectionId, createRecord, deleteRecord, findCollection, ident, loadCollections, notFound, one, requireAuth, rowToValues, updateRecord, VERSION, listCollections, loadSettings } from "@voidbase-cloud/voidbase/sdk";
import { lookup, onBootstrap } from "@voidbase-cloud/voidbase/kernel";
import { ensureCollections } from "@voidbase-cloud/voidbase/plugins/collections";
import { AI_BINDING, AI_VAR, DEFAULT_MODEL, aiModelOf } from "@voidbase-cloud/voidbase/plugins/ai-binding";
/** the instance's own collections and settings: what the shipped ai plugin reads */
const defaultSource = {
  collections: (env) => listCollections(env.DB),
  appName: async (env) => String((await loadSettings(env.DB)).meta.appName ?? ""),
};
/** what runs a tool when no plugin provides mcp@1; never called, since there are then no tools to call */
const noTool = async () => { throw new Error("no plugin provides mcp@1, so there are no tools to run"); };
export { AI_BINDING, AI_VAR, DEFAULT_MODEL, aiModelOf };
/** the model these bindings name: the knob's value, or the default when the binding is there and the knob says only that */
export const aiModel = (env) => aiModelOf(String(env[AI_VAR] ?? voidEnv[AI_VAR] ?? "")) || (env.AI ? DEFAULT_MODEL : "");
export const AI_CONVERSATIONS = "ai_conversations";
export const AI_MESSAGES = "ai_messages";
/** whether the two collections exist on this instance: they do once a request carried the binding through bootstrap */
export async function hasConversations(env) {
  // No database, no conversations, and no lookup: the collections cache is per isolate rather than per database, so
  // asking it without one would answer for whichever database filled it last (a test process with several instances
  // did exactly that in CI, 2026-09-11).
  if (!env.DB)
    return false;
  try {
    return !!(await findCollection(env.DB, AI_CONVERSATIONS));
  }
  catch {
    return false;
  }
}
/** what GET /api/plugins says in its `ai` field */
export async function aiRoute(env) {
  if (!env.AI)
    return { via: "none" };
  return { via: "workers-ai", model: aiModel(env), conversations: await hasConversations(env) };
}
export const NOT_BOUND = `Workers AI is not bound; deploy with ${AI_VAR}=1`;
export const RATE = { limit: 30, periodMs: 60_000 };
export const DEFAULT_MAX_STEPS = 6;
export const MAX_STEPS_CEILING = 20;
/** how much of a tool's answer a step reports */
export const RESULT_SUMMARY = 500;
/** how many stored messages a conversation's next answer sees: the last ones, in order */
export const HISTORY = 40;
/** how much of the first user message becomes the title of a conversation made without one */
export const TITLE_LENGTH = 60;
export const MESSAGE_ROLES = ["user", "assistant", "tool", "system"];
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (v === null || v === undefined ? "" : String(v));
/** the tool list in Workers AI's OpenAI-style `tools` shape, from the MCP tool list */
export const aiToolsOf = (tools) => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: { type: "object", properties: isObject(t.inputSchema.properties) ? t.inputSchema.properties : {}, required: Array.isArray(t.inputSchema.required) ? t.inputSchema.required : [] } } }));
/** the calls a response carries, in the legacy `{ name, arguments }` shape or the OpenAI `{ function: { name, arguments } }` one */
export function toolCallsOf(output) {
  if (!isObject(output) || !Array.isArray(output.tool_calls))
    return [];
  const calls = [];
  for (const raw of output.tool_calls) {
    if (!isObject(raw))
      continue;
    const fn = isObject(raw.function) ? raw.function : raw;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name)
      continue;
    let args = fn.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      }
      catch {
        args = {};
      }
    }
    calls.push({ name, arguments: isObject(args) ? args : {} });
  }
  return calls;
}
const responseOf = (output) => (typeof output === "string" ? output : typeof output.response === "string" ? output.response : "");
const tokensOf = (output) => (isObject(output) && isObject(output.usage) && typeof output.usage.total_tokens === "number" ? output.usage.total_tokens : 0);
/**
 * The text deltas of a streamed call. Workers AI streams SSE: `data: {"response": "..."}` per chunk and
 * `data: [DONE]` at the end, which is how Cloudflare's workers-ai-provider reads it too. A plain answer (a string,
 * or an object with `response`) is one delta, so a binding that did not stream still answers.
 */
export async function* deltasOf(output) {
  if (typeof output === "string") {
    if (output)
      yield output;
    return;
  }
  if (!isObject(output))
    return;
  if (typeof output.getReader !== "function") {
    const text = responseOf(output);
    if (text)
      yield text;
    return;
  }
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += typeof value === "string" ? value : decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.startsWith("data:"))
          continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]")
          continue;
        try {
          const json = JSON.parse(data);
          if (isObject(json) && typeof json.response === "string" && json.response)
            yield json.response;
        }
        catch { /* not a chunk */ }
      }
      if (done)
        return;
    }
  }
  finally {
    reader.releaseLock();
  }
}
/** who the caller is, for the system prompt */
export function describeCaller(auth) {
  if (!auth)
    return "anonymous: nobody is signed in, so only the public API is reachable";
  if (auth.collection.name === "_superusers")
    return `a superuser (${String(auth.row.id)}): every collection and every write is reachable`;
  return `a signed-in record of the ${auth.collection.name} collection (id ${String(auth.row.id)}): what its own token may call is reachable`;
}
export const systemPrompt = (appName, auth, toolCount) => `You are the assistant of ${JSON.stringify(appName || "voidbase")}, a voidbase instance (a PocketBase-compatible backend of collections and records). ` +
  `The person asking is ${describeCaller(auth)}. ` +
  (toolCount ? `Use the tools for facts: they are this instance's own API as this caller may call it (${toolCount} tools), so list or get records before stating what they hold, and never invent an id, a field or a value. A tool's answer is the instance's answer; a non-2xx is a refusal to report, not to work around. ` : "") +
  `Answer briefly and plainly.`;
/** the title a conversation gets from its first user message: one line, the first characters */
export const titleOf = (content) => content.replace(/\s+/g, " ").trim().slice(0, TITLE_LENGTH);
const callerKey = (c) => {
  const auth = c.get("auth");
  if (auth)
    return `${auth.collection.name}:${String(auth.row.id)}`;
  return `ip:${c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "anonymous"}`;
};
function allow(windows, key, now) {
  const w = windows.get(key);
  if (!w || now - w.start >= RATE.periodMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 10_000)
      for (const [k, v] of windows)
        if (now - v.start >= RATE.periodMs)
          windows.delete(k);
    return true;
  }
  w.count++;
  return w.count <= RATE.limit;
}
// --- the collections -------------------------------------------------------------------------------------------------
/**
 * The two collections, as POST /api/collections would take them; `users` is the relation's target when it exists.
 * Reads are the owner's; creates and updates are superuser-only, which is what makes the routes below the way in.
 */
export async function conversationDefinitions(db) {
  const users = (await findCollection(db, "users"))?.id ?? collectionId("auth", "users");
  const conversations = collectionId("base", AI_CONVERSATIONS);
  const own = "owner = @request.auth.id", ownConversation = "conversation.owner = @request.auth.id";
  const autodates = [{ name: "created", type: "autodate", onCreate: true, onUpdate: false }, { name: "updated", type: "autodate", onCreate: true, onUpdate: true }];
  return [
    {
      name: AI_CONVERSATIONS, type: "base", listRule: own, viewRule: own, createRule: null, updateRule: null, deleteRule: own,
      fields: [
        { name: "owner", type: "text", required: true },
        { name: "user", type: "relation", collectionId: users, maxSelect: 1, cascadeDelete: true },
        { name: "title", type: "text" },
        { name: "model", type: "text" },
        { name: "system", type: "text" },
        { name: "tools", type: "bool" },
        { name: "lastMessageAt", type: "date" },
        ...autodates,
      ],
      indexes: [`CREATE INDEX \`idx_ai_conversations_user\` ON \`${AI_CONVERSATIONS}\` (\`owner\`, \`lastMessageAt\`)`],
    },
    {
      name: AI_MESSAGES, type: "base", listRule: ownConversation, viewRule: ownConversation, createRule: null, updateRule: null, deleteRule: ownConversation,
      fields: [
        { name: "conversation", type: "relation", collectionId: conversations, maxSelect: 1, required: true, cascadeDelete: true },
        { name: "role", type: "select", maxSelect: 1, required: true, values: [...MESSAGE_ROLES] },
        { name: "content", type: "text" },
        { name: "steps", type: "json" },
        { name: "tokens", type: "number" },
        ...autodates,
      ],
      indexes: [`CREATE INDEX \`idx_ai_messages_conversation\` ON \`${AI_MESSAGES}\` (\`conversation\`, \`created\`)`],
    },
  ];
}
/** a realtime client for writes with nobody watching: nothing is recorded */
const idleRealtime = {
  active: () => false,
  publish: async () => undefined,
  presence: async () => null,
  publishToClient: async () => false,
  controlClient: async () => undefined,
  openSocket: async () => { throw new Error("voidbase: no realtime hub here"); },
};
/** the rows in D1, written through the records service as a superuser so hooks fire and realtime publishes */
export function d1AiRows(env, realtime, waitUntil) {
  let pending;
  const ctx = () => (pending ??= (async () => ({
    db: env.DB, storage: env.STORAGE, auth: null, superuser: true,
    request: { auth: null, method: "POST", query: {}, headers: {}, body: {}, context: "default" },
    collections: await loadCollections(env.DB),
    realtime: realtime ?? idleRealtime,
    ...(waitUntil ? { waitUntil } : {}),
  }))());
  const collection = async (name) => {
    const c = (await ctx()).collections.get(name);
    if (!c)
      throw new ApiError(503, `the ai plugin's collection "${name}" does not exist yet; it is created on the first request that carries the Workers AI binding (${AI_VAR}=1)`);
    return c;
  };
  const values = async (name, rows) => { const c = await collection(name); return rows.map((r) => rowToValues(c, r)); };
  return {
    async get(name, id) { return (await values(name, await all(env.DB, `SELECT * FROM ${ident(name)} WHERE id = ? LIMIT 1`, [id])))[0] ?? null; },
    async conversations(user, page, perPage) {
      const items = await values(AI_CONVERSATIONS, await all(env.DB, `SELECT * FROM ${ident(AI_CONVERSATIONS)} WHERE ${ident("owner")} = ? ORDER BY ${ident("lastMessageAt")} DESC, created DESC, rowid DESC LIMIT ? OFFSET ?`, [user, perPage, (page - 1) * perPage]));
      const total = await one(env.DB, `SELECT COUNT(*) AS n FROM ${ident(AI_CONVERSATIONS)} WHERE ${ident("owner")} = ?`, [user]);
      return { items, totalItems: Number(total?.n ?? 0) };
    },
    async messages(conversation, last) {
      const rows = last
        ? (await all(env.DB, `SELECT * FROM ${ident(AI_MESSAGES)} WHERE conversation = ? ORDER BY created DESC, rowid DESC LIMIT ?`, [conversation, last])).reverse()
        : await all(env.DB, `SELECT * FROM ${ident(AI_MESSAGES)} WHERE conversation = ? ORDER BY created ASC, rowid ASC`, [conversation]);
      return values(AI_MESSAGES, rows);
    },
    async create(name, v) { return (await createRecord(await ctx(), await collection(name), v, {})); },
    async update(name, id, v) { return (await updateRecord(await ctx(), await collection(name), id, v, {})); },
    async delete(name, id) { await deleteRecord(await ctx(), await collection(name), id); },
  };
}
const ROLES = new Set(MESSAGE_ROLES);
function parseChat(body) {
  if (!isObject(body))
    return "The body must be a JSON object.";
  if (!Array.isArray(body.messages) || !body.messages.length)
    return "messages must be a non-empty array of { role, content }.";
  const messages = [];
  for (const m of body.messages) {
    if (!isObject(m) || typeof m.role !== "string" || !ROLES.has(m.role) || typeof m.content !== "string")
      return "Each message needs a role (user, assistant, system or tool) and a string content.";
    messages.push({ role: m.role, content: m.content });
  }
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim()))
    return "model must be a Workers AI model name.";
  if (body.tools !== undefined && typeof body.tools !== "boolean")
    return "tools must be a boolean.";
  const steps = parseMaxSteps(body.maxSteps);
  if (typeof steps === "string")
    return steps;
  if (body.stream === true)
    return `stream is not supported here: Workers AI cannot stream a call that may answer with tool calls, so the answer is one JSON body. POST /api/ai/conversations/:id/messages streams the final answer of a stored conversation.`;
  return { messages, model: body.model, tools: body.tools, maxSteps: steps };
}
function parseMaxSteps(v) {
  if (v === undefined)
    return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_STEPS_CEILING)
    return `maxSteps must be an integer from 0 to ${MAX_STEPS_CEILING}.`;
  return v;
}
/** the function-calling loop: ask, run what the model calls in process, feed the answers back, until it answers or maxSteps is reached */
async function runLoop(app, c, loop) {
  const { messages, tools, doc } = loop;
  const aiTools = aiToolsOf(tools);
  const steps = [];
  let content = "", tokens = 0, stopped = false;
  for (let step = 0;; step++) {
    const output = (await c.env.AI.run(loop.model, { messages, ...(aiTools.length ? { tools: aiTools } : {}) }));
    content = responseOf(output);
    tokens += tokensOf(output);
    const calls = aiTools.length ? toolCallsOf(output) : [];
    if (!calls.length)
      break;
    if (step >= loop.maxSteps) {
      stopped = true;
      content = content || `I stopped after ${loop.maxSteps} tool calls without a final answer; ask again with a higher maxSteps or a narrower question.`;
      break;
    }
    for (const call of calls) {
      messages.push({ role: "assistant", content: JSON.stringify(call) });
      const tool = tools.find((t) => t.name === call.name);
      let result;
      if (!tool)
        result = JSON.stringify({ error: `There is no tool called ${JSON.stringify(call.name)} for this caller.` });
      else {
        try {
          result = (await loop.runTool(app, c, doc, tool, call.arguments)).text;
        }
        catch (err) {
          result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
      }
      messages.push({ role: "tool", name: call.name, content: result });
      steps.push({ tool: call.name, arguments: call.arguments, result: result.slice(0, RESULT_SUMMARY) });
    }
  }
  return { content, steps, tokens, stopped };
}
// --- the routes ------------------------------------------------------------------------------------------------------
const MAX_PER_PAGE = 500, DEFAULT_PER_PAGE = 30;
const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;
const waitUntilOf = (c) => {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  }
  catch {
    return undefined;
  }
};
function mountRoutes(app, version, source, now, rowsFactory, mcpOf) {
  const windows = new Map();
  const rowsFor = (c) => rowsFactory(c.env, c.get("realtime"), waitUntilOf(c));
  const readJson = async (c) => {
    let body;
    try {
      body = await c.req.json();
    }
    catch {
      throw badRequest("The body is not JSON.");
    }
    if (!isObject(body))
      throw badRequest("The body must be a JSON object.");
    return body;
  };
  /** the caller's own conversation, or 404: somebody else's is not distinguished from none */
  const owned = async (rows, id, auth) => {
    const row = await rows.get(AI_CONVERSATIONS, id);
    if (!row || str(row.owner) !== str(auth.row.id))
      throw notFound(`There is no conversation ${JSON.stringify(id)} of yours.`);
    return row;
  };
  const capped = (c) => {
    if (allow(windows, callerKey(c), now()))
      return null;
    c.header("Retry-After", String(Math.ceil(RATE.periodMs / 1000)));
    return c.json({ message: `Too many requests: ${RATE.limit} per minute per caller.` }, 429);
  };
  const toolsFor = async (c, useTools) => {
    const mcp = useTools ? mcpOf() : undefined;
    const doc = mcp ? await mcp.documentFor(source, c, version) : null;
    const appName = (await source.appName(c.env).catch(() => "")).trim();
    return { doc, tools: doc && mcp ? mcp.toolsOf(doc) : [], appName, runTool: mcp?.runTool ?? noTool };
  };
  app.post("/api/ai/chat", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!c.env.AI)
      return c.json({ message: NOT_BOUND }, 503);
    const over = capped(c);
    if (over)
      return over;
    let body;
    try {
      body = await c.req.json();
    }
    catch {
      return c.json({ message: "The body is not JSON." }, 400);
    }
    const parsed = parseChat(body);
    if (typeof parsed === "string")
      return c.json({ message: parsed }, 400);
    const model = parsed.model?.trim() || aiModel(c.env);
    // the caller's tools: the MCP list for this token, none when the request turned them off
    const { doc, tools, appName, runTool } = await toolsFor(c, parsed.tools ?? true);
    const messages = [{ role: "system", content: systemPrompt(appName, c.get("auth"), tools.length) }, ...parsed.messages];
    const { content, steps } = await runLoop(app, c, { model, messages, tools, doc, runTool, maxSteps: parsed.maxSteps ?? DEFAULT_MAX_STEPS });
    const answer = { message: { role: "assistant", content }, steps, model };
    return c.json(answer);
  });
  // a conversation of the signed-in caller: the routes are the only way to create and append, so the rows are the
  // plugin's and a subscriber on ai_messages sees each message as it is stored
  app.post("/api/ai/conversations", async (c) => {
    c.header("Cache-Control", "no-store");
    const auth = requireAuth(c);
    if (!c.env.AI)
      return c.json({ message: NOT_BOUND }, 503);
    const body = await readJson(c);
    for (const k of ["title", "model", "system"])
      if (body[k] !== undefined && typeof body[k] !== "string")
        throw badRequest(`${k} must be a string.`);
    if (body.tools !== undefined && typeof body.tools !== "boolean")
      throw badRequest("tools must be a boolean.");
    const row = await rowsFor(c).create(AI_CONVERSATIONS, {
      owner: str(auth.row.id), user: auth.collection.name === "users" ? str(auth.row.id) : "", title: titleOf(str(body.title)), model: str(body.model).trim(), system: str(body.system), tools: body.tools ?? true, lastMessageAt: "",
    });
    return c.json(row);
  });
  app.get("/api/ai/conversations", async (c) => {
    c.header("Cache-Control", "no-store");
    const auth = requireAuth(c);
    const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1) || 1));
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(Number(c.req.query("perPage") ?? DEFAULT_PER_PAGE) || DEFAULT_PER_PAGE)));
    const { items, totalItems } = await rowsFor(c).conversations(str(auth.row.id), page, perPage);
    return c.json({ page, perPage, totalItems, totalPages: Math.ceil(totalItems / perPage), items });
  });
  app.get("/api/ai/conversations/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const auth = requireAuth(c);
    const rows = rowsFor(c);
    const conversation = await owned(rows, c.req.param("id") ?? "", auth);
    return c.json({ ...conversation, messages: await rows.messages(str(conversation.id)) });
  });
  app.delete("/api/ai/conversations/:id", async (c) => {
    const auth = requireAuth(c);
    const rows = rowsFor(c);
    const conversation = await owned(rows, c.req.param("id") ?? "", auth);
    await rows.delete(AI_CONVERSATIONS, str(conversation.id));
    return c.body(null, 204);
  });
  app.post("/api/ai/conversations/:id/messages", async (c) => {
    c.header("Cache-Control", "no-store");
    const auth = requireAuth(c);
    if (!c.env.AI)
      return c.json({ message: NOT_BOUND }, 503);
    const over = capped(c);
    if (over)
      return over;
    const rows = rowsFor(c);
    const conversation = await owned(rows, c.req.param("id") ?? "", auth);
    const id = str(conversation.id);
    const body = await readJson(c);
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim())
      throw badRequest("content must be a non-empty string.");
    const maxSteps = parseMaxSteps(body.maxSteps);
    if (typeof maxSteps === "string")
      throw badRequest(maxSteps);
    if (body.stream !== undefined && typeof body.stream !== "boolean")
      throw badRequest("stream must be a boolean.");
    const model = str(conversation.model).trim() || aiModel(c.env);
    const useTools = conversation.tools !== false;
    const { doc, tools, appName, runTool } = await toolsFor(c, useTools);
    // the user's message is stored first, so a subscriber sees it before the answer and the history includes it
    await rows.create(AI_MESSAGES, { conversation: id, role: "user", content });
    const history = await rows.messages(id, HISTORY);
    const messages = [
      { role: "system", content: systemPrompt(appName, auth, tools.length) },
      ...(str(conversation.system).trim() ? [{ role: "system", content: str(conversation.system) }] : []),
      ...history.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system").map((m) => ({ role: str(m.role), content: str(m.content) })),
    ];
    const finish = async (text, steps, tokens) => {
      const message = await rows.create(AI_MESSAGES, { conversation: id, role: "assistant", content: text, steps, ...(tokens ? { tokens } : {}) });
      const patch = { lastMessageAt: new Date(now()).toISOString() };
      if (!str(conversation.title))
        patch.title = titleOf(str(history.find((m) => m.role === "user")?.content ?? content));
      return { message, conversation: await rows.update(AI_CONVERSATIONS, id, patch) };
    };
    const loopInput = { model, messages, tools, doc, runTool, maxSteps: maxSteps ?? DEFAULT_MAX_STEPS };
    if (body.stream !== true) {
      const { content: text, steps, tokens } = await runLoop(app, c, loopInput);
      const { message, conversation: updated } = await finish(text, steps, tokens);
      return c.json({ message, steps, model, conversation: updated });
    }
    // streaming: the tool steps run first, then one last call with stream: true and no tools, as runWithTools does.
    // Without tools that last call is the only one; when maxSteps stopped the loop, its stop message is the answer.
    const ran = tools.length ? await runLoop(app, c, loopInput) : { content: "", steps: [], tokens: 0, stopped: false };
    const waitUntil = waitUntilOf(c);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const write = (event) => controller.enqueue(encoder.encode(sse(event)));
        try {
          let text = "";
          if (ran.stopped) {
            text = ran.content;
            write({ delta: text });
          }
          else {
            const final = await c.env.AI.run(model, { messages, stream: true });
            for await (const delta of deltasOf(final)) {
              text += delta;
              write({ delta });
            }
          }
          const stored = finish(text, ran.steps, ran.tokens);
          waitUntil?.(stored.catch(() => undefined));
          const { message, conversation: updated } = await stored;
          write({ done: true, message, steps: ran.steps, model, conversation: updated });
        }
        catch (err) {
          write({ error: err instanceof Error ? err.message : String(err) });
        }
        controller.close();
      },
    });
    c.header("Content-Type", "text/event-stream; charset=utf-8");
    c.header("Connection", "keep-alive");
    return c.body(stream);
  });
}
/** the plugin over a source of its own: tests hand in collections, a name, a clock and rows without a database */
export const aiWith = (source = {}, version = VERSION, now = Date.now, rows = d1AiRows) => {
  const plugin = {
    info: (env) => aiRoute(env),
    apply(ctx) {
      // the collections exist only where the binding does: an instance without VOIDBASE_AI never sees them
      onBootstrap(ctx, async (env) => { if (env.AI)
        await ensureCollections(plugin, env.DB, await conversationDefinitions(env.DB)); });
      mountRoutes(ctx.app, version, { ...defaultSource, ...source }, now, rows, () => lookup(ctx, "mcp@1"));
    },
  };
  return plugin;
};
/** the shipped plugin: the instance's own collections, settings and rows */
const ai = aiWith();

// what the plugin does; its declaration is manifest.json beside this file, which the instance reads
export default ai;
