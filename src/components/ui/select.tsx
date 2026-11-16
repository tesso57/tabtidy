import { Check, ChevronDown } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  id?: string;
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

function computeMenuStyle(trigger: HTMLElement, optionCount: number): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(Math.max(rect.width, 112), Math.max(112, viewportWidth - 16));
  const right = Math.min(
    Math.max(8, viewportWidth - rect.right),
    Math.max(8, viewportWidth - width - 8)
  );
  const estimatedHeight = optionCount * 32 + 10;
  const spaceBelow = viewportHeight - rect.bottom;
  const spaceAbove = rect.top;
  const openUpward = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
  const maxHeight = Math.max(80, (openUpward ? spaceAbove : spaceBelow) - 12);

  return {
    position: 'fixed',
    right,
    width,
    maxHeight,
    ...(openUpward
      ? { bottom: viewportHeight - rect.top + 4 }
      : { top: rect.bottom + 4 }),
  };
}

export function Select({
  id,
  value,
  options,
  onValueChange,
  disabled = false,
  className,
}: SelectProps) {
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const listboxId = useId();
  const open = menuStyle !== null;

  const selectedIndex = useMemo(
    () => Math.max(0, options.findIndex((o) => o.value === value)),
    [options, value]
  );

  const selectedLabel = useMemo(
    () => (options.find((o) => o.value === value) ?? options[0])?.label ?? '',
    [options, value]
  );

  useEffect(() => {
    if (!open) return;

    const targetIndex = pendingFocusIndexRef.current;
    if (targetIndex !== null) {
      pendingFocusIndexRef.current = null;
      const optionButtons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      optionButtons?.[targetIndex]?.focus({ preventScroll: true });
    }

    const handlePointerDown = (e: PointerEvent) => {
      if (
        e.target instanceof Node &&
        (triggerRef.current?.contains(e.target) || menuRef.current?.contains(e.target))
      ) {
        return;
      }
      setMenuStyle(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuStyle(null);
        triggerRef.current?.focus({ preventScroll: true });
        return;
      }

      if (e.key === 'Tab') {
        if (menuRef.current?.contains(document.activeElement)) {
          triggerRef.current?.focus({ preventScroll: true });
        }
        setMenuStyle(null);
        return;
      }

      if (
        e.key !== 'ArrowDown' &&
        e.key !== 'ArrowUp' &&
        e.key !== 'Home' &&
        e.key !== 'End'
      ) {
        return;
      }

      const optionButtons = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
      );
      if (optionButtons.length === 0) return;

      e.preventDefault();
      const currentIdx = optionButtons.findIndex((el) => el === document.activeElement);
      let nextIdx = selectedIndex;

      if (e.key === 'Home') {
        nextIdx = 0;
      } else if (e.key === 'End') {
        nextIdx = optionButtons.length - 1;
      } else if (currentIdx === -1) {
        nextIdx = Math.min(selectedIndex, optionButtons.length - 1);
      } else if (e.key === 'ArrowDown') {
        nextIdx = (currentIdx + 1) % optionButtons.length;
      } else {
        nextIdx = (currentIdx - 1 + optionButtons.length) % optionButtons.length;
      }

      optionButtons[nextIdx]?.focus({ preventScroll: true });
    };

    const handleScrollOrResize = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setMenuStyle(null);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleScrollOrResize, { passive: true });
    window.addEventListener('scroll', handleScrollOrResize, { capture: true, passive: true });

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
    };
  }, [open, selectedIndex]);

  function openMenu(focusIndex: number | null) {
    if (disabled || options.length === 0) return;
    const el = triggerRef.current;
    if (!el) return;
    pendingFocusIndexRef.current = focusIndex;
    setMenuStyle(computeMenuStyle(el, options.length));
  }

  function handleToggle(e: ReactMouseEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (open) {
      setMenuStyle(null);
      return;
    }
    openMenu(e.detail === 0 ? selectedIndex : null);
  }

  function handleTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled || open || options.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(selectedIndex);
    }
  }

  function handleOptionClick(e: ReactMouseEvent<HTMLButtonElement>) {
    const nextValue = e.currentTarget.dataset.value;
    const shouldReturnFocus = menuRef.current?.contains(document.activeElement) ?? false;
    setMenuStyle(null);
    if (shouldReturnFocus) {
      triggerRef.current?.focus({ preventScroll: true });
    }
    if (nextValue !== undefined && nextValue !== value) {
      onValueChange(nextValue);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={handleToggle}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          'inline-flex h-7 min-w-[96px] shrink-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground shadow-xs transition-colors cursor-pointer hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
            open && 'rotate-180'
          )}
        />
      </button>

      {menuStyle &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            role="listbox"
            style={menuStyle}
            className="thin-scrollbar z-50 overflow-y-auto rounded-md border border-border bg-card p-1 text-card-foreground shadow-lg"
          >
            {options.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  data-value={opt.value}
                  onClick={handleOptionClick}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-xs px-2 py-1.5 text-left text-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    isSelected
                      ? 'bg-accent font-semibold text-accent-foreground'
                      : 'text-foreground hover:bg-muted focus-visible:bg-muted'
                  )}
                >
                  <span className="truncate">{opt.label}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}
