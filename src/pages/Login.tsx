import { useState } from 'react'
import { signInAndSave } from '../lib/auth'
import { Eye, EyeOff, LogIn } from 'lucide-react'

export default function Login() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [showPw, setShowPw] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')

    const handleLogin = async () => {
        if (!email || !password) { setError('請輸入帳號和密碼'); return }
        setLoading(true); setError('')
        try {
            await signInAndSave(email, password)
        } catch (err: unknown) {
            const code = typeof err === 'object' && err !== null && 'code' in err
                ? String(err.code)
                : ''
            if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
                setError('帳號或密碼錯誤')
            } else if (code === 'auth/too-many-requests') {
                setError('登入嘗試次數過多，請稍後再試')
            } else if (code === 'auth/invalid-email') {
                setError('電子郵件格式不正確')
            } else {
                setError('登入失敗，請稍後再試')
            }
        }
        setLoading(false)
    }

    return (
        <div className="login-screen" style={{ backgroundColor: '#0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
            <div style={{ width: '100%', maxWidth: '400px' }}>

                {/* Logo */}
                <div style={{ textAlign: 'center', marginBottom: '40px' }}>
                    <div style={{ width: '56px', height: '56px', backgroundColor: '#4f8ef7', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: '24px' }}>
                        ⚡
                    </div>
                    <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#e2e8f0', margin: '0 0 8px' }}>個人系統</h1>
                    <p style={{ fontSize: '14px', color: '#8892a4', margin: 0 }}>Personal Dashboard</p>
                </div>

                {/* 登入卡片 */}
                <div style={{ backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '16px', padding: '32px' }}>
                    <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#e2e8f0', margin: '0 0 24px' }}>登入</h2>

                    {/* 錯誤訊息 */}
                    {error && (
                        <div style={{ backgroundColor: 'rgba(255,87,87,0.1)', border: '1px solid rgba(255,87,87,0.3)', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', color: '#ff5757', fontSize: '13px' }}>
                            {error}
                        </div>
                    )}

                    {/* Email */}
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '6px' }}>電子郵件</label>
                        <input
                            type="email"
                            autoComplete="email"
                            inputMode="email"
                            placeholder="your@email.com"
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleLogin()}
                            style={{ backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '10px 14px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box', transition: 'border-color 0.2s' }}
                            onFocus={e => e.target.style.borderColor = '#4f8ef7'}
                            onBlur={e => e.target.style.borderColor = '#2e3349'}
                        />
                    </div>

                    {/* 密碼 */}
                    <div style={{ marginBottom: '24px' }}>
                        <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '6px' }}>密碼</label>
                        <div style={{ position: 'relative' }}>
                            <input
                                type={showPw ? 'text' : 'password'}
                                autoComplete="current-password"
                                placeholder="••••••••"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                                style={{ backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '10px 42px 10px 14px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box', transition: 'border-color 0.2s' }}
                                onFocus={e => e.target.style.borderColor = '#4f8ef7'}
                                onBlur={e => e.target.style.borderColor = '#2e3349'}
                            />
                            <button type="button" aria-label={showPw ? '隱藏密碼' : '顯示密碼'} onClick={() => setShowPw(v => !v)}
                                style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', display: 'flex' }}>
                                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                        </div>
                    </div>

                    {/* 登入按鈕 */}
                    <button type="button" onClick={handleLogin} disabled={loading}
                        style={{ width: '100%', backgroundColor: loading ? '#3a6fd4' : '#4f8ef7', border: 'none', borderRadius: '10px', padding: '12px', color: '#fff', fontSize: '15px', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', transition: 'background-color 0.2s' }}>
                        <LogIn size={18} />
                        {loading ? '登入中...' : '登入'}
                    </button>
                </div>
            </div>
        </div>
    )
}
