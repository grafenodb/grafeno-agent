# Releasing

A release publishes `@grafenodb/agent-cli` to npm (the command it
installs is `grafeno-agent`) and makes a GitHub release with the same
package (`grafenodb-agent-cli-<version>.tgz`, and `grafeno-agent.tgz` for
`releases/latest/download/grafeno-agent.tgz`). A release is the owner's
decision: nothing is published by an agent or a session on its own.

npm trusts `.github/workflows/publish.yml` through trusted publishing
(OIDC): no token is stored, and the package gets provenance. On
npmjs.com, the package's settings name the trusted publisher: GitHub
Actions, `grafenodb/grafeno-agent`, workflow `publish.yml`. A package
must exist before it can be given one, so a placeholder (`0.0.0-stage`,
tagged `stage`) was published first. `publish.yml` does not publish a
version that is already on npm; `release.yml` makes the GitHub release.

## Rules

- A version is released only after a green pipeline: the checks (`npm run
ci` on Node 22.18 and 24) and the evaluation (`npm run eval`, at or above
  `test/eval/baseline.json`). The release workflow runs both before it
  publishes, and refuses a tag that does not match `package.json`.
- Versions follow semantic versioning. Before 1.0, a minor version may
  change settings or behaviour; the changelog says how.
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

3. Commit and push; once the pipeline on that commit is green, tag
   `v<version>` and push the tag. The release workflow runs the pipeline
   again; then `publish.yml` publishes to npm and `release.yml` makes the
   GitHub release.
