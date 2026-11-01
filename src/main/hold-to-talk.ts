/** Decides what a held key means once, so a release only ends what its own press began. */
export class HoldToTalk {
  private holding: "dictation" | "test" | null = null;

  constructor(private readonly actions: {
    setupComplete: () => boolean;
    begin: () => void;
    end: () => void;
    /** Setup is still open, so the key only proves it works and no window comes up. */
    test: (pressed: boolean) => void;
  }) {}

  press(): void {
    if (this.holding) return;
    this.holding = this.actions.setupComplete() ? "dictation" : "test";
    if (this.holding === "dictation") this.actions.begin();
    else this.actions.test(true);
  }

  release(): void {
    const held = this.holding;
    this.holding = null;
    if (held === "dictation") this.actions.end();
    else if (held === "test") this.actions.test(false);
  }
}
