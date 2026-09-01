# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Thin HTTP client for the Cloudflare Worker that runs the contracts
pipeline. Django never talks to the Cloudflare account API directly — the
Worker exposes a narrow, single-purpose trigger surface protected by a shared
secret (same pattern as LIVE_SERVER_SECRET_KEY for apps/live).
"""

import requests
from django.conf import settings

# Generic, infra-free message safe to hand to any authenticated caller.
# WorkerTriggerError's own message (str(e)) carries the real detail — base
# URL, raw connection error, the Worker's response body — for server logs
# only; callers must log the exception and use `.public_message`, never
# str(e), when building the HTTP response.
_GENERIC_WORKER_ERROR = "The AI service is temporarily unavailable. Please try again shortly."


class WorkerTriggerError(Exception):
    def __init__(self, message, public_message=_GENERIC_WORKER_ERROR):
        super().__init__(message)
        self.public_message = public_message


def _post(path, payload, timeout=30):
    base_url = settings.CF_WORKER_TRIGGER_URL
    secret = settings.CF_WORKER_TRIGGER_SECRET
    if not base_url or not secret:
        raise WorkerTriggerError("CF_WORKER_TRIGGER_URL / CF_WORKER_TRIGGER_SECRET are not configured")

    try:
        response = requests.post(
            f"{base_url.rstrip('/')}{path}",
            json=payload,
            headers={"X-Trigger-Secret": secret},
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise WorkerTriggerError(f"Worker unreachable at {base_url}: {exc}") from exc
    if response.status_code >= 400:
        raise WorkerTriggerError(f"Worker trigger failed ({response.status_code}): {response.text[:500]}")
    return response.json()


def trigger_contract_pipeline(job_id, contract_id, workspace_id, asset_id, mode="EXTRACT_FULL", retry_options=None):
    """Starts a ContractPipelineWorkflow instance; returns the workflow instance id."""
    data = _post(
        "/trigger/extract",
        {
            "job_id": str(job_id),
            "contract_id": str(contract_id),
            "workspace_id": str(workspace_id),
            "asset_id": str(asset_id),
            "mode": mode,
            "retry_options": retry_options or {},
        },
    )
    return data.get("workflow_instance_id")


def _get(path):
    base_url = settings.CF_WORKER_TRIGGER_URL
    secret = settings.CF_WORKER_TRIGGER_SECRET
    if not base_url or not secret:
        raise WorkerTriggerError("CF_WORKER_TRIGGER_URL / CF_WORKER_TRIGGER_SECRET are not configured")

    try:
        response = requests.get(
            f"{base_url.rstrip('/')}{path}",
            headers={"X-Trigger-Secret": secret},
            timeout=15,
        )
    except requests.RequestException as exc:
        raise WorkerTriggerError(f"Worker unreachable at {base_url}: {exc}") from exc
    if response.status_code >= 400:
        raise WorkerTriggerError(f"Worker request failed ({response.status_code}): {response.text[:500]}")
    return response.json()


def ai_map_music_columns(columns, canonical_fields, multi_fields):
    """AI column mapping for the manual music import panel."""
    return _post(
        "/music/ai-map",
        {"columns": columns, "canonical_fields": canonical_fields, "multi_fields": multi_fields},
        timeout=60,
    )


def get_chat_models():
    """Env-declared chat models for the UI picker: {models, default_model}."""
    return _get("/models")


def get_contracts_agent_models():
    """Same list, with the tool-capable default the contracts agent runs on."""
    return _get("/contracts/models")


def get_assistant_models():
    """Same list, but the default follows the worker's ASSISTANT_AI_PROVIDER."""
    return _get("/assistant/models")


def chat_with_contracts(workspace_id, mode, query, history, contract_id=None, model=None):
    """Synchronous chat turn against the Worker. `mode` is GENERAL (RAG over
    vectorized chunks) or CONTRACT (full extracted text as system context).
    Returns {answer, sources: [{contract_id, title, file_name, asset_id, similarity}]}.
    """
    return _post(
        "/chat",
        {
            "workspace_id": str(workspace_id),
            "mode": mode,
            "query": query,
            "history": history,
            "contract_id": str(contract_id) if contract_id else None,
            "model": model or None,
        },
        timeout=90,
    )


def _stream(path, payload, timeout):
    """Opens a streaming POST against the Worker and returns the raw `requests`
    response (SSE body) so the caller can pipe it through a
    StreamingHttpResponse without buffering.
    """
    base_url = settings.CF_WORKER_TRIGGER_URL
    secret = settings.CF_WORKER_TRIGGER_SECRET
    if not base_url or not secret:
        raise WorkerTriggerError("CF_WORKER_TRIGGER_URL / CF_WORKER_TRIGGER_SECRET are not configured")

    try:
        response = requests.post(
            f"{base_url.rstrip('/')}{path}",
            json=payload,
            headers={"X-Trigger-Secret": secret},
            stream=True,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise WorkerTriggerError(f"Worker unreachable at {base_url}: {exc}") from exc
    if response.status_code >= 400:
        detail = response.text[:500]
        response.close()
        raise WorkerTriggerError(f"Agent stream failed ({response.status_code}): {detail}")
    return response


def stream_contracts_agent(payload, timeout=180):
    """Streams one turn of the contracts agent (tool-calling over the
    workspace's contracts). Longer timeout than the assistant: a run may fan
    out sub-agent summaries over several documents.
    """
    return _stream("/contracts/agent", payload, timeout)


def stream_assistant_chat(payload, timeout=120):
    """Opens a streaming POST against the Worker's assistant agent and returns
    the raw `requests` response (SSE body) so the caller can pipe it through a
    StreamingHttpResponse without buffering.
    """
    base_url = settings.CF_WORKER_TRIGGER_URL
    secret = settings.CF_WORKER_TRIGGER_SECRET
    if not base_url or not secret:
        raise WorkerTriggerError("CF_WORKER_TRIGGER_URL / CF_WORKER_TRIGGER_SECRET are not configured")

    try:
        response = requests.post(
            f"{base_url.rstrip('/')}/assistant/chat",
            json=payload,
            headers={"X-Trigger-Secret": secret},
            stream=True,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise WorkerTriggerError(f"Worker unreachable at {base_url}: {exc}") from exc
    if response.status_code >= 400:
        detail = response.text[:500]
        response.close()
        raise WorkerTriggerError(f"Assistant chat failed ({response.status_code}): {detail}")
    return response


def trigger_contract_query(job_id, query_id, workspace_id, user_query):
    """Starts a ContractQueryWorkflow instance; returns the workflow instance id."""
    data = _post(
        "/trigger/query",
        {
            "job_id": str(job_id),
            "query_id": str(query_id),
            "workspace_id": str(workspace_id),
            "user_query": user_query,
        },
    )
    return data.get("workflow_instance_id")
