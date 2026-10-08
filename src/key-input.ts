import { CURSOR_MARKER, Input, Key, matchesKey } from "@earendil-works/pi-tui";

// Input handles the terminal's bracketed paste protocol (Cmd+V on macOS).
// Only the presentation and visibility toggle differ from the stock input.
export class KeyInput extends Input {
  private visible = true;
  constructor(submit: (value: string) => void) {
    super({ prompt: "OpenAI key (visible): " });
    this.onSubmit = submit;
  }
  override render(width: number) {
    if (this.visible) return super.render(width);
    const label = "OpenAI key (hidden): ";
    const size = Math.max(0, width - label.length - 1);
    const masked = "•".repeat(Math.min(this.getValue().length, size));
    return [label + masked + (this.focused ? CURSOR_MARKER : "")];
  }
  override handleInput(data: string) {
    if (matchesKey(data, Key.ctrl("r"))) { this.visible = !this.visible; return; }
    const before = this.getValue();
    super.handleInput(data);
    if (this.getValue().length > 512) this.setValue(before);
  }
  clear() { this.setValue(""); }
}
