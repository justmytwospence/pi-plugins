# Mermaid (vendored)

`mermaid.min.js` is `dist/mermaid.min.js` from the npm package `mermaid@12.1.0` (MIT, see `LICENSE`).
The rendered plan pages load it from here to draw ` ```mermaid ` blocks, so nothing comes from the network
and the plugin does not install Mermaid's 120 MB of npm dependencies.

SHA-256: `6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2`

To update it, pick a release at least seven days old, then:

```sh
npm pack mermaid@<version>
tar xzf mermaid-<version>.tgz package/dist/mermaid.min.js package/LICENSE
mv package/dist/mermaid.min.js package/LICENSE vendor/mermaid/
shasum -a 256 vendor/mermaid/mermaid.min.js
```

Then update the version and checksum above.
