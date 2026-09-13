# @voidbase-cloud/plugin-ai

The ai plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), in a repository of its own. It answers
questions about the instance's own data: a chat endpoint, conversations kept as records, and the instance's MCP
tools as the means of actually reading and writing rows.

It is not part of voidbase itself, and this repository is its home, released on its own. Install it on an instance
from the marketplace: `voidbase plugins add ai` in a project, or the admin panel's Plugins page on a vanilla
instance. Its tests run against the core's `@voidbase-cloud/voidbase/testing` entry: `bun install && bun test`.

## What it needs

A model binding. `VOIDBASE_AI=1` (or a model name) and the Worker's `AI` binding is the shipped path; without them
the plugin loads and stays idle, and `/api/plugins` says so.

## Why it depends on two sibling packages

The tools it calls are the MCP tools, which are written from the OpenAPI document: it reads `documentFor`,
`toolsOf` and `runTool` from `@voidbase-cloud/plugin-mcp`, and the `OpenApiSource` type from
`@voidbase-cloud/plugin-openapi`. It names both packages directly rather than the core's re-exports of them,
because those packages are what it uses — and the release publishes them, in order, before this one.

## Swapping it

An instance loads whichever plugin claims the name `ai`: install one from a marketplace and it shadows this one, or
turn this one off in `voidbase.lock`. The conversations it keeps are ordinary records, so they survive the swap.

MIT
