// Centralizes class-name composition for reusable UI primitives.
// Tailwind Merge prevents variant classes from producing conflicting output.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
