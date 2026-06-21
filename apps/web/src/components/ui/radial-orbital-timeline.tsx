'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface TimelineItem {
  id: number;
  title: string;
  date: string;
  content: string;
  category: string;
  icon: React.ElementType;
  relatedIds: number[];
  status: 'completed' | 'in-progress' | 'pending';
  energy: number;
}

interface NodePosition {
  x: number;
  y: number;
}

interface Props {
  timelineData: TimelineItem[];
}

function getStatusStyles(status: TimelineItem['status']): {
  badge: string;
  node: string;
} {
  switch (status) {
    case 'completed':
      return {
        badge: 'text-white bg-black border border-white',
        node: 'bg-black border-white text-white',
      };
    case 'in-progress':
      return {
        badge: 'text-black bg-white border border-black',
        node: 'bg-white border-black text-black',
      };
    case 'pending':
    default:
      return {
        badge: 'text-white bg-black/40 border border-white/50',
        node: 'bg-black/40 border-white/50 text-white',
      };
  }
}

export default function RadialOrbitalTimeline({ timelineData }: Props) {
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());
  const [rotationAngle, setRotationAngle] = useState<number>(0);
  const [autoRotate, setAutoRotate] = useState<boolean>(true);
  const [pulseEffect, setPulseEffect] = useState<boolean>(false);
  const [centerOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [activeNodeId, setActiveNodeId] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const orbitRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const rotationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const ORBIT_RADIUS = 200;

  const calculateNodePosition = useCallback(
    (index: number, total: number): NodePosition => {
      const angle = (index / total) * 2 * Math.PI + (rotationAngle * Math.PI) / 180;
      return {
        x: ORBIT_RADIUS * Math.cos(angle),
        y: ORBIT_RADIUS * Math.sin(angle),
      };
    },
    [rotationAngle]
  );

  useEffect(() => {
    if (autoRotate) {
      rotationIntervalRef.current = setInterval(() => {
        setRotationAngle(prev => (prev + 0.3) % 360);
      }, 50);
    } else {
      if (rotationIntervalRef.current) {
        clearInterval(rotationIntervalRef.current);
        rotationIntervalRef.current = null;
      }
    }
    return () => {
      if (rotationIntervalRef.current) {
        clearInterval(rotationIntervalRef.current);
      }
    };
  }, [autoRotate]);

  useEffect(() => {
    setPulseEffect(true);
    const t = setTimeout(() => setPulseEffect(false), 600);
    return () => clearTimeout(t);
  }, [activeNodeId]);

  const toggleItem = useCallback((id: number) => {
    setAutoRotate(false);
    setActiveNodeId(prev => (prev === id ? null : id));
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (next.size === 0) setAutoRotate(true);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const getRelatedItems = useCallback(
    (item: TimelineItem): TimelineItem[] =>
      timelineData.filter(d => item.relatedIds.includes(d.id)),
    [timelineData]
  );

  const isRelatedToActive = useCallback(
    (id: number): boolean => {
      if (activeNodeId === null) return false;
      const active = timelineData.find(d => d.id === activeNodeId);
      if (!active) return false;
      return active.relatedIds.includes(id);
    },
    [activeNodeId, timelineData]
  );

  return (
    <div
      ref={containerRef}
      className="relative w-full h-screen bg-black flex items-center justify-center overflow-hidden"
    >
      {/* Center orb — RECOLORED: from-purple-500 via-blue-500 to-teal-500 → from-primary via-primary to-orange-400 */}
      <div
        className={cn(
          'absolute z-10 rounded-full transition-all duration-500',
          pulseEffect ? 'scale-110' : 'scale-100'
        )}
        style={{
          width: 80,
          height: 80,
          transform: `translate(${centerOffset.x}px, ${centerOffset.y}px)`,
        }}
      >
        {/* Soft outer glow so the core reads as a light source on black */}
        <div className="absolute -inset-6 rounded-full bg-primary/30 blur-2xl" />
        <div className="w-full h-full rounded-full bg-gradient-to-br from-primary via-primary to-orange-400 opacity-90 blur-sm" />
        <div className="absolute inset-0 rounded-full bg-gradient-to-br from-primary via-primary to-orange-400 shadow-[0_0_50px_rgba(255,110,1,0.55)]" />
        {/* Inner highlight for a glassy core */}
        <div className="absolute inset-2 rounded-full bg-gradient-to-br from-white/40 to-transparent" />
        <div
          className={cn(
            'absolute inset-0 rounded-full bg-gradient-to-br from-primary via-primary to-orange-400 animate-ping',
            pulseEffect ? 'opacity-40' : 'opacity-10'
          )}
        />
      </div>

      {/* Orbit ring */}
      <div
        ref={orbitRef}
        className="absolute rounded-full border border-white/15"
        style={{ width: ORBIT_RADIUS * 2, height: ORBIT_RADIUS * 2 }}
      />

      {/* Nodes */}
      {timelineData.map((item, index) => {
        const pos = calculateNodePosition(index, timelineData.length);
        const isExpanded = expandedItems.has(item.id);
        const isActive = activeNodeId === item.id;
        const isRelated = isRelatedToActive(item.id);
        const statusStyles = getStatusStyles(item.status);
        const Icon = item.icon;

        return (
          <div
            key={item.id}
            className="absolute"
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px)`,
              zIndex: isExpanded ? 30 : isRelated ? 20 : 10,
              transition: 'transform 0.05s linear',
            }}
          >
            {/* Node button */}
            <button
              ref={el => {
                if (el) nodeRefs.current.set(item.id, el);
                else nodeRefs.current.delete(item.id);
              }}
              onClick={() => toggleItem(item.id)}
              className={cn(
                'relative flex flex-col items-center gap-1 group outline-none',
                isActive && 'scale-110',
                isRelated && !isActive && 'opacity-80'
              )}
              style={{ transform: 'translate(-50%, -50%)' }}
              aria-label={item.title}
            >
              {/* Icon circle */}
              <div
                className={cn(
                  'flex items-center justify-center w-10 h-10 rounded-full border-2 transition-all duration-200 group-hover:scale-110',
                  statusStyles.node
                )}
              >
                <Icon size={18} />
              </div>
              {/* Title label */}
              <span className="text-white/90 text-xs font-medium whitespace-nowrap max-w-[120px] text-center leading-tight">
                {item.title}
              </span>
            </button>

            {/* Expanded card */}
            {isExpanded && (
              <div
                className="absolute z-40 pointer-events-auto"
                style={{
                  top: '50%',
                  left: '50%',
                  transform: `translate(${pos.x > 0 ? '0%' : '-100%'}, -50%) translate(${
                    pos.x > 0 ? '12px' : '-12px'
                  }, 0)`,
                  minWidth: 220,
                  maxWidth: 280,
                }}
              >
                <Card className="bg-black/90 backdrop-blur-lg border border-white/30 text-white shadow-2xl">
                  <CardContent className="p-4 flex flex-col gap-3">
                    {/* Header row */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm leading-snug">{item.title}</span>
                      <Badge className={cn('text-xs shrink-0', statusStyles.badge)}>
                        {item.status}
                      </Badge>
                    </div>

                    {/* Date / category */}
                    <div className="flex items-center gap-2 text-white/50 text-xs">
                      <span>{item.date}</span>
                      <span>·</span>
                      <span>{item.category}</span>
                    </div>

                    {/* Content */}
                    <p className="text-white/70 text-xs leading-relaxed">{item.content}</p>

                    {/* Energy bar — RECOLORED: from-blue-500 to-purple-500 → from-primary to-orange-300 */}
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-xs text-white/50">
                        <span>Energy</span>
                        <span>{item.energy}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-primary to-orange-300 transition-all duration-500"
                          style={{ width: `${item.energy}%` }}
                        />
                      </div>
                    </div>

                    {/* Related nodes */}
                    {getRelatedItems(item).length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-white/40 text-xs">Related</span>
                        <div className="flex flex-wrap gap-1.5">
                          {getRelatedItems(item).map(related => (
                            <button
                              key={related.id}
                              onClick={e => {
                                e.stopPropagation();
                                toggleItem(related.id);
                              }}
                              className="text-xs px-2 py-0.5 rounded-full border border-white/20 text-white/60 hover:border-white/50 hover:text-white transition-colors"
                            >
                              {related.title}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        );
      })}

      {/* Resume rotation hint */}
      {!autoRotate && (
        <button
          onClick={() => {
            setExpandedItems(new Set());
            setActiveNodeId(null);
            setAutoRotate(true);
          }}
          className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/30 hover:text-white/60 text-xs transition-colors z-50"
        >
          Click to resume rotation
        </button>
      )}
    </div>
  );
}
