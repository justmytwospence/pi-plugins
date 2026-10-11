import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "../src/git.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function fakeChild(writeError?: Error) {
	const child = Object.assign(new EventEmitter(), {
		stdin: new Writable({
			write(_chunk, _encoding, callback) {
				callback(writeError);
			},
		}),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	});
	vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
	return child;
}

const pipeError = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

describe("git stdin errors", () => {
	it.each([0, 128, null])("preserves exit code %s and output after early stdin closure", async (code) => {
		// A real Writable emits an asynchronous error when its write callback fails.
		// Inject the broken pipe rather than depending on OS pipe buffering/timing.
		const child = fakeChild(pipeError());
		const stdinClosed = new Promise<void>((resolve) => child.stdin.on("close", resolve));
		const result = git("/repo", ["rev-parse", "HEAD"], { input: "input" });
		const settled = vi.fn();
		void result.then(settled);
		await stdinClosed;
		expect(settled).not.toHaveBeenCalled();
		child.stdout.write("git output\n");
		child.stderr.write("git diagnostics\n");
		child.emit("close", code);
		await expect(result).resolves.toEqual({ code: code ?? -1, stdout: "git output\n", stderr: "git diagnostics\n" });
	});

	it.each(["EIO", undefined])("reports other stdin errors (%s) as failures", async (code) => {
		const error = Object.assign(new Error("stdin failed"), { code });
		const child = fakeChild(error);
		const stdinClosed = new Promise<void>((resolve) => child.stdin.on("close", resolve));
		const result = git("/repo", [], { input: "input" });
		await stdinClosed;
		child.emit("close", 0);
		await expect(result).resolves.toEqual({ code: -1, stdout: "", stderr: String(error) });
	});

	it.each(["ENOENT", "EPIPE"])("preserves process error semantics for %s", async (code) => {
		const child = fakeChild();
		const result = git("/repo", []);
		const error = Object.assign(new Error("process failed"), { code });
		child.emit("error", error);
		child.emit("close", -1);
		await expect(result).resolves.toEqual({ code: -1, stdout: "", stderr: String(error) });
	});

	it("preserves output-limit semantics despite stdin EPIPE", async () => {
		const child = fakeChild(pipeError());
		const stdinClosed = new Promise<void>((resolve) => child.stdin.on("close", resolve));
		const result = git("/repo", [], { input: "input", maxBytes: 2 });
		child.stdout.write("ok");
		child.stdout.write("too large");
		await stdinClosed;
		expect(child.kill).toHaveBeenCalledOnce();
		child.emit("close", null);
		await expect(result).resolves.toEqual({ code: -2, stdout: "ok", stderr: "output too large" });
	});
});
