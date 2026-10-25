/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The "?" beside the composer: a short card on what the assistant can do,
 * each with an example that is typed into the composer when clicked.
 */

import { useRef, useState } from "react";
import { useAui } from "@assistant-ui/react";
import { CircleHelp } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Popover } from "@plane/propel/popover";

const CAPABILITIES = ["search", "pages", "tasks", "tags", "music"] as const;

type Props = {
  /** The music catalog is on for this workspace */
  music: boolean;
};

export function AssistantHelp({ music }: Props) {
  const { t } = useTranslation();
  const aui = useAui();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  // Set when an example was picked, so closing focuses the composer instead of the "?"
  const inserted = useRef(false);

  const composerInput = () => anchorRef.current?.closest("form")?.querySelector("textarea") ?? null;

  const insert = (text: string) => {
    aui.composer().setText(text);
    inserted.current = true;
    setOpen(false);
  };

  const capabilities = CAPABILITIES.filter((key) => key !== "music" || music);

  return (
    <span ref={anchorRef} className="flex shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Button
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-tertiary outline-none hover:bg-layer-1-hover hover:text-secondary focus-visible:ring-1 focus-visible:ring-accent-strong"
          aria-label={t("assistant.help.label")}
          title={t("assistant.help.label")}
        >
          <CircleHelp className="size-3.5" aria-hidden />
        </Popover.Button>
        <Popover.Panel
          side="top"
          align="end"
          sideOffset={10}
          positionerClassName="z-[40]"
          finalFocus={() => {
            if (!inserted.current) return true;
            inserted.current = false;
            const input = composerInput();
            if (!input) return true;
            input.setSelectionRange(input.value.length, input.value.length);
            return input;
          }}
        >
          <div className="w-72 rounded-lg border border-subtle bg-surface-1 p-3 text-12 shadow-raised-200">
            <p className="font-medium text-primary">{t("assistant.help.all_contracts")}</p>
            <ExampleButton text={t("assistant.help.all_contracts_example")} onPick={insert} />
            <p className="mt-1 text-11 leading-relaxed text-placeholder">{t("assistant.help.all_contracts_note")}</p>

            <p className="mt-3 border-t border-subtle pt-2.5 font-medium text-primary">{t("assistant.help.also")}</p>
            <ul className="mt-1 space-y-1.5">
              {capabilities.map((key) => (
                <li key={key}>
                  <span className="block text-secondary">{t(`assistant.help.${key}`)}</span>
                  <ExampleButton text={t(`assistant.help.${key}_example`)} onPick={insert} />
                </li>
              ))}
            </ul>
          </div>
        </Popover.Panel>
      </Popover>
    </span>
  );
}

function ExampleButton({ text, onPick }: { text: string; onPick: (text: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(text)}
      className="mt-0.5 block w-full rounded-md px-1.5 py-1 text-left text-11 text-tertiary outline-none hover:bg-layer-1-hover hover:text-accent-primary focus-visible:ring-1 focus-visible:ring-accent-strong"
    >
      “{text}”
    </button>
  );
}
