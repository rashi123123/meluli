import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { he } from "@shared/locale";

export interface InfoSection {
  title?: string;
  paragraphs: readonly string[];
}

export function InfoPage({ title, sections, footnote, onBack, showVersion = false, children }: { title: string; sections: readonly InfoSection[]; footnote?: string; onBack: () => void; showVersion?: boolean; children?: ReactNode }) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!showVersion) return;
    let current = true;
    void window.ivritMenuBar.app.version().then(next => { if (current) setVersion(next); }).catch(() => undefined);
    return () => { current = false; };
  }, [showVersion]);
  return <div className="info-page">
    <div className="info-page-head"><Button variant="ghost" size="sm" onClick={onBack}><ArrowRight />{he.back}</Button></div>
    <div className="info-page-body">
      {/* The toolbar already holds this page's heading for screen readers. */}
      <p className="info-page-title" aria-hidden="true">{title}</p>
      {sections.map((section, index) => <section key={section.title ?? index} className="info-page-section">
        {section.title && <h3>{section.title}</h3>}
        {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </section>)}
      {children}
      {version && <p className="info-page-version">{he.appVersion} <span dir="ltr">{version}</span></p>}
      {footnote && <p className="info-page-version">{footnote}</p>}
    </div>
  </div>;
}
