/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * A small pixel grid that keeps time while the model has nothing to show yet.
 * Adapted from assistant-ui's loading-state element (GenerationLoader), laid
 * out in a row so it fits the narrow side panel.
 */

import { useEffect, useState } from "react";
import { cn } from "@plane/utils";
import { ShimmerLabel } from "./surfaces";

export function GenerationLoader({ label, className }: { label: string; className?: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 120);
    return () => clearInterval(id);
  }, []);
  const offset = Math.floor(tick / 3);

  return (
    <div className={cn("flex items-center gap-2.5", className)} role="status">
      <div aria-hidden className="grid grid-cols-3 gap-0.5">
        {Array.from({ length: 9 }, (_, index) => (
          <span
            key={index}
            className={cn(
              "size-1 rounded-full bg-accent-primary transition-opacity duration-300 motion-reduce:transition-none",
              (index * 2 + offset) % 9 < 3 ? "opacity-90" : "opacity-15"
            )}
          />
        ))}
      </div>
      <ShimmerLabel className="text-12 text-tertiary">{label}</ShimmerLabel>
    </div>
  );
}
