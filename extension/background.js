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
  constructor() {
    this.matchPatternsMap = {};

    console.debug("registering telemetry events");
    browser.telemetry.registerEvents(TELEMETRY_CATEGORY, {
      [TELEMETRY_METHOD_ETLD_CHANGE]: {
        methods: [TELEMETRY_METHOD_ETLD_CHANGE],
        objects: [TELEMETRY_OBJECT_WEBREQUEST, TELEMETRY_OBJECT_OTHER],
        extra_keys: ["addonId", "addonVersion", "from", "to"],
        record_on_release: true,
      },
    });
  }

  async getMatchPatterns() {
    try {
      this.matchPatternsMap =
        await browser.addonsSearchExperiment.getMatchPatterns();
    } catch (err) {
      console.error(`failed to retrieve the list of URL patterns: ${err}`);
      this.matchPatternsMap = {};
    }

    return this.matchPatternsMap;
  }

  // When the search service changes the set of engines that are enabled, we
  // update our pattern matching in the webrequest listeners (go to the bottom
  // of this file for the search service events we listen to).
  async monitor() {
    // If there is already a listener, remove it so that we can re-add one
    // after. This is because we're using the same listener with different URL
    // patterns (when the list of search engines changes).
    if (
      browser.webRequest.onBeforeRedirect.hasListener(this.webRequestHandler)
    ) {
      console.debug("removing onBeforeRedirect listener");
      browser.webRequest.onBeforeRedirect.removeListener(
        this.webRequestHandler
      );
    }

    if (browser.webRequest.onBeforeRedirect.hasListener(this.noOpHandler)) {
      browser.webRequest.onBeforeRedirect.removeListener(this.noOpHandler);
    }

    // Retrieve the list of URL patterns to monitor with our listener.
    //
    // Note: search suggestions are system principal requests, so webRequest
    // cannot intercept them.
    const matchPatternsMap = await this.getMatchPatterns();
    const patterns = Object.keys(matchPatternsMap);

    if (patterns.length === 0) {
      console.debug(
        "not registering any listener because there is no URL to monitor"
      );
      return;
    }

    // This is needed to force the registration of a traceable channel.
    browser.webRequest.onBeforeRequest.addListener(
      this.noOpHandler,
      { urls: patterns },
      ["blocking"]
    );

    console.debug("registering onBeforeRedirect listener");
    browser.addonsSearchExperiment.onBeforeRedirect.addListener(
      this.webRequestHandler,
      { urls: patterns }
    );
  }

  noOpHandler = () => {
    // Do nothing.
  };

  webRequestHandler = async ({ addonId, redirectUrl, requestId, url }) => {
    // When we do not have an add-on ID (in the request property bag) and the
    // `redirectUrl` is different than the original URL. we likely detected a
    // search server-side redirect.
    const isServerSideRedirect = !addonId && url !== redirectUrl;

    // Search server-side redirects are possible because an extension has
    // registered a search engine, which is why we can (hopefully) retrieve the
    // add-on ID.
    if (isServerSideRedirect) {
      addonId = this.getAddonIdFromUrl(url);
    }

    if (!addonId) {
      // No add-on ID means there is nothing we can report.
      return;
    }

    // This is the (initial) URL before the redirect.
    const from = await browser.addonsSearchExperiment.getPublicSuffix(url);
    // This is the URL after the redirect.
    const to = await browser.addonsSearchExperiment.getPublicSuffix(
      redirectUrl
    );

    if (from === to) {
      // We do not report redirects to same public suffixes.
      return;
    }

    const telemetryObject = isServerSideRedirect
      ? TELEMETRY_OBJECT_OTHER
      : TELEMETRY_OBJECT_WEBREQUEST;

    const telemetryValue = isServerSideRedirect
      ? TELEMETRY_VALUE_SERVER
      : TELEMETRY_VALUE_EXTENSION;

    const addonVersion = await browser.addonsSearchExperiment.getAddonVersion(
      addonId
    );

    this.recordEvent(
      TELEMETRY_METHOD_ETLD_CHANGE,
      telemetryObject,
      telemetryValue,
      { addonId, addonVersion, from, to }
    );
  };

  recordEvent(method, object, value, extra) {
    console.debug(
      `recording event: method=${method} object=${object} value=${value} extra=${JSON.stringify(
        extra
      )}`
    );

    browser.telemetry.recordEvent(
      TELEMETRY_CATEGORY,
      method,
      object,
      value,
      extra
    );
  }

  getAddonIdFromUrl(url) {
    for (const pattern of Object.keys(this.matchPatternsMap)) {
      const [urlPrefix] = pattern.split("*");

      if (url.startsWith(urlPrefix)) {
        return this.matchPatternsMap[pattern];
      }
    }

    return null;
  }
}

const exp = new AddonsSearchExperiment();
exp.monitor();

browser.addonsSearchExperiment.onSearchEngineModified.addListener(async () => {
  await exp.monitor();
});
