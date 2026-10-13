$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$certificateRoot = 'C:\CAFubon'
$certificates = @(Get-ChildItem -LiteralPath $certificateRoot -Filter '*.pfx' -File -Recurse -ErrorAction SilentlyContinue)
if ($certificates.Count -ne 1) {
    Write-Error '富邦預設資料夾內需要剛好一個 .pfx 憑證；若憑證在其他位置，請先確認檔案位置。'
    exit 1
}

function Convert-SecretToText([Security.SecureString]$secret) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

Write-Host '已找到富邦憑證。以下資料只在這次測試程序中使用，不會寫入檔案。'
$loginId = Read-Host '富邦登入 ID（輸入時不顯示）' -AsSecureString
$apiKey = Read-Host '富邦 API Key（輸入時不顯示）' -AsSecureString
$certificatePassword = Read-Host '憑證密碼（輸入時不顯示）' -AsSecureString
$names = @('FUBON_LOGIN_ID', 'FUBON_API_KEY', 'FUBON_CERT_PATH', 'FUBON_CERT_PASSWORD')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

try {
    [Environment]::SetEnvironmentVariable('FUBON_LOGIN_ID', (Convert-SecretToText $loginId), 'Process')
    [Environment]::SetEnvironmentVariable('FUBON_API_KEY', (Convert-SecretToText $apiKey), 'Process')
    [Environment]::SetEnvironmentVariable('FUBON_CERT_PATH', $certificates[0].FullName, 'Process')
    [Environment]::SetEnvironmentVariable('FUBON_CERT_PASSWORD', (Convert-SecretToText $certificatePassword), 'Process')
    Push-Location -LiteralPath $projectRoot
    try {
        & node 'scripts/check-fubon-snapshot.mjs'
        $result = $LASTEXITCODE
    } finally { Pop-Location }
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
exit $result
