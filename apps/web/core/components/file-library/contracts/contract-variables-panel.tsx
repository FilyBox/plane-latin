/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Reference for the reserved template placeholders, shown beside the Word
 * editor.
 *
 * Most `{{Something}}` in a template is a free variable the user fills in from
 * a form. A specific set is not: those become recipients and interactive
 * signing fields in the generated PDF. Nothing in the editor said which was
 * which, so the only way to discover them was to read the backend. This panel
 * is that reference, with the tokens copyable so the naming stays exact.
 *
 * The catalogue mirrors `plane/integrations/contract_docx.py` (FIELD_PREFIXES
 * and `_classify`). Matching there is accent- and case-insensitive, so the
 * casing below is a readable convention rather than a requirement.
 */

import { useState } from "react";
import { Check, Copy, Info } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import { cn } from "@plane/utils";

/** One reserved placeholder, described for the person writing the template. */
type TVariableSpec = {
  /** Token as it goes in the document, without braces */
  token: string;
  /** What it becomes once the contract is generated */
  descriptionKey: string;
  /** How to write it for several signers or several occurrences */
  exampleKey: string;
};

type TVariableGroup = {
  titleKey: string;
  hintKey: string;
  variables: TVariableSpec[];
};

const PREFIX = "file_library.contracts.workflow.variables";

/**
 * `Firmante1`, `Firmante2`… select the recipient. The suffix is optional on
 * the three signing prefixes, where it means the first recipient.
 */
const GROUPS: TVariableGroup[] = [
  {
    titleKey: `${PREFIX}.groups.recipients`,
    hintKey: `${PREFIX}.groups.recipients_hint`,
    variables: [
      {
        token: "NombreFirmante1",
        descriptionKey: `${PREFIX}.items.recipient_name`,
        exampleKey: `${PREFIX}.examples.recipient_name`,
      },
      {
        token: "CorreoFirmante1",
        descriptionKey: `${PREFIX}.items.recipient_email`,
        exampleKey: `${PREFIX}.examples.recipient_email`,
      },
    ],
  },
  {
    titleKey: `${PREFIX}.groups.signing`,
    hintKey: `${PREFIX}.groups.signing_hint`,
    variables: [
      {
        token: "FirmaFirmante1",
        descriptionKey: `${PREFIX}.items.signature`,
        exampleKey: `${PREFIX}.examples.signature`,
      },
      {
        token: "InicialesFirmante1",
        descriptionKey: `${PREFIX}.items.initials`,
        exampleKey: `${PREFIX}.examples.initials`,
      },
      {
        token: "FechaFirmaFirmante1",
        descriptionKey: `${PREFIX}.items.sign_date`,
        exampleKey: `${PREFIX}.examples.sign_date`,
      },
    ],
  },
  {
    titleKey: `${PREFIX}.groups.fields`,
    hintKey: `${PREFIX}.groups.fields_hint`,
    variables: [
      {
        token: "CampoNombreFirmante1",
        descriptionKey: `${PREFIX}.items.field_name`,
        exampleKey: `${PREFIX}.examples.field_name`,
      },
      {
        token: "CampoCorreoFirmante1",
        descriptionKey: `${PREFIX}.items.field_email`,
        exampleKey: `${PREFIX}.examples.field_email`,
      },
      {
        token: "CampoFechaFirmante1",
        descriptionKey: `${PREFIX}.items.field_date`,
        exampleKey: `${PREFIX}.examples.field_date`,
      },
      {
        token: "TextoFirmante1",
        descriptionKey: `${PREFIX}.items.field_text`,
        exampleKey: `${PREFIX}.examples.field_text`,
      },
      {
        token: "NumeroFirmante1",
        descriptionKey: `${PREFIX}.items.field_number`,
        exampleKey: `${PREFIX}.examples.field_number`,
      },
      {
        token: "CasillaFirmante1",
        descriptionKey: `${PREFIX}.items.field_checkbox`,
        exampleKey: `${PREFIX}.examples.field_checkbox`,
      },
      {
        token: "RadioFirmante1",
        descriptionKey: `${PREFIX}.items.field_radio`,
        exampleKey: `${PREFIX}.examples.field_radio`,
      },
      {
        token: "ListaFirmante1",
        descriptionKey: `${PREFIX}.items.field_dropdown`,
        exampleKey: `${PREFIX}.examples.field_dropdown`,
      },
    ],
  },
  {
    titleKey: `${PREFIX}.groups.free`,
    hintKey: `${PREFIX}.groups.free_hint`,
    variables: [
      {
        token: "NombreDelProyecto",
        descriptionKey: `${PREFIX}.items.free_text`,
        exampleKey: `${PREFIX}.examples.free_text`,
      },
      {
        token: "FechaDeInicio",
        descriptionKey: `${PREFIX}.items.free_date`,
        exampleKey: `${PREFIX}.examples.free_date`,
      },
      {
        token: "NumeroDeSerie",
        descriptionKey: `${PREFIX}.items.free_number`,
        exampleKey: `${PREFIX}.examples.free_number`,
      },
    ],
  },
];

const placeholder = (token: string) => `{{${token}}}`;

function VariableRow({ variable }: { variable: TVariableSpec }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const text = placeholder(variable.token);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be blocked by permissions; the token stays selectable.
      setCopied(false);
    }
  };

  return (
    <li className="group rounded-md border border-subtle bg-layer-1 px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <code className="font-mono min-w-0 flex-1 truncate text-11 text-primary" title={text}>
          {text}
        </code>
        <Tooltip tooltipContent={t(variable.exampleKey)} position="left">
          <span className="shrink-0 text-tertiary">
            <Info className="size-3.5" />
          </span>
        </Tooltip>
        <button
          type="button"
          onClick={() => void copy()}
          className="shrink-0 rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
          title={t(`${PREFIX}.copy`)}
          aria-label={t(`${PREFIX}.copy`)}
        >
          {copied ? <Check className="size-3.5 text-success-primary" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <p className="mt-0.5 text-11 leading-snug text-tertiary">{t(variable.descriptionKey)}</p>
    </li>
  );
}

type Props = {
  className?: string;
};

/** The reference itself; the editor modal decides when to show it. */
export function ContractVariablesPanel({ className }: Props) {
  const { t } = useTranslation();
  return (
    <aside className={cn("flex h-full min-h-0 w-full flex-col bg-surface-1", className)}>
      <div className="shrink-0 border-b border-subtle px-3 py-2">
        <p className="text-12 font-medium">{t(`${PREFIX}.title`)}</p>
        <p className="mt-0.5 text-11 text-tertiary">{t(`${PREFIX}.subtitle`)}</p>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {GROUPS.map((group) => (
          <section key={group.titleKey}>
            <p className="text-10 font-medium tracking-wide text-tertiary uppercase">{t(group.titleKey)}</p>
            <p className="mt-0.5 mb-1.5 text-11 leading-snug text-tertiary">{t(group.hintKey)}</p>
            <ul className="space-y-1.5">
              {group.variables.map((variable) => (
                <VariableRow key={variable.token} variable={variable} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
