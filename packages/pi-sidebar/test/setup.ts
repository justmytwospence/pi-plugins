// Pi's interactive mode installs its app keybinding manager globally; tests do the same, so keys
// resolve through Pi's defaults (app.interrupt is Escape, app.tools.expand is Ctrl+O, and so on).
import { setKeybindings } from "@earendil-works/pi-tui";
// Loaded by path, as the suite's other tests do.
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

setKeybindings(new KeybindingsManager());

// Never read or write the user's remembered divider position.
process.env.PI_SIDEBAR_PREFS = `${process.env.TMPDIR ?? "/tmp"}/pi-sidebar-test-${process.pid}.json`;
