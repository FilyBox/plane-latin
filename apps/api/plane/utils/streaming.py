# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Proxying an upstream SSE stream without Django buffering it."""

# Third party imports
from asgiref.sync import sync_to_async

# Django imports
from django.core.handlers.asgi import ASGIRequest

_EXHAUSTED = object()


def proxy_stream(request, upstream, chunk_size=None):
    """Iterate `upstream` in the flavour the running server can stream.

    Django adapts a mismatched iterator by materialising it. Under ASGI a sync
    iterator is drained with ``await sync_to_async(list)(...)`` before a single
    part is yielded; under WSGI an async one goes through an equivalent
    ``to_list``. Either way the entire agent run is collected before the first
    byte reaches the browser.

    That difference is invisible in development — ``runserver`` is WSGI and
    streams a plain `requests` iterator fine — while production runs gunicorn
    with UvicornWorker, where the same code buffered the whole turn and the
    chat sat on "thinking" until the run finished.

    So the iterator is chosen from the request class: an async generator for
    ASGI, the plain sync iterator for WSGI.
    """
    chunks = upstream.iter_content(chunk_size=chunk_size)
    # DRF hands views its own Request wrapper, so the ASGI/WSGI class lives on
    # `_request`; testing the wrapper itself always says WSGI and silently
    # puts every deployment back on the buffering path.
    underlying = getattr(request, "_request", request)
    if not isinstance(underlying, ASGIRequest):
        return chunks

    def read_next():
        return next(chunks, _EXHAUSTED)

    async def aiterator():
        try:
            while True:
                # `requests` blocks, so each read is handed to a worker thread
                # rather than stalling the event loop.
                chunk = await sync_to_async(read_next, thread_sensitive=False)()
                if chunk is _EXHAUSTED:
                    break
                yield chunk
        finally:
            await sync_to_async(upstream.close, thread_sensitive=False)()

    return aiterator()
