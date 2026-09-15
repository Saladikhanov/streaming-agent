import { useState } from "react";

import type { QuestionNode } from "./model";
import { tr } from "../i18n";

type Props = {
  node: QuestionNode;
  /** Interactive only while this ask is still the one waiting on the user. */
  isPending: boolean;
  onSubmit: (text: string) => void;
};

/**
 * An ask-user-question card.
 *
 * The whole ask submits as one turn: there is deliberately no per-question
 * submit, because the brief requires the answers to arrive together. Any
 * question may be left unanswered, and every question accepts free-form text
 * alongside its options — the offered choices are suggestions, not a menu the
 * user is confined to.
 *
 * Once answered the card stays visible but inert. Nothing records *that* it was
 * answered: the answering user message follows it in the transcript, which is
 * what makes the state survive reopening the thread with no persistence.
 */
export function QuestionCard({ isPending, node, onSubmit }: Props) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  const toggle = (questionId: string, label: string, isMulti: boolean) => {
    setChosen((current) => {
      const existing = current[questionId] ?? [];
      if (!isMulti) {
        return { ...current, [questionId]: existing.includes(label) ? [] : [label] };
      }
      return {
        ...current,
        [questionId]: existing.includes(label)
          ? existing.filter((one) => one !== label)
          : [...existing, label],
      };
    });
  };

  const submit = () => {
    // One message covering every question, so the reply is a single user turn.
    const lines = node.questions.map((question) => {
      const answers = [...(chosen[question.id] ?? [])];
      const typed = freeText[question.id]?.trim();
      if (typed) {
        answers.push(typed);
      }
      return `${question.header}: ${answers.length > 0 ? answers.join(", ") : tr('question.noAnswer')}`;
    });
    onSubmit(lines.join("\n"));
  };

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3">
      <div className="space-y-3">
        {node.questions.map((question) => (
          <fieldset key={question.id}>
            <legend className="text-[11px] font-medium tracking-wide text-blue-700 uppercase">
              {question.header}
            </legend>
            <p className="mt-0.5 mb-2">{question.question}</p>

            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option) => {
                const isSelected = (chosen[question.id] ?? []).includes(option.label);
                return (
                  <button
                    className={`rounded-full border px-3 py-1 text-xs ${
                      isSelected
                        ? "border-blue-600 bg-blue-600 text-white"
                        : "border-neutral-300 bg-white hover:bg-neutral-50"
                    } disabled:opacity-60`}
                    disabled={!isPending}
                    key={option.label}
                    onClick={() => toggle(question.id, option.label, question.multi_select)}
                    title={option.description}
                    type="button"
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            <input
              className="mt-2 w-full rounded border border-neutral-300 px-2 py-1 text-xs disabled:bg-neutral-100"
              disabled={!isPending}
              onChange={(event) => setFreeText((current) => ({ ...current, [question.id]: event.target.value }))}
              placeholder={tr('question.freeTextPlaceholder')}
              value={freeText[question.id] ?? ""}
            />
          </fieldset>
        ))}
      </div>

      <button
        className="mt-3 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:bg-neutral-300"
        disabled={!isPending}
        onClick={submit}
        type="button"
      >
        {isPending ? tr('question.submit') : tr('question.submitted')}
      </button>
    </div>
  );
}
