import { useEffect } from 'react';
import io from 'socket.io-client';
import { Globe, LogOut, Terminal } from "lucide-react";

import { LoginScreen } from './components/LoginScreen';
import { WhaleFeedPopover } from './components/WhaleFeedPopover';
import { SplitViewLayout } from './components/SplitViewLayout';
import { CRTEffect } from './components/ui/crt-effect';
import { generateAsciiAvatar } from './utils/asciiAvatar';
import { Button } from './components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "./components/ui/dialog"
import { useMarketStore, type DisplayMarket } from './store/marketStore';
import { useAuthStore } from './store/authStore';
import { useSignalStore, type Signal } from './store/signalStore';
import { getMarketCoordinates } from './utils/GeoMapper';
import { SOCKET_URL } from './config';

interface PinsResponse {
    pins?: string[];
}

interface PinToggledResponse {
    conditionId: string;
    isPinned: boolean;
}

interface RawMarket {
    condition_id: string;
    description?: string;
    question?: string;
    slug: string;
    event_slug?: string;
    image: string;
    end_date: string;
    yes_asset_id: string;
    no_asset_id: string;
    yes_price?: number;
    no_price?: number;
    tags?: string[];
    volume?: number;
    liquidity?: number;
}

interface RawTrade {
    asset_id?: string;
    assetId?: string;
    price: string | number;
    size?: string | number;
    side: 'BUY' | 'SELL';
    outcome: string;
    market_slug?: string;
}

interface MarketSnapshotPayload {
    markets?: RawMarket[];
}

interface ServerEvent {
    type: string;
    payload: unknown;
    timestamp?: number;
}

