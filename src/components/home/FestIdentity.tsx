'use client';

import React from 'react';
import { Terminal, Cpu, Music, Gamepad2 } from 'lucide-react';

/* ─── Event-specific micro SVG marks ─────────────────────────── */
const TerminalMark = () => (
  <svg width="48" height="14" viewBox="0 0 48 14" fill="none" className="opacity-30 mb-1" aria-hidden>
    <text x="0" y="11" fontFamily="monospace" fontSize="10" fill="#a78bfa">{'> _'}</text>
    <rect x="28" y="2"  width="18" height="1.5" fill="#6b7280" />
    <rect x="28" y="6"  width="12" height="1.5" fill="#6b7280" />
    <rect x="28" y="10" width="16" height="1.5" fill="#6b7280" />
  </svg>
);

const CircuitMark = () => (
  <svg width="54" height="14" viewBox="0 0 54 14" fill="none" className="opacity-30 mb-1" aria-hidden>
    <circle cx="4"  cy="7" r="2.5" stroke="#6b7280" strokeWidth="1" />
    <line x1="6.5" y1="7"  x2="14"  y2="7"  stroke="#6b7280" strokeWidth="1" />
    <line x1="14"  y1="7"  x2="14"  y2="2"  stroke="#6b7280" strokeWidth="1" />
    <line x1="14"  y1="2"  x2="24"  y2="2"  stroke="#6b7280" strokeWidth="1" />
    <line x1="24"  y1="2"  x2="24"  y2="12" stroke="#6b7280" strokeWidth="1" />
    <line x1="24"  y1="12" x2="34"  y2="12" stroke="#6b7280" strokeWidth="1" />
    <line x1="34"  y1="12" x2="34"  y2="7"  stroke="#6b7280" strokeWidth="1" />
    <line x1="34"  y1="7"  x2="44"  y2="7"  stroke="#6b7280" strokeWidth="1" />
    <circle cx="50" cy="7" r="2.5" stroke="#6b7280" strokeWidth="1" />
  </svg>
);

const WaveformMark = () => (
  <svg width="54" height="14" viewBox="0 0 54 14" fill="none" className="opacity-30 mb-1" aria-hidden>
    {([4,8,12,6,10,14,8,12,6,10,4,8,6] as number[]).map((h, i) => (
      <rect key={i} x={i * 4} y={(14 - h) / 2} width="2" height={h} fill="#8b5cf6" rx="1" />
    ))}
  </svg>
);

const CrosshairMark = () => (
  <svg width="48" height="14" viewBox="0 0 48 14" fill="none" className="opacity-30 mb-1" aria-hidden>
    <circle cx="7" cy="7" r="5"  stroke="#6b7280" strokeWidth="1" />
    <line x1="7" y1="1" x2="7"  y2="13" stroke="#6b7280" strokeWidth="1" />
    <line x1="1" y1="7" x2="13" y2="7"  stroke="#6b7280" strokeWidth="1" />
    <line x1="18" y1="7" x2="44" y2="7" stroke="#6b7280" strokeWidth="1" strokeDasharray="2 3" />
    <polygon points="43,4 48,7 43,10" fill="#6b7280" />
  </svg>
);

const microMarks = [TerminalMark, CircuitMark, WaveformMark, CrosshairMark];

/* ─── Diamond divider between blocks ─────────────────────────── */
const DiamondDivider = () => (
  <div className="hidden lg:flex flex-col items-center justify-center w-7 flex-shrink-0 relative self-stretch">
    <span className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px border-l border-dashed border-slate-700/40" />
    <span className="relative z-10 w-2 h-2 bg-[#060812] border border-slate-600/50 rotate-45 block" />
  </div>
);

/* ─── Mobile separator ────────────────────────────────────────── */
const MobileSep = () => (
  <div className="lg:hidden flex items-center gap-2 px-2 py-0.5">
    <span className="flex-1 h-px bg-slate-800" />
    <span className="w-1.5 h-1.5 bg-slate-700 rotate-45 block" />
    <span className="flex-1 h-px bg-slate-800" />
  </div>
);

/* ─── Bottom-line decoration per card ────────────────────────── */
const BottomAccent = ({ index }: { index: number }) => {
  if (index === 0) return <span className="block h-px w-8 bg-purple-700/50 mt-2" />;
  if (index === 1) return <span className="block h-px w-full bg-slate-700/30 mt-2" style={{ borderTop: '1px dashed rgba(100,100,120,0.25)' }} />;
  if (index === 2) return (
    <span className="flex gap-1 mt-2">
      {[...Array(6)].map((_, i) => <span key={i} className="block h-px flex-1 bg-purple-700/25" />)}
    </span>
  );
  return <span className="block h-px w-5 bg-indigo-600/50 mt-2" />;
};

/* ─── Pillar type ─────────────────────────────────────────────── */
interface Pillar {
  icon: React.ElementType;
  title: string;
  description: string;
  tag: string;
  highlight: string;
}

