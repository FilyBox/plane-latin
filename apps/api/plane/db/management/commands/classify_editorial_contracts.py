# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.core.management.base import BaseCommand

# Module imports
from plane.app.views.contract.base import create_and_dispatch_job, live_contracts
from plane.db.models import ContractProcessingJob


class Command(BaseCommand):
    help = (
        "Classifies existing contracts as editorial or not. Contracts analyzed before the "
        "editorial field existed have it empty; this runs only the cheap classification "
        "step over their stored text and touches no other field."
    )

    def add_arguments(self, parser):
        parser.add_argument("--workspace", help="Workspace slug; all workspaces when omitted")
        parser.add_argument("--limit", type=int, help="Dispatch at most this many, to run in batches")
        parser.add_argument("--dry-run", action="store_true", help="Count what would be dispatched")

    def handle(self, *args, **options):
        contracts = (
            live_contracts()
            .filter(es_editorial__isnull=True, extracted_text__isnull=False)
            .exclude(extracted_text="")
            .exclude(jobs__status__in=[ContractProcessingJob.Status.QUEUED, ContractProcessingJob.Status.RUNNING])
            .select_related("workspace")
            .order_by("created_at")
            .distinct()
        )
        if options["workspace"]:
            contracts = contracts.filter(workspace__slug=options["workspace"])
        if options["limit"]:
            contracts = contracts[: options["limit"]]

        contracts = list(contracts)
        if options["dry_run"]:
            self.stdout.write(f"{len(contracts)} contracts would be classified")
            return

        for contract in contracts:
            create_and_dispatch_job(
                workspace=contract.workspace,
                contract=contract,
                task_type=ContractProcessingJob.TaskType.RETRY_PARTIAL,
                metadata={"retry_options": {"classify": True}},
            )
        self.stdout.write(self.style.SUCCESS(f"Dispatched classification for {len(contracts)} contracts"))