function App() {
    const { isAuthenticated, user, token, logout, socket, setSocket, setStatus } = useAuthStore();

    const {
        marketMap, setSnapshot, updatePrice, addTrade
    } = useMarketStore();

    const markets = Array.from(marketMap.values());

    // Only connect socket when authenticated (with JWT token)
    useEffect(() => {
        if (!isAuthenticated || !token) {
            // Close any existing connection if user logs out
            const currentSocket = useAuthStore.getState().socket;
            if (currentSocket) {
                currentSocket.close();
                setSocket(null);
            }
            return;
        }

        // Connect with JWT token in handshake
        const newSocket = io(SOCKET_URL, {
            auth: { token }
        });
        setSocket(newSocket);

        return () => {
            newSocket.close();
            setSocket(null);
        };
    }, [isAuthenticated, token, setSocket]);





    useEffect(() => {
        if (!socket) return;



        const onPinsResponse = (data: PinsResponse) => {
            if (data.pins) {
                useMarketStore.getState().setPinnedIds(data.pins);
                console.log('SYSTEM', `Loaded ${data.pins.length} pinned markets`);
            }
        };

        const onPinToggled = (data: PinToggledResponse) => {
            useMarketStore.getState().syncPin(data.conditionId, data.isPinned);
        };

        socket.on('pins_response', onPinsResponse);
        socket.on('pin_toggled', onPinToggled);

        const onConnect = () => {
            setStatus('Connected');
            console.log('SYSTEM', 'Connected to Meridian');
            socket.emit('get_market_snapshot');

            // Fetch pins for authenticated user
            const { user } = useAuthStore.getState();
            if (user) {
                socket.emit('get_pins', { userId: user.id });
            }
        };

        const onDisconnect = () => {
            setStatus('Disconnected');
            console.log('SYSTEM', 'Disconnected from server');
        };

        const onConnectError = (error: Error) => {
            console.error('SYSTEM', 'Connection error:', error.message);
            setStatus('Auth Failed');
            // If token is invalid, force logout
            if (error.message.includes('Authentication') || error.message.includes('token')) {
                logout();
            }
        };

        const onEvent = (data: ServerEvent) => {
            if (data.type !== 'MARKET_SNAPSHOT' && data.type !== 'trade_update' && data.type !== 'TRADE') {
                // console.log(data.type, data.payload);
            }

            if (data.type === 'MARKET_SNAPSHOT') {
                const payload = data.payload as MarketSnapshotPayload;
                if (payload.markets) {
                    const mappedMarkets: DisplayMarket[] = payload.markets.map((m) => ({
                        conditionId: m.condition_id,
                        question: m.description || m.question || 'Unknown Market',
                        slug: m.slug,
                        eventSlug: m.event_slug,
                        image: m.image,
                        endDate: m.end_date,
                        yesAssetId: m.yes_asset_id,
                        noAssetId: m.no_asset_id,
                        yesPrice: m.yes_price || 0.5,
                        noPrice: m.no_price || 0.5,
                        history: [],
                        tags: m.tags || [], // Category tags from API
                        volume: m.volume || 0,
                        liquidity: m.liquidity || 0
                    }));
                    setSnapshot(mappedMarkets);
                }
            }

            if (data.type === 'trade_update' || data.type === 'TRADE') {
                const trade = data.payload as RawTrade;
                const assetId = trade.asset_id || trade.assetId;
                if (!assetId) return;
                updatePrice(assetId, Number.parseFloat(String(trade.price)), data.timestamp || Date.now());

                // Allow ALL trades for now (client-side filtering can be added later if needed)
                // previously: if (parseFloat(trade.size) > 500)
                addTrade({
                    id: Math.random().toString(),
                    price: Number.parseFloat(String(trade.price)),
                    size: Number.parseFloat(String(trade.size || '0')),
                    side: trade.side,
                    timestamp: data.timestamp || Date.now(),
                    outcome: trade.outcome,
                    marketTitle: trade.market_slug || 'Unknown Market'
                });
            }
        };

        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);
        socket.on('connect_error', onConnectError);
        socket.on('event', onEvent);
        socket.on('market_snapshot', (payload) => onEvent({ type: 'MARKET_SNAPSHOT', payload, timestamp: Date.now() }));

        // Handle signal events from SignalEngine
        const onSignal = (signal: Signal) => {
            // Resolve coordinates if missing (critical for Map display)
            if (!signal.coordinates && (signal.metadata.marketTitle || signal.region)) {
                // Try to resolve using market title/question + tags if available
                const searchText = signal.metadata.marketTitle || signal.region;
                // Tags might be in metadata or we might not have them easily, just use text for now
                const coords = getMarketCoordinates(searchText);

                if (coords) {
                    signal.coordinates = { lat: coords.lat, lng: coords.lng };
                    // Ensure region is set if missing
                    if (!signal.region) {
                        signal.region = coords.country;
                    }
                    console.log(`[Signal] Resolved coords for ${searchText}:`, coords);
                }
            }

            useSignalStore.getState().addSignal(signal);
        };
        socket.on('signal', onSignal);

        return () => {
            socket.off('pins_response', onPinsResponse);
            socket.off('pin_toggled', onPinToggled);
            socket.off('connect', onConnect);
            socket.off('disconnect', onDisconnect);
            socket.off('connect_error', onConnectError);
            socket.off('event', onEvent);
            socket.off('market_snapshot');
            socket.off('signal', onSignal);
        };
    }, [socket, addTrade, logout, setSnapshot, setStatus, updatePrice]);

    // Signal Garbage Collection (Runs every 5 seconds)
    useEffect(() => {
        const interval = setInterval(() => {
            useSignalStore.getState().clearOldSignals();
        }, 5000);
        return () => clearInterval(interval);
    }, []);

    if (!isAuthenticated) {
        return <LoginScreen />;
    }

    return (
        <div className="h-screen bg-black text-primary font-mono flex overflow-hidden selection:bg-primary selection:text-black">
            <CRTEffect />

            {/* Sidebar Navigation */}
            <aside className="w-16 flex flex-col items-center py-6 border-r-2 border-primary bg-black z-20">
                <div className="w-8 h-8 bg-primary flex items-center justify-center mb-8 shadow-[0_0_15px_rgba(0,255,159,0.3)]">
                    <Terminal className="w-5 h-5 text-black" />
                </div>

                <div className="flex flex-col gap-4">
                    <div className="p-2 bg-primary/10 rounded-none text-primary hover:bg-primary hover:text-black transition cursor-pointer border border-primary/50" title="Map View">
                        <Globe className="w-5 h-5" />
                    </div>
                </div>


                <div className="mt-auto flex flex-col items-center gap-4">
                    <div className="p-1 border border-primary/20 bg-black" title={user?.username}>
                        <pre className="text-[8px] leading-[8px] font-bold text-primary font-mono whitespace-pre select-none">
                            {generateAsciiAvatar(user?.username || 'GUEST')}
                        </pre>
                    </div>
                    <Dialog>
                        <DialogTrigger asChild>
                            <button className="p-2 text-primary/50 hover:text-destructive transition" title="Logout">
                                <LogOut className="w-5 h-5" />
                            </button>
                        </DialogTrigger>
                        <DialogContent className="bg-black border-2 border-primary text-primary font-mono sm:max-w-[425px]">
                            <DialogHeader>
                                <DialogTitle className="text-xl font-bold uppercase tracking-widest text-destructive">
                                    [!] TERMINATE_SESSION?
                                </DialogTitle>
                                <DialogDescription className="text-primary/70 font-mono">
                                    Are you sure you want to log out? Unsaved local configurations may be lost.
                                </DialogDescription>
                            </DialogHeader>
                            <DialogFooter className="flex gap-2 sm:gap-0 mt-4">
                                <DialogClose asChild>
                                    <Button variant="outline" className="border-primary text-primary hover:bg-primary hover:text-black font-mono uppercase bg-black rounded-none">
                                        Cancel
                                    </Button>
                                </DialogClose>
                                <Button
                                    variant="destructive"
                                    onClick={logout}
                                    className="bg-destructive text-white hover:bg-destructive/90 font-mono uppercase rounded-none border border-destructive"
                                >
                                    Confirm_Exit
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                </div>
            </aside>
            <main className="flex-1 flex flex-col min-w-0 relative">
                {/* Header (Static) */}
                <header className="h-16 bg-black border-b-2 border-primary px-8 flex items-center justify-between z-10 shrink-0">
                    <div className="pointer-events-auto">
                        <h1 className="text-xl font-bold tracking-tight text-primary flex items-center gap-2 font-mono">
                            FENT_GOBLIN // <span className="text-xs font-mono text-black bg-primary px-1 animate-pulse">LIVE_CONNECTION</span>
                        </h1>
                        <p className="text-xs text-primary/70 typewriter">Global Event Surveillance System v1.0</p>
                    </div>

                    <div className="flex items-center gap-4 pointer-events-auto">
                        <div className="text-right mr-4">
                            <p className="text-xs text-primary/70 uppercase tracking-widest">Monitored Zones</p>
                            <p className="text-lg font-mono font-bold text-primary">&gt; {new Set(markets.map(m => m.eventSlug || m.conditionId)).size}</p>
                        </div>
                        <WhaleFeedPopover />
                    </div>
                </header>

                {/* Split View: Map + Event List */}
                <div className="flex-1 bg-black relative min-h-0">
                    <SplitViewLayout />
                </div>
            </main>
        </div>
    );
}

export default App;
