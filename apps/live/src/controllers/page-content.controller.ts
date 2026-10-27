/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import type { Request, Response } from "express";
import * as Y from "yjs";
import { z } from "zod";
// plane imports
import { Controller, Middleware, Post } from "@plane/decorators";
import { getBinaryDataFromDocumentEditorHTMLString } from "@plane/editor";
import { logger } from "@plane/logger";
// lib
import { requireSecretKey } from "@/lib/auth-middleware";
import type { HocusPocusServerContext } from "@/types";

const replaceSchema = z.object({
  page_id: z.string().uuid(),
  workspace_slug: z.string().min(1),
  project_id: z.string().uuid(),
  html: z.string().min(1),
  // The session of the person applying the change: the page is loaded and
  // saved through the API as them, with their permissions
  cookie: z.string().min(1),
  user_id: z.string().min(1),
});

/**
 * Rewrites a page's content from the server (the assistant's page edits).
 * The change goes through the live document, so anyone with the page open
 * sees it at once and it is saved like any other edit, instead of being
 * overwritten by the copy open in someone's editor.
 */
@Controller("/pages")
export class PageContentController {
  [key: string]: unknown;
  private readonly hocusPocusServer: Hocuspocus;

  constructor(hocusPocusServer: Hocuspocus) {
    this.hocusPocusServer = hocusPocusServer;
  }

  @Post("/replace-content")
  @Middleware(requireSecretKey)
  async replaceContent(req: Request, res: Response) {
    const parsed = replaceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Validation error", context: parsed.error.flatten() });
    }
    const { page_id, workspace_slug, project_id, html, cookie, user_id } = parsed.data;
    const context: HocusPocusServerContext = {
      documentType: "project_page",
      workspaceSlug: workspace_slug,
      projectId: project_id,
      cookie,
      userId: user_id,
    };
    try {
      const update = getBinaryDataFromDocumentEditorHTMLString(html);
      const connection = await this.hocusPocusServer.openDirectConnection(page_id, context);
      try {
        await connection.transact((document) => {
          // The body only: the title lives in its own fragment and stays
          const body = document.getXmlFragment("default");
          body.delete(0, body.length);
          Y.applyUpdate(document, update);
        });
      } finally {
        // Leaving stores the document when nobody else has it open
        await connection.disconnect();
      }
      return res.status(200).json({ ok: true });
    } catch (error) {
      logger.error("PAGE_CONTENT_CONTROLLER: Failed to replace page content", error);
      return res.status(500).json({ message: "Could not update the page." });
    }
  }
}
