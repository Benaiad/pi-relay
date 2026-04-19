/**
 * Branded identifier types for the plan IR and runtime.
 *
 * Every domain ID is a structurally distinct type — a `StepId` cannot be
 * assigned to an `ActorId` even though both are strings at runtime. The only
 * way to construct a branded ID is through the exported constructors, which
 * validate the underlying string. This keeps the brand origin single-sourced.
 *
 * `unwrap` is the single sanctioned way to read the raw string back out
 * (for serialization, logging, or display). Do not cast directly.
 */

type Brand<Tag extends string, Base> = Base & { readonly __brand: Tag };

export type PlanId = Brand<"PlanId", string>;
export type RunId = Brand<"RunId", string>;
export type StepId = Brand<"StepId", string>;
export type ActorId = Brand<"ActorId", string>;
export type ArtifactId = Brand<"ArtifactId", string>;
export type RouteId = Brand<"RouteId", string>;
export type TemplateId = Brand<"TemplateId", string>;

const validate = (kind: string, value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError(`${kind} must be a string, received ${typeof value}`);
  }
  if (value.length === 0) {
    throw new TypeError(`${kind} must be non-empty`);
  }
  return value;
};

export const PlanId = (value: string): PlanId =>
  validate("PlanId", value) as PlanId;
export const RunId = (value: string): RunId =>
  validate("RunId", value) as RunId;
export const StepId = (value: string): StepId =>
  validate("StepId", value) as StepId;
export const ActorId = (value: string): ActorId =>
  validate("ActorId", value) as ActorId;
export const ArtifactId = (value: string): ArtifactId =>
  validate("ArtifactId", value) as ArtifactId;
export const RouteId = (value: string): RouteId =>
  validate("RouteId", value) as RouteId;
export const TemplateId = (value: string): TemplateId =>
  validate("TemplateId", value) as TemplateId;

/**
 * Compound key used to index edges by `(step, route)`.
 *
 * Treated as opaque by consumers — only `edgeKey` constructs one.
 */
export type EdgeKey = Brand<"EdgeKey", string>;

/** Union of every branded identifier type; `unwrap` accepts any of them. */
export type AnyBrand =
  | PlanId
  | RunId
  | StepId
  | ActorId
  | ArtifactId
  | RouteId
  | TemplateId
  | EdgeKey;

/**
 * Extract the raw string from a branded ID.
 *
 * Use this only at boundaries where a string is required (JSON serialization,
 * log messages, UI display). Within the codebase, pass the branded ID itself.
 */
export const unwrap = (id: AnyBrand): string => id;

export const edgeKey = (from: StepId, route: RouteId): EdgeKey =>
  `${unwrap(from)}::${unwrap(route)}` as EdgeKey;
