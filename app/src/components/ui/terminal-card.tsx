import { Terminal } from 'lucide-react';
import React from 'react';

interface TerminalCardProps {
    title?: string;
    subTitle?: string;
    children: React.ReactNode;
    className?: string;
}

export function TerminalCard({ title = "MERIDIAN_NODE", subTitle = "SHELL", children, className = "" }: TerminalCardProps) {
    return (
        <div className={`z-10 bg-black border-2 border-primary shadow-[0_0_30px] shadow-primary/20 ${className}`}>
            {/* Header Bar */}
            <div className="border-b-2 border-primary bg-primary/10 p-2 flex items-center justify-between select-none">
                <div className="flex items-center gap-2 text-xs font-bold text-primary">
                    <Terminal className="w-4 h-4" />
                    <span>{title} // {subTitle}</span>
                </div>
                <div className="flex gap-1">
                    <div className="w-3 h-3 bg-primary opacity-20"></div>
                    <div className="w-3 h-3 bg-primary opacity-50"></div>
                    <div className="w-3 h-3 bg-primary"></div>
                </div>
            </div>

            <div className="p-8 font-mono text-primary">
                {children}
            </div>
        </div>
    );
}
