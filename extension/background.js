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

// console.debug = () => {};

class AddonsSearchExperiment {
  constructor() {
    this.matchPatternsMap = {};
    // The key is a requestId. The corresponding value should be an object.
    this.requestIdsToFollow = new Map();

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
      browser.addonsSearchExperiment.onBeforeRedirect.hasListener(
        this.onRedirectHandler
      )
    ) {
      console.debug("removing onBeforeRedirect listener");
      browser.addonsSearchExperiment.onBeforeRedirect.removeListener(
        this.onRedirectHandler
      );
    }

    if (browser.webRequest.onBeforeRequest.hasListener(this.onRequestHandler)) {
      console.debug("removing onBeforeRequest listener");
      browser.webRequest.onBeforeRequest.removeListener(this.onRequestHandler);
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

    console.debug("registering onBeforeRequest listener");
    browser.webRequest.onBeforeRequest.addListener(
      this.onRequestHandler,
      { types: ["main_frame"], urls: patterns },
      ["blocking"]
    );

    console.debug("registering onBeforeRedirect listener");
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
      console.debug(`registering follow listener`);
      browser.webRequest.onBeforeRequest.addListener(
        this.followHandler,
        { types: ["main_frame"], urls: ["<all_urls>"] },
        ["blocking"]
      );
    }

    if (!this.requestIdsToFollow.has(requestId)) {
      console.debug(
        `registering unfollow delayed function for requestId=${requestId}`
      );

      setTimeout(() => {
        this.unfollowHandler({ requestId });
      }, UNFOLLOW_DELAY_IN_SECONDS * 1000);
    }
  };

  // This listener is used when we detect a "server side redirect". We want to
  // follow the request (ID) and keep a list of URLs (chain) for it.
  followHandler = ({ requestId, url }) => {
    if (!this.requestIdsToFollow.has(requestId)) {
      return;
    }

    // Add current URL to the redirect chain.
    this.requestIdsToFollow.get(requestId).chain.push(url);
  };

  // This listener is used when we stop following a request (ID). We report
  // information if needed, then the requestId is removed from the map of
  // request IDs to follow. In addition, when there is no request IDs to
  // follow, we also remove the (wildcard) follow listener.
  unfollowHandler = async ({ requestId }) => {
    if (this.requestIdsToFollow.has(requestId)) {
      const { addonIds, chain } = this.requestIdsToFollow.get(requestId);

      await this.report({
        addonIds,
        url: chain[0],
        redirectUrl: chain[chain.length - 1],
        telemetryObject: TELEMETRY_OBJECT_OTHER,
        telemetryValue: TELEMETRY_VALUE_SERVER,
      });

      console.debug(`stop following requestId=${requestId}`);
      this.requestIdsToFollow.delete(requestId);
    }

    if (this.requestIdsToFollow.size === 0) {
      console.debug(`removing follow listener`);
      browser.webRequest.onBeforeRequest.removeListener(this.followHandler);
    }
  };

  onRedirectHandler = async ({ addonId, redirectUrl, requestId, url }) => {
    // When we do not have an add-on ID (in the request property bag) and the
    // `redirectUrl` is different than the original URL. we likely detected a
    // search server-side redirect.
    const isServerSideRedirect = !addonId && url !== redirectUrl;

    let addonIds = [];
    // Search server-side redirects are possible because an extension has
    // registered a search engine, which is why we can (hopefully) retrieve the
    // add-on ID.
    if (isServerSideRedirect) {
      addonIds = this.getAddonIdsForUrl(url);
    } else if (addonId) {
      addonIds = [addonId];
    }

    if (addonIds.length === 0) {
      // No add-on ID means there is nothing we can report.
      return;
    }

    if (isServerSideRedirect) {
      console.debug(`start following requestId=${requestId}`);

      // Pass metadata to the follow listener.
      this.requestIdsToFollow.set(requestId, { addonIds, chain: [url] });
    } else {
      await this.report({
        addonIds,
        url,
        redirectUrl,
        telemetryObject: TELEMETRY_OBJECT_WEBREQUEST,
        telemetryValue: TELEMETRY_VALUE_EXTENSION,
      });
    }
  };

  report = async ({
    addonIds,
    url,
    redirectUrl,
    telemetryObject,
    telemetryValue,
  }) => {
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
      return;
    }

    for (const addonId of addonIds) {
      const addonVersion = await browser.addonsSearchExperiment.getAddonVersion(
        addonId
      );
      const extra = { addonId, addonVersion, from, to };

      console.debug(
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
  };

  getAddonIdsForUrl(url) {
    for (const pattern of Object.keys(this.matchPatternsMap)) {
      const [urlPrefix] = pattern.split("*");

      if (url.startsWith(urlPrefix)) {
        return this.matchPatternsMap[pattern];
      }
    }

    return [];
  }
}

const exp = new AddonsSearchExperiment();
exp.monitor();

browser.addonsSearchExperiment.onSearchEngineModified.addListener(async () => {
  await exp.monitor();
});
