import { useCallback } from 'react';
import { useMarketStore } from '../store/marketStore';
import { useAuthStore } from '../store/authStore';

/**
 * Hook for toggling pin state on markets with socket sync
 */
export function usePinToggle() {
    const { togglePin, pinnedIds } = useMarketStore();
    const { user } = useAuthStore();
    const socket = useAuthStore(state => state.socket);

    const toggle = useCallback((conditionId: string) => {
        togglePin(conditionId);
        if (socket && user) {
            socket.emit('toggle_pin', { conditionId });
        }
    }, [togglePin, socket, user]);

    const isPinned = useCallback((conditionId: string) => {
        return pinnedIds.has(conditionId);
    }, [pinnedIds]);

    const pinAll = useCallback((conditionIds: string[]) => {
        conditionIds.forEach(id => {
            if (!pinnedIds.has(id)) {
                toggle(id);
            }
        });
    }, [pinnedIds, toggle]);

    const unpinAll = useCallback((conditionIds: string[]) => {
        conditionIds.forEach(id => {
            if (pinnedIds.has(id)) {
                toggle(id);
            }
        });
    }, [pinnedIds, toggle]);

    return { toggle, isPinned, pinAll, unpinAll, pinnedIds };
}
