---
title: pi-mcp-device-login
description: Sign in to OAuth MCP servers with a device code when the browser runs on another machine, and let Pi keep and refresh the tokens.
plugin: pi-mcp-device-login
---

## Quick reference

- **Use it for:** Signing in to an OAuth MCP server from a Pi session whose browser is elsewhere (SSH, a phone, a web terminal), without pasting a dead `127.0.0.1` redirect URL.
- **Enable:** Select `packages/pi-mcp-device-login/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/mcp-code` opens a menu like `/mcp`'s: pick a server or All servers. `/mcp-code <server...>` or `/mcp-code all` skips the menu. Escape cancels a sign-in.
- **Settings:** None of its own. Reads the server's `url` and `oauth` (`clientId`, `scope`, `authServerMetadataUrl`) from Pi's `mcp.json` files.
- **Requirements, cost & privacy:** An authorization server that supports the device authorization grant (RFC 8628) for a pre-registered public client. Talks only to the server's own OAuth endpoints. No inference.
- **Integrations & limits:** Writes tokens into Pi's private `mcp-auth.json` format, so a Pi update that changes it needs this entry updated. Public clients only: a server whose `oauth` sets `clientSecret` is refused.

## Purpose and selection

Pi's built-in MCP sign-in (`/mcp login`) sends the browser back to a loopback URL such as `http://127.0.0.1:8765/callback`. When Pi runs on another machine, that page does not load and the redirected URL has to be pasted into Pi by hand. The device authorization grant avoids the redirect: Pi asks the authorization server for a short code, you approve it on any device, and Pi collects the tokens by polling.

Entry: `packages/pi-mcp-device-login/src/index.ts`.

## How a sign-in runs

1. The entry reads the server from `~/.pi/agent/mcp.json`, from a trusted project's `.pi/mcp.json` (whose entry wins), or from servers that extensions registered.
2. It reads the server's protected resource metadata (RFC 9728) for the authorization server, its scopes and resource, then the authorization server metadata (RFC 8414 or OpenID discovery) for the device and token endpoints. The issuer must match, and endpoints must use HTTPS. `oauth.authServerMetadataUrl` overrides this discovery as it does for Pi.
3. It requests a device code for `oauth.clientId` with the configured `oauth.scope`, or else the advertised scopes, and the server as `resource` (RFC 8707). A screen framed like Pi's own `/mcp` sign-in shows the approval link, the code and a countdown, one block per server.
4. It polls the token endpoint at the server's interval, slowing down when asked, until you approve, deny, press Escape, or the code expires. When every server signed in, the screen closes; otherwise it stays open with each server's result until you close it.
5. It stores the tokens in `~/.pi/agent/mcp-auth.json` under the same key Pi uses, removing any half-finished browser sign-in and cached discovery for that server. Pi refreshes them itself from then on. After the screen closes, the entry reloads the session if the agent is idle (Pi does not reconnect a server that failed, and extensions cannot reconnect one directly); during a turn it asks you to `/reload` afterwards.

Request `offline_access` (through `oauth.scope` or the server's advertised scopes) to get a refresh token; without one the session ends when the access token expires.

## Security

Approve only a code your own terminal just displayed. Device codes can be phished: anyone who gets you to approve their code receives the token. Authorization servers that remember consent may approve a known client without a prompt, which makes that check yours alone.

## Troubleshooting

- `does not support the device authorization grant`: the authorization server metadata has no `device_authorization_endpoint`, or the grant is not enabled for the client.
- `has no oauth.clientId`: device sign-in needs a pre-registered client; dynamic client registration is not attempted.
- Signed in, but the server still asks for sign-in: the authorization server may issue device-grant tokens that the resource server rejects (for example without its audience), or refuse refreshes for them. Check a token's claims and a refresh by hand before relying on it.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-mcp-device-login)
