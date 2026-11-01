import type { ReactNode } from "react";

export function SettingsRow({ title, titleId, description, descriptionId, children, detail }: {
  title: ReactNode; titleId?: string; description?: ReactNode; descriptionId?: string; children?: ReactNode; detail?: ReactNode;
}) {
  return <div className="settings-row">
    <div className="settings-row-copy">
      <span id={titleId} className="settings-row-title">{title}</span>
      {description && <span id={descriptionId} className="settings-row-description">{description}</span>}
    </div>
    {children && <div className="settings-row-control">{children}</div>}
    {detail && <div className="settings-row-wide">{detail}</div>}
  </div>;
}
