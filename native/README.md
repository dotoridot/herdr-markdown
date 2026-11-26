# Native host extension

The complete Rich editor currently requires a macOS build of Herdr with the local WebView host extension. This directory contains the patch, including the local terminal Markdown link route and per-document text palettes used by the fallback preview.

The upstream base is Herdr App 0.1.18, pinned in `base.json`. Apply the patch to that exact revision.

```sh
git clone https://github.com/herdrdev/herdr-app.git
cd herdr-app
git checkout 9a9ae13d998e6ed74c76e8eb13bdeb2e1420f50c
git submodule update --init --depth 1 vendor/ghostty
git apply /absolute/path/to/herdr-markdown/native/herdr-markdown-host.patch
cargo build --release --locked --bin herdr-app
```

Use the upstream build prerequisites, including the pinned Rust dependencies, macOS SDK, and Zig 0.16 for the terminal library. This patch does not update or restart herdr-core.

Test the resulting app in a separate `HERDR_APP_HOME` and a dedicated `HC_SESSION`. Clear inherited terminal-specific HC environment variables before launching the candidate. Copy the mod into that separate home, then run its check with the same explicit home. Keep the usual app and existing sessions intact until native UI validation succeeds.

Finder drops on the document editor open one local Markdown file. Drops on a terminal retain the Herdr 0.1.18 behavior of pasting paths. Cmd-clicking a local Markdown path in a terminal opens a document tab.

## Mod API

```js
import {WebViewState, WebView} from 'gpui-base';

// Create retained state in init(), then register message handling.
this.page = WebViewState.new({
  asset_root: '/absolute/path/to/the/mod/editor',
  entry: 'index.html',
});
this.page.on('message', (message, cx) => {
  // The page sends JSON through window.ipc.postMessage(string).
});

// After the page's ready message, send JSON strings to its message event.
this.page.post_message(JSON.stringify({type: 'example'}));

// Return this from render(). Release the retained state in close().
WebView.new(this.page).size_full();
```

The asset root itself must be inside the script's read grants. The host retains a capability directory and opens assets relative to it. Absolute paths, parent traversal, and links outside the root are rejected. Messages are limited to 8 MiB, assets to 16 MiB. An unbounded event queue preserves a Save request after large image-message bursts without blocking the UI thread.

The page has only bundled local assets. Network requests, frames, external navigation, popups, and arbitrary HTML execution from document content are excluded. The owning mod supplies file operations using its existing host capabilities.

The patch also includes a vendored lb-wry editing-shortcut correction for focused child WebViews. Native document activation follows Herdr's existing pane-focus route, and GPUI cursor rectangles exclude visible native child views. These host corrections require an OS-level retest; compilation and geometry tests alone do not establish keyboard or cursor behavior.

## Native limitations

- The host extension is currently implemented for macOS. Other platforms show an explicit unsupported notice.
- The GPUI pre backend places the native WebView above GPUI elements. The app hides document surfaces while a non-toast GPUI overlay is open, then reveals the same retained page when it closes.
- A partially clipped surface uses its visible intersection as its native frame.
- GPUI screenshots can omit native WebViews. Validate with an OS window capture.
- Browser unit tests are separate from native keyboard, IME, focus, and visibility validation. Check `VALIDATION.md` before treating a build as an installed release.

Native page visibility and focus ownership follow the current script generation after a mod reload. In the app's normal close and reload paths, context-aware retirement hides the native surface immediately even when a rendered frame retains it. Cleanup without an app context remains best-effort and can defer destruction until the retained frame drops. Focus returns to the parent only when that page owns the AppKit first responder. These lifecycle paths have host regression tests; actual OS keyboard recovery remains a separate manual check.
