export const GOOGLE_ACCOUNT_EMAIL = 'summer94232@gmail.com'
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'
export const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
export const GOOGLE_DRIVE_SEARCH_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly'
export const GOOGLE_DATA_SCOPES = [GOOGLE_CALENDAR_SCOPE, GOOGLE_SHEETS_SCOPE, GOOGLE_DRIVE_SEARCH_SCOPE]
export const GOOGLE_AUTH_SCOPES = [...GOOGLE_DATA_SCOPES, 'openid', 'email']

export function hasGoogleSheetsAuthorization(connection) {
    return connection?.googleEmail === GOOGLE_ACCOUNT_EMAIL
        && Array.isArray(connection.grantedScopes)
        && connection.grantedScopes.includes(GOOGLE_SHEETS_SCOPE)
}

export function hasGoogleDriveSearchAuthorization(connection) {
    return connection?.googleEmail === GOOGLE_ACCOUNT_EMAIL
        && Array.isArray(connection.grantedScopes)
        && connection.grantedScopes.includes(GOOGLE_DRIVE_SEARCH_SCOPE)
}

export function hasGoogleReportAuthorization(connection) {
    return hasGoogleSheetsAuthorization(connection) && hasGoogleDriveSearchAuthorization(connection)
}
