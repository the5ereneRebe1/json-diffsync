export const DEFAULT_KEY_FIELDS = ["key", "id"];

export function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

export function hashJson(value) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!jsonEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key) || !jsonEqual(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.keys(value)
    .sort()
    .reduce((sorted, key) => {
      sorted[key] = sortJson(value[key]);
      return sorted;
    }, {});
}
