# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The workspace assistant's shared memory: what to inject on each turn, and
the bookkeeping (history, limits) around writing it.

Each turn gets two blocks:
- pinned: a small, stable set always in the prompt (rules, spelling, owners).
  Its order never changes between turns, so the model provider's prompt cache
  keeps hitting.
- relevant: up to a few more, chosen for this message by fusing three cheap
  signals with reciprocal rank fusion (agentmemory's approach): an alias said
  in the message, an item linked to the memory being on screen or mentioned,
  and plain keyword overlap. No LLM call and no embeddings needed at this size.
"""

import math
import re
import unicodedata

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from plane.db.models import AssistantMemory, AssistantMemoryRevision

MAX_CONTENT = 300
MAX_ALIASES = 10
MAX_ENTITIES = 10
MAX_ACTIVE = 200
MAX_PINNED = 20
MAX_RELEVANT = 8
# About 1,500 tokens for both blocks together.
BUDGET_CHARS = 6000
RRF_K = 60

STOPWORDS = {
    "que", "qué", "los", "las", "del", "con", "por", "para", "una", "uno", "unos", "unas", "como", "cómo",
    "sus", "mas", "más", "pero", "este", "esta", "estos", "estas", "ese", "esa", "eso", "son", "hay", "fue",
    "the", "and", "for", "with", "this", "that", "are", "was", "from", "have", "has", "what", "which",
    "tiene", "tienen", "cuantos", "cuántos", "cuales", "cuáles", "sobre", "todo", "todos", "todas",
}

_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]{0,200}>")


def normalize(text: str) -> str:
    """Lowercase, without accents, single spaces: "Canción" matches "cancion"."""
    folded = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode("ascii")
    return " ".join(folded.lower().split())


def tokens(text: str) -> set[str]:
    return {word for word in re.findall(r"[a-z0-9]{3,}", normalize(text)) if word not in STOPWORDS}


def clean_content(text: str) -> str:
    """Memories are reference data, not markup or links to follow."""
    text = _TAG_RE.sub("", str(text or ""))
    text = _URL_RE.sub("", text)
    return " ".join(text.split())[:MAX_CONTENT]


def clean_aliases(values) -> list[str]:
    if not isinstance(values, list):
        return []
    seen, out = set(), []
    for value in values:
        alias = clean_content(value)[:80]
        if alias and normalize(alias) not in seen:
            seen.add(normalize(alias))
            out.append(alias)
    return out[:MAX_ALIASES]


def clean_entities(values) -> list[dict]:
    if not isinstance(values, list):
        return []
    out = []
    for value in values:
        if isinstance(value, dict) and value.get("entity_name") and value.get("id"):
            item = {"entity_name": str(value["entity_name"])[:30], "id": str(value["id"])[:64]}
            if item not in out:
                out.append(item)
    return out[:MAX_ENTITIES]


def memory_payload(memory: AssistantMemory) -> dict:
    return {
        "id": str(memory.id),
        "kind": memory.kind,
        "content": memory.content,
        "aliases": memory.aliases or [],
        "entities": memory.entities or [],
        "status": memory.status,
        "pinned": memory.pinned,
        "valid_until": memory.valid_until.isoformat() if memory.valid_until else None,
        "supersedes": str(memory.supersedes_id) if memory.supersedes_id else None,
        "source": memory.source,
        "evidence": memory.evidence,
        "created_by": str(memory.created_by_id) if memory.created_by_id else None,
        "approved_by": str(memory.approved_by_id) if memory.approved_by_id else None,
        "approved_at": memory.approved_at.isoformat() if memory.approved_at else None,
        "use_count": memory.use_count,
        "last_used_at": memory.last_used_at.isoformat() if memory.last_used_at else None,
        "created_at": memory.created_at.isoformat(),
        "updated_at": memory.updated_at.isoformat(),
    }


def record(memory: AssistantMemory, action: str) -> None:
    AssistantMemoryRevision.objects.create(
        workspace_id=memory.workspace_id, memory=memory, action=action, snapshot=memory_payload(memory)
    )


def active_memories(workspace_id):
    today = timezone.localdate()
    return AssistantMemory.objects.filter(workspace_id=workspace_id, status=AssistantMemory.Status.ACTIVE).exclude(
        valid_until__lt=today
    )


def _visible(ctx, memories: list[AssistantMemory]) -> list[AssistantMemory]:
    """Drop memories about items this user can't open (tags are workspace-wide)."""
    linked = [
        item
        for memory in memories
        for item in (memory.entities or [])
        if item.get("entity_name") != "tag"
    ]
    if not linked or ctx is None:
        return memories if ctx is not None or not linked else [m for m in memories if not m.entities]
    from plane.utils.entities import resolve_entities

    allowed = {
        (card["entity_name"], str(card["id"]))
        for card in resolve_entities(ctx, linked)
        if card.get("status") == "ok"
    }
    return [
        memory
        for memory in memories
        if all(
            item.get("entity_name") == "tag" or (item.get("entity_name"), str(item.get("id"))) in allowed
            for item in (memory.entities or [])
        )
    ]


def _alias_hit(memory: AssistantMemory, text_norm: str) -> bool:
    for alias in memory.aliases or []:
        alias_norm = normalize(alias)
        if alias_norm and re.search(rf"(?<![a-z0-9]){re.escape(alias_norm)}(?![a-z0-9])", text_norm):
            return True
    return False


def rank(memories: list[AssistantMemory], text: str, entity_keys: set[tuple[str, str]]) -> list[AssistantMemory]:
    """Memories with at least one signal for this message, best first."""
    text_norm = normalize(text)
    text_tokens = tokens(text)
    signals: dict[str, list[tuple[float, AssistantMemory]]] = {"alias": [], "entity": [], "keyword": []}
    for memory in memories:
        if _alias_hit(memory, text_norm):
            signals["alias"].append((1.0, memory))
        hits = sum(
            1 for item in memory.entities or [] if (item.get("entity_name"), str(item.get("id"))) in entity_keys
        )
        if hits:
            signals["entity"].append((float(hits), memory))
        memory_tokens = tokens(memory.content + " " + " ".join(memory.aliases or []))
        overlap = len(text_tokens & memory_tokens)
        if overlap:
            signals["keyword"].append((overlap / math.sqrt(len(memory_tokens) or 1), memory))
    scores: dict[str, float] = {}
    by_id: dict[str, AssistantMemory] = {}
    for entries in signals.values():
        entries.sort(key=lambda entry: -entry[0])
        for position, (_score, memory) in enumerate(entries):
            key = str(memory.id)
            by_id[key] = memory
            scores[key] = scores.get(key, 0.0) + 1.0 / (RRF_K + position + 1)
    return [by_id[key] for key in sorted(scores, key=lambda key: -scores[key])]


def _line(memory: AssistantMemory) -> dict:
    item = {"id": str(memory.id), "kind": memory.kind, "content": memory.content}
    if memory.valid_until:
        item["valid_until"] = memory.valid_until.isoformat()
    return item


def memory_context(workspace_id, ctx, text: str, entity_keys: set[tuple[str, str]]) -> dict:
    """The two blocks for this turn, within the character budget."""
    memories = _visible(ctx, list(active_memories(workspace_id)))
    pinned = sorted((m for m in memories if m.pinned), key=lambda m: (m.kind, m.created_at))[:MAX_PINNED]
    budget = BUDGET_CHARS
    pinned_lines = []
    for memory in pinned:
        if budget - len(memory.content) < 0:
            break
        budget -= len(memory.content)
        pinned_lines.append(_line(memory))
    relevant_lines = []
    for memory in rank([m for m in memories if not m.pinned], text, entity_keys):
        if len(relevant_lines) >= MAX_RELEVANT or budget - len(memory.content) < 0:
            break
        budget -= len(memory.content)
        relevant_lines.append(_line(memory))
    used = [line["id"] for line in pinned_lines + relevant_lines]
    if used:
        AssistantMemory.objects.filter(id__in=used).update(use_count=F("use_count") + 1, last_used_at=timezone.now())
    return {"pinned": pinned_lines, "relevant": relevant_lines}


def search(workspace_id, ctx, query: str, limit: int = MAX_RELEVANT) -> list[dict]:
    """For the assistant's search_memory tool and for spotting duplicates."""
    memories = _visible(ctx, list(active_memories(workspace_id)))
    return [memory_payload(memory) for memory in rank(memories, query, set())[:limit]]


@transaction.atomic
def activate(memory: AssistantMemory, user, action: str = "approved") -> AssistantMemory:
    """Make a memory active; the one it corrects becomes history."""
    memory.status = AssistantMemory.Status.ACTIVE
    memory.approved_by = user
    memory.approved_at = timezone.now()
    memory.save()
    record(memory, action)
    if memory.supersedes_id:
        previous = AssistantMemory.objects.filter(
            id=memory.supersedes_id, workspace_id=memory.workspace_id, status=AssistantMemory.Status.ACTIVE
        ).first()
        if previous is not None:
            previous.status = AssistantMemory.Status.ARCHIVED
            previous.save(update_fields=["status", "updated_at"])
            record(previous, "superseded")
    return memory


@transaction.atomic
def archive(memory: AssistantMemory, action: str = "archived") -> AssistantMemory:
    """Archive a memory; if it had replaced another, that one comes back."""
    was_active = memory.status == AssistantMemory.Status.ACTIVE
    memory.status = AssistantMemory.Status.ARCHIVED
    memory.pinned = False
    memory.save(update_fields=["status", "pinned", "updated_at"])
    record(memory, action)
    if was_active and memory.supersedes_id:
        previous = AssistantMemory.objects.filter(
            id=memory.supersedes_id, workspace_id=memory.workspace_id, status=AssistantMemory.Status.ARCHIVED
        ).first()
        if previous is not None:
            previous.status = AssistantMemory.Status.ACTIVE
            previous.save(update_fields=["status", "updated_at"])
            record(previous, "restored")
    return memory
