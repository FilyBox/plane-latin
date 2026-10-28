/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * A contract template edited by the assistant: every change with the text
 * around it (one checkbox per appearance), what it does to the variables and
 * signers, the format check, a PDF preview, and where it is saved: a new
 * variant (the default, its name editable) or a new version of a variant
 * the person asked to change. The base is never written.
 */

import { useMemo, useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Eye, FileCog } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractTemplateWarning } from "@plane/types";
import { cn } from "@plane/utils";
import { TemplateWarnings } from "@/components/file-library/contracts/template-warnings";
import { assistantService } from "@/services/assistant.service";
import { CARD, FIELD, Footer, alreadyUndone, errorText, useOutcome } from "./action-cards";
import { AssistantLink } from "./links";
import { outcomeFromAction } from "./outcome-store";
import { TraceLine } from "./steps";

type TApplied = {
  index?: number;
  paragraph: string;
  location?: string;
  before?: string;
  text?: string;
  after?: string;
  replacement?: string;
  inserted?: string;
  inserted_paragraphs?: string[];
  deleted_text?: string;
  position?: string;
  loose?: boolean;
};

type TEdit = { op: string; default_off?: boolean; occurrences?: "all" | number[] } & Record<string, unknown>;

type TTemplateEditProposal = {
  base?: {
    variant_id: string;
    variant_name: string;
    template_name: string;
    revision?: number | null;
    latest_revision?: number | null;
    base_sha256: string;
    has_unpublished_draft?: boolean;
  };
  edits?: TEdit[];
  operations?: { op: string; applied: TApplied[] }[];
  warnings?: { code: string; paragraph?: string; text?: string }[];
  document_warnings?: TContractTemplateWarning[];
  schema_changes?: { added: string[]; removed: string[]; signers_added: number[]; signers_removed: number[] };
  variable_settings?: Record<string, { label?: string; required?: boolean; case?: string }>;
  recipient_roles?: Record<string, string>;
  verification?: {
    runs_changed: number;
    paragraphs_changed: number;
    paragraphs_inserted: number;
    paragraphs_deleted: number;
  };
  manual_fields?: number;
  save?: "new_variant" | "this_variant";
  name?: string;
  summary?: string;
  workspace_slug?: string;
  error?: string;
};

/** The edits as they go to the server, with the appearances left checked. */
function chosenEdits(edits: TEdit[], operations: TTemplateEditProposal["operations"], off: Set<string>) {
  const result: TEdit[] = [];
  edits.forEach((edit, position) => {
    const applied = operations?.[position]?.applied ?? [];
    if (edit.op === "replace_text") {
      const indexes = applied
        .map((item, row) => ({ index: item.index ?? row, key: `${position}:${row}` }))
        .filter((item) => !off.has(item.key))
        .map((item) => item.index);
      if (indexes.length > 0) result.push({ ...edit, occurrences: indexes, default_off: undefined });
    } else if (!off.has(`${position}:0`)) {
      result.push(edit);
    }
  });
  return result;
}

function Change({ item }: { item: TApplied }) {
  const { t } = useTranslation();
  const middle =
    item.replacement !== undefined ? (
      <>
        <span className="text-danger-primary line-through">{item.text}</span>
        <span className="mx-0.5 text-tertiary">→</span>
        <span className="rounded-sm bg-success-subtle px-0.5 text-success-primary">{item.replacement}</span>
      </>
    ) : item.inserted !== undefined ? (
      <>
        {item.position === "before" && (
          <span className="rounded-sm bg-success-subtle px-0.5 text-success-primary">{item.inserted}</span>
        )}
        <span>{item.text}</span>
        {item.position !== "before" && (
          <span className="rounded-sm bg-success-subtle px-0.5 text-success-primary">{item.inserted}</span>
        )}
      </>
    ) : item.inserted_paragraphs ? (
      <span className="text-success-primary">
        {t("assistant.templates.new_paragraph", { count: item.inserted_paragraphs.length })}:{" "}
        {item.inserted_paragraphs.join(" / ")}
      </span>
    ) : item.deleted_text !== undefined ? (
      <span className="text-danger-primary line-through">{item.deleted_text}</span>
    ) : (
      <span>{item.text}</span>
    );
  return (
    <span className="min-w-0 text-11 leading-snug break-words text-secondary">
      {item.before ? <span className="text-tertiary">…{item.before}</span> : null}
      {middle}
      {item.after ? <span className="text-tertiary">{item.after}…</span> : null}
    </span>
  );
}

