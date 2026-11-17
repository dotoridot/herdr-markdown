# Herdr Markdown

A local Markdown editor for Herdr, with **Source** and editable **Rich** views, explicit **Light / Dark** themes, and bundled fonts.

> Experimental macOS host extension required. This is a community mod, not a built-in Herdr feature. The bundled native patch provides the `WebViewState` / `WebView` APIs used by the editor. A stock Herdr build cannot provide Rich editing just by copying this mod.

## Editing

- Type directly into the formatted document in Rich, or edit Markdown in Source.
- Save with the **Save** button. The editor checks the file's original contents before writing. If another program changed the file, it keeps your draft and reports the conflict.
- Switching views preserves the draft. The native host keeps the same editor page while its tab is inactive, preserving scroll and selection.
- Reload asks before discarding unsaved changes. Unsaved drafts are also stored in Herdr's local mod storage for recovery; this is separate from saving the file.
- Light and Dark use Docpilot's neutral palette. Body text uses DM Sans and Noto Sans KR, headings and controls use Space Grotesk and Noto Sans KR, and code uses JetBrains Mono. All font files are local and include their OFL licenses.
- Tables, task lists, code blocks, and Mermaid diagrams work in Rich. Local document images are staged into the mod's local cache. External images are not fetched.

YAML frontmatter and raw HTML are preserved as inert source fragments. Use Source to edit those fragments. Opening a document or switching views leaves the original Markdown untouched. Rich edits can normalize Markdown spacing, delimiters, and line endings when serialized.

In Rich prose, existing C0 controls (except U+0009, U+000A, and U+000D) and DEL are preserved and shown as codes such as `[U+001C]`. Code spans, code blocks, and raw fragments retain their original text. Ordinary key input cannot insert these characters accidentally. Source and paste retain the original text; null bytes must be removed before saving a text document.

## Install

The native host patch and its matching base revision are in `native/`. Build and test the patched application separately before replacing your usual Herdr app. Keep your existing app and config available for rollback.

Copy `mods/rich-document/` into your Herdr app home's `mods/` directory. The usual home is `~/.config/herdr-app`. Preserve any existing mod under a different name before replacing it.

Open a document through the patched app's local terminal Cmd-click handler, or explicitly create a mod tab:

```sh
herdr-app do tab.new '{"name":"Markdown","mod":"rich-document","props":{"file":"/absolute/path/notes.md"}}'
```

Cmd-click handles existing local `.md`, `.markdown`, `.mdown`, and `.mkd` files. Remote terminal links retain Herdr's system opener behavior. Manually opened remote document props use the read-only native preview.

The editing limit is 1 MiB of UTF-8 text per file. Local image previews are limited to 16 MiB. The legacy read-only preview targets earlier patched builds; compatibility with stock Herdr releases is not verified. Its optional Mermaid renderer needs Node, Python 3, local Chrome/Chromium, and `npm ci` in `mods/rich-document/renderer/`.

## Develop

Use a separate app home and Core session for native testing so your live terminals remain untouched.

```sh
npm ci
npm run build
npm test
herdr-app check /absolute/path/to/mods/rich-document
```

The browser tests exercise the editor and its message contract. They do not prove native WebKit keyboard routing, IME, tab visibility, or installed app behavior. Native validation is recorded separately in `VALIDATION.md`.

The WebView page loads only bundled assets under its assigned root. It has no network or direct file access. File reads, compare-and-swap writes, local image staging, links, and Finder actions go through the owning Herdr mod. The read-only fallback can run Python and Node subprocesses for images and diagrams. Installing the mod grants it the normal capabilities of trusted Herdr mod code.

## Sharing

Herdr Mods discovers repositories through the `herdr-mod` topic, `RECIPE.md`, and `preview.png`. Repository publication and catalog indexing are separate: indexing is controlled by Herdr's catalog. See `VALIDATION.md` for release status.

## Licenses

Project source is Apache-2.0. Font licenses are under `mods/rich-document/editor/fonts/`. Bundled JavaScript notices accompany the editor bundle and Mermaid renderer. See `NOTICE` for upstream projects.
