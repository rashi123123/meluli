import { FloatingRecorderHud } from "@/features/overlay/FloatingRecorderHud";

import { usePointerFeedback } from "@/components/usePointerFeedback";

export default function OverlayApp() {
  usePointerFeedback();
  return <FloatingRecorderHud />;
}
