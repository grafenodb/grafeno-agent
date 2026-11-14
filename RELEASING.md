# Releasing

Grafeno Agent is published to npm as `grafeno-agent`. A release is the
owner's decision: nothing is published by an agent or a session on its
own.

## Rules

- A version is released only after a green pipeline: the checks (`npm run
ci` on Node 22.18 and 24) and the evaluation (`npm run eval`, at or above
  `test/eval/baseline.json`). The release workflow runs both before it
  publishes, and refuses a tag that does not match `package.json`.
- Versions follow semantic versioning. Before 1.0, a minor version may
  change settings or behaviour; the changelog says how.
- `package.json` keeps `"private": true` until the owner decides to
  publish: removing it is part of the first release, done on purpose.
- Nothing secret goes into the package: `npm pack --dry-run` lists what
  would be published (`dist`, the README, the changelog, the licenses and
  `.env.example`).

## Steps

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Run, and look at the results:

   ```bash
   npm run ci
   npm run eval
   npm run eval:real
   npm pack --dry-run
   ```

   `eval:real` spends a little of the Claude plan; its results go in
   `docs/eval/`.

3. Commit, tag `v<version>`, and push the commit and the tag. The release
   workflow publishes after the pipeline is green. It needs the `npm`
   environment and an `NPM_TOKEN` secret in the repository.
