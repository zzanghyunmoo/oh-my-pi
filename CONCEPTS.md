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
