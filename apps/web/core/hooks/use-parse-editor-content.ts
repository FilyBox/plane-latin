/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import { useTranslation } from "@plane/i18n";
// plane types
import type { TEntityCard, TSearchEntities } from "@plane/types";
// helpers
import { getBase64Image, getEditorAssetSrc } from "@plane/utils";
import type { TCustomComponentsMetaData } from "@plane/utils";
// references
import { entityLabelKey, isEntityName } from "@/components/references/entity-meta";
// hooks
import { useMember } from "@/hooks/store/use-member";
// plane web hooks
import { useAdditionalEditorMention } from "@/hooks/use-additional-editor-mention";
// services
import { referencesService } from "@/services/references.service";

type TMentionLabel = { textContent: string; path?: string };

type TArgs = {
  projectId?: string;
  workspaceSlug: string;
};

export const useParseEditorContent = (args: TArgs) => {
  const { projectId, workspaceSlug } = args;
  const { t } = useTranslation();
  // store hooks
  const { getUserDetails } = useMember();
  // parse additional content
  const { parseAdditionalEditorContent } = useAdditionalEditorMention({
    enableAdvancedMentions: true,
  });

  /**
   * @description labels for every mention in the exported content: the user's display name, or the
   * contract/song/file… title resolved in one request (same lookup and permissions as the editor chips).
   * Items the reader can't see, or that no longer exist, show their kind ("Canción", "Contrato"…).
   */
  const getMentionLabels = useCallback(
    async (mentions: { id: string; entityType: string }[]): Promise<Map<string, TMentionLabel>> => {
      const entities = new Map<string, { entity_name: string; id: string }>();
      mentions.forEach(({ id, entityType }) => {
        if (id && entityType !== "user_mention" && isEntityName(entityType))
          entities.set(`${entityType}:${id}`, { entity_name: entityType, id });
      });
      let cards: TEntityCard[] = [];
      if (entities.size > 0 && workspaceSlug) {
        try {
          cards = await referencesService.resolve(workspaceSlug, [...entities.values()]);
        } catch (error) {
          console.error("Failed to resolve mentioned items for export:", error);
        }
      }
      const resolved = new Map(
        cards
          .filter((card) => card.status === "ok" && card.title)
          .map((card) => [`${card.entity_name}:${card.id}`, card])
      );

      const labels = new Map<string, TMentionLabel>();
      mentions.forEach(({ id, entityType }) => {
        const key = `${entityType}:${id}`;
        if (labels.has(key)) return;
        if (entityType === "user_mention") {
          labels.set(key, {
            textContent: getUserDetails(id)?.display_name ?? "",
            path: `${workspaceSlug}/profile/${id}`,
          });
        } else if (isEntityName(entityType)) {
          const card = resolved.get(key);
          labels.set(
            key,
            card
              ? { textContent: card.title ?? "", path: card.path?.replace(/^\//, "") }
              : { textContent: t(entityLabelKey(entityType)) }
          );
        } else {
          const details = parseAdditionalEditorContent({ id, entityType: entityType as TSearchEntities });
          labels.set(
            key,
            details ? { textContent: details.textContent, path: details.redirectionPath } : { textContent: "" }
          );
        }
      });
      return labels;
    },
    [getUserDetails, parseAdditionalEditorContent, t, workspaceSlug]
  );

  /**
   * @description function to replace all the custom components from the html component to make it pdf compatible
   * @param props
   * @returns {Promise<string>}
   */
  const replaceCustomComponentsFromHTMLContent = useCallback(
    async (props: { htmlContent: string; noAssets?: boolean }): Promise<string> => {
      const { htmlContent, noAssets = false } = props;
      // create a DOM parser
      const parser = new DOMParser();
      // parse the HTML string into a DOM document
      const doc = parser.parseFromString(htmlContent, "text/html");
      // replace all mention-component elements
      const mentionComponents = Array.from(doc.querySelectorAll("mention-component"));
      const readMention = (component: Element) => ({
        id: component.getAttribute("entity_identifier") || "",
        entityType: component.getAttribute("entity_name") || "user_mention",
      });
      const mentionLabels = await getMentionLabels(mentionComponents.map(readMention));
      mentionComponents.forEach((component) => {
        const { id, entityType } = readMention(component);
        // create a span element to replace the mention-component
        const span = doc.createElement("span");
        span.setAttribute("data-node-type", "mention-block");
        span.textContent = `@${mentionLabels.get(`${entityType}:${id}`)?.textContent ?? ""}`;
        // replace the mention-component with the span element
        component.replaceWith(span);
      });
      // handle code inside pre elements
      const preElements = doc.querySelectorAll("pre");
      preElements.forEach((preElement) => {
        const codeElement = preElement.querySelector("code");
        if (codeElement) {
          // create a div element with the required attributes for code blocks
          const div = doc.createElement("div");
          div.setAttribute("data-node-type", "code-block");
          div.setAttribute("class", "courier");
          // transfer the content from the code block
          div.innerHTML = codeElement.innerHTML.replace(/\n/g, "<br>") || "";
          // replace the pre element with the new div
          preElement.replaceWith(div);
        }
      });
      // handle inline code elements (not inside pre tags)
      const inlineCodeElements = doc.querySelectorAll("code");
      inlineCodeElements.forEach((codeElement) => {
        // check if the code element is inside a pre element
        if (!codeElement.closest("pre")) {
          // create a span element with the required attributes for inline code blocks
          const span = doc.createElement("span");
          span.setAttribute("data-node-type", "inline-code-block");
          span.setAttribute("class", "courier-bold");
          // transfer the code content
          span.textContent = codeElement.textContent || "";
          // replace the standalone code element with the new span
          codeElement.replaceWith(span);
        }
      });
      // handle image-component elements
      const imageComponents = doc.querySelectorAll("image-component");
      if (noAssets) {
        // if no assets is enabled, remove the image component elements
        imageComponents.forEach((component) => component.remove());
        // remove default img elements
        const imageElements = doc.querySelectorAll("img");
        imageElements.forEach((img) => img.remove());
      } else {
        // if no assets is not enabled, replace the image component elements with img elements
        imageComponents.forEach((component) => {
          // get the image src from the component
          const src = component.getAttribute("src") ?? "";
          const height = component.getAttribute("height") ?? "";
          const width = component.getAttribute("width") ?? "";
          // create an img element to replace the image-component
          const img = doc.createElement("img");
          img.src = src;
          img.style.height = height;
          img.style.width = width;
          // replace the image-component with the img element
          component.replaceWith(img);
        });
      }
      // convert all images to base64
      const imgElements = doc.querySelectorAll("img");
      await Promise.all(
        Array.from(imgElements).map(async (img) => {
          // get the image src from the img element
          const src = img.getAttribute("src");
          if (src) {
            try {
              const base64Image = await getBase64Image(src);
              img.src = base64Image;
            } catch (error) {
              // log the error if the image conversion fails
              console.error("Failed to convert image to base64:", error);
            }
          }
        })
      );
      // replace all checkbox elements
      const checkboxComponents = doc.querySelectorAll("input[type='checkbox']");
      checkboxComponents.forEach((component) => {
        // get the checked status from the element
        const checked = component.getAttribute("checked");
        // create a div element to replace the input element
        const div = doc.createElement("div");
        div.classList.value = "input-checkbox";
        // add the checked class if the checkbox is checked
        if (checked === "checked" || checked === "true") div.classList.add("checked");
        // replace the input element with the div element
        component.replaceWith(div);
      });
      // remove all issue-embed-component elements
      const issueEmbedComponents = doc.querySelectorAll("issue-embed-component");
      issueEmbedComponents.forEach((component) => component.remove());
      // serialize the document back into a string
      let serializedDoc = doc.body.innerHTML;
      // remove null colors from table elements
      serializedDoc = serializedDoc.replace(/background-color: null/g, "").replace(/color: null/g, "");
      return serializedDoc;
    },
    [getMentionLabels]
  );

  /**
   * @description function to replace all the custom components from the markdown content
   * @param props
   * @returns {Promise<string>}
   */
  const replaceCustomComponentsFromMarkdownContent = useCallback(
    async (props: { markdownContent: string; noAssets?: boolean }): Promise<string> => {
      const { markdownContent, noAssets = false } = props;
      let parsedMarkdownContent = markdownContent;
      // replace the matched mention components with [display_name](redirect_url)
      const mentionRegex =
        /<mention-component[^>]*entity_identifier="([^"]+)"[^>]*entity_name="([^"]+)"[^>]*><\/mention-component>/g;
      const originUrl = typeof window !== "undefined" && (window.location.origin ?? "");
      const mentionLabels = await getMentionLabels(
        Array.from(markdownContent.matchAll(mentionRegex), ([, id, entityType]) => ({ id, entityType }))
      );
      parsedMarkdownContent = parsedMarkdownContent.replace(mentionRegex, (_match, id: string, entityType: string) => {
        const label = mentionLabels.get(`${entityType}:${id}`);
        if (!label?.textContent) return "";
        return label.path ? `[${label.textContent}](${originUrl}/${label.path})` : label.textContent;
      });
      // replace the matched image components with <img src={src} >
      const imageComponentRegex = /<image-component[^>]*src="([^"]+)"[^>]*>[^]*<\/image-component>/g;
      const imgTagRegex = /<img[^>]*src="([^"]+)"[^>]*\/?>/g;
      if (noAssets) {
        // remove all image components
        parsedMarkdownContent = parsedMarkdownContent.replace(imageComponentRegex, "").replace(imgTagRegex, "");
      } else {
        // replace the matched image components with <img src={src} >
        parsedMarkdownContent = parsedMarkdownContent.replace(
          imageComponentRegex,
          (_match, src) => `<img src="${src}" >`
        );
      }
      // remove all issue-embed components
      const issueEmbedRegex = /<issue-embed-component[^>]*>[^]*<\/issue-embed-component>/g;
      parsedMarkdownContent = parsedMarkdownContent.replace(issueEmbedRegex, "");
      return parsedMarkdownContent;
    },
    [getMentionLabels]
  );

  const getEditorMetaData = useCallback(
    (htmlContent: string): TCustomComponentsMetaData => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlContent, "text/html");
      const filesMetaData: TCustomComponentsMetaData["file_assets"] = [];
      // process image components
      const imageComponents = doc.querySelectorAll("image-component");
      imageComponents.forEach((element) => {
        const src = element.getAttribute("src");
        if (src) {
          const assetSrc = src.startsWith("http")
            ? src
            : getEditorAssetSrc({
                assetId: src,
                projectId,
                workspaceSlug,
              });
          if (assetSrc) {
            filesMetaData.push({
              id: src,
              name: src,
              url: assetSrc,
            });
          }
        }
      });
      // process user mentions
      const userMentions: TCustomComponentsMetaData["user_mentions"] = [];
      const mentionComponents = doc.querySelectorAll("mention-component");
      mentionComponents.forEach((element) => {
        const id = element.getAttribute("entity_identifier");
        if (id) {
          const userDetails = getUserDetails(id);
          const originUrl = typeof window !== "undefined" && (window.location.origin ?? "");
          const path = `${workspaceSlug}/profile/${id}`;
          const url = `${originUrl}/${path}`;
          if (userDetails) {
            userMentions.push({
              id,
              display_name: userDetails.display_name,
              url,
            });
          }
        }
      });

      return {
        file_assets: filesMetaData,
        user_mentions: userMentions,
      };
    },
    [getUserDetails, projectId, workspaceSlug]
  );

  return {
    replaceCustomComponentsFromHTMLContent,
    replaceCustomComponentsFromMarkdownContent,
    getEditorMetaData,
  };
};
