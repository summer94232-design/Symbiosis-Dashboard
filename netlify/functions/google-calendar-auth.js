// netlify/functions/google-calendar-auth.js
// ──────────────────────────────────────────────────────────────
// Google OAuth2 授權碼交換
//
// 流程：
//   1. 前端把使用者導去 Google 的授權頁（access_type=offline, prompt=consent）
//   2. Google 導回這支 function，網址帶著 ?code=xxx
//   3. 這支 function 用 GOOGLE_CLIENT_SECRET（只存在 Netlify 環境變數，前端拿不到）
//      向 Google 換取 access_token + refresh_token
//   4. 換完後，把 token 放在 URL fragment（#...）導回 /calendar 頁面
//      → fragment 不會被送到伺服器、也不會出現在 Netlify 的存取紀錄裡
//   5. 前端（CalendarSettings.tsx）讀取 fragment，用目前登入的 investAuth
//      把 refresh_token 寫進該使用者自己的 Firestore 路徑
//
// 這支 function 全程不連 Firestore、不需要 firebase-admin，
// 唯一職責就是「用 Client Secret 跟 Google 換 token」這件無法在前端做的事。
// ──────────────────────────────────────────────────────────────

const SITE_ORIGIN = 'https://symbiosis-jiawei.netlify.app'
const REDIRECT_URI = `${SITE_ORIGIN}/.netlify/functions/google-calendar-auth`
// ⚠️ 這裡一定要對到 App.tsx 裡實際掛載 <CalendarSettings /> 的路由，
// 因為只有那個頁面會讀取下面的 URL fragment、把 token 存進 Firestore。
const FRONTEND_RETURN_PATH = '/calendar/settings'

export const handler = async (event) => {
    const code = event.queryStringParameters?.code
    const oauthError = event.queryStringParameters?.error

    if (oauthError) {
        return redirectWithError(`使用者拒絕授權或發生錯誤：${oauthError}`)
    }
    if (!code) {
        return redirectWithError('缺少授權碼（code）')
    }

    try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code',
            }),
        })

        const tokenData = await tokenRes.json()

        if (!tokenRes.ok) {
            console.error('[google-calendar-auth] 換 token 失敗：', tokenData)
            return redirectWithError(tokenData.error_description || tokenData.error || '換取 token 失敗')
        }

        const { access_token, refresh_token, expires_in } = tokenData

        if (!refresh_token) {
            // 常見原因：這個 Google 帳號先前已經授權過，這次沒有真的跳出同意畫面，
            // Google 只有在「新授權 / prompt=consent」時才會回傳 refresh_token。
            return redirectWithError(
                '未取得 refresh_token，請到 Google 帳號的「第三方應用程式存取權」頁面移除本應用的授權後，再重新連結一次'
            )
        }

        const params = new URLSearchParams({
            gcal_access_token: access_token,
            gcal_refresh_token: refresh_token,
            gcal_expires_in: String(expires_in ?? ''),
        })

        return {
            statusCode: 302,
            headers: { Location: `${SITE_ORIGIN}${FRONTEND_RETURN_PATH}#${params.toString()}` },
            body: '',
        }
    } catch (err) {
        console.error('[google-calendar-auth] 例外：', err.message)
        return redirectWithError('伺服器錯誤，請稍後再試')
    }
}

function redirectWithError(message) {
    const params = new URLSearchParams({ gcal_error: message })
    return {
        statusCode: 302,
        headers: { Location: `${SITE_ORIGIN}${FRONTEND_RETURN_PATH}#${params.toString()}` },
        body: '',
    }
}