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

const UNFOLLOW_DELAY_IN_SECONDS = 90;

class AddonsSearchExperiment {
  constructor({ debugMode = false }) {
    this.debugMode = debugMode;
    // Make the extension report events earlier in debug mode.
    this.unfollowDelayInSeconds = debugMode ? 10 : UNFOLLOW_DELAY_IN_SECONDS;
    // The key is an URL pattern to monitor and its corresponding value is a
    // list of add-on IDs.
    this.matchPatterns = {};
    // The key is a requestId. The corresponding value should be an object.
    this.requestIdsToFollow = new Map();

    this.debug("registering telemetry events");
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
      browser.addonsSearchExperiment.onBeforeRedirect.hasListener(
        this.onRedirectHandler
      )
    ) {
      this.debug("removing onBeforeRedirect listener");
      browser.addonsSearchExperiment.onBeforeRedirect.removeListener(
        this.onRedirectHandler
      );
    }
    // If there is already a listener, remove it so that we can re-add one
    // after. This is because we're using the same listener with different URL
    // patterns (when the list of search engines changes).
    if (browser.webRequest.onBeforeRequest.hasListener(this.onRequestHandler)) {
      this.debug("removing onBeforeRequest listener");
      browser.webRequest.onBeforeRequest.removeListener(this.onRequestHandler);
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
      this.onRequestHandler,
      { types: ["main_frame"], urls: patterns },
      ["blocking"]
    );

    this.debug("registering onBeforeRedirect listener");
    browser.addonsSearchExperiment.onBeforeRedirect.addListener(
      this.onRedirectHandler,
      { urls: patterns }
    );
  }

  // This listener is used to lazily create a wildcard listener used to follow
  // redirect chains (in addition to being required to force the registration
  // of traceable channels).
  onRequestHandler = ({ requestId }) => {
    if (!browser.webRequest.onBeforeRequest.hasListener(this.followHandler)) {
      this.debug(`registering follow listener`);
      browser.webRequest.onBeforeRequest.addListener(
        this.followHandler,
        { types: ["main_frame"], urls: ["<all_urls>"] },
        ["blocking"]
      );
    }

    if (!this.requestIdsToFollow.has(requestId)) {
      this.debug(
        `registering unfollow delayed function for requestId=${requestId}`
      );

      setTimeout(() => {
        this.unfollowRequest({ requestId });
      }, this.unfollowDelayInSeconds * 1000);
    }
  };

  // This listener is used when we detect a "server side redirect". We want to
  // follow the request (ID) and keep a list of URLs (chain) for it.
  followHandler = ({ requestId, url }) => {
    if (!this.requestIdsToFollow.has(requestId)) {
      return;
    }

    const { chain } = this.requestIdsToFollow.get(requestId);

    if (chain[chain.length - 1] !== url) {
      // Add current URL to the redirect chain, unless it was added in
      // `onRedirectHandler`.
      this.requestIdsToFollow.get(requestId).chain.push(url);
    }
  };

  onRedirectHandler = async ({ addonId, redirectUrl, requestId, url }) => {
    // When we do not have an add-on ID (in the request property bag) and the
    // `redirectUrl` is different than the original URL. we likely detected a
    // search server-side redirect.
    const maybeServerSideRedirect = !addonId && url !== redirectUrl;

    let addonIds = [];
    // Search server-side redirects are possible because an extension has
    // registered a search engine, which is why we can (hopefully) retrieve the
    // add-on ID.
    if (maybeServerSideRedirect) {
      addonIds = this.getAddonIdsForUrl(url);
    } else if (addonId) {
      addonIds = [addonId];
    }

    if (addonIds.length === 0) {
      // No add-on ID means there is nothing we can report.
      return;
    }

    if (maybeServerSideRedirect) {
      this.debug(`start following requestId=${requestId}`);

      // Pass metadata to the follow listener and "start following" this
      // request.
      if (!this.requestIdsToFollow.has(requestId)) {
        this.requestIdsToFollow.set(requestId, {
          addonIds,
          chain: [url, redirectUrl],
        });
      }

      // If we likely found a server-side redirect, we can stop there and let
      // the follow/unfollow logic do the rest and maybe report an actual
      // server-side redirect.
      return;
    }

    // At this point, we observed a webRequest redirect initiated by an add-on,
    // which we want to report if both eTLDs are different. This is verified in
    // the `report()` method.
    this.report({
      addonIds,
      url,
      redirectUrl,
      telemetryObject: TELEMETRY_OBJECT_WEBREQUEST,
      telemetryValue: TELEMETRY_VALUE_EXTENSION,
    });
  };

  async report({
    addonIds,
    url,
    redirectUrl,
    telemetryObject,
    telemetryValue,
  }) {
    // This is the (initial) URL before the redirect.
    const from = await browser.addonsSearchExperiment.getPublicSuffix(url);
    // This is the URL after the redirect (or the last one of a chain).
    const to = await browser.addonsSearchExperiment.getPublicSuffix(
      redirectUrl
    );

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

  // This method is used when we stop following a request (ID). We report
  // information if needed, then the requestId is removed from the map of
  // request IDs to follow. In addition, when there is no request IDs to
  // follow, we also remove the (wildcard) follow listener.
  async unfollowRequest({ requestId }) {
    if (this.requestIdsToFollow.has(requestId)) {
      const { addonIds, chain } = this.requestIdsToFollow.get(requestId);

      this.report({
        addonIds,
        url: chain[0],
        redirectUrl: chain[chain.length - 1],
        telemetryObject: TELEMETRY_OBJECT_OTHER,
        telemetryValue: TELEMETRY_VALUE_SERVER,
      });

      this.debug(`stop following requestId=${requestId}`);
      this.requestIdsToFollow.delete(requestId);
    }

    if (this.requestIdsToFollow.size === 0) {
      this.debug(`removing follow listener`);
      browser.webRequest.onBeforeRequest.removeListener(this.followHandler);
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
