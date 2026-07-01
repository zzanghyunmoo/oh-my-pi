import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import workspaceConnectorsExtension, {
	buildMcpRemoteEnvironment,
	formatInteractiveLoginResultNotification,
	runInteractiveLogin,
	type InteractiveLoginResult,
} from "./index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { routeWorkspaceMcpConnector } from "../connector-backend-catalog.js";

class FakeChild extends EventEmitter {}

test("buildMcpRemoteEnvironment appends system CA trust and preserves TLS/proxy overrides", () => {
	const env = buildMcpRemoteEnvironment({
		NODE_OPTIONS: "--max-old-space-size=4096",
		NODE_EXTRA_CA_CERTS: "/tmp/custom-ca.pem",
		HTTPS_PROXY: "http://proxy.example.test:8080",
		NO_PROXY: "localhost,127.0.0.1",
	});

	assert.equal(env.NODE_OPTIONS, "--max-old-space-size=4096 --use-system-ca");
	assert.equal(env.NODE_EXTRA_CA_CERTS, "/tmp/custom-ca.pem");
	assert.equal(env.HTTPS_PROXY, "http://proxy.example.test:8080");
	assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
});

test("buildMcpRemoteEnvironment does not duplicate the system CA Node option", () => {
	const env = buildMcpRemoteEnvironment({ NODE_OPTIONS: "--use-system-ca" });

	assert.equal(env.NODE_OPTIONS, "--use-system-ca");
});

function makeContext(hasUI = true) {
	const calls: string[] = [];

	return {
		calls,
		ctx: {
			hasUI,
			ui: {
				notify: () => undefined,
				custom: <T>(
					factory: (
						tui: {
							stop(): void;
							start(): void;
							requestRender(force?: boolean): void;
						},
						theme: unknown,
						keybindings: unknown,
						done: (result: T) => void,
					) => { render(): string[]; invalidate(): void },
				) =>
					new Promise<T>((resolve) => {
						const component = factory(
							{
								stop: () => calls.push("stop"),
								start: () => calls.push("start"),
								requestRender: (force?: boolean) =>
									calls.push(`render:${String(force)}`),
							},
							{},
							{},
							resolve,
						);
						assert.deepEqual(component.render(), []);
						component.invalidate();
					}),
			},
		},
	};
}

test("runInteractiveLogin stops TUI before spawn and restores it after successful exit", async () => {
	const { ctx, calls } = makeContext();
	const child = new FakeChild();
	const resultPromise = runInteractiveLogin(
		"npx",
		["-y"],
		ctx,
		(command, args) => {
			calls.push(`spawn:${command}:${args.join(" ")}`);
			return child;
		},
	);

	assert.deepEqual(calls, ["stop", "spawn:npx:-y"]);
	child.emit("exit", 0, null);

	assert.deepEqual(await resultPromise, {
		status: "completed",
		code: 0,
		signal: null,
	} satisfies InteractiveLoginResult);
	assert.deepEqual(calls, ["stop", "spawn:npx:-y", "start", "render:true"]);
});

test("runInteractiveLogin enables system CA trust for the Node-based MCP remote login process", async () => {
	const { ctx } = makeContext();
	const child = new FakeChild();
	let spawnEnv: NodeJS.ProcessEnv | undefined;
	const resultPromise = runInteractiveLogin(
		"npx",
		["-y"],
		ctx,
		(_command, _args, options) => {
			spawnEnv = (options as { env?: NodeJS.ProcessEnv }).env;
			return child;
		},
	);

	child.emit("exit", 0, null);

	assert.equal((await resultPromise).status, "completed");
	assert.match(spawnEnv?.NODE_OPTIONS ?? "", /--use-system-ca/);
});

test("runInteractiveLogin restores TUI after a non-zero exit", async () => {
	const { ctx, calls } = makeContext();
	const child = new FakeChild();
	const resultPromise = runInteractiveLogin("npx", ["-y"], ctx, () => child);

	child.emit("exit", 1, null);

	assert.deepEqual(await resultPromise, {
		status: "completed",
		code: 1,
		signal: null,
	} satisfies InteractiveLoginResult);
	assert.deepEqual(calls, ["stop", "start", "render:true"]);
});

