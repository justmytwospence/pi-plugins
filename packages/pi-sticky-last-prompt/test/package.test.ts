import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import stickyLastPrompt from "../src/index.ts";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const sha256 = (name: string) => createHash("sha256").update(read(name)).digest("hex");

test("the independent manifest exposes the scoped entry point and only host-supplied runtime peers", () => {
  const manifest = JSON.parse(read("package.json"));
  expect(manifest.name).toBe("@justmytwospence/pi-sticky-last-prompt");
  expect(manifest.private).toBe(true);
  expect(manifest.type).toBe("module");
  expect(manifest.license).toBe("MIT");
  expect(manifest.pi).toEqual({ extensions: ["./src/index.ts"] });
  expect(manifest.dependencies ?? {}).toEqual({});
  for (const importedHost of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    expect(manifest.peerDependencies[importedHost]).toBe("*");
  }
  const hostPeers = new Set([
    "@earendil-works/pi-ai", "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
  ]);
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    expect(hostPeers.has(name)).toBe(true);
    expect(range).toBe("*");
  }
  expect(manifest.devDependencies["@earendil-works/pi-coding-agent"]).toBe("1.2.0");
  expect(manifest.devDependencies["@earendil-works/pi-tui"]).toBe("1.2.0");
  expect(manifest.repository.directory).toBe("packages/pi-sticky-last-prompt");
  expect(typeof stickyLastPrompt).toBe("function");
  for (const file of manifest.files) expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(true);
  expect(manifest.files).toEqual(["src", "README.md", "LICENSE", "UPSTREAM.md", "UPSTREAM-CHANGELOG.md"]);
});

test("the component lockfile agrees with its manifest without a root install", () => {
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  expect(lock.name).toBe(manifest.name);
  expect(lock.version).toBe(manifest.version);
  expect(lock.packages[""].devDependencies).toEqual(manifest.devDependencies);
  expect(lock.packages[""].peerDependencies).toEqual(manifest.peerDependencies);
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    expect(lock.packages[`node_modules/${name}`].version).toBe("1.2.0");
  }
});

test("MIT attribution and imported changelog retain exact installed upstream bytes", () => {
  expect(read("LICENSE")).toContain("Copyright (c) 2025 pi-collections contributors");
  expect(sha256("LICENSE")).toBe("1ca4eccf5be4ec4f5bdfcded8f23dff4f72dff34edc14445e9f40c6abf933ac4");
  expect(sha256("UPSTREAM-CHANGELOG.md")).toBe("84b669a4e12b1c3af9be2f9759b4b01ba25e87c0059fcfe4d3cb326cfc8fa3b8");
  const provenance = read("UPSTREAM.md");
  expect(provenance).toContain("pi-sticky-last-prompt@0.1.1");
  expect(provenance).toContain("b6cbcbe37e7d148027f02070047159617b7b743a40b58e35e6e47b64ec2b0e7e");
  expect(provenance).toContain("git+https://github.com/tangentyh/pi-collections.git");
});
