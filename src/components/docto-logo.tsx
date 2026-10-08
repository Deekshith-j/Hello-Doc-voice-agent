// Renders Docto's compact wordmark and appointment-inspired symbol.
// The mark inherits theme tokens so it needs no per-theme artwork.
export function DoctoLogo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative grid size-7 place-items-center rounded-[9px] bg-foreground text-background">
        <span className="h-3 w-[5px] rounded-full bg-accent" />
        <span className="absolute h-[5px] w-3 rounded-full bg-accent" />
      </div>
      <span className="text-[15px] font-semibold tracking-[-0.03em]">
        Docto
      </span>
    </div>
  );
}
