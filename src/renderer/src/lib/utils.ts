import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Tailwind-aware class merger.
 *
 * `clsx` accepts arrays / objects / nested conditions; `tailwind-merge`
 * dedupes conflicting Tailwind utilities (e.g. `px-2 px-4` → `px-4`),
 * which matters as soon as components compose user-supplied `className`
 * over a base list. Together they're the canonical shadcn/ui pattern;
 * every primitive in `components/ui/` calls `cn(...)` for its base
 * classes plus the `className` prop.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
