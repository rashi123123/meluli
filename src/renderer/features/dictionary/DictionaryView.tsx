import { Check } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { SettingsRow } from "@/features/settings/SettingsRow";
import { usePendingActions } from "@/hooks/use-pending-actions";
import { TERM_PACK_IDS } from "@shared/constants";
import { he } from "@shared/locale";
import type { TermPackId } from "@shared/types";
import { useId, useState } from "react";
import { DictionarySection } from "./DictionarySection";

export function DictionaryView() {
  const { settings, updateSetting } = useAppContext();
  const { pendingActions, runAction, switchBusy } = usePendingActions();
  const packsTitleId = useId();
  const packsNoteId = useId();
  const exampleId = useId();
  const [shown, setShown] = useState<TermPackId | null>(null);

  if (!settings) return null;

  // One busy key for every pack, so a second switch never saves from a list that is still changing.
  const togglePack = (id: TermPackId, checked: boolean) => {
    const next = TERM_PACK_IDS.filter((pack) => pack === id ? checked : settings.termPacks.includes(pack));
    void runAction("termPacks", () => updateSetting("termPacks", next));
  };

  return <div className="settings-page">
    {/* The person's own corrections are why they come here; the packs are set once. */}
    <section className="settings-group">
      <div className="settings-rows">
        <SettingsRow title={he.dictionaryPersonal} description={he.dictionaryPersonalDescription}
          detail={<DictionarySection entries={settings.dictionary} busy={pendingActions.has("dictionary")}
            onChange={(next) => void runAction("dictionary", () => updateSetting("dictionary", next))} />} />
      </div>
    </section>
    <section className="settings-group" aria-labelledby={packsTitleId} aria-describedby={packsNoteId}>
      <h3 id={packsTitleId}>{he.builtInTerms}</h3>
      <p id={packsNoteId} className="settings-group-note">{he.builtInTermsDescription}</p>
      {/* Chips, not six full rows: the names are short, and one example line under them is enough. */}
      <div className="settings-rows term-packs">
        <div className="term-pack-chips" role="group" aria-labelledby={packsTitleId}>
          {TERM_PACK_IDS.map((id) => {
            const on = settings.termPacks.includes(id);
            return <Button key={id} variant="plain" className="term-pack" aria-pressed={on} aria-describedby={`${exampleId}-${id}`}
              {...switchBusy("termPacks")} onClick={() => togglePack(id, !on)}
              onPointerEnter={() => setShown(id)} onPointerLeave={() => setShown(null)} onFocus={() => setShown(id)} onBlur={() => setShown(null)}>
              <span className="term-pack-mark" aria-hidden="true">{on && <Check />}</span>{he.termPackNames[id]}
              <span id={`${exampleId}-${id}`} hidden>{he.termPackExamples[id]}</span>
            </Button>;
          })}
        </div>
        <p className="term-pack-example" aria-hidden="true">{shown ? he.termPackExamples[shown] : he.termPackHint}</p>
      </div>
    </section>
  </div>;
}
