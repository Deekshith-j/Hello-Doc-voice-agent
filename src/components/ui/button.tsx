// Provides the shared button primitive used across the operational dashboard.
// Variants make hierarchy explicit while preserving one accessible interaction model.
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Press feedback uses transform only, so it never triggers layout.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-[transform,background-color,color,border-color] duration-150 ease-out-strong outline-none select-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary: "bg-foreground text-background hover:bg-foreground/88",
        secondary:
          "border border-border bg-surface text-foreground shadow-card hover:bg-surface-muted",
        ghost:
          "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
        danger: "bg-danger text-white hover:bg-danger/90",
        glass:
          "border border-white/10 bg-white/[0.06] text-white/90 backdrop-blur-md hover:bg-white/[0.11] aria-pressed:bg-white aria-pressed:text-[oklch(0.2_0.02_170)]",
      },
      size: {
        default: "h-9 px-3.5",
        icon: "size-9",
        large: "h-11 rounded-full px-5",
        iconLarge: "size-11 rounded-full",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({
  className,
  size,
  type = "button",
  variant,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ size, variant }), className)}
      type={type}
      {...props}
    />
  );
}
