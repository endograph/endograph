# Endograph teaser

Static site: no dependencies or build step. Serve this directory with any static
HTTP server, or open `index.html` directly.

Hover or click a stage to open its panel. Click the close button or press Escape
to dismiss it. Keyboard users can activate all controls with Enter or Space.
Panels stay open while reading; touch devices open them on tap. Reduced-motion
preferences disable transitions.

The header's theme control follows Sidecar's sliding-drop design. Click to cycle
through system, light, dark, and ink. Light mode uses warm tan tones; dark mode uses black, white, and neutral greys.
Ink is the default; a saved choice takes precedence. Ink picks a random hue and
its complement on each page load and each time you cycle back into it. System
mode follows the OS preference. The mode stays in this site's local storage.

Install also opens on hover. GitHub previews the repository README on hover or
keyboard focus; clicking it opens the repository in a new tab. The install panel
contains a copyable prompt for exploring Endograph with a coding agent.

The README panel is generated from the root README and committed as HTML. After
editing that README, run `bun site/sync-readme.js` to refresh the panel. There is
no browser fetch or Markdown dependency.

The sandbox controls change an illustrative configuration, not a live agent.
The manifest, inception report, and evolution story describe the same fictional
release watcher. The report is explanatory copy, not captured CLI output.

The `Deploy marketing site` workflow publishes to
https://endograph.github.io/endograph/ when site files, the root README, or the
workflow change on `main`. It refreshes the README panel and uploads only
`index.html`, `style.css`, and `site.js`. It can also run manually from Actions.
All asset paths are relative, so it works under a repository path or a custom
domain.
