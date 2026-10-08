// Gives every dashboard page the same title block so hierarchy stays identical across screens.
// Only one h1 exists per page, and it lives here.
import type { ReactNode } from "react";

export function PageHeader({
  actions,
  description,
  eyebrow,
  title,
}: {
  actions?: ReactNode;
  description?: string;
  eyebrow?: ReactNode;
  title: string;
}) {
  return (
    <div className="enter flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div>
        {eyebrow}
        <h1
          className={`text-2xl font-semibold tracking-[-0.035em] text-balance ${eyebrow ? "mt-2.5" : ""}`}
        >
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export function PageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1180px] px-4 py-6 md:px-6 md:py-8">
      {children}
    </div>
  );
}

export function EmptyState({
  children,
  title,
}: {
  children?: ReactNode;
  title: string;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? (
        <div className="mx-auto mt-1 max-w-[46ch] text-xs leading-5 text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}
