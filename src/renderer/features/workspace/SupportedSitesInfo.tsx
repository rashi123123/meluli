import { useRef } from "react";
import { Popover } from "@base-ui/react/popover";
import { ArrowSquareOut, Info } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { he } from "@shared/locale";
import { SUPPORTED_SITES_URL } from "@shared/constants";

// Every name here was downloaded and decoded in testing; the full list is yt-dlp's.
const SITES = ["SoundCloud", "Dailymotion", "Bilibili", "TED"];

export function SupportedSitesInfo() {
  // Focus lands on the panel, not its link, so a second Enter does not open the browser.
  const popup = useRef<HTMLDivElement>(null);
  return <Popover.Root>
    <Popover.Trigger render={<Button type="button" variant="ghost" size="icon-xs" className="source-info" aria-label={he.supportedSitesLabel} title={he.supportedSitesLabel} />}><Info /></Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12} className="sites-positioner">
        <Popover.Popup ref={popup} initialFocus={popup} tabIndex={-1} className="sites-popup app-no-drag">
          <Popover.Title className="sites-title">{he.supportedSitesTitle}</Popover.Title>
          <ul className="sites-list" dir="ltr">{SITES.map(site => <li key={site}>{site}</li>)}</ul>
          <Popover.Description className="sites-note">{he.supportedSitesNote}</Popover.Description>
          <Button type="button" variant="ghost" size="sm" className="sites-link" onClick={() => void window.ivritMenuBar.files.openExternal(SUPPORTED_SITES_URL)}>{he.supportedSitesAll}<ArrowSquareOut /></Button>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
