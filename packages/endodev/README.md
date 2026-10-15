# Endodev

A declarative Endograph prefab for an autonomous development process helper.
Create one with `endo create endodev` or `npx endograph@latest create endodev`.
Bun and a signed-in Codex are required; setup and inception can use Claude Code
with `--harness claude`.

The package supplies owner templates, a conversational setup brief, and the TypeSafe/Jev
skill. The coding agent reads relevant repository context and user-referenced skills, then
asks focused clarifying questions before customizing the owner files. Inception writes the program and any procedures; the living agent owns its
methods, memory, and evolution. The default grant includes bash, scheduling, and
evolution, with no sandbox. The agent does not upgrade Endograph dependencies.

Setup writes checked-in owner files under `.endodev/` and a reference in the
parent `AGENTS.md`. Keep the generated lockfile. `.endo/`, `node_modules/`, and
`.env` are ignored. The same config can run independently in worktrees; each
instance is started explicitly and has a distinct directory-derived identity.

Testing choices are agnostic (no standing responsibility), own tests (run and
periodically prune according to the owner's philosophy), and custom prose.
Additional responsibilities are explicit owner choices. Edit the generated
manifest to change the mandate; creation never overwrites an existing instance.

The bundled TypeSafe skill (MIT) lives here, with its live documentation pointers intact;
the repository's `.agents/skills/typesafe-ai` is a symlink to it. Place Jev credentials
in `.endodev/.env` when needed; they are not part of the prefab or committed files.
