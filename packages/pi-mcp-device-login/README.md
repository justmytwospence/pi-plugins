# pi-mcp-device-login

`/mcp-code <server>` signs in to an OAuth MCP server with the device authorization grant (RFC 8628): approve a short code on any device instead of pasting a dead `127.0.0.1` redirect when Pi runs on another machine. Tokens go into Pi's own MCP credential store, so the built-in client sends and refreshes them.

The server needs `oauth.clientId` in `mcp.json` (a public client) and an authorization server with device grant enabled for it.

Docs: https://pi-plugins.vercel.app/plugins/pi-mcp-device-login/
