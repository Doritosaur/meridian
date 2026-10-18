import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Socket } from 'socket.io-client';

interface User {
    id: number;
    username: string;
}

interface AuthState {
    user: User | null;
    token: string | null;
    isAuthenticated: boolean;
    socket: Socket | null;
    loginError: string | null;
    registerError: string | null;
    status: string;
    showLogin: boolean;

    setShowLogin: (show: boolean) => void;
    setUser: (user: User, token: string) => void;
    logout: () => void;
    setSocket: (socket: Socket | null) => void;
    setLoginError: (error: string | null) => void;
    setRegisterError: (error: string | null) => void;
    setStatus: (status: string) => void;
}

export const useAuthStore = create<AuthState>()(
    persist(
        (set) => ({
            user: null,
            token: null,
            isAuthenticated: false,
            socket: null,
            loginError: null,
            registerError: null,
            status: 'Disconnected',
            showLogin: false,

            setShowLogin: (showLogin) => set({ showLogin }),
            setUser: (user, token) => set({ user, token, isAuthenticated: true, showLogin: false, loginError: null, registerError: null }),
            logout: () => {
                localStorage.removeItem('auth-storage'); // Force clear
                set({ user: null, token: null, isAuthenticated: false });
            },
            setSocket: (socket) => set({ socket }),
            setLoginError: (error) => set({ loginError: error }),
            setRegisterError: (error) => set({ registerError: error }),
            setStatus: (status) => set({ status }),
        }),
        {
            name: 'auth-storage',
            partialize: (state) => ({ user: state.user, token: state.token, isAuthenticated: state.isAuthenticated }),
        }
    )
);
