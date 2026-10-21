import { cn } from "@/lib/utils";

/** Summit Air mark: two peaks over a horizon line, in the brand accent. Inline SVG, no asset. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} role="img" aria-label="Summit Air">
      <rect width="32" height="32" rx="8" className="fill-brand" />
      <path d="M5 23 12.5 11l4 6.2L19.5 13 27 23Z" className="fill-brand-foreground" />
      <path d="m12.5 11 2.3 3.6-1.3-.7-1 1.1-1-1.4Z" className="fill-brand" opacity="0.55" />
      <path d="M5 25.5h22" className="stroke-brand-foreground" strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}

export function BrandLockup({ subtitle = "Operations", className }: { subtitle?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <div className="leading-tight">
        <p className="text-[15px] font-semibold tracking-tight">Summit Air</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}
