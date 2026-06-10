# @mdcms/shared

Shared contracts, types, and validators used across MDCMS packages.

## Install

```bash
npm install @mdcms/shared
```

> **Note:** This package provides the shared contract layer for MDCMS. Most consumers will interact with it indirectly through `@mdcms/cli`, `@mdcms/studio`, or `@mdcms/sdk`.

## What's Inside

### Config Authoring

- `defineConfig`, `defineType`, `fieldTypes` — Content schema authoring helpers
- `parseMdcmsConfig` — Config validator and normalizer

### Content and Schema Contracts

- Content API response types and validators
- Schema registry sync and entry contracts
- Environment management contracts

### Runtime Contracts

- `parseCoreEnv`, `parseDatabaseEnv` — Environment variable parsing
- Error envelope types and validators
- Module manifest and compatibility types

### Studio Contracts

- `StudioBootstrapManifest`, `StudioMountContext`, `HostBridgeV1`
- Bootstrap and mount validators
- MDX component prop extraction and auto-form field generation

### Request Routing

- Target routing header/query constants and resolvers
- Route-level requirement enforcement

## Documentation

Full contract reference at [docs.mdcms.ai](https://docs.mdcms.ai/).
