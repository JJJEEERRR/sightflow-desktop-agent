import * as React from 'react'

import { cn } from '../../lib/utils'

/**
 * shadcn/ui Input — copy-pasted from
 * https://ui.shadcn.com/docs/components/input. Renders a styled
 * `<input>` that picks up the same `--input` border / `--ring` focus
 * tokens as the rest of the form surface.
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border border-input bg-background/40 px-3 py-1 text-sm font-mono text-foreground shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
