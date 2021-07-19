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

const CLEAN_UP_TIMEOUT_IN_SECONDS = 90;

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
      console.debug(`registering clean-up function for requestId=${requestId}`);

      setTimeout(() => {
        this.cleanUpHandler({ requestId });
      }, CLEAN_UP_TIMEOUT_IN_SECONDS * 1000);
    }
  };

  // This is used when we detect a "server side redirect" but the "from" and
  // "to" eTLDs are the same. In this case, we want to follow the redirect
  // chain in case there is a server side redirect to a different eTLD
  // somewhere.
  followHandler = ({ requestId, url: redirectUrl }) => {
    if (!this.requestIdsToFollow.has(requestId)) {
      return;
    }

    const { addonIds, url } = this.requestIdsToFollow.get(requestId);

    console.debug(`following requestId=${requestId}`);
    this.onRedirectHandler({ requestId, url, redirectUrl, addonIds });
  };

  // This listener is used to clean up the temporary listeners used to follow
  // requests in the case of redirect chains. The requestId is removed from the
  // map of request IDs to follow if it was followed. When there is no request
  // IDs to follow, we also remove the wildcard listeners.
  cleanUpHandler = ({ requestId }) => {
    if (this.requestIdsToFollow.has(requestId)) {
      console.debug(`removing requestId=${requestId} from the follow map`);
      this.requestIdsToFollow.delete(requestId);
    }

    if (this.requestIdsToFollow.size === 0) {
      console.debug(`removing follow listener`);
      browser.webRequest.onBeforeRequest.removeListener(this.followHandler);
    }
  };

  onRedirectHandler = async ({
    addonId,
    redirectUrl,
    requestId,
    url,
    // Only set in the case of a redirect chain.
    addonIds,
  }) => {
    // When we do not have an add-on ID (in the request property bag) and the
    // `redirectUrl` is different than the original URL. we likely detected a
    // search server-side redirect.
    const isServerSideRedirect = !addonId && url !== redirectUrl;

    // Search server-side redirects are possible because an extension has
    // registered a search engine, which is why we can (hopefully) retrieve the
    // add-on ID.
    if (!addonIds && isServerSideRedirect) {
      addonIds = this.getAddonIdsForUrl(url);
    } else if (addonId) {
      addonIds = [addonId];
    }

    if (addonIds.length === 0) {
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
      if (isServerSideRedirect) {
        // This could be a redirect chain so let's register a new listener to
        // "follow" the request (ID).
        console.debug(
          `requestId=${requestId} might be a server side redirect - ${url} -> ${redirectUrl}`
        );

        // Pass metadata to the follow listener.
        this.requestIdsToFollow.set(requestId, { addonIds, url: redirectUrl });
      }

      // We do not report redirects to same public suffixes. However, we will
      // report redirects from public suffixes belonging to a same entity
      // (.e.g., `example.com` -> `example.fr`).
      return;
    }

    const telemetryObject = isServerSideRedirect
      ? TELEMETRY_OBJECT_OTHER
      : TELEMETRY_OBJECT_WEBREQUEST;

    const telemetryValue = isServerSideRedirect
      ? TELEMETRY_VALUE_SERVER
      : TELEMETRY_VALUE_EXTENSION;

    for (const addonId of addonIds) {
      const addonVersion = await browser.addonsSearchExperiment.getAddonVersion(
        addonId
      );

      this.recordEvent(
        TELEMETRY_METHOD_ETLD_CHANGE,
        telemetryObject,
        telemetryValue,
        { addonId, addonVersion, from, to }
      );
    }
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
