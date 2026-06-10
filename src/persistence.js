export function createLocalStoragePersister(key, storage = globalThis.localStorage) {
  return {
    load() {
      const raw = storage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    },
    save(state) {
      storage?.setItem(key, JSON.stringify(state));
    },
    clear() {
      storage?.removeItem(key);
    }
  };
}
