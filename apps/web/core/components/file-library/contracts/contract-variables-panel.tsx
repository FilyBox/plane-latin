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
import { Check, Copy, Info, Loader2 } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import type {
  TContractTemplateSummary,
  TContractTemplateVariableSchema,
  TContractTemplateWarning,
  TContractVariableSetting,
} from "@plane/types";
import { cn } from "@plane/utils";
// local imports
import { formatTemplateCounts, templateCounts, variableLabel } from "./template-utils";
import { TemplateWarnings } from "./template-warnings";

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

/** The variables found in the document being edited (recomputed after saves). */
export type TDocumentVariables = {
  schema?: TContractTemplateVariableSchema | null;
  summary?: TContractTemplateSummary | null;
  warnings?: TContractTemplateWarning[];
  isLoading?: boolean;
  variableSettings?: Record<string, TContractVariableSetting>;
  recipientRoles?: Record<string, string>;
};

type Props = {
  className?: string;
  /** When given, the panel opens on "Variables de este documento". */
  documentVariables?: TDocumentVariables;
};

type PanelTab = "DOCUMENT" | "REFERENCE";

/** The reference itself; the editor modal decides when to show it. */
export function ContractVariablesPanel({ className, documentVariables }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PanelTab>(documentVariables ? "DOCUMENT" : "REFERENCE");
  return (
    <aside className={cn("flex h-full min-h-0 w-full flex-col bg-surface-1", className)}>
      <div className="shrink-0 border-b border-subtle px-3 py-2">
        <p className="text-12 font-medium">{t(`${PREFIX}.title`)}</p>
        {documentVariables ? (
          <div className="mt-2 grid grid-cols-2 rounded-md bg-layer-2 p-0.5">
            {(["DOCUMENT", "REFERENCE"] as const).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
                className={cn(
                  "rounded px-2 py-1 text-11",
                  tab === key ? "shadow-sm bg-surface-1 font-medium text-primary" : "text-tertiary"
                )}
              >
                {t(
                  key === "DOCUMENT"
                    ? "file_library.contracts.workflow.doc_variables.tab_document"
                    : "file_library.contracts.workflow.doc_variables.tab_reference"
                )}
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-0.5 text-11 text-tertiary">{t(`${PREFIX}.subtitle`)}</p>
        )}
      </div>
      {documentVariables && tab === "DOCUMENT" ? (
        <DocumentVariables value={documentVariables} />
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {documentVariables ? <p className="text-11 text-tertiary">{t(`${PREFIX}.subtitle`)}</p> : null}
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
      )}
    </aside>
  );
}

/** A token chip that copies itself. */
function TokenChip({ token, label, meta }: { token: string; label?: string; meta?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const text = placeholder(token);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <li>
      <button
        type="button"
        onClick={() => void copy()}
        title={t("file_library.contracts.workflow.doc_variables.copy_hint")}
        className="flex w-full min-w-0 items-center gap-2 rounded-md border border-subtle bg-layer-1 px-2.5 py-1.5 text-left hover:bg-layer-1-hover"
      >
        <span className="min-w-0 flex-1">
          <code className="font-mono block truncate text-11 text-primary">{text}</code>
          {label || meta ? (
            <span className="block truncate text-11 text-tertiary">{[label, meta].filter(Boolean).join(" · ")}</span>
          ) : null}
        </span>
        {copied ? (
          <Check className="size-3.5 shrink-0 text-success-primary" />
        ) : (
          <Copy className="size-3.5 shrink-0 text-tertiary" />
        )}
      </button>
    </li>
  );
}

function DocumentVariables({ value }: { value: TDocumentVariables }) {
  const { t } = useTranslation();
  const schema = value.schema;
  if (value.isLoading && !schema)
    return (
      <div className="grid flex-1 place-items-center">
        <Loader2 className="size-4 animate-spin text-tertiary" />
      </div>
    );
  if (!schema)
    return (
      <p className="p-3 text-11 text-tertiary">{t("file_library.contracts.workflow.doc_variables.unavailable")}</p>
    );

  const counts = templateCounts({ summary: value.summary, schema });
  const variables = schema.variables ?? [];
  const recipients = schema.recipients ?? [];
  const fields = schema.signing_fields ?? [];
  const roleName = (index: number, fallback: string) => value.recipientRoles?.[String(index)]?.trim() || fallback;

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <p className="flex items-center gap-1.5 text-11 text-secondary">
        {value.isLoading ? <Loader2 className="size-3 animate-spin text-tertiary" /> : null}
        {formatTemplateCounts(t, counts)}
      </p>
      <TemplateWarnings warnings={value.warnings ?? schema.warnings ?? []} compact />
      <section>
        <p className="text-10 font-medium tracking-wide text-tertiary uppercase">
          {t("file_library.contracts.workflow.summary.data")}
        </p>
        {variables.length === 0 ? (
          <p className="mt-1 text-11 text-tertiary">
            {t("file_library.contracts.workflow.doc_variables.no_data", { example: "{{NombreCliente}}" })}
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {variables.map((variable) => (
              <TokenChip
                key={variable.key}
                token={variable.key}
                label={variableLabel(variable.key, variable.label, value.variableSettings?.[variable.key])}
                meta={
                  variable.occurrences > 1
                    ? t("file_library.contracts.workflow.use.occurrences", { count: variable.occurrences })
                    : undefined
                }
              />
            ))}
          </ul>
        )}
      </section>
      <section>
        <p className="text-10 font-medium tracking-wide text-tertiary uppercase">
          {t("file_library.contracts.workflow.summary.signers")}
        </p>
        {recipients.length === 0 ? (
          <p className="mt-1 text-11 text-tertiary">
            {t("file_library.contracts.workflow.doc_variables.no_signers", {
              first: "{{NombreFirmante1}}",
              second: "{{FirmaFirmante1}}",
            })}
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {recipients.map((recipient) => (
              <li key={recipient.index} className="rounded-md border border-subtle bg-layer-1 px-2.5 py-1.5">
                <p className="truncate text-12 font-medium text-primary">
                  {roleName(
                    recipient.index,
                    t("file_library.contracts.workflow.common.signer_number", { number: recipient.index + 1 })
                  )}
                </p>
                <p className="truncate text-11 text-tertiary">
                  {fields
                    .filter((field) => field.recipient_index === recipient.index)
                    .map((field) => field.label)
                    .join(", ") || t("file_library.contracts.workflow.doc_variables.no_signature_yet")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
