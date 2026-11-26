// A state key marks a note as the current value of something that changes (a setting, a
// status, an owner). Saving under the same key archives the earlier value, so search only
// ever returns the current one.
export const STATE_KEY_NAMESPACES = [
  "config",
  "status",
  "pricing",
  "policy",
  "stack",
  "vendor",
  "infra",
  "person",
];

export function validateStateKey(
  raw: string
): { ok: true; key: string } | { ok: false; error: string } {
  const key = raw.trim().toLowerCase();
  const parts = key.split(":");
  if (
    key.length > 80 ||
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => !/^[a-z0-9][a-z0-9-]*$/.test(part)) ||
    !STATE_KEY_NAMESPACES.includes(parts[0])
  ) {
    return {
      ok: false,
      error:
        "Invalid state key. Use <namespace>:<subject> or <namespace>:<subject>:<attribute>, " +
        "with letters, digits, and hyphens; each part must start with a letter or digit. " +
        "The key must be at most 80 characters. " +
        `Namespaces: ${STATE_KEY_NAMESPACES.join(", ")}. Example: config:theme.`,
    };
  }
  return { ok: true, key };
}
