# Plane Context

This file captures the working context for `makeplane/plane` so future tasks can stay aligned with the repo architecture, UI language, and module conventions.

## 1. Repository shape

- Plane is a `pnpm` monorepo.
- Main split:
  - `apps/*` for applications.
  - `packages/*` for shared libraries and utilities.
- Internal dependencies should use `workspace:*`.
- Build and task orchestration use Turborepo.

### Main apps

- `apps/web`: primary product UI.
- `apps/admin`: instance admin and setup UI.
- `apps/space`: guest/viewer interface.
- `apps/live`: real-time collaboration WebSocket server.
- `apps/api`: Django API, kept outside the pnpm workspace.

## 2. Shared package layers

Think of the repo in layers:

1. Configuration
   - `@plane/typescript-config`
   - `@plane/tailwind-config`
2. Domain
   - `@plane/types`
   - `@plane/constants`
3. Logic
   - `@plane/utils`
   - `@plane/hooks`
   - `@plane/services`
   - `@plane/shared-state`
4. UI
   - `@plane/propel`
   - `@plane/ui`
   - `@plane/editor`

### Practical package roles

- `@plane/propel`: base primitives.
- `@plane/ui`: higher-level internal UI composed from Propel.
- `@plane/editor`: rich text editor core and extensions.
- `@plane/shared-state`: MobX-based shared state.
- `@plane/services`: shared API and business logic.
- `@plane/hooks`: reusable React hooks.
- `@plane/utils`: helper functions.

## 3. Dependency boundaries

- Lower layers should not depend on higher layers.
- Prefer reusing shared packages instead of duplicating logic in apps.
- Avoid introducing new external dependencies when an internal package already covers the need.
- Keep imports local to the correct layer to avoid circular dependencies.

## 4. UI / UX language

Plane uses a semantic background hierarchy:

- `bg-canvas`: application root only.
- `bg-surface-1`, `bg-surface-2`, `bg-surface-3`: top-level containers.
- `bg-layer-1`, `bg-layer-2`, `bg-layer-3`: nested UI elements within a surface.

### Rules of thumb

- Use `bg-canvas` once at the app root only.
- Surfaces are usually siblings, not nested.
- Layers should match their corresponding surface level.
- Most components only need `layer-1`.
- Modals and overlays can exist on another plane.

### Interaction states

- Hover state should match the base layer, for example `bg-layer-X` with `hover:bg-layer-X-hover`.
- Use active variants for pressed states.
- Use selected variants only when the item is actually selected.

### Typography and borders

- `text-primary`: main content.
- `text-secondary`: supporting content.
- `text-tertiary`: labels and metadata.
- `text-placeholder`: input placeholder text.
- `border-subtle`, `border-subtle-1`, `border-strong`: semantic borders.

## 5. Modules in the product

In Plane product language, "Modules" are issue groupings inside a project.

- Modules are thematic, not time-boxed like cycles.
- A single issue can belong to both a module and a cycle.
- Module UI is typically wired through:
  - project navigation
  - module list views
  - module detail pages
  - quick actions
  - MobX-backed hooks/stores

## 6. Where new features should live

### Put it in `apps/*` when

- It is a standalone application.
- It needs its own routes, pages, or deployment boundary.

### Put it in `packages/*` when

- It is shared across apps.
- It is a reusable component, hook, service, state store, editor extension, or utility.

## 7. How to add a new module or feature cleanly

1. Identify the right layer first.
2. Reuse existing shared packages before creating new code.
3. Keep UI on the Plane design system:
   - canvas at root
   - surfaces for large containers
   - layers for nested content
4. Add translations in the i18n package.
5. Respect existing permission and navigation patterns.
6. Cover the change with tests.
7. Run formatting and linting before finishing.

## 8. Good defaults

- Prefer semantic tokens over arbitrary colors.
- Prefer composition over one-off implementations.
- Prefer small focused components over large feature-only bundles.
- Keep new UI visually native to Plane instead of introducing a new theme.

## 9. Useful references

- Root `AGENTS.md`
- `packages/tailwind-config/AGENTS.md`
- `packages/propel/src/design-system/design-system-philosophy.stories.tsx`
- DeepWiki notes for `makeplane/plane`
