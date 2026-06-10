import {
  DEFAULT_KEY_FIELDS,
  cloneJson,
  hashJson,
  isPlainObject,
  stableStringify
} from "./json.js";

const KEY_SEGMENT = "$key";

export function createJsonPatch(before, after, options = {}) {
  const ops = [];
  diffJson(before, after, [], ops, options);
  return {
    kind: "json-keyed",
    baseHash: hashJson(before),
    beforeBytes: stableStringify(before).length,
    afterBytes: stableStringify(after).length,
    lossy: ops.some((op) => op.lossy === true),
    ops
  };
}

export function applyJsonPatch(value, patch, options = {}) {
  if (!patch || patch.kind !== "json-keyed") {
    throw new Error("Unsupported patch format.");
  }

  let next = cloneJson(value);
  for (const op of patch.ops) {
    next = applyJsonOp(next, op, options);
  }
  return next;
}

function diffJson(before, after, path, ops, options) {
  if (jsonEqual(before, after)) return;

  if (isKeyedArray(before, options) && isKeyedArray(after, options)) {
    diffKeyedArray(before, after, path, ops, options);
    return;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      if (!(key in after)) {
        ops.push({ op: "delete", path: [...path, key], oldValue: cloneJson(before[key]) });
      } else if (!(key in before)) {
        ops.push({ op: "set", path: [...path, key], value: cloneJson(after[key]) });
      } else {
        diffJson(before[key], after[key], [...path, key], ops, options);
      }
    }
    return;
  }

  ops.push({
    op: "replace",
    path,
    oldValue: cloneJson(before),
    value: cloneJson(after),
    lossy: Array.isArray(before) || Array.isArray(after),
    lossyReason: Array.isArray(before) || Array.isArray(after) ? "unkeyed_array_replace" : undefined
  });
}

function diffKeyedArray(before, after, path, ops, options) {
  const beforeByKey = mapByKey(before, options);
  const afterByKey = mapByKey(after, options);

  for (const [key, item] of beforeByKey) {
    if (!afterByKey.has(key)) {
      ops.push({
        op: "removeItem",
        path,
        key,
        oldValue: cloneJson(item),
        beforeLength: before.length,
        afterLength: after.length
      });
    }
  }

  for (let index = 0; index < after.length; index += 1) {
    const item = after[index];
    const key = getItemKey(item, options);
    if (!beforeByKey.has(key)) {
      ops.push({ op: "insertItem", path, key, index, value: cloneJson(item) });
    } else {
      diffJson(beforeByKey.get(key), item, [...path, { [KEY_SEGMENT]: key }], ops, options);
    }
  }

  const beforeKeys = before.map((item) => getItemKey(item, options));
  const afterKeys = after.map((item) => getItemKey(item, options));
  if (!arrayEqual(beforeKeys, afterKeys)) {
    ops.push({ op: "reorderItems", path, beforeKeys, keys: afterKeys });
  }
}

function applyJsonOp(root, op, options) {
  if (op.path.length === 0) {
    if (op.op === "replace" || op.op === "set") return cloneJson(op.value);
    if (op.op === "delete") return undefined;
  }

  const parentPath = op.op === "insertItem" || op.op === "removeItem" || op.op === "reorderItems"
    ? op.path
    : op.path.slice(0, -1);
  const parent = resolvePath(root, parentPath, options);

  switch (op.op) {
    case "set":
    case "replace": {
      const key = op.path.at(-1);
      if (options.strict && "oldValue" in op && !jsonEqual(getChild(parent, key, options), op.oldValue)) {
        throw new Error("Patch oldValue does not match target.");
      }
      setChild(parent, key, cloneJson(op.value), options);
      return root;
    }
    case "delete": {
      const key = op.path.at(-1);
      if (options.strict && "oldValue" in op && !jsonEqual(getChild(parent, key, options), op.oldValue)) {
        throw new Error("Patch oldValue does not match target.");
      }
      deleteChild(parent, key);
      return root;
    }
    case "insertItem": {
      if (!Array.isArray(parent)) throw new Error("insertItem target is not an array.");
      const existing = findIndexByKey(parent, op.key, options);
      if (existing >= 0) parent.splice(existing, 1);
      parent.splice(Math.min(op.index, parent.length), 0, cloneJson(op.value));
      return root;
    }
    case "removeItem": {
      if (!Array.isArray(parent)) throw new Error("removeItem target is not an array.");
      const index = findIndexByKey(parent, op.key, options);
      if (index < 0) {
        if (options.strict) throw new Error("removeItem target key does not exist.");
        return root;
      }
      if (options.strict && op.oldValue && !jsonEqual(parent[index], op.oldValue)) {
        throw new Error("Patch oldValue does not match target.");
      }
      parent.splice(index, 1);
      return root;
    }
    case "reorderItems": {
      if (!Array.isArray(parent)) throw new Error("reorderItems target is not an array.");
      const byKey = mapByKey(parent, options);
      const ordered = [];
      for (const key of op.keys) {
        if (byKey.has(key)) ordered.push(byKey.get(key));
      }
      for (const item of parent) {
        const key = getItemKey(item, options);
        if (!op.keys.includes(key)) ordered.push(item);
      }
      parent.splice(0, parent.length, ...ordered);
      return root;
    }
    default:
      throw new Error(`Unsupported op: ${op.op}`);
  }
}

function resolvePath(root, path, options) {
  let current = root;
  for (const segment of path) {
    current = getChild(current, segment, options);
    if (current === undefined) throw new Error("Patch path could not be resolved.");
  }
  return current;
}

function getChild(parent, segment, options) {
  if (isKeySegment(segment)) {
    if (!Array.isArray(parent)) throw new Error("Key segment parent is not an array.");
    return parent.find((item) => getItemKey(item, options) === segment[KEY_SEGMENT]);
  }
  return parent?.[segment];
}

function setChild(parent, segment, value, options) {
  if (isKeySegment(segment)) {
    if (!Array.isArray(parent)) throw new Error("Key segment parent is not an array.");
    const index = findIndexByKey(parent, segment[KEY_SEGMENT], options);
    if (index < 0) parent.push(value);
    else parent[index] = value;
    return;
  }
  parent[segment] = value;
}

function deleteChild(parent, segment) {
  if (Array.isArray(parent) && typeof segment === "number") {
    parent.splice(segment, 1);
    return;
  }
  delete parent[segment];
}

function isKeyedArray(value, options) {
  return (
    Array.isArray(value) &&
    value.every((item) => getItemKey(item, options) !== null)
  );
}

function mapByKey(array, options) {
  return new Map(array.map((item) => [getItemKey(item, options), item]));
}

function getItemKey(item, options) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (typeof options.getKey === "function") return options.getKey(item);
  for (const field of options.keyFields ?? DEFAULT_KEY_FIELDS) {
    if (typeof item[field] === "string" || typeof item[field] === "number") {
      return String(item[field]);
    }
  }
  return null;
}

function findIndexByKey(array, key, options) {
  return array.findIndex((item) => getItemKey(item, options) === key);
}

function isKeySegment(segment) {
  return isPlainObject(segment) && typeof segment[KEY_SEGMENT] === "string";
}

function jsonEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function arrayEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
