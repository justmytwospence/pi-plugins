# pi-clear-screen

A [pi](https://pi.dev) extension: `ctrl+l` clears the screen the way a shell does.
The transcript is pushed up out of view, new output starts at the top, and scrolling
up still shows everything. Nothing is removed from the session or the model context.

pi has no clear action, so this works on the fullscreen transcript directly: it
appends an invisible marker to the chat and pads the transcript until the marker is
the first visible row. As new output arrives the padding shrinks to nothing, so no
blank page is left in the history. The marker is ephemeral; `/new`, `/resume` and
`/reload` drop it.

Only fullscreen mode (`"tuiMode": "fullscreen"`) has an application-owned transcript.
In regular mode the terminal owns scrollback and `ctrl+l` just says so.

The extension reaches into pi's transcript layout, which is not public API. If a pi
release changes it, `ctrl+l` reports that instead of misbehaving.

## Install

```sh
pi install git:github.com/justmytwospence/pi-clear-screen
```

`ctrl+l` opens the model selector by default. Move that elsewhere in
`~/.pi/agent/keybindings.json`, for example:

```json
{ "app.model.select": "alt+m" }
```

## Development

```sh
npm install
npm run check   # tsc against pi's types
```
