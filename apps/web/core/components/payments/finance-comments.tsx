import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TCommentsOperations, TIssueComment } from "@plane/types";
import { CommentCreate } from "@/components/comments/comment-create";
import { CommentCard } from "@/components/comments/card/root";
import { useUser } from "@/hooks/store/user";
import { fileLibraryService } from "@/services/file-library.service";
import { financeService } from "@/services/finance.service";

export type FinanceCommentTarget = { scenario?: string; expense?: string; row_key?: string; cell?: string };
type Comment = TIssueComment & { parent: string | null };

export function FinanceComments({ workspaceSlug, target }: { workspaceSlug: string; target: FinanceCommentTarget }) {
  const { t } = useTranslation();
  const { data: user } = useUser();
  const { mutate: mutateGlobal } = useSWRConfig();
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const path = `/api/workspaces/${workspaceSlug}/finance-comments/`;
  const {
    data: comments = [],
    mutate,
    error,
  } = useSWR<Comment[]>([path, target], () =>
    financeService.get(path, { params: target }).then((response) => response.data)
  );
  const refresh = async () => {
    await mutate();
    void mutateGlobal((key) => Array.isArray(key) && key[0] === "FINANCE_COMMENT_COUNTS");
  };
  const run = async (operation: Promise<unknown>) => {
    try {
      await operation;
      await refresh();
    } catch (reason) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
      throw reason;
    }
  };
  const react = (id: string, emoji: string, active: boolean) =>
    run(financeService.patch(`${path}${id}/`, { reaction: emoji, active }));
  const operations: TCommentsOperations = {
    createComment: async (data) => {
      try {
        const response = await financeService.post(path, {
          ...target,
          comment_html: data.comment_html,
          parent: replyTo,
        });
        setReplyTo(null);
        await refresh();
        return response.data;
      } catch (reason) {
        setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
        throw reason;
      }
    },
    updateComment: (id, data) => run(financeService.patch(`${path}${id}/`, { comment_html: data.comment_html })),
    removeComment: (id) => run(financeService.delete(`${path}${id}/`)),
    uploadCommentAsset: (_blockId, file) => fileLibraryService.uploadFile(workspaceSlug, file),
    duplicateCommentAsset: async (assetId) => {
      await fileLibraryService.getPresignedViewUrl(workspaceSlug, assetId);
      return { asset_id: assetId };
    },
    addCommentReaction: (id, emoji) => react(id, emoji, true),
    deleteCommentReaction: (id, emoji) => react(id, emoji, false),
    react: (id, emoji, existing) => react(id, emoji, !existing.includes(emoji)),
    userReactions: (id) =>
      (comments.find((item) => item.id === id)?.comment_reactions ?? [])
        .filter((r) => r.actor === user?.id)
        .map((r) => r.reaction),
    reactionIds: (id) => {
      const groups: Record<string, string[]> = {};
      for (const reaction of comments.find((item) => item.id === id)?.comment_reactions ?? [])
        (groups[reaction.reaction] ??= []).push(reaction.actor);
      return groups;
    },
    getReactionUsers: (emoji, groups) =>
      [
        ...new Set(
          comments
            .flatMap((item) => item.comment_reactions)
            .filter((r) => r.reaction === emoji && groups[emoji]?.includes(r.actor))
            .map((r) => r.actor_detail?.display_name ?? "")
        ),
      ].join(", "),
    copyCommentLink: (id) => {
      void navigator.clipboard.writeText(`${window.location.href.split("#")[0]}#comment-${id}`);
    },
  };
  const entityId = target.expense ?? target.scenario!;
  const renderThread = (parent: string | null, depth = 0): React.ReactNode =>
    comments
      .filter((comment) => comment.parent === parent)
      .map((comment) => (
        <div key={comment.id} className={depth ? "ml-5 border-l border-subtle pl-3" : ""}>
          <CommentCard
            workspaceSlug={workspaceSlug}
            entityId={entityId}
            comment={comment}
            activityOperations={operations}
            ends={undefined}
            showAccessSpecifier={false}
            showCopyLinkOption={false}
            enableReplies={false}
          />
          <button
            type="button"
            className="mb-3 ml-9 text-12 text-tertiary hover:text-primary"
            onClick={() => setReplyTo(comment.id)}
          >
            {t("common.actions.reply")}
          </button>
          {renderThread(comment.id, depth + 1)}
        </div>
      ));
  // The handler only stops the peek panel from reading Escape as "close" while
  // someone is typing a comment; it adds no behaviour of its own.
  // eslint-disable-next-line jsx-a11y/no-static-element-interactions
  return (
    <section className="space-y-4" onKeyDown={(event) => event.stopPropagation()}>
      {error && (
        <button type="button" onClick={() => void mutate()}>
          {t("payments.ledger.retry")}
        </button>
      )}
      {renderThread(null)}
      {replyTo && (
        <div className="flex items-center justify-between text-12 text-secondary">
          <span>{comments.find((comment) => comment.id === replyTo)?.actor_detail?.display_name}</span>
          <button type="button" onClick={() => setReplyTo(null)}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      <CommentCreate
        key={`${target.cell ?? ""}-${replyTo ?? "root"}`}
        assetsAlreadyUploaded
        workspaceSlug={workspaceSlug}
        entityId={entityId}
        activityOperations={operations}
        showToolbarInitially
      />
    </section>
  );
}
