# Add-ons Search Experiment Pings

This add-on will collect information about search engines.

- `addonsSearchExperiment`
  - `etld_change`: indicates a eTLD change
    - `webrequest` or `other`: the "API" used to change the eTLD. Note that `other` is used when the change has not been initiated from the client.
    - `extension` or `server`: whether the eTLD change has been done by an extension (add-on) or server.
    - `addonId`: the add-on ID tied to this change
    - `addonVersion`: the version of the add-on
    - `from`: the eTLD of the search endpoint hostname defined by the Search service
    - `to`: the eTLD of the final endpoint hostname

## Example log entry

```js
  "dynamic": {
  "events": [
    [
      123456,
      "addonsSearchExperiment",
      "etld_change",
      "webrequest",
      "extension",
      {
        addonId:  "extension-id@example.com",
        addonVersion: "1.2",
        from: "google.com",
        to: "example.com"
      }
    ]
  ]
}
```