function TemplateEditForm({ proposal, toolCallId }: { proposal: TTemplateEditProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const base = proposal.base!;
  const edits = useMemo(() => proposal.edits ?? [], [proposal.edits]);
  const [outcome, remember, meta] = useOutcome(`assistant-template-edit:${toolCallId}`);
  const newVariant = proposal.save !== "this_variant";
  const [name, setName] = useState(proposal.name ?? `${base.variant_name} – ${proposal.summary ?? ""}`.slice(0, 200));
  // Appearances the person left out; partial ones ("el Sr. Pérez") start out
  const [off, setOff] = useState<Set<string>>(() => {
    const keys = new Set<string>();
    edits.forEach((edit, position) => {
      if (!edit.default_off) return;
      (proposal.operations?.[position]?.applied ?? []).forEach((_, row) => keys.add(`${position}:${row}`));
    });
    return keys;
  });
  const [previewing, setPreviewing] = useState(false);
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const chosen = useMemo(() => chosenEdits(edits, proposal.operations, off), [edits, proposal.operations, off]);

  const toggle = (key: string) =>
    setOff((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const preview = async () => {
    setPreviewing(true);
    try {
      const { blob, note } = await assistantService.templatePreview(slug, base.variant_id, {
        revision: base.revision ?? undefined,
        edits: chosen,
      });
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
      if (note) {
        const [, pages] = note.split(":");
        setToast({ type: TOAST_TYPE.INFO, title: t("assistant.templates.pages_changed", { pages }) });
      }
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.templates.preview_failed")) });
    } finally {
      setPreviewing(false);
    }
  };

  const apply = async () => {
    remember({ state: "busy" });
    try {
      const action = await assistantService.createAction(slug, {
        ...meta,
        kind: newVariant ? "CREATE_TEMPLATE_VARIANT" : "EDIT_TEMPLATE_VARIANT",
        base: { variant_id: base.variant_id, revision: base.revision ?? undefined },
        base_sha256: base.base_sha256,
        edits: chosen,
        name: newVariant ? name : undefined,
        variable_settings: proposal.variable_settings,
        recipient_roles: proposal.recipient_roles,
      });
      remember(outcomeFromAction(action));
    } catch (error) {
      remember({ state: "idle" });
      setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
    }
  };
  const undo = async () => {
    if (!outcome.id) return;
    remember({ ...outcome, state: "busy" });
    try {
      const action = await assistantService.undoAction(slug, outcome.id);
      remember(outcomeFromAction(action));
    } catch (error) {
      if (alreadyUndone(error)) remember({ state: "undone", id: outcome.id });
      else {
        remember({ ...outcome, state: "applied" });
        setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
      }
    }
  };

  const result = outcome.result as { path?: string; variant_name?: string; revision?: number } | undefined;
  const changes = proposal.schema_changes;
  const verification = proposal.verification;
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <FileCog className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.templates.title", { template: base.template_name })}
        </p>
      </div>
      <p className="mt-0.5 text-11 text-tertiary">
        {t("assistant.templates.base", {
          variant: base.variant_name,
          version: base.revision ?? base.latest_revision ?? "—",
        })}
        {base.has_unpublished_draft ? ` · ${t("assistant.templates.draft_ignored")}` : ""}
      </p>
      {proposal.summary && <p className="mt-1.5 text-12 text-primary">{proposal.summary}</p>}

      <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto">
        {edits.map((edit, position) =>
          (proposal.operations?.[position]?.applied ?? []).map((item, row) => {
            const key = `${position}:${row}`;
            const checked = !off.has(key);
            return (
              <li key={key}>
                <label
                  className={cn(
                    "flex items-start gap-2 rounded-md px-1.5 py-1",
                    !done && "cursor-pointer hover:bg-layer-1-hover"
                  )}
                >
                  <input
                    type="checkbox"
                    className="accent-accent-primary mt-0.5"
                    checked={checked}
                    disabled={done || busy}
                    onChange={() => toggle(key)}
                  />
                  <span className={cn("min-w-0 flex-1", !checked && "opacity-50")}>
                    <Change item={item} />
                    <span className="mt-0.5 block text-10 text-tertiary">
                      {t(`assistant.templates.locations.${item.location ?? "body"}`)}
                      {item.loose ? ` · ${t("assistant.templates.loose")}` : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })
        )}
      </ul>

      {changes &&
        (changes.added.length > 0 ||
          changes.removed.length > 0 ||
          changes.signers_added.length > 0 ||
          changes.signers_removed.length > 0) && (
          <div className="mt-2 space-y-0.5 text-11">
            {changes.added.map((key) => (
              <p key={`a:${key}`} className="text-success-primary">
                {t("assistant.templates.variable_added", {
                  label: proposal.variable_settings?.[key]?.label ?? key,
                  key,
                })}
                {proposal.variable_settings?.[key]?.required ? ` · ${t("assistant.templates.required")}` : ""}
                {proposal.variable_settings?.[key]?.case === "upper" ? ` · ${t("assistant.templates.upper")}` : ""}
              </p>
            ))}
            {changes.removed.map((key) => (
              <p key={`r:${key}`} className="text-danger-primary">
                {t("assistant.templates.variable_removed", { key })}
              </p>
            ))}
            {changes.signers_added.map((index) => (
              <p key={`s:${index}`} className="text-success-primary">
                {t("assistant.templates.signer_added", { index: index + 1 })}
              </p>
            ))}
          </div>
        )}

      {(proposal.warnings ?? []).map((warning) => (
        <p
          key={`${warning.code}:${warning.paragraph ?? ""}:${warning.text ?? ""}`}
          className="mt-1 text-11 text-warning-primary"
        >
          {t(`assistant.templates.warnings.${warning.code}`, { text: warning.text ?? "" })}
        </p>
      ))}
      {proposal.manual_fields ? (
        <p className="mt-1 text-11 text-warning-primary">
          {t("assistant.templates.manual_fields", { count: proposal.manual_fields })}
        </p>
      ) : null}
      {(proposal.document_warnings?.length ?? 0) > 0 && (
        <TemplateWarnings warnings={proposal.document_warnings!} compact className="mt-2" />
      )}
      {verification && (
        <p className="mt-2 text-11 text-tertiary">
          {t("assistant.templates.verified", {
            runs: verification.runs_changed,
            paragraphs:
              verification.paragraphs_changed + verification.paragraphs_inserted + verification.paragraphs_deleted,
          })}
        </p>
      )}

      {!done && (
        <div className="mt-2.5 space-y-1.5 border-t border-subtle pt-2.5">
          {newVariant ? (
            <label className="block">
              <span className="text-11 text-tertiary">{t("assistant.templates.new_variant_name")}</span>
              <input
                value={name}
                maxLength={200}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                className={cn(FIELD, "mt-0.5")}
              />
            </label>
          ) : (
            <p className="text-12 text-secondary">
              {t("assistant.templates.new_version_of", { variant: base.variant_name })}
            </p>
          )}
          <p className="text-11 text-tertiary">{t("assistant.templates.base_untouched")}</p>
          <Button
            variant="secondary"
            size="sm"
            loading={previewing}
            disabled={chosen.length === 0}
            onClick={() => void preview()}
          >
            <Eye className="size-3" />
            {t("assistant.templates.preview")}
          </Button>
        </div>
      )}
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={
          newVariant
            ? t("assistant.templates.created", { name: result?.variant_name ?? name })
            : t("assistant.templates.versioned", { version: result?.revision ?? "" })
        }
        extra={
          result?.path ? (
            <AssistantLink href={result.path} className="shrink-0 text-12">
              {t("assistant.templates.open")}
            </AssistantLink>
          ) : null
        }
        applyLabel={t(newVariant ? "assistant.templates.apply_new" : "assistant.templates.apply_version")}
        disabled={chosen.length === 0 || (newVariant && !name.trim())}
        onApply={() => void apply()}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const TemplateEditCard = makeAssistantToolUI<Record<string, unknown>, TTemplateEditProposal>({
  toolName: "propose_template_edit",
  render: function TemplateEditRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FileCog} label={t("assistant.steps.propose_template_edit.running")} />;
    }
    if (result.error || !result.base || !result.workspace_slug) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <TemplateEditForm proposal={result} toolCallId={toolCallId} />;
  },
});
