"use strict";

const TELEMETRY_CATEGORY = "addonsSearchExperiment";
// methods
const TELEMETRY_METHOD_ETLD_CHANGE = "etld_change";
// objects
const TELEMETRY_OBJECT_WEBREQUEST = "webrequest";
const TELEMETRY_OBJECT_OTHER = "other";
// values
const TELEMETRY_VALUE_EXTENSION = "extension";
const TELEMETRY_VALUE_SERVER = "server";

class AddonsSearchExperiment {
  constructor({ debugMode = false }) {
    this.debugMode = debugMode;
    // The key is an URL pattern to monitor and its corresponding value is a
    // list of add-on IDs.
    this.matchPatterns = {};

    this.debug("registering telemetry events");
    browser.telemetry.registerEvents(TELEMETRY_CATEGORY, {
      [TELEMETRY_METHOD_ETLD_CHANGE]: {
        methods: [TELEMETRY_METHOD_ETLD_CHANGE],
        objects: [TELEMETRY_OBJECT_WEBREQUEST, TELEMETRY_OBJECT_OTHER],
        extra_keys: ["addonId", "addonVersion", "from", "to"],
        record_on_release: true,
      },
    });

    this.onRedirectedListener = this.onRedirectedListener.bind(this);
  }

  async getMatchPatterns() {
    try {
      this.matchPatterns =
        await browser.addonsSearchExperiment.getMatchPatterns();
    } catch (err) {
      console.error(`failed to retrieve the list of URL patterns: ${err}`);
      this.matchPatterns = {};
    }

    return this.matchPatterns;
  }

  // When the search service changes the set of engines that are enabled, we
  // update our pattern matching in the webrequest listeners (go to the bottom
  // of this file for the search service events we listen to).
  async monitor() {
    // If there is already a listener, remove it so that we can re-add one
    // after. This is because we're using the same listener with different URL
    // patterns (when the list of search engines changes).
    if (
      browser.addonsSearchExperiment.onRedirected.hasListener(
        this.onRedirectedListener
      )
    ) {
      this.debug("removing onRedirected listener");
      browser.addonsSearchExperiment.onRedirected.removeListener(
        this.onRedirectedListener
      );
    }
    // If there is already a listener, remove it so that we can re-add one
    // after. This is because we're using the same listener with different URL
    // patterns (when the list of search engines changes).
    if (browser.webRequest.onBeforeRequest.hasListener(this.noOpListener)) {
      this.debug("removing onBeforeRequest listener");
      browser.webRequest.onBeforeRequest.removeListener(this.noOpListener);
    }

    // Retrieve the list of URL patterns to monitor with our listener.
    //
    // Note: search suggestions are system principal requests, so webRequest
    // cannot intercept them.
    const matchPatterns = await this.getMatchPatterns();
    const patterns = Object.keys(matchPatterns);

    if (patterns.length === 0) {
      this.debug(
        "not registering any listener because there is no URL to monitor"
      );
      return;
    }

    this.debug("registering onBeforeRequest listener");
    browser.webRequest.onBeforeRequest.addListener(
      this.noOpListener,
      { types: ["main_frame"], urls: patterns },
      ["blocking"]
    );

    this.debug("registering onRedirected listener");
    browser.addonsSearchExperiment.onRedirected.addListener(
      this.onRedirectedListener,
      { urls: patterns }
    );
  }

  // This listener is required to force the registration of traceable channels.
  noOpListener() {
    // Do nothing.
  }

  async onRedirectedListener({ addonId, firstUrl, lastUrl }) {
    if (!firstUrl || !lastUrl) {
      // Something went wrong but there is nothing we can do at this point.
      return;
    }

    // When we do not have an add-on ID (in the request property bag), we
    // likely detected a search server-side redirect.
    const maybeServerSideRedirect = !addonId;

    let addonIds = [];
    // Search server-side redirects are possible because an extension has
    // registered a search engine, which is why we can (hopefully) retrieve the
    // add-on ID.
    if (maybeServerSideRedirect) {
      addonIds = this.getAddonIdsForUrl(firstUrl);
    } else if (addonId) {
      addonIds = [addonId];
    }

    if (addonIds.length === 0) {
      // No add-on ID means there is nothing we can report.
      return;
    }

    // This is the initial URL before any redirect.
    const from = await browser.addonsSearchExperiment.getPublicSuffix(firstUrl);
    // This is the final URL after redirect(s).
    const to = await browser.addonsSearchExperiment.getPublicSuffix(lastUrl);

    if (from === to) {
      // We do not want to report redirects to same public suffixes. However,
      // we will report redirects from public suffixes belonging to a same
      // entity (.e.g., `example.com` -> `example.fr`).
      //
      // Known limitation: if a redirect chain starts and ends with the same
      // public suffix, we won't report any event, even if the chain contains
      // different public suffixes in between.
      return;
    }

    const telemetryObject = maybeServerSideRedirect
      ? TELEMETRY_OBJECT_OTHER
      : TELEMETRY_OBJECT_WEBREQUEST;
    const telemetryValue = maybeServerSideRedirect
      ? TELEMETRY_VALUE_SERVER
      : TELEMETRY_VALUE_EXTENSION;

    for (const addonId of addonIds) {
      const addonVersion = await browser.addonsSearchExperiment.getAddonVersion(
        addonId
      );
      const extra = { addonId, addonVersion, from, to };

      this.debug(
        [
          `recording event: method=${TELEMETRY_METHOD_ETLD_CHANGE}`,
          `object=${telemetryObject} value=${telemetryValue}`,
          `extra=${JSON.stringify(extra)}`,
        ].join(" ")
      );
      browser.telemetry.recordEvent(
        TELEMETRY_CATEGORY,
        TELEMETRY_METHOD_ETLD_CHANGE,
        telemetryObject,
        telemetryValue,
        extra
      );
    }
  }

  getAddonIdsForUrl(url) {
    for (const pattern of Object.keys(this.matchPatterns)) {
      const [urlPrefix] = pattern.split("*");

      if (url.startsWith(urlPrefix)) {
        return this.matchPatterns[pattern];
      }
    }

    return [];
  }

  debug(message) {
    if (this.debugMode) {
      console.debug(message);
    }
  }
}

// Set `debugMode` to `true` for development purposes.
const exp = new AddonsSearchExperiment({ debugMode: false });
exp.monitor();

browser.addonsSearchExperiment.onSearchEngineModified.addListener(async () => {
  await exp.monitor();
});
