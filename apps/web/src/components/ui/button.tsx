import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-9 px-3",
        icon: "size-9",
        sm: "h-8 px-2.5 text-xs",
      },
      variant: {
        default: "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
        ghost: "border-transparent bg-transparent text-foreground hover:bg-muted",
        outline: "border-border bg-background text-foreground hover:bg-muted",
        secondary: "border-secondary bg-secondary text-secondary-foreground hover:bg-secondary/80",
      },
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, size, variant, ...props }, ref) => (
    <button className={cn(buttonVariants({ className, size, variant }))} ref={ref} {...props} />
  ),
);

Button.displayName = "Button";
