import type { RealtimeClient } from "@voidbase-cloud/voidbase/interfaces";
import type { AuthRecord, Bindings, Row } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";
interface Tool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
import type { OpenApiSource } from "@voidbase-cloud/voidbase/plugins/openapi";
import { AI_BINDING, AI_VAR, DEFAULT_MODEL, aiModelOf } from "@voidbase-cloud/voidbase/plugins/ai-binding";
export { AI_BINDING, AI_VAR, DEFAULT_MODEL, aiModelOf };
/** the model these bindings name: the knob's value, or the default when the binding is there and the knob says only that */
export declare const aiModel: (env: Bindings) => string;
export declare const AI_CONVERSATIONS = "ai_conversations";
export declare const AI_MESSAGES = "ai_messages";
export type AiCollection = typeof AI_CONVERSATIONS | typeof AI_MESSAGES;
/** whether the two collections exist on this instance: they do once a request carried the binding through bootstrap */
export declare function hasConversations(env: Bindings): Promise<boolean>;
/** what GET /api/plugins says in its `ai` field */
export declare function aiRoute(env: Bindings): Promise<{
    via: "none";
} | {
    via: "workers-ai";
    model: string;
    conversations: boolean;
}>;
export declare const NOT_BOUND = "Workers AI is not bound; deploy with VOIDBASE_AI=1";
export declare const RATE: {
    readonly limit: 30;
    readonly periodMs: 60000;
};
export declare const DEFAULT_MAX_STEPS = 6;
export declare const MAX_STEPS_CEILING = 20;
/** how much of a tool's answer a step reports */
export declare const RESULT_SUMMARY = 500;
/** how many stored messages a conversation's next answer sees: the last ones, in order */
export declare const HISTORY = 40;
/** how much of the first user message becomes the title of a conversation made without one */
export declare const TITLE_LENGTH = 60;
export declare const MESSAGE_ROLES: readonly ["user", "assistant", "tool", "system"];
type ToolCall = {
    name: string;
    arguments: Record<string, unknown>;
};
type AiOutput = {
    response?: string;
    tool_calls?: unknown[];
    usage?: {
        total_tokens?: number;
    };
} | string;
type AiTool = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required: string[];
        };
    };
};
/** the tool list in Workers AI's OpenAI-style `tools` shape, from the MCP tool list */
export declare const aiToolsOf: (tools: Tool[]) => AiTool[];
/** the calls a response carries, in the legacy `{ name, arguments }` shape or the OpenAI `{ function: { name, arguments } }` one */
export declare function toolCallsOf(output: AiOutput): ToolCall[];
/**
 * The text deltas of a streamed call. Workers AI streams SSE: `data: {"response": "..."}` per chunk and
 * `data: [DONE]` at the end, which is how Cloudflare's workers-ai-provider reads it too. A plain answer (a string,
 * or an object with `response`) is one delta, so a binding that did not stream still answers.
 */
export declare function deltasOf(output: unknown): AsyncGenerator<string>;
/** who the caller is, for the system prompt */
export declare function describeCaller(auth: AuthRecord | null | undefined): string;
export declare const systemPrompt: (appName: string, auth: AuthRecord | null | undefined, toolCount: number) => string;
/** the title a conversation gets from its first user message: one line, the first characters */
export declare const titleOf: (content: string) => string;
/**
 * The two collections, as POST /api/collections would take them; `users` is the relation's target when it exists.
 * Reads are the owner's; creates and updates are superuser-only, which is what makes the routes below the way in.
 */
export declare function conversationDefinitions(db: D1Database): Promise<Record<string, unknown>[]>;
/** where the conversations live: D1 through the records service, or whatever a test hands in */
export interface AiRows {
    /** one row by id, or null */
    get(collection: AiCollection, id: string): Promise<Row | null>;
    /** a user's conversations, newest first (by last message, then by creation): one page and the total */
    conversations(user: string, page: number, perPage: number): Promise<{
        items: Row[];
        totalItems: number;
    }>;
    /** a conversation's messages oldest first; only the last `last` of them when given */
    messages(conversation: string, last?: number): Promise<Row[]>;
    create(collection: AiCollection, values: Row): Promise<Row>;
    update(collection: AiCollection, id: string, values: Row): Promise<Row>;
    /** a deleted conversation takes its messages with it, as the records service does with cascadeDelete */
    delete(collection: AiCollection, id: string): Promise<void>;
}
export type WaitUntil = (p: Promise<unknown>) => void;
export type AiRowsFactory = (env: Bindings, realtime?: RealtimeClient, waitUntil?: WaitUntil) => AiRows;
/** the rows in D1, written through the records service as a superuser so hooks fire and realtime publishes */
export declare function d1AiRows(env: Bindings, realtime?: RealtimeClient, waitUntil?: WaitUntil): AiRows;
export interface ChatRequest {
    messages: {
        role: string;
        content: string;
    }[];
    model?: string;
    tools?: boolean;
    maxSteps?: number;
    stream?: boolean;
}
export interface ChatStep {
    tool: string;
    arguments: Record<string, unknown>;
    result: string;
}
export interface ChatResponse {
    message: {
        role: "assistant";
        content: string;
    };
    steps: ChatStep[];
    model: string;
}
/** the plugin over a source of its own: tests hand in collections, a name, a clock and rows without a database */
export declare const aiWith: (source?: Partial<OpenApiSource>, version?: string, now?: () => number, rows?: AiRowsFactory) => Omit<Plugin, "manifest">;
/** the shipped plugin: the instance's own collections, settings and rows */
declare const ai: Omit<Plugin, "manifest">;
export default ai;
