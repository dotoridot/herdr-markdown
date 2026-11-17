# Validation

Current status: candidate implementation, native UI validation pending.

- Headless browser and bridge tests cover Rich/Source editing, save request contents, compare-and-swap conflicts, failed-open recovery, inline code angle brackets, local fonts, Docpilot themes, narrow layout, visible Source focus, and frontmatter/HTML preservation.
- The angle-bracket test failed against the prior parser before its fix. The failed-open and stale-save tests failed against the initial editor bridge before their fixes.
- The native host has passed an app compile check and focused host/asset tests. Native filesystem capability confinement received a separate independent review and correction.
- Headless browser tests do not establish actual native keyboard/IME behavior, installed tab restoration, or public catalog indexing.

Native checks and final release SHAs will be recorded after the candidate is verified. This status does not claim that the candidate is installed or that Herdr Mods has indexed it.
