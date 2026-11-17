# Validation

Current status: experimental candidate. Native UI validation found issues that need correction before installation or catalog registration.

- Headless browser and bridge tests cover Rich/Source editing, save request contents, compare-and-swap conflicts, failed-open recovery, inline code angle brackets, local fonts, Docpilot themes, narrow layout, visible Source focus, and frontmatter/HTML preservation.
- The angle-bracket test failed against the prior parser before its fix. The failed-open and stale-save tests failed against the initial editor bridge before their fixes.
- The native host has passed an app compile check and focused host/asset tests. Native filesystem capability confinement received a separate independent review and correction.
- Headless browser tests do not establish actual native keyboard/IME behavior, installed tab restoration, or public catalog indexing.

The x86_64 macOS UI run used editor `c02254d` and native host `97a3722f`:

- Verified real Rich/Source input, Korean IME, Save and Cmd+S, Undo/Redo, tab scroll and unsaved draft retention, selection readability, Light/Dark switching, literal angle brackets, control-character preservation, popup dismissal, 320px width, 200% app zoom, conflict rejection, and failed-open recovery.
- Failed expectations: Cmd+B, Copy/Paste, split-pane focus tracking, link Back viewport restoration, and the OS text cursor. These observations do not yet establish the root cause in each case.
- Still unverified: exact restored caret/selection range, the actual native font family, and control/raw-fragment clipboard round trips.

Corrections and a native retest are required. This status does not claim that the candidate is installed or that Herdr Mods has indexed it.

Editor `ab45a03` adds a clean-document link/Back selection regression that fails on the earlier editor and passes after saving the outgoing snapshot. Native host `fda6de4c` corrects child WebView shortcut routing, pane-focus activation, and cursor ownership. Its app compile check, seven shell tests, one cursor geometry test, and arm64/x86_64 release builds pass. Independent static reviews approve these changes. The corrected pair still needs its native UI retest.

Manual use of the corrected main runtime exposed page visibility and keyboard recovery defects after mod reload/close. Native host `b394efe6` addresses them: three lifecycle regressions fail on the prior host and pass after the fix; ten WebView tests, the app compile check, and the arm64 release build pass. The corrected build still needs manual OS confirmation.
