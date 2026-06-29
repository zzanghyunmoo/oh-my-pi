# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Workspace Connector Auth

### Workspace Connector
A Pi integration surface that lets an agent read or operate on an external workspace service through registered commands and tools while keeping service credentials local to the user's machine.

A Workspace Connector separates human setup actions from agent tool execution: login and status flows may involve the user, but tool calls should use existing credentials or fail with setup guidance rather than starting an interactive consent flow.

### Connector Backend Catalog
The shared description of each external integration's backend type, auth strategy, user-facing guidance, and exposed commands or tools.

The catalog is the vocabulary source for connector behavior; command text, setup diagnostics, and runtime guidance should derive from it so connector setup instructions do not drift across surfaces.

### Browser OAuth
A human login flow where Pi opens the service authorization page in a browser, receives the redirect on a local loopback callback, and stores resulting OAuth credentials in local-only state.

Browser OAuth is distinct from tool execution: it is allowed to involve the user and browser, while later agent tools must reuse stored credentials non-interactively.

### Access-key Fallback
A secondary connector auth path that uses a local secret token when Browser OAuth is unavailable or insufficient for a service.

Access-key Fallback is not the preferred setup path. It exists so connector tools can still run deterministically in environments where browser login cannot complete, while preserving the rule that secrets stay local and out of version control.

### Runtime Safety Policy Ledger
The project-level safety vocabulary for deciding how registered tools and connector actions are described to agents, especially whether an operation is read-only or requires confirmation before writes.

The ledger does not authenticate services. It describes behavioral boundaries for agent use after a connector is reachable.

### Connector Setup Control Plane
A human-facing setup surface for choosing connector setup mode, seeing desired readiness, and receiving login/status/logout next actions before agent tools run.

The control plane owns setup guidance and readiness explanation. Runtime connector tools remain non-interactive: they reuse existing credentials or fail with a setup path rather than starting login.

### Capability Slot
A connector role such as issue tracker, wiki, git, or provider that can be filled by different services depending on tenant or setup mode.

Capability slots let company and personal stacks use the same product vocabulary while resolving to different backends, for example Jira vs Linear for issue tracking or Confluence vs Notion for wiki.

### Auth Passport
A secret-free view of a connector's auth provenance, local-state ownership, and logout blast radius.

An auth passport may report sources like Pi-managed OAuth state, CWD env fallback, `gh` CLI, `glab` CLI, or setup-only guidance, but it must not print tokens, API keys, auth headers, or copied `.env` content.

### Readiness-Gated Tool Affordance
A connector tool exposure rule where the selected setup mode and auth readiness decide whether a tool is visible, hidden, gated, or replaced by setup guidance.

This keeps minimal setup from advertising excluded issue-tracker, wiki, or git tools, and keeps unauthenticated runtime calls from initiating interactive auth.

### Connector Setup State
A secret-free local record of the user's selected connector setup mode and selector choices.

Connector Setup State may store mode, tenant, capability, service, schema version, and update time. It must not store OAuth tokens, API keys, CLI tokens, auth headers, or copied `.env` values, and it remains separate from Workspace Connector Auth state.
