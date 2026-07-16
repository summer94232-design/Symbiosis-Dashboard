import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import Login from './pages/Login.tsx'
import { onBothAuthChanged } from './lib/auth.ts'
import type { User } from 'firebase/auth'
import './index.css'

export function Root() {
    const [user, setUser] = useState<User | null | undefined>(undefined)

    useEffect(() => {
        // 同時等待 investAuth 和 kmsAuth 都完成初始化，再決定顯示 App 或 Login
        const unsub = onBothAuthChanged(u => setUser(u))
        return unsub
    }, [])

    // 載入中（兩個 Auth 都還沒回應）
    if (user === undefined) {
        return (
            <div style={{ minHeight: '100vh', backgroundColor: 'var(--c-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center', color: 'var(--c-muted)' }}>
                    <div style={{ fontSize: '24px', marginBottom: '12px' }}>⚡</div>
                    <p style={{ fontSize: '14px' }}>載入中...</p>
                </div>
            </div>
        )
    }

    // uid 改變時強制重新掛載整個 App，清除上一個帳號的頁面與 Context state。
    return user ? <App key={user.uid} /> : <Login />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <BrowserRouter>
            <Root />
        </BrowserRouter>
    </React.StrictMode>,
)
