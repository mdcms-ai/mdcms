# @mdcms/cli

CLI for MDCMS content workflows — pull content to local Markdown files, edit with any tool, and push changes back.

## Install

Install globally to use the `mdcms` command anywhere:

```bash
npm install -g @mdcms/cli
```

Or add it as a project dependency and run via `npx`:

```bash
npm install @mdcms/cli
npx mdcms pull
```

## Configuration

Create a `mdcms.config.ts` in your project root:

```ts
import { defineConfig, defineType, fieldTypes } from "@mdcms/cli";
import { z } from "zod";

export default defineConfig({
  project: "marketing-site",
  environment: "staging",
  serverUrl: "http://localhost:4000",
  contentDirectories: ["content"],
  types: [
    defineType("Author", {
      directory: "content/authors",
      fields: {
        name: z.string().min(1),
      },
    }),
    defineType("BlogPost", {
      directory: "content/blog",
      localized: true,
      fields: {
        title: z.string().min(1),
        author: fieldTypes.reference("Author"),
      },
    }),
  ],
  locales: {
    default: "en-US",
    supported: ["en-US", "fr"],
  },
});
```

### Environment files

The CLI loads `.env*` files from the directory containing the nearest `mdcms.config.ts`, `mdcms.config.js`, or `mdcms.config.mjs` before it imports the config. This lets `mdcms.config.ts` read values from `process.env`.

Put local developer values in `.env.local` next to `mdcms.config.ts`:

```bash
MDCMS_SERVER_URL=http://localhost:4000
MDCMS_PROJECT=marketing-site
MDCMS_ENVIRONMENT=staging
MDCMS_API_KEY=mdcms_key_local
```

Loading order, highest precedence first:

| Order | File                    | When loaded                 |
| ----- | ----------------------- | --------------------------- |
| 1     | `.env.{NODE_ENV}.local` | Always                      |
| 2     | `.env.local`            | Except when `NODE_ENV=test` |
| 3     | `.env.{NODE_ENV}`       | Always                      |
| 4     | `.env`                  | Always                      |

`NODE_ENV` defaults to `development` for CLI runs. In this table, `NODE_ENV` is only the dotenv file selector; it is not the same thing as the MDCMS `environment` field or `MDCMS_ENVIRONMENT`. For example, `NODE_ENV=production` makes the CLI look for `.env.production` and `.env.production.local`, while `MDCMS_ENVIRONMENT=staging` tells MDCMS which content environment to target.

Shell-exported variables override all file values. Use `--no-env-file` or `MDCMS_DOTENV=0` to disable auto-loading for a run.

## Commands

| Command             | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `mdcms login`       | Authenticate via browser-based OAuth flow                |
| `mdcms logout`      | Revoke credentials and clear local profile               |
| `mdcms pull`        | Pull content from the server to local Markdown files     |
| `mdcms push`        | Push local content changes back to the server            |
| `mdcms schema sync` | Sync your local schema definition to the server registry |
| `mdcms mcp`         | Run an MCP stdio bridge for AI agents                    |

### Pull

```bash
mdcms pull              # Interactive mode — prompts before overwriting
mdcms pull --force      # Skip overwrite prompts
mdcms pull --dry-run    # Preview changes without writing files
mdcms pull --published  # Fetch published snapshots instead of drafts
```

### Push

```bash
mdcms push --dry-run    # Preview the push plan without uploading
mdcms push              # Interactive mode: prompts before uploading
mdcms push --yes        # Include new and deleted files, skip the confirmation prompt (--force is an alias)
```

### MCP bridge

`mdcms mcp` exposes the configured project and environment to AI agents over the Model Context Protocol. It reuses the credentials from `mdcms login`; that key does not include `content:publish`. To publish, create a key with that scope in Studio settings and pass it with `MDCMS_API_KEY` or `--api-key`.

Install the CLI locally in the host project first (`npm install --save-dev @mdcms/cli`), then configure the agent from that directory:

```bash
claude mcp add mdcms -- npx mdcms mcp
```

Requires Node.js 24.11.1 or later and a server exposing `/api/v1/mcp`. The CLI relays the server registry, including its schemas, annotations, results and errors. Available tools depend on server capabilities and credential scopes.

The local `sync_schema` tool reloads `mdcms.config.ts` and its imported local modules, then syncs to the connection resolved at startup. TypeScript configs support extensionless local imports and transformed syntax such as enums on both Node and Bun. Config edits do not change that connection. After syncing, read `get_schema` and pass its `schemaHash` explicitly to tools that require it. The bridge never substitutes a local or newly fetched hash. Restart the bridge to change server, project, environment or credentials.

Remote writes affect the server. Run `mdcms pull` to refresh local content. Transport failures can have unknown mutation outcomes; inspect server state before retrying. stdout is reserved for JSON-RPC, diagnostics go to stderr, and closing stdin stops the bridge.

`get_credentials_info` is a read-only local diagnostic for the resolved target, capability-derived scopes, and common content/schema tool scope requirements. Its `allowed` flags do not guarantee path access or describe the complete remote inventory. Remote discovery remains authoritative. Login/init keys exclude publishing; supply a Studio-created key with `content:publish` to publish. After replacing a rejected key, restart the bridge.

### Global Flags

| Flag            | Env Variable        | Description                                      |
| --------------- | ------------------- | ------------------------------------------------ |
| `--project`     | `MDCMS_PROJECT`     | Target project name                              |
| `--environment` | `MDCMS_ENVIRONMENT` | Target environment name                          |
| `--server-url`  | `MDCMS_SERVER_URL`  | Server URL                                       |
| `--api-key`     | `MDCMS_API_KEY`     | API key (for headless/CI use)                    |
| `--config`      |                     | Path to config file (default: `mdcms.config.ts`) |
| `--no-env-file` | `MDCMS_DOTENV=0`    | Disable automatic `.env*` loading                |

## Documentation

Full CLI reference at [docs.mdcms.ai](https://docs.mdcms.ai/).

Remote OAuth clients connect to `https://cms.example.com/api/v1/mcp`, approve a scope subset and one immutable project/environment target. Revoke grants in Studio Connected apps. See the [MCP guide](https://docs.mdcms.ai/guide/mcp) for all remote tools, permissions, explicit schema hashes and recovery guidance. Client names are unverified; initialize identity alone does not persist across stateless calls.