test("runInteractiveLogin restores TUI after signal termination", async () => {
	const { ctx, calls } = makeContext();
	const child = new FakeChild();
	const resultPromise = runInteractiveLogin("npx", ["-y"], ctx, () => child);

	child.emit("exit", null, "SIGTERM");

	assert.deepEqual(await resultPromise, {
		status: "completed",
		code: null,
		signal: "SIGTERM",
	} satisfies InteractiveLoginResult);
	assert.deepEqual(calls, ["stop", "start", "render:true"]);
});

test("runInteractiveLogin restores TUI and returns spawn errors instead of throwing", async () => {
	const { ctx, calls } = makeContext();
	const child = new FakeChild();
	const resultPromise = runInteractiveLogin("npx", ["-y"], ctx, () => child);
	const error = Object.assign(new Error("spawn npx ENOENT"), {
		code: "ENOENT",
	});

	child.emit("error", error);

	assert.deepEqual(await resultPromise, {
		status: "spawn-error",
		error: "ENOENT: spawn npx ENOENT",
	} satisfies InteractiveLoginResult);
	assert.deepEqual(calls, ["stop", "start", "render:true"]);
});

test("runInteractiveLogin does not spawn without an interactive UI", async () => {
	const { ctx } = makeContext(false);
	let spawned = false;

	const result = await runInteractiveLogin("npx", ["-y"], ctx, () => {
		spawned = true;
		return new FakeChild();
	});

	assert.equal(spawned, false);
	assert.deepEqual(result, {
		status: "unsupported",
	} satisfies InteractiveLoginResult);
});

test("fallback formatting is catalog-derived for Linear and Notion", () => {
	const linear = routeWorkspaceMcpConnector("linear");
	const notion = routeWorkspaceMcpConnector("notion");

	const linearNotification = formatInteractiveLoginResultNotification(linear, {
		status: "completed",
		code: 1,
		signal: null,
	});
	const notionNotification = formatInteractiveLoginResultNotification(notion, {
		status: "unsupported",
	});

	assert.equal(linearNotification.level, "error");
	assert.match(linearNotification.message, /mcp-remote-client/);
	assert.match(linearNotification.message, /https:\/\/mcp\.linear\.app\/mcp/);
	assert.match(notionNotification.message, /mcp-remote-client/);
	assert.match(notionNotification.message, /https:\/\/mcp\.notion\.com\/mcp/);
});

test("signal-based login notification points to fallback guidance", () => {
	const route = routeWorkspaceMcpConnector("linear");
	const notification = formatInteractiveLoginResultNotification(route, {
		status: "completed",
		code: null,
		signal: "SIGTERM",
	});

	assert.equal(notification.level, "error");
	assert.match(notification.message, /signal SIGTERM/);
	assert.match(notification.message, /External shell fallback/);
});

test("connector-login invalid service preserves usage output without invoking custom TUI handoff", async () => {
	const previousToggle = process.env.ENABLE_WORKSPACE_CONNECTORS;
	process.env.ENABLE_WORKSPACE_CONNECTORS = "true";
	let customCalled = false;
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void> | void }
	>();
	const pi = {
		on: () => undefined,
		registerCommand: (name: string, options: unknown) => {
			commands.set(
				name,
				options as {
					handler: (args: string, ctx: unknown) => Promise<void> | void;
				},
			);
		},
		registerTool: () => undefined,
	} as unknown as ExtensionAPI;
	const notifications: Array<{ message: string; level: string | undefined }> =
		[];

	try {
		workspaceConnectorsExtension(pi);
		const command = commands.get("connector-login");
		assert.ok(command);
		await command.handler("jira", {
			hasUI: true,
			ui: {
				notify: (message: string, level?: string) =>
					notifications.push({ message, level }),
				custom: <T>() => {
					customCalled = true;
					return Promise.resolve(undefined as T);
				},
			},
		});
	} finally {
		if (previousToggle === undefined) {
			delete process.env.ENABLE_WORKSPACE_CONNECTORS;
		} else {
			process.env.ENABLE_WORKSPACE_CONNECTORS = previousToggle;
		}
	}

	assert.equal(customCalled, false);
	assert.deepEqual(notifications, [
		{ message: "Usage: /connector-login linear|notion", level: "error" },
	]);
});

test("successful login notification points to status guidance without fallback failure wording", () => {
	const route = routeWorkspaceMcpConnector("linear");
	const notification = formatInteractiveLoginResultNotification(route, {
		status: "completed",
		code: 0,
		signal: null,
	});

	assert.equal(notification.level, "info");
	assert.match(notification.message, /Run \/connector-tools linear/);
	assert.doesNotMatch(notification.message, /External shell fallback/);
});
