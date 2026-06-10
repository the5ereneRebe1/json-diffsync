# Contributing

Thanks for considering a contribution to `json-diffsync`.

## Development

Install dependencies:

```sh
npm install
```

Run tests:

```sh
npm test
```

Run the browser E2E test:

```sh
npm run test:e2e:browser
```

Run the benchmark:

```sh
npm run bench
```

## Project Direction

This project is intentionally focused on differential synchronization for JSON autosave. It should not grow into a CRDT or OT implementation.

Important design rules:

- Any JSON value should be accepted.
- Keyed arrays should get item-level patches.
- Unkeyed arrays should be supported but marked lossy.
- The library should make autosave safer without pretending all semantic conflicts disappear.

## Pull Requests

Please include tests for behavior changes. For performance-sensitive changes, include benchmark output before and after.
