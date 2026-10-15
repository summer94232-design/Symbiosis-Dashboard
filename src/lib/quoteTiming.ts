// Include proxy startup, login verification and shared-quota transactions.
// The batch bound includes time spent waiting behind other symbols.
export const QUOTE_PROXY_TIMEOUT_MS = 20_000
// The market snapshot also verifies login and may initialize the native SDK.
// Production successful responses can take more than the old eight-second bound.
export const FUBON_SNAPSHOT_TIMEOUT_MS = 20_000
export const QUOTE_REFRESH_TIMEOUT_MS = 60_000
