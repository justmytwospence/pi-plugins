// node-pty 1.1.0 ships its macOS spawn-helper without executable mode.
// Repair only that published binary, for both standalone and suite installs.
const fs = require("node:fs");
const path = require("node:path");
if (process.platform === "darwin") {
  const dir = path.dirname(require.resolve("node-pty/package.json", { paths: [process.cwd()] }));
  for (const relative of [`prebuilds/darwin-${process.arch}/spawn-helper`, "build/Release/spawn-helper"]) {
    const helper = path.join(dir, relative);
    if (fs.existsSync(helper)) {
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, mode | 0o111);
    }
  }
}
