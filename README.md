# addons-search-detection

## Super Quick Start

```
$ yarn install
$ yarn web-ext run -s extension --pref "extensions.experiments.enabled=true"
```

## Development XPIs

TaskCluster should build and sign development XPIs for each commit. Open the
`dep-signing-addons-search-detection` CI check from GitHub, then click on "View
task in Taskcluster". On TaskCluster, look for the "Artifacts" section, which
should have a link to this file: `public/build/addons-search-detection.xpi`.
Clicking the link will start the install process.

As documented [here][doc-xpi-dev], only Nightly and unbranded FF will accept to
install this XPI file. In addition, the following boolean prefs are required and
should be set to `true`:

- `xpinstall.signatures.dev-root`
- `extensions.experiments.enabled`

[doc-xpi-dev]: https://github.com/mozilla-extensions/xpi-manifest/blob/3029cf2130adb04ac01b37e6ebd222052e1e3598/docs/testing-a-xpi.md
