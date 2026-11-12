import { useRef } from 'react';

export function SidebarResize({
  width,
  onChange,
}: {
  width: number;
  onChange(width: number): void;
}) {
  const drag = useRef<{ x: number; width: number; scale: number } | null>(null);
  const change = (value: number) =>
    onChange(Math.round(Math.max(185, Math.min(420, value))));
  return (
    <div
      className="sidebar-resize"
      role="separator"
      tabIndex={0}
      aria-label="Resize plans sidebar"
      aria-orientation="vertical"
      aria-valuemin={185}
      aria-valuemax={420}
      aria-valuenow={width}
      onDoubleClick={() => change(244)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const sidebar = event.currentTarget.parentElement!;
        drag.current = {
          x: event.clientX,
          width: sidebar.offsetWidth,
          scale: sidebar.getBoundingClientRect().width / sidebar.offsetWidth,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.resizing = 'true';
      }}
      onPointerMove={(event) => {
        if (drag.current)
          change(
            drag.current.width +
              (event.clientX - drag.current.x) / drag.current.scale,
          );
      }}
      onLostPointerCapture={(event) => {
        drag.current = null;
        delete event.currentTarget.dataset.resizing;
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
          return;
        event.preventDefault();
        change(
          event.key === 'Home'
            ? 185
            : event.key === 'End'
              ? 420
              : width +
                (event.key === 'ArrowRight' ? 1 : -1) *
                  (event.shiftKey ? 40 : 10),
        );
      }}
    />
  );
}
