import { OrbitGlyph } from "@/components/OrbitGlyph";
import { he } from "@shared/locale";

export function LoadingMark() {
  return <span className="loading-mark">
    <OrbitGlyph top={270} height={750} ringClassName="loading-mark-ring">
      <rect x="416" y="288" width="402" height="522" rx="201" />
      <path d="M378 628C378 770 490 869 622 869C750 869 848 780 865 672" fill="none" stroke="currentColor" strokeWidth="50" strokeLinecap="round" />
      <rect x="593" y="880" width="64" height="72" />
      <rect x="464" y="942" width="321" height="60" rx="30" />
    </OrbitGlyph>
    <span className="loading-mark-label">{he.loadingContent}</span>
  </span>;
}
