# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""GZip, except over server-sent events."""

# Django imports
from django.middleware.gzip import GZipMiddleware

SSE_CONTENT_TYPE = "text/event-stream"


class StreamingSafeGZipMiddleware(GZipMiddleware):
    """Compresses everything except SSE streams.

    Django wraps a StreamingHttpResponse in an incremental gzip compressor,
    but zlib only emits bytes once its internal buffer fills. The agent's
    events are a few hundred bytes each, so a whole run's worth of tool calls
    can sit inside the compressor and reach the browser only when the response
    ends — the chat showed "thinking" for the entire turn and then dumped the
    finished answer, with none of the live progress the stream was carrying.

    Streaming responses of other kinds (file downloads) still get compressed.
    """

    def process_response(self, request, response):
        if getattr(response, "streaming", False) and SSE_CONTENT_TYPE in response.get("Content-Type", ""):
            return response
        return super().process_response(request, response)
