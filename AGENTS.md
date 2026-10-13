# Project instructions

## Codex / Claude Code collaboration

Shared collaboration files live outside this repository in `../ai-collaboration/`.
For shared work, read its `RULES.md` and current `STATUS.md`, then only the relevant
task and handoff. Each task has one implementation owner; the other agent reviews
without editing application files until ownership is explicitly handed over.
Preserve pre-existing changes and distinguish agent suggestions from user
authorization. Keep all handoff content outside builds and deployments.
These project instructions remain the source of application rules.

## Deployment approval

Do not deploy automatically after fixes or updates. Finish the requested changes and local verification first, then wait for the user's explicit approval to deploy the completed batch together. Prior deployment approvals do not authorize later batches. This applies to Netlify and Firebase deployments and production configuration changes.

## Verification and usage

Run the necessary tests for each change after identifying its full impact. Cover the modified behavior and all affected callers, shared dependencies, data read/write paths, and downstream user workflows; a focused scope must not omit related features. Avoid unrelated tests. Run the full suite when broad impact (such as shared authentication or data schemas) cannot be safely bounded, the affected scope is unclear, or a release requirement calls for it; do not run it merely because an update was made. Do not repeat passing checks without new changes, failures, or unresolved concerns. Keep file reads, tool output, and status reports focused to reduce token usage while preserving necessary verification.

## Brokerage scope

The user uses one brokerage account (Yuanta Securities). Do not add multi-broker support or make it a prerequisite for current work unless the user changes this requirement.

## Saved account passwords

User decision (2026-10-13): keep the existing saved-account password storage and seamless account switching (`src/lib/accountStore.ts`, `signInAndSave`/`switchAccount` in `src/lib/auth.ts`). Do not remove or weaken this feature, and do not propose removing it in reviews or roadmaps unless the user raises it again.

## Git commits

After each completed update/fix batch passes its local verification, commit it and push it to the GitHub remote (`origin`). Review staged files first; never commit `.env`, credentials, service accounts, `local-secrets/`, logs, debug output or other local artifacts. Pushing to Git is not deployment approval: production deployments still follow the deployment approval rule above, so confirm a push will not trigger an automatic Netlify or Firebase deployment.

## Cash-flow timing

The user's default performance assumption is deposits after market close on the actual transfer date, often to fund settlement after buying stocks. Do not backdate deposits to the trade date or assume they occur before the open. Ordinary asset trends and estimated performance use recorded daily snapshots, including legacy, manual and intraday values; do not require closing confirmation or show its controls/status labels. Newly captured quotes must be valid and dated that day. Keep manual exact TWR optional and retain its saved data. Do not relabel intraday or unverified legacy snapshots as verified closing valuations.

## Interface preferences

Keep icons, status dots, disclosure arrows, and their text aligned on both PC and mobile. Use shared alignment and spacing rules; expanding details must not shift a status dot away from its label or move the summary's right edge. Verify desktop as well as portrait, landscape, and narrow phone layouts when changing shared interface components.

Retain the system's original light/dark palette, including the original blue-purple accent and asset-distribution colors. UI consistency work should unify component styling, alignment and spacing without introducing a new palette unless the user explicitly requests it.

Interface preferences: retain the manual exact TWR implementation and saved data but hide its normal entry until requested. Hide the automatic performance explanation card in AssetTrend; retain all performance calculations and data. For successful KMS searches, show only the total notes searched; show retry only after search failure.

Mobile interfaces should default to a compact, information-dense layout. Prioritize showing more useful information per screen: reduce unnecessary whitespace, card padding and row height, and keep short actions inline where practical. Preserve readable text, usable touch targets and visible important information. Charts and tables may use the space they need for readability and interaction, while still avoiding unnecessary whitespace. Apply this to both portrait and landscape phone layouts, including future features.

## Version labels

User preference: whenever updating or fixing this system, update `APP_VERSION` in `src/lib/appVersion.ts` to the work date in Asia/Taipei, formatted `vYY.M.D.N` (for example, `v26.9.9.1`). Use two-digit year and unpadded month/day. N is the daily revision: start at 1 for a new date and increment for each subsequent completed update/fix batch on that date. Keep one revision for a continuous batch, including retries, verification fixes, and "continue" messages; do not increment for each file edit, test run, or status-only response. When migrating a legacy date-only label, start its first numbered revision at 1 without retroactively numbering earlier changes. This is the date of the code update, not the current viewing date, so do not calculate it at runtime. Keep the displayed version in `src/App.tsx` sourced from this constant. Do not change backup schema versions or package semver just to match this display label.
