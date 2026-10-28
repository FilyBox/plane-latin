/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * A page the assistant wrote (report, dossier, minutes…): preview it, edit the
 * text or title, pick the project and visibility, then create it. Mentions in
 * the text become links in the page. It can be undone until someone edits it.
 */

import { useMemo, useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { FilePen, FileText } from "lucide-react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { cn } from "@plane/utils";
import { useProject } from "@/hooks/store/use-project";
import { assistantService } from "@/services/assistant.service";
import { CARD, FIELD, Footer, alreadyUndone, errorText, fold, useOutcome } from "./action-cards";
import { outcomeFromAction } from "./outcome-store";
import { AssistantLink } from "./links";
import { markdownToPreviewHtml } from "./markdown-preview";
import { TraceLine } from "./steps";

type TPageProposal = {
  title?: string;
  markdown?: string;
  project?: string;
  private?: boolean;
  workspace_slug?: string;
};

export const PREVIEW =
  "min-w-0 text-12 leading-relaxed break-words text-primary *:first:mt-0 [&_blockquote]:border-l-2 [&_blockquote]:border-strong [&_blockquote]:pl-2 [&_blockquote]:text-secondary [&_h1]:mt-2 [&_h1]:text-14 [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:text-13 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-medium [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_table]:my-2 [&_table]:w-max [&_table]:min-w-full [&_table]:border-collapse [&_td]:border [&_td]:border-subtle [&_td]:px-1.5 [&_td]:py-0.5 [&_td]:align-top [&_th]:border [&_th]:border-subtle [&_th]:bg-layer-2 [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left [&_th]:font-medium [&_a]:text-accent-primary";

export const PageForm = observer(function PageForm({
  proposal,
  toolCallId,
}: {
  proposal: TPageProposal;
  toolCallId: string;
}) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const { joinedProjectIds, getProjectById } = useProject();
  const [outcome, remember, meta] = useOutcome(`assistant-page:${toolCallId}`);
  const projects = useMemo(
    () =>
      joinedProjectIds
        .map((id) => getProjectById(id))
        .filter((project): project is NonNullable<typeof project> => !!project && !project.archived_at),
    [joinedProjectIds, getProjectById]
  );
  const guessProject = () => {
    const wanted = fold(proposal.project ?? "");
    const match = wanted
      ? (projects.find((project) => fold(project.name) === wanted || fold(project.identifier) === wanted) ??
        projects.find((project) => fold(project.name).includes(wanted)))
      : undefined;
    return (match ?? projects[0])?.id ?? "";
  };
  const [title, setTitle] = useState(proposal.title ?? "");
  const [markdown, setMarkdown] = useState(proposal.markdown ?? "");
  const [projectId, setProjectId] = useState<string>(guessProject);
  const [isPrivate, setIsPrivate] = useState(Boolean(proposal.private));
  const [editing, setEditing] = useState(false);
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const previewHtml = useMemo(() => markdownToPreviewHtml(markdown), [markdown]);

  const apply = async () => {
    remember({ state: "busy" });
    try {
      const action = await assistantService.createAction(slug, {
        ...meta,
        kind: "CREATE_PAGE",
        project_id: projectId,
        name: title,
        markdown,
        private: isPrivate,
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
      await assistantService.undoAction(slug, outcome.id);
      remember({ state: "undone", id: outcome.id });
    } catch (error) {
      if (alreadyUndone(error)) remember({ state: "undone", id: outcome.id });
      else {
        remember({ ...outcome, state: "applied" });
        setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
      }
    }
  };

  const created = outcome.result as { path?: string; name?: string } | undefined;
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <FileText className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">{t("assistant.actions.page_title")}</p>
        {!done && (
          <button
            type="button"
            onClick={() => setEditing((value) => !value)}
            className="shrink-0 text-11 text-accent-primary hover:underline"
          >
            {editing ? t("assistant.actions.preview") : t("assistant.actions.edit_text")}
          </button>
        )}
      </div>
      {done ? (
        <p className="mt-2 text-13 break-words text-primary">{created?.name ?? title}</p>
      ) : (
        <>
          <input
            value={title}
            maxLength={255}
            onChange={(event) => setTitle(event.target.value)}
            aria-label={t("assistant.actions.fields.name")}
            className={cn(FIELD, "mt-2 text-13 font-medium")}
          />
          {editing ? (
            <textarea
              value={markdown}
              rows={10}
              onChange={(event) => setMarkdown(event.target.value)}
              aria-label={t("assistant.actions.fields.content")}
              className={cn(FIELD, "font-mono mt-1.5 [field-sizing:content] max-h-96 min-h-40 resize-y text-11")}
            />
          ) : (
            <div className="mt-1.5 max-h-72 overflow-auto rounded-md border border-subtle px-2.5 py-2">
              <div
                className={PREVIEW}
                // Escaped by the converter before any tag is added.
                // oxlint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              aria-label={t("assistant.actions.fields.project")}
              className={cn(FIELD, "w-auto min-w-0 flex-1")}
            >
              {projects.length === 0 && <option value="">{t("assistant.actions.no_projects")}</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.identifier} · {project.name}
                </option>
              ))}
            </select>
            <label className="flex cursor-pointer items-center gap-1.5 text-12 whitespace-nowrap text-secondary">
              <input
                type="checkbox"
                className="accent-accent-primary"
                checked={isPrivate}
                onChange={(event) => setIsPrivate(event.target.checked)}
              />
              {t("assistant.actions.private")}
            </label>
          </div>
        </>
      )}
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={t("assistant.actions.page_created")}
        extra={
          created?.path ? (
            <AssistantLink href={created.path} className="shrink-0 text-12">
              {t("assistant.actions.open")}
            </AssistantLink>
          ) : null
        }
        applyLabel={t("assistant.actions.create_page")}
        disabled={!title.trim() || !markdown.trim() || !projectId}
        onApply={() => void apply()}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
});

export const PageCard = makeAssistantToolUI<Record<string, unknown>, TPageProposal>({
  toolName: "propose_page",
  render: function PageRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FileText} label={t("assistant.steps.propose_page.running")} />;
    }
    if (!result.workspace_slug) return <p className="text-12 text-tertiary">{t("assistant.actions.failed")}</p>;
    return <PageForm proposal={result} toolCallId={toolCallId} />;
  },
});

