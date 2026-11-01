import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context/app-context";
import { SettingsRow } from "@/features/settings/SettingsRow";
import { usePendingActions } from "@/hooks/use-pending-actions";
import { he } from "@shared/locale";
import { useId } from "react";
import { DictionarySection } from "./DictionarySection";

export function DictionaryView() {
  const { settings, updateSetting } = useAppContext();
  const { pendingActions, runAction, switchBusy } = usePendingActions();
  const builtInTermsLabelId = useId();
  const builtInTermsDescriptionId = useId();

  if (!settings) return null;

  return <div className="settings-page">
    <section className="settings-group">
      <div className="settings-rows">
        <SettingsRow title={he.builtInTerms} titleId={builtInTermsLabelId} description={he.builtInTermsDescription} descriptionId={builtInTermsDescriptionId}>
          <Switch checked={settings.builtInTerms} aria-labelledby={builtInTermsLabelId} aria-describedby={builtInTermsDescriptionId} {...switchBusy("builtInTerms")}
            onCheckedChange={(checked) => void runAction("builtInTerms", () => updateSetting("builtInTerms", checked))} />
        </SettingsRow>
        <SettingsRow title={he.dictionaryPersonal} description={he.dictionaryPersonalDescription}
          detail={<DictionarySection entries={settings.dictionary} busy={pendingActions.has("dictionary")}
            onChange={(next) => void runAction("dictionary", () => updateSetting("dictionary", next))} />} />
      </div>
    </section>
  </div>;
}
