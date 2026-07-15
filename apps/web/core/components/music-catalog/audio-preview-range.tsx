import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

type Props = {
  src: string;
  durationMs: number;
  startMs: number;
  endMs: number;
  onChange: (startMs: number, endMs: number) => void;
  onDurationChange: (durationMs: number) => void;
};

const formatTime = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function AudioPreviewRange({ src, durationMs, startMs, endMs, onChange, onDurationChange }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: "start" | "end" | "move"; offset: number }>();
  const [currentMs, setCurrentMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const safeDuration = Math.max(durationMs, 1000);
  const safeStart = Math.min(Math.max(startMs, 0), safeDuration);
  const safeEnd = Math.min(Math.max(endMs || safeDuration, safeStart + 100), safeDuration);

  const bars = useMemo(
    () =>
      Array.from({ length: 68 }, (_, index) => {
        const wave = Math.abs(Math.sin(index * 1.81) * 0.46 + Math.sin(index * 0.37) * 0.34);
        return {
          id: `waveform-bar-${index}`,
          height: Math.max(22, Math.round((0.28 + wave) * 78)),
          position: index / 67,
        };
      }),
    []
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => {
      const next = audio.currentTime * 1000;
      setCurrentMs(next);
      if (next >= safeEnd) {
        audio.pause();
        audio.currentTime = safeStart / 1000;
        setCurrentMs(safeStart);
      }
    };
    const onEnded = () => setIsPlaying(false);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("pause", onEnded);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("pause", onEnded);
      audio.removeEventListener("ended", onEnded);
    };
  }, [safeEnd, safeStart]);

  const timeAt = (clientX: number) => {
    const bounds = waveformRef.current?.getBoundingClientRect();
    if (!bounds) return 0;
    return Math.min(safeDuration, Math.max(0, ((clientX - bounds.left) / bounds.width) * safeDuration));
  };

  const updateDrag = (clientX: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    const value = timeAt(clientX);
    if (drag.mode === "start") onChange(Math.min(value, safeEnd - 100), safeEnd);
    if (drag.mode === "end") onChange(safeStart, Math.max(value, safeStart + 100));
    if (drag.mode === "move") {
      const width = safeEnd - safeStart;
      const nextStart = Math.min(Math.max(0, value - drag.offset), safeDuration - width);
      onChange(nextStart, nextStart + width);
    }
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const value = timeAt(event.clientX);
    const tolerance = safeDuration * 0.025;
    if (Math.abs(value - safeStart) <= tolerance) dragRef.current = { mode: "start", offset: 0 };
    else if (Math.abs(value - safeEnd) <= tolerance) dragRef.current = { mode: "end", offset: 0 };
    else if (value > safeStart && value < safeEnd) dragRef.current = { mode: "move", offset: value - safeStart };
    else {
      const width = Math.min(Math.max(safeEnd - safeStart, 30000), safeDuration);
      const nextStart = Math.min(value, safeDuration - width);
      onChange(nextStart, nextStart + width);
      dragRef.current = { mode: "move", offset: value - nextStart };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (audio.currentTime * 1000 < safeStart || audio.currentTime * 1000 >= safeEnd)
      audio.currentTime = safeStart / 1000;
    await audio.play();
    setIsPlaying(true);
  };

  return (
    <div className="rounded-xl border border-subtle bg-layer-1 p-3 sm:p-5">
      {/* Song previews do not contain spoken accessibility content that requires captions. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const nextDuration = Math.round(event.currentTarget.duration * 1000);
          if (Number.isFinite(nextDuration)) onDurationChange(nextDuration);
        }}
      />
      <div
        ref={waveformRef}
        className="relative flex h-28 cursor-ew-resize touch-none items-center gap-1 overflow-hidden rounded-xl bg-layer-2 px-4 select-none"
        onPointerDown={startDrag}
        onPointerMove={(event) => updateDrag(event.clientX)}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = undefined;
        }}
        onPointerCancel={() => (dragRef.current = undefined)}
      >
        {bars.map((bar) => {
          const point = bar.position * safeDuration;
          const selected = point >= safeStart && point <= safeEnd;
          return (
            <span
              key={bar.id}
              className={`min-w-0 flex-1 rounded-full transition-colors ${selected ? "bg-[#0875b5]" : "bg-[#a7a7a7]"}`}
              style={{ height: `${bar.height}%` }}
            />
          );
        })}
        <div
          className="border-accent-primary shadow-sm pointer-events-none absolute inset-y-4 rounded-lg border-2 bg-accent-primary/5"
          style={{
            left: `${(safeStart / safeDuration) * 100}%`,
            width: `${((safeEnd - safeStart) / safeDuration) * 100}%`,
          }}
        >
          <span className="absolute top-1/2 -left-1 h-9 w-1 -translate-y-1/2 rounded-full bg-accent-primary" />
          <span className="absolute top-1/2 -right-1 h-9 w-1 -translate-y-1/2 rounded-full bg-accent-primary" />
        </div>
      </div>
      <div className="font-mono mt-4 flex items-center justify-between gap-3 text-12 text-secondary">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="bg-primary flex size-10 items-center justify-center rounded-full text-on-color"
            onClick={() => void togglePlayback()}
            aria-label={isPlaying ? "Pause preview" : "Play preview"}
          >
            {isPlaying ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
          </button>
          <span>
            {formatTime(currentMs)} / {formatTime(safeDuration)}
          </span>
        </div>
        <span className="whitespace-nowrap">
          [{formatTime(safeStart)} - {formatTime(safeEnd)}]
        </span>
      </div>
    </div>
  );
}