/** A report built by the server (an artist's contracts, songs and releases):
 * same card as a written page, ready to review and create. */
export const ReportCard = makeAssistantToolUI<Record<string, unknown>, TPageProposal & { error?: string }>({
  toolName: "propose_report",
  render: function ReportRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FileText} label={t("assistant.steps.propose_report.running")} />;
    }
    if (result.error || !result.workspace_slug || !result.markdown) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <PageForm proposal={result} toolCallId={toolCallId} />;
  },
});

type TPageEditProposal = {
  page_id?: string;
  name?: string;
  path?: string;
  before?: string;
  markdown?: string;
  base_version?: string;
  summary?: string;
  workspace_slug?: string;
  error?: string;
};

// A block the Markdown can't show (image, checklist, code…): it stays as it is
const KEPT_BLOCK = /^\s*\[\[bloque:[0-9a-f]{10}\]\]\s*$/gm;

/** Changes to an existing page: the new version next to the current one,
 * editable before applying; undoable until someone edits the page again. */
const PageEditForm = observer(function PageEditForm({
  proposal,
  toolCallId,
}: {
  proposal: TPageEditProposal;
  toolCallId: string;
}) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const [outcome, remember, meta] = useOutcome(`assistant-page-edit:${toolCallId}`);
  const [markdown, setMarkdown] = useState(proposal.markdown ?? "");
  const [view, setView] = useState<"new" | "current" | "edit">("new");
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const keptLabel = `> ${t("assistant.actions.page_kept_block")}`;
  const previewHtml = useMemo(
    () =>
      markdownToPreviewHtml((view === "current" ? (proposal.before ?? "") : markdown).replace(KEPT_BLOCK, keptLabel)),
    [view, markdown, proposal.before, keptLabel]
  );

  const apply = async () => {
    remember({ state: "busy" });
    try {
      const action = await assistantService.createAction(slug, {
        ...meta,
        kind: "EDIT_PAGE",
        page_id: proposal.page_id,
        markdown,
        base_version: proposal.base_version,
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
      await assistantService.undoAction(slug, outcome.id);
      remember({ state: "undone", id: outcome.id });
    } catch (error) {
      if (alreadyUndone(error)) remember({ state: "undone", id: outcome.id });
      else {
        remember({ ...outcome, state: "applied" });
        setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
      }
    }
  };

  const tab = (key: typeof view, label: string) => (
    <button
      type="button"
      onClick={() => setView(key)}
      aria-pressed={view === key}
      className={cn(
        "rounded-sm px-1.5 py-0.5 text-11",
        view === key ? "bg-layer-2 font-medium text-primary" : "text-secondary hover:text-primary"
      )}
    >
      {label}
    </button>
  );

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <FilePen className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.actions.page_edit_title", { name: proposal.name ?? "" })}
        </p>
      </div>
      {proposal.summary && <p className="mt-1 text-12 text-secondary">{proposal.summary}</p>}
      {!done && (
        <>
          <div className="mt-2 flex items-center gap-1">
            {tab("new", t("assistant.actions.page_new_version"))}
            {tab("current", t("assistant.actions.page_current_version"))}
            {tab("edit", t("assistant.actions.edit_text"))}
          </div>
          {view === "edit" ? (
            <textarea
              value={markdown}
              rows={10}
              onChange={(event) => setMarkdown(event.target.value)}
              aria-label={t("assistant.actions.fields.content")}
              className={cn(FIELD, "font-mono mt-1.5 [field-sizing:content] max-h-96 min-h-40 resize-y text-11")}
            />
          ) : (
            <div className="mt-1.5 max-h-72 overflow-auto rounded-md border border-subtle px-2.5 py-2">
              <div
                className={PREVIEW}
                // Escaped by the converter before any tag is added.
                // oxlint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>
          )}
        </>
      )}
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={t("assistant.actions.page_edited")}
        extra={
          proposal.path ? (
            <AssistantLink href={proposal.path} className="shrink-0 text-12">
              {t("assistant.actions.open")}
            </AssistantLink>
          ) : null
        }
        applyLabel={t("assistant.actions.apply_page_edit")}
        disabled={!markdown.trim()}
        onApply={() => void apply()}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
});

export const PageEditCard = makeAssistantToolUI<Record<string, unknown>, TPageEditProposal>({
  toolName: "propose_page_edit",
  render: function PageEditRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FilePen} label={t("assistant.steps.propose_page_edit.running")} />;
    }
    if (result.error || !result.workspace_slug || !result.page_id) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <PageEditForm proposal={result} toolCallId={toolCallId} />;
  },
});
