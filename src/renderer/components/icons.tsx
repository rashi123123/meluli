import type { CSSProperties, HTMLAttributes } from "react";

const assets = import.meta.glob<string>("../assets/sf-symbols/*.png", { eager: true, query: "?url", import: "default" });

function symbol(name: string) {
  return function Symbol({ style, className = "", ...props }: HTMLAttributes<HTMLSpanElement>) {
    return <span {...props} aria-hidden="true" data-sf-symbol={name} className={`sf-symbol ${className}`}
      style={{ "--sf-symbol": `url("${assets[`../assets/sf-symbols/${name}.png`]}")`, ...style } as CSSProperties} />;
  };
}

// SF Symbols rendered through AppKit. Sizes come from CSS.
export const Microphone = symbol("mic.fill");
export const Pause = symbol("pause.fill");
export const Play = symbol("play.fill");
export const Stop = symbol("square.fill");
export const Phone = symbol("phone.fill");
export const X = symbol("xmark");
export const Check = symbol("checkmark");
export const Copy = symbol("doc.on.doc");
export const House = symbol("house.fill");
export const GearSix = symbol("gearshape.fill");
export const DownloadSimple = symbol("arrow.down.to.line");
export const ArrowClockwise = symbol("arrow.counterclockwise");
export const ArrowLeft = symbol("arrow.left");
export const ArrowUp = symbol("arrow.up");
export const ArrowDown = symbol("arrow.down");
export const Plus = symbol("plus");
export const Wand = symbol("wand.and.stars");
export const Sparkles = symbol("sparkles");
export const Envelope = symbol("envelope");
export const Globe = symbol("globe");
export const Bubble = symbol("bubble.left");
export const Terminal = symbol("terminal");
export const Branch = symbol("arrow.triangle.branch");
export const Clipboard = symbol("doc.on.clipboard");
export const ArrowRight = symbol("arrow.right");
export const ArrowSquareOut = symbol("arrow.up.right");
export const ClockCounterClockwise = symbol("clock.fill");
export const BookClosed = symbol("character.book.closed.fill.he");
export const MagnifyingGlass = symbol("magnifyingglass");
export const CaretDown = symbol("chevron.down");
export const Warning = symbol("exclamationmark.triangle");
export const Accessibility = symbol("accessibility");
export const LinkSimple = symbol("link");
export const Info = symbol("info.circle");
export const FolderOpen = symbol("folder");
export const Trash = symbol("trash");
export const Pencil = symbol("pencil");
export const Restore = symbol("arrow.uturn.backward");
export const FloatingWindow = symbol("pip");
