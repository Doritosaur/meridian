import { useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { Key, User as UserIcon, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { TerminalCard } from './ui/terminal-card';
import { CRTEffect } from './ui/crt-effect';
import { API_BASE_URL } from '../config';

export function LoginScreen() {
    const [isRegistering, setIsRegistering] = useState(false);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [terminalLines, setTerminalLines] = useState<string[]>(['> SYSTEM_READY', '> AWAITING_AUTH...']);

    const { loginError, registerError, setUser, setLoginError, setRegisterError } = useAuthStore();

    const addLog = (msg: string) => setTerminalLines(prev => [...prev.slice(-4), msg]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setLoginError(null);
        setRegisterError(null);
        addLog(`> INITIATING_${isRegistering ? 'REGISTRATION' : 'LOGIN'}_SEQUENCE...`);

        try {
            const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            const data = await response.json();

            if (data.success) {
                addLog('> AUTH_SUCCESS. TOKEN_ACQUIRED.');
                setTimeout(() => setUser(data.user, data.token), 500);
            } else {
                const err = data.error || 'Operation failed';
                addLog(`> ERROR: ${err.toUpperCase()}`);
                if (isRegistering) {
                    setRegisterError(err);
                } else {
                    setLoginError(err);
                }
            }
        } catch (error) {
            console.error('Login/Register Error:', error);
            const errorMessage = 'CONNECTION_REFUSED';
            addLog(`> CRITICAL_FAILURE: ${errorMessage}`);
            if (isRegistering) {
                setRegisterError(errorMessage);
            } else {
                setLoginError(errorMessage);
            }
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-black text-primary font-mono relative overflow-hidden selection:bg-primary selection:text-black">
            <CRTEffect />

            <div className="z-10 w-full max-w-md">
                <TerminalCard title="MERIDIAN_NODE" subTitle="LOGIN_SHELL">
                    {/* Terminal Log Output */}
                    <div className="mb-6 font-mono text-xs opacity-70 border-l border-primary/30 pl-3">
                        {terminalLines.map((line, i) => (
                            <div key={i} className="mb-1">{line}</div>
                        ))}
                        <div className="animate-pulse">_</div>
                    </div>

                    <h1 className="text-3xl font-bold mb-1 tracking-tighter">ACCESS <span className="opacity-50">CONTROL</span></h1>
                    <p className="text-xs mb-8 opacity-70">ENTER CREDENTIALS TO PROCEED</p>

                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="space-y-1">
                            <label className="text-[10px] font-bold uppercase tracking-widest opacity-80">Codename</label>
                            <div className="relative group">
                                <UserIcon className="absolute left-3 top-3 w-4 h-4 opacity-50 group-focus-within:opacity-100 transition-opacity" />
                                <Input
                                    type="text"
                                    placeholder="USER_ID"
                                    value={username}
                                    onChange={e => setUsername(e.target.value)}
                                    className="pl-10 bg-black border-primary/50 text-primary placeholder:text-primary/30 rounded-none focus:border-primary focus:ring-0 h-10 font-mono"
                                    required
                                    disabled={isLoading}
                                />
                            </div>
                        </div>

                        <div className="space-y-1">
                            <label className="text-[10px] font-bold uppercase tracking-widest opacity-80">Secure HasH</label>
                            <div className="relative group">
                                <Key className="absolute left-3 top-3 w-4 h-4 opacity-50 group-focus-within:opacity-100 transition-opacity" />
                                <Input
                                    type="password"
                                    placeholder="PASSWORD"
                                    value={password}
                                    onChange={e => setPassword(e.target.value)}
                                    className="pl-10 bg-black border-primary/50 text-primary placeholder:text-primary/30 rounded-none focus:border-primary focus:ring-0 h-10 font-mono"
                                    required
                                    disabled={isLoading}
                                />
                            </div>
                        </div>

                        {(loginError || registerError) && (
                            <div className="text-xs border border-destructive text-destructive p-2 bg-destructive/20 font-bold uppercase">
                                [!] {loginError || registerError}
                            </div>
                        )}

                        <Button
                            type="submit"
                            className="w-full bg-primary hover:bg-primary/90 text-black font-bold py-6 rounded-none mt-6 group transition-all"
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <span className="flex items-center gap-2 animate-pulse">&gt; PROCESSING...</span>
                            ) : isRegistering ? (
                                <span className="flex items-center gap-2 uppercase">&gt; Init_Registration</span>
                            ) : (
                                <span className="flex items-center gap-2 uppercase">&gt; Execute_Login <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" /></span>
                            )}
                        </Button>
                    </form>

                    <div className="mt-6 text-center text-xs">
                        <button
                            onClick={() => {
                                setIsRegistering(!isRegistering);
                                setLoginError(null);
                                setRegisterError(null);
                                addLog(`> SWAP_MODE: ${!isRegistering ? 'REGISTER' : 'LOGIN'}`);
                            }}
                            className="hover:bg-primary hover:text-black px-2 py-1 transition-colors uppercase decoration-transparent"
                            disabled={isLoading}
                        >
                            [{isRegistering ? "Switch to Login" : "Initialize New User"}]
                        </button>
                    </div>
                </TerminalCard>
            </div>

            <div className="absolute bottom-4 text-[10px] opacity-40 font-mono">
                SECURE_CONNECTION // {API_BASE_URL || 'LOCAL_NODE'}
            </div>
        </div>
    );
}
