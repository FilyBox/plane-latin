#!/bin/bash
set -e

python manage.py wait_for_db
# Wait for migrations
python manage.py wait_for_migrations

# Keep the idle footprint small while preserving capacity for short bursts.
# These defaults are intentionally owned by the worker branch so switching the
# Railway service back to `preview` restores Plane's original worker command.
worker_autoscale="${CELERY_WORKER_AUTOSCALE:-2,1}"
worker_prefetch_multiplier="${CELERY_WORKER_PREFETCH_MULTIPLIER:-1}"
worker_max_tasks_per_child="${CELERY_WORKER_MAX_TASKS_PER_CHILD:-100}"

worker_args=(
    -A plane
    worker
    -l info
    "--autoscale=${worker_autoscale}"
    "--prefetch-multiplier=${worker_prefetch_multiplier}"
    "--max-tasks-per-child=${worker_max_tasks_per_child}"
)

# Celery expects this value in KiB. It is opt-in until the production child
# process baseline has been measured, avoiding a recycle loop on startup.
if [[ -n "${CELERY_WORKER_MAX_MEMORY_PER_CHILD:-}" ]]; then
    worker_args+=("--max-memory-per-child=${CELERY_WORKER_MAX_MEMORY_PER_CHILD}")
fi

echo "Starting Celery worker: autoscale=${worker_autoscale}, prefetch=${worker_prefetch_multiplier}, max_tasks_per_child=${worker_max_tasks_per_child}"
exec celery "${worker_args[@]}"
