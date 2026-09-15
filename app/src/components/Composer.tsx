import { useState } from "react";
import { tr } from "../i18n";

type Props = {
  disabled: boolean;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /**
   * Set while an unanswered question is blocking free-form input. Explains the
   * lock in the composer itself, so it does not read as a broken input.
   */
  lockedReason?: string;
};

export function Composer({ disabled, isStreaming, lockedReason, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const isLocked = disabled || lockedReason !== undefined;

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || isLocked || isStreaming) {
      return;
    }
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="border-t border-neutral-200 bg-white p-3">
      <div className="flex items-end gap-2">
        <textarea
          className="max-h-40 min-h-10 flex-1 resize-none rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          disabled={isLocked}
          onChange={(changeEvent) => setText(changeEvent.target.value)}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === "Enter" && !keyEvent.shiftKey) {
              keyEvent.preventDefault();
              submit();
            }
          }}
          placeholder={lockedReason ?? (disabled ? tr('composer.noThread') : tr('composer.placeholder'))}
          rows={1}
          value={text}
        />
        {isStreaming ? (
          <button
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
            onClick={onStop}
            type="button"
          >
            {tr('composer.stop')}
          </button>
        ) : (
          <button
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            disabled={isLocked || !text.trim()}
            onClick={submit}
            type="button"
          >
            {tr('composer.send')}
          </button>
        )}
      </div>
    </div>
  );
}