/* ─── Single event block ──────────────────────────────────────── */
const EventBlock = ({ pillar, index }: { pillar: Pillar; index: number }) => {
  const Icon = pillar.icon;
  const MicroMark = microMarks[index];

  // Each block has a unique border / corner treatment
  const borderStyles: React.CSSProperties[] = [
    // 0 HackArena — bracket corners only
    { background: 'rgba(6,8,18,0.95)', position: 'relative' },
    // 1 RoboWars — left + top only
    { background: 'rgba(6,8,20,0.97)', position: 'relative' },
    // 2 Battle of Bands — full thin border + lifted accent
    { background: 'rgba(7,6,20,0.96)', position: 'relative', border: '1px solid rgba(71,85,105,0.45)', borderRadius: '2px' },
    // 3 Esports — right + bottom only
    { background: 'rgba(5,6,18,0.95)', position: 'relative' },
  ];

  return (
    <div
      className="flex-1 min-w-[200px] p-5 pt-6 group cursor-default transition-transform duration-200 ease-out hover:-translate-y-1.5"
      style={borderStyles[index]}
    >

      {/* ── Border corner decorations per card ── */}
      {index === 0 && <>
        <span className="absolute top-0 left-0 w-5 h-5 border-t border-l border-purple-700/60 pointer-events-none" />
        <span className="absolute bottom-0 right-0 w-5 h-5 border-b border-r border-purple-700/60 pointer-events-none" />
        <span className="absolute top-0 right-0 w-4 h-px bg-slate-700/40 pointer-events-none" />
        <span className="absolute top-0 bottom-0 left-0 w-px bg-slate-700/30 pointer-events-none" />
        {/* tiny top-right cross */}
        <span className="absolute top-2 right-2 pointer-events-none" aria-hidden>
          <span className="absolute w-2 h-px bg-slate-600/60 top-1/2 left-0" />
          <span className="absolute h-2 w-px bg-slate-600/60 left-1/2 top-0" />
        </span>
      </>}

      {index === 1 && <>
        <span className="absolute top-0 left-3 right-0 h-px bg-slate-600/60 pointer-events-none" />
        <span className="absolute top-0 left-0 bottom-5 w-px bg-slate-600/60 pointer-events-none" />
        <span className="absolute top-[-2px] left-[-2px] w-2 h-2 bg-purple-900/60 pointer-events-none" />
        <span className="absolute bottom-0 left-3 right-0 h-px bg-slate-700/30 pointer-events-none" />
        {/* annotation */}
        <span className="absolute bottom-1.5 right-2 text-[8px] font-mono text-slate-700 tracking-widest pointer-events-none">ARENA_02</span>
      </>}

      {index === 2 && <>
        {/* lifted top accent above border */}
        <span className="absolute top-[-4px] left-6 right-6 h-0.5 bg-purple-700/55 pointer-events-none" />
        <span className="absolute top-[-5px] left-6 w-px h-2 bg-purple-700/55 pointer-events-none" />
        <span className="absolute top-[-5px] right-6 w-px h-2 bg-purple-700/55 pointer-events-none" />
        <span className="absolute bottom-1.5 right-2 text-[8px] font-mono text-slate-700 tracking-widest pointer-events-none">STAGE_03</span>
      </>}

      {index === 3 && <>
        <span className="absolute top-4 bottom-0 right-0 w-px bg-slate-600/55 pointer-events-none" />
        <span className="absolute bottom-0 left-0 right-4 h-px bg-slate-600/55 pointer-events-none" />
        <span className="absolute top-0 left-0 w-8 h-px bg-slate-600/55 pointer-events-none" />
        <span className="absolute top-0 left-0 h-8 w-px bg-slate-600/55 pointer-events-none" />
        <span className="absolute bottom-[-2px] right-[-2px] w-2 h-2 bg-indigo-900/55 pointer-events-none" />
        <span className="absolute top-1.5 right-2 text-[8px] font-mono text-slate-700 tracking-widest pointer-events-none">LAN_04</span>
      </>}

      {/* ── Content ── */}
      <div className="space-y-3 flex flex-col h-full">
        {/* micro mark + prize row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col">
            <MicroMark />
            <div className="w-9 h-9 flex items-center justify-center text-purple-400 group-hover:text-purple-300 transition-colors">
              <Icon className="w-5 h-5" />
            </div>
          </div>
          <span
            className="text-[10px] font-mono font-bold uppercase text-amber-300 border border-amber-500/30 px-2 py-0.5 mt-1 shrink-0"
            style={{ letterSpacing: '0.07em', background: 'rgba(245,158,11,0.05)' }}
          >
            {pillar.highlight}
          </span>
        </div>

        {/* tag + title */}
        <div>
          <span className="text-[10px] font-mono uppercase text-slate-500 block mb-1 tracking-widest">
            — {pillar.tag}
          </span>
          <h3 className="font-pixel text-white text-base leading-snug group-hover:text-purple-200 transition-colors">
            {pillar.title}
          </h3>
        </div>

        {/* description */}
        <p className="text-xs text-slate-400 leading-relaxed font-normal flex-1">
          {pillar.description}
        </p>

        <BottomAccent index={index} />
      </div>
    </div>
  );
};

