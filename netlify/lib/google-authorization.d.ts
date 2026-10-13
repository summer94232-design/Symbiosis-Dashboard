export const GOOGLE_ACCOUNT_EMAIL: string
export const GOOGLE_CALENDAR_SCOPE: string
export const GOOGLE_SHEETS_SCOPE: string
export const GOOGLE_DRIVE_SEARCH_SCOPE: string
export const GOOGLE_DATA_SCOPES: string[]
export const GOOGLE_AUTH_SCOPES: string[]
export function hasGoogleSheetsAuthorization(connection?: {
    googleEmail?: string
    grantedScopes?: string[]
} | null): boolean
export function hasGoogleDriveSearchAuthorization(connection?: {
    googleEmail?: string
    grantedScopes?: string[]
} | null): boolean
export function hasGoogleReportAuthorization(connection?: {
    googleEmail?: string
    grantedScopes?: string[]
} | null): boolean
