# pi-reload-all

`/reload-all` reloads every interactive Pi session on this machine and on Herdr's saved machines (`herdr machine list`). Each session reloads itself once its turn has ended, nothing is queued and its editor is empty, so running turns and half-written drafts are never interrupted. `/reload-all --local` signals only this machine.

Nothing is typed into other panes. The command writes `reload-request` in Pi's agent directory (over `ssh -o BatchMode=yes` for other machines); every session running this extension watches the file. Anything else that writes it, such as a package-update script after installing a new pin, triggers the same reload.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-reload-all/>.

## Install

Merge this object into the `packages` array of `~/.pi/agent/settings.json`:

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-reload-all/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Every session that should be reloaded needs this entry. To try it from a checkout: `pi -e ./packages/pi-reload-all`.

## Development

```sh
npm ci
npm run check
```