/* ─── Main export ─────────────────────────────────────────────── */
export const FestIdentity = () => {
  const pillars: Pillar[] = [
    {
      icon: Terminal,
      title: 'HackArena 3.0',
      description: '36 hours of non-stop algorithmic building, cloud deployment, and direct VC pitching.',
      tag: 'Flagship Hackathon',
      highlight: '₹1.5L Prize',
    },
    {
      icon: Cpu,
      title: 'RoboWars Deathmatch',
      description: 'Bulletproof steel enclosure matches where custom heavyweight combat bots battle for total dominance.',
      tag: 'Heavyweight Arena',
      highlight: '₹1.2L Prize',
    },
    {
      icon: Music,
      title: 'Battle of Bands & Live Concerts',
      description: 'National band competitions, choreography clashes, and headline music acts on the main lawn.',
      tag: 'Grand Stage',
      highlight: '₹1.0L Prize',
    },
    {
      icon: Gamepad2,
      title: 'Esports LAN Arena',
      description: 'High-refresh Valorant & BGMI tournaments on stage with live shoutcasting.',
      tag: 'LAN Stadium',
      highlight: '₹1.0L Prize',
    },
  ];

  return (
    <section className="py-20 bg-[#060812] border-b border-slate-800/80 relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

        {/* Editorial Manifesto Header */}
        <div className="max-w-3xl space-y-4 mb-16">
          <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight leading-tight font-display">
            Two days. One campus.<br />
            <span className="text-slate-400">Thousands of stories.</span>
          </h2>
          <p className="text-sm sm:text-base text-slate-300 pt-3 font-normal leading-snug">
            Parinaam 2026 brings together students from engineering, science, and arts institutions across India. Whether you are debugging at 3:00 AM in the innovation hall or performing under stage spotlights, this is where India's brightest talent converges.
          </p>
        </div>

        {/* ── REDESIGNED EVENT SECTION ── */}
        <div className="relative">

          {/* Top schematic rule */}
          <div className="flex items-center gap-3 mb-5">
            <span className="text-[9px] font-mono text-slate-600 tracking-[0.25em] uppercase select-none">
              FLAGSHIP EVENTS · 2026
            </span>
            <span className="flex-1 h-px bg-slate-800" />
            <span className="text-[9px] font-mono text-slate-600 select-none">04 ARENAS</span>
          </div>

          {/* Connecting SVG schematic — desktop only */}
          <div className="relative hidden lg:block pointer-events-none" aria-hidden>
            <svg
              className="absolute inset-0 w-full h-full z-0"
              viewBox="0 0 1000 240"
              preserveAspectRatio="none"
              fill="none"
            >
              {/* dashed backbone route */}
              <path
                d="M 0 120 L 220 120 L 232 106 L 256 106 L 268 120 L 480 120 L 492 136 L 516 136 L 528 120 L 730 120 L 742 108 L 766 108 L 778 120 L 1000 120"
                stroke="#1e1b4b"
                strokeWidth="1.5"
                strokeDasharray="5 7"
              />
              {/* junction squares */}
              <rect x="228" y="102" width="6" height="6" fill="none" stroke="#312e81" strokeWidth="1" />
              <rect x="512" y="132" width="6" height="6" fill="none" stroke="#312e81" strokeWidth="1" />
              <rect x="738" y="104" width="6" height="6" fill="none" stroke="#312e81" strokeWidth="1" />
              {/* midpoint cross marks */}
              <line x1="110" y1="116" x2="110" y2="124" stroke="#1f2937" strokeWidth="1" />
              <line x1="106" y1="120" x2="114" y2="120" stroke="#1f2937" strokeWidth="1" />
              <line x1="604" y1="116" x2="604" y2="124" stroke="#1f2937" strokeWidth="1" />
              <line x1="600" y1="120" x2="608" y2="120" stroke="#1f2937" strokeWidth="1" />
              {/* node labels */}
              <text x="96"  y="113" fontFamily="monospace" fontSize="6" fill="#1f2937" letterSpacing="1.5">A</text>
              <text x="590" y="113" fontFamily="monospace" fontSize="6" fill="#1f2937" letterSpacing="1.5">B</text>
            </svg>
          </div>

          {/* Four event blocks */}
          <div className="flex flex-col lg:flex-row relative z-10">
            {pillars.map((pillar, i) => (
              <React.Fragment key={pillar.title}>
                <EventBlock pillar={pillar} index={i} />
                {i < pillars.length - 1 && <DiamondDivider />}
                {i < pillars.length - 1 && <MobileSep />}
              </React.Fragment>
            ))}
          </div>

          {/* Bottom schematic rule */}
          <div className="flex items-center gap-3 mt-5">
            <span className="flex-1 h-px bg-slate-800" />
            <span className="text-[9px] font-mono text-slate-600 tracking-[0.2em] uppercase select-none">
              PARINAAM · AMARAVATI · 2026
            </span>
          </div>

        </div>
      </div>
    </section>
  );
};
