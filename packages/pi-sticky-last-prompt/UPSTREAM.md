# Upstream provenance

This component derives from the installed npm artifact **`pi-sticky-last-prompt@0.1.1`**, not from a claimed Git revision.

Verified read-only source directory:

```text
/Users/spencerboucher/.pi/agent/npm/node_modules/pi-sticky-last-prompt
```

Its `package.json` identifies:

- Name: `pi-sticky-last-prompt`
- Version: `0.1.1`
- License: `MIT`
- Repository: `git+https://github.com/tangentyh/pi-collections.git`
- Repository directory: `extensions/sticky-last-prompt`
- Homepage: `https://github.com/tangentyh/pi-collections/tree/main/extensions/sticky-last-prompt`
- Pi entry point: `./sticky-last-prompt.ts`

The read-only install lockfile at `/Users/spencerboucher/.pi/agent/npm/package-lock.json`, entry `packages["node_modules/pi-sticky-last-prompt"]`, records:

```text
resolved: https://registry.npmjs.org/pi-sticky-last-prompt/-/pi-sticky-last-prompt-0.1.1.tgz
integrity: sha512-lj9ggIQK7qqPkk2BA/XfkCmwySVqCrnZA/AcQIfFW0iaN7qbIiItwXWUAyKceGFJTYcgY6LAJPZHqJBeWwHmjA==
```

The integrity above is lockfile metadata, not a newly downloaded/reverified tarball. No upstream Git commit is asserted; the installed artifact does not identify one.

## Installed file fingerprints

SHA-256 of the actual read-only installed files (all five shipped files):

| File | SHA-256 |
| --- | --- |
| `sticky-last-prompt.ts` | `b6cbcbe37e7d148027f02070047159617b7b743a40b58e35e6e47b64ec2b0e7e` |
| `package.json` | `f98c1d3cb10990b4fba9273cf1699e7f553b83fdcfe0aba7ba586ad0f64137b6` |
| `README.md` | `47cbd356fc95cba4197ffc00fcbeb1c1b34678fc8e46505460066bcdfa696aa1` |
| `LICENSE` | `1ca4eccf5be4ec4f5bdfcded8f23dff4f72dff34edc14445e9f40c6abf933ac4` |
| `CHANGELOG.md` | `84b669a4e12b1c3af9be2f9759b4b01ba25e87c0059fcfe4d3cb326cfc8fa3b8` |

`LICENSE` is retained byte-for-byte, including `Copyright (c) 2025 pi-collections contributors`. The upstream `CHANGELOG.md` is retained byte-for-byte as `UPSTREAM-CHANGELOG.md`. Source moved to `src/index.ts` and is modified; the upstream manifest and README are replaced with independent suite-component metadata and documentation.

## Local changes

- Independent package manifest, SDK 1.1.0 development pins, scoped strict typecheck/tests, and no sibling runtime dependencies.
- Public SDK 1.1 `handleMouse` routing replaces the upstream `handleSelectionMouseEvent` patch.
- Real renderer acquisition accounts for SDK 1.1's stable TUI proxy; wrapper cleanup uses exact instance/function identity, yields to existing owners, and leaves newer wrappers intact.
- Instance-specific widget ownership, disposal, generation guards and idempotent shutdown protect reload/rebinding and overlapping copies.
- Live transcript remeasurement fixes nested/in-place same-height rebuilds, resize/scrollbar width changes and expanded skills. Exact clear markers add no rows; the latest prompt stays pinned after a clear.
- Boundary visibility, narrow/wide text rendering, fresh theme lookup and stale-click validation are covered by regression tests and in-memory SDK tests.

No upstream installed file was changed. This provenance file is package-local; it does not update the suite's root import ledger.
