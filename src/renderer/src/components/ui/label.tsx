import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils'

/**
 * shadcn/ui Label — copy-pasted from
 * https://ui.shadcn.com/docs/components/label. Wraps Radix's accessible
 * label primitive so clicking the label focuses the bound input via
 * htmlFor.
 */
const labelVariants = cva(
  'text-xs font-medium leading-none text-muted-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70'
)

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props} />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
